/**
 * 本插件自己的 WorkBuddy 账号库：`<dataDir>/accounts/<region>/<accountId>.json`。
 *
 * 为什么不是一份大 JSON：一个账号一个文件才能做到"只改一个账号不重写整库"，
 * 刷新失败也最多毁掉一条记录；文件名用 accountId 而不是 uid，是为了让
 * 「同一个 uid 换区域重登」变成两个文件而不是互相覆盖。
 *
 * 目录结构刻意与 `dsh-connect-workbuddy` 的 vault **不同**（那个是
 * `$DSH_HOME/workbuddy-vault/<region>/<file>.json`）：本插件的库在自己的
 * dataDir 里，两个插件都装时互不干扰；要迁移账号走 `importFromVault()` 显式导入。
 *
 * 安全约定：
 *   - 文件权限 0600，目录 0700；
 *   - `list()` / `status()` 绝不返回 token，只返回 hasToken/过期等布尔；
 *   - token 只在 `resolveToken()` 与 `refresh()` 里读，且不回日志。
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { baseForRegion, regionOfDomain } from './wb-login.js'

const RECORD_VERSION = 1
const LOCK_STALE_MS = 2 * 60 * 1000
const LOCK_TIMEOUT_MS = 10 * 1000
const LOCK_RETRY_MS = 40

/** 区域顺序：国内优先（本机多数账号是国内版）。 */
const REGION_ORDER = ['cn', 'global']

function nowMs() {
  return Date.now()
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 上游可能给秒也可能给毫秒；1e12 是分界，与 vault 里的既有数据一致。 */
export function normalizeExpiry(value) {
  const numeric = typeof value === 'string' ? Number(value) : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return numeric > 1e12 ? numeric : numeric * 1000
}

/**
 * accountId：稳定、可做文件名、不泄露 uid 原文。
 *
 * 用 `sha256(uid)` 前 24 位而不是 uid 本身，理由有两条：uid 是账号标识（写进
 * 文件名会被任何读目录的进程看到），而 24 位十六进制在单机范围内不会撞。
 * 没有 uid 时退回随机值——宁可多一条记录，也不要让两个账号互相覆盖。
 */
export function accountIdOf(uid) {
  const text = String(uid ?? '').trim()
  if (text === '') return randomUUID().replaceAll('-', '').slice(0, 24)
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

/** 脱敏后的对外视图：没有任何 token 字段。 */
export function describeAccount(record, now = nowMs()) {
  const expiresAt = normalizeExpiry(record?.auth?.expiresAt)
  const refreshExpiresAt = normalizeExpiry(record?.auth?.refreshExpiresAt)
  const hasToken = typeof record?.auth?.accessToken === 'string' && record.auth.accessToken !== ''
  const hasRefresh = typeof record?.auth?.refreshToken === 'string' && record.auth.refreshToken !== ''
  return {
    accountId: String(record?.accountId ?? ''),
    uid: String(record?.account?.uid ?? ''),
    nickname: String(record?.account?.nickname ?? ''),
    uin: String(record?.account?.uin ?? ''),
    avatarUrl: typeof record?.account?.avatarUrl === 'string' ? record.account.avatarUrl : null,
    region: String(record?.region ?? ''),
    domain: String(record?.auth?.domain ?? ''),
    expiresAt: expiresAt > 0 ? expiresAt : 0,
    refreshExpiresAt: refreshExpiresAt > 0 ? refreshExpiresAt : 0,
    expired: expiresAt > 0 ? expiresAt <= now : true,
    refreshExpired: refreshExpiresAt > 0 ? refreshExpiresAt <= now : false,
    hasToken,
    hasRefreshToken: hasRefresh,
    // 能用 = 有 access 且没过期；refresh 还能用也算可用（调用方会先刷新）。
    usable: hasToken && (expiresAt === 0 || expiresAt > now || (hasRefresh && (refreshExpiresAt === 0 || refreshExpiresAt > now))),
    refreshedAtMs: Number(record?.refreshedAtMs ?? 0) || 0,
    file: typeof record?.file === 'string' ? record.file : undefined,
  }
}

async function acquireLock(lockDir, options = {}) {
  const timeoutMs = Number(options.lockTimeoutMs ?? LOCK_TIMEOUT_MS)
  const staleMs = Number(options.lockStaleMs ?? LOCK_STALE_MS)
  const force = options.force === true
  let forced = false
  const deadline = nowMs() + timeoutMs
  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false, mode: 0o700 })
      await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: nowMs() }), { encoding: 'utf8', mode: 0o600 })
      return { acquired: true, forced }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stat
      try {
        stat = await fs.stat(lockDir)
      } catch {
        continue
      }
      const stale = nowMs() - stat.mtimeMs > staleMs
      if (stale || (force && forced === false)) {
        try {
          await fs.rm(lockDir, { recursive: true, force: true })
        } catch {
          // Someone else may have removed it between stat and rm.
        }
        if (!stale) forced = true
        continue
      }
      if (nowMs() > deadline) throw new Error(`another account operation is still running (${lockDir})`)
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function releaseLock(lockDir) {
  try {
    await fs.rm(lockDir, { recursive: true, force: true })
  } catch {
    // A leftover lock is broken by the stale window; not worth failing a write.
  }
}

/**
 * 账号库。
 *
 * `dataDir` 由插件传入（默认 `$DSH_HOME/workbuddy-helper`），所以库文件落在
 * `$DSH_HOME/workbuddy-helper/accounts/...`。
 */
export function createAccountStore(options = {}) {
  // `dir` 直接指定账号根（<dir>/<region>/<accountId>.json）；`dataDir` 是"插件数据
  // 目录"，账号根在它下面的 accounts/。两种都给时 dir 优先——测试与自定义布局用得上。
  const explicitDir = String(options.dir ?? '')
  const dataDir = String(options.dataDir ?? '')
  if (explicitDir === '' && dataDir === '') throw new Error('createAccountStore requires a dir or a dataDir')
  const root = explicitDir !== '' ? explicitDir : path.join(dataDir, 'accounts')
  const now = options.now ?? nowMs
  let cache = null

  const fileOf = (region, accountId) => path.join(root, region, `${accountId}.json`)
  const lockRoot = () => path.join(root, '.lock')

  async function readAll() {
    const accounts = []
    for (const region of REGION_ORDER) {
      const dir = path.join(root, region)
      let names
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        if (name.startsWith('.')) continue
        const file = path.join(dir, name)
        let record
        try {
          record = JSON.parse(await fs.readFile(file, 'utf8'))
        } catch {
          continue
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
        accounts.push({ ...record, region, file })
      }
    }
    const order = item => {
      const index = REGION_ORDER.indexOf(item.region)
      return index === -1 ? REGION_ORDER.length : index
    }
    accounts.sort((a, b) => order(a) - order(b) || normalizeExpiry(b?.auth?.expiresAt) - normalizeExpiry(a?.auth?.expiresAt))
    return accounts
  }

  async function load() {
    if (cache !== null) return cache
    cache = await readAll()
    return cache
  }

  function invalidate() {
    cache = null
  }

  async function writeRecord(record) {
    const region = String(record.region ?? regionOfDomain(record?.auth?.domain))
    const accountId = String(record.accountId ?? '')
    if (accountId === '') throw new Error('cannot write an account without an accountId')
    const dir = path.join(root, region)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const target = fileOf(region, accountId)
    const temp = `${target}.tmp-${process.pid}-${nowMs().toString(36)}`
    const body = { ...record, version: RECORD_VERSION, refreshedAtMs: nowMs() }
    delete body.file
    await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, target)
    invalidate()
    return { ...body, region, file: target }
  }

  async function rawRecord(accountId) {
    const all = await load()
    return all.find(record => describeAccount(record, now()).accountId === accountId)
  }

  async function updateRecord(accountId, patch) {
    const existing = await rawRecord(accountId)
    if (existing === undefined) throw new Error(`account not found: ${accountId}`)
    const region = String(existing.region ?? regionOfDomain(existing?.auth?.domain))
    await fs.mkdir(lockRoot(), { recursive: true, mode: 0o700 })
    const lock = await acquireLock(path.join(lockRoot(), `${region}-${accountId}`), options)
    try {
      const record = await writeRecord({
        ...existing,
        accountId,
        region,
        account: existing.account ?? {},
        auth: {
          ...existing.auth ?? {},
          ...typeof patch?.accessToken === 'string' ? { accessToken: patch.accessToken } : {},
          ...typeof patch?.refreshToken === 'string' && patch.refreshToken !== '' ? { refreshToken: patch.refreshToken } : {},
          ...patch?.expiresAtMs !== undefined ? { expiresAt: normalizeExpiry(patch.expiresAtMs) } : {},
          ...patch?.refreshExpiresAtMs !== undefined ? { refreshExpiresAt: normalizeExpiry(patch.refreshExpiresAtMs) } : {},
          ...typeof patch?.domain === 'string' && patch.domain !== '' ? { domain: patch.domain } : {},
        },
      })
      return { ...describeAccount(record, now()), forced: lock.forced }
    } finally {
      await releaseLock(path.join(lockRoot(), `${region}-${accountId}`))
    }
  }

  return {
    root,

    /** 落一条新凭据（登录成功或导入）。返回脱敏视图。 */
    async save(input) {
      const uid = String(input?.uid ?? '').trim()
      if (uid === '') throw new Error('cannot save an account without a uid')
      const region = String(input?.region ?? regionOfDomain(input?.domain))
      const accountId = String(input?.accountId ?? accountIdOf(uid))
      await fs.mkdir(lockRoot(), { recursive: true, mode: 0o700 })
      const lock = await acquireLock(path.join(lockRoot(), `${region}-${accountId}`), options)
      try {
        const record = await writeRecord({
          accountId,
          region,
          account: {
            uid,
            ...typeof input?.nickname === 'string' && input.nickname !== '' ? { nickname: input.nickname } : {},
            ...typeof input?.uin === 'string' && input.uin !== '' ? { uin: input.uin } : {},
            ...typeof input?.avatarUrl === 'string' && input.avatarUrl !== '' ? { avatarUrl: input.avatarUrl } : {},
          },
          auth: {
            accessToken: String(input?.accessToken ?? ''),
            refreshToken: String(input?.refreshToken ?? ''),
            expiresAt: normalizeExpiry(input?.expiresAtMs ?? input?.expiresAt),
            refreshExpiresAt: normalizeExpiry(input?.refreshExpiresAtMs ?? input?.refreshExpiresAt),
            domain: String(input?.domain ?? ''),
            ...typeof input?.enterpriseId === 'string' && input.enterpriseId !== '' ? { enterpriseId: input.enterpriseId } : {},
          },
        })
        return { ...describeAccount(record, now()), forced: lock.forced }
      } finally {
        await releaseLock(path.join(lockRoot(), `${region}-${accountId}`))
      }
    },

    /** 脱敏列表。默认只返回可用账号，`includeExpired` 才全给。 */
    async list(options_ = {}) {
      const all = await load()
      const items = all.map(record => describeAccount(record, now()))
      return options_.includeExpired === true ? items : items.filter(item => item.usable)
    },

    /** 全量视图（含过期），面板要显示"已过期"那一行。 */
    async all() {
      return (await load()).map(record => describeAccount(record, now()))
    },

    /**
     * 按 region 取一条能用的凭据。
     *
     * 顺序：区域匹配 → 未过期 → expiresAt 最晚。返回的 `token` 是明文，
     * 调用方只该立刻塞进请求头。
     */
    async resolve(options_ = {}) {
      const all = await load()
      const wanted = options_.region
      const candidates = all
        .map(record => ({ record, view: describeAccount(record, now()) }))
        .filter(item => item.view.hasToken)
        .filter(item => wanted === undefined || item.view.region === wanted)
        .filter(item => options_.includeExpired === true || item.view.usable)
        .sort((a, b) => b.view.expiresAt - a.view.expiresAt)
      const chosen = candidates[0]
      if (chosen === undefined) return undefined
      return {
        token: String(chosen.record.auth?.accessToken ?? ''),
        refreshToken: String(chosen.record.auth?.refreshToken ?? ''),
        accountId: chosen.view.accountId,
        uid: chosen.view.uid,
        nickname: chosen.view.nickname,
        region: chosen.view.region,
        domain: chosen.view.domain,
        expiresAt: chosen.view.expiresAt,
        base: baseForRegion(chosen.view.region, undefined),
      }
    },

    /** 读一条完整记录（含 token），只给刷新用。 */
    async raw(accountId) {
      const all = await load()
      return all.find(record => describeAccount(record, now()).accountId === accountId)
    },

    /** 把刷新结果写回。找不到账号就抛错，绝不悄悄新建一条半成品。 */
    async update(accountId, patch) {
      const existing = await this.raw(accountId)
      if (existing === undefined) throw new Error(`account not found: ${accountId}`)
      const region = String(existing.region ?? regionOfDomain(existing?.auth?.domain))
      await fs.mkdir(lockRoot(), { recursive: true, mode: 0o700 })
      const lock = await acquireLock(path.join(lockRoot(), `${region}-${accountId}`), options)
      try {
        const record = await writeRecord({
          ...existing,
          accountId,
          region,
          account: existing.account ?? {},
          auth: {
            ...existing.auth ?? {},
            ...typeof patch?.accessToken === 'string' ? { accessToken: patch.accessToken } : {},
            ...typeof patch?.refreshToken === 'string' && patch.refreshToken !== '' ? { refreshToken: patch.refreshToken } : {},
            ...patch?.expiresAtMs !== undefined ? { expiresAt: normalizeExpiry(patch.expiresAtMs) } : {},
            ...patch?.refreshExpiresAtMs !== undefined ? { refreshExpiresAt: normalizeExpiry(patch.refreshExpiresAtMs) } : {},
            ...typeof patch?.domain === 'string' && patch.domain !== '' ? { domain: patch.domain } : {},
          },
        })
        return { ...describeAccount(record, now()), forced: lock.forced }
      } finally {
        await releaseLock(path.join(lockRoot(), `${region}-${accountId}`))
      }
    },

    /** 删一条。返回是否真的删到了东西。 */
    async remove(accountId) {
      const all = await load()
      const hit = all.find(record => describeAccount(record, now()).accountId === accountId)
      if (hit === undefined) return false
      await fs.rm(hit.file, { force: true })
      invalidate()
      return true
    },

    /** 统计：给 status 用，不暴露文件名。 */
    async summary() {
      const items = await this.all()
      return {
        dir: root,
        count: items.length,
        usableCount: items.filter(item => item.usable).length,
        regions: [...new Set(items.map(item => item.region))].sort(),
        accounts: items,
      }
    },
  }
}

/**
 * 从 `dsh-connect-workbuddy` 的 vault 导入账号（一次性迁移，不是运行时依赖）。
 *
 * 只读那个目录，读失败就跳过对应文件——别人的账号库格式化一次不该让本插件报错。
 * 返回 `{ imported, skipped, errors }`，`imported` 里只有脱敏视图。
 */
export async function importFromVault(options = {}) {
  const vaultDir = String(options.vaultDir ?? '')
  if (vaultDir === '') throw new Error('importFromVault requires a vaultDir')
  const store = options.store
  if (store === undefined || typeof store.save !== 'function') throw new Error('importFromVault requires a store')

  const imported = []
  const skipped = []
  const errors = []

  const regions = options.regions ?? REGION_ORDER
  for (const region of regions) {
    const dir = path.join(vaultDir, region)
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const file = path.join(dir, name)
      let doc
      try {
        doc = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch (error) {
        errors.push({ file: name, error: messageOf(error) })
        continue
      }
      const uid = String(doc?.account?.uid ?? '').trim()
      const accessToken = String(doc?.auth?.accessToken ?? '').trim()
      if (uid === '' || accessToken === '') {
        skipped.push({ file: name, reason: uid === '' ? 'no account.uid' : 'no auth.accessToken' })
        continue
      }
      try {
        const saved = await store.save({
          uid,
          region,
          nickname: doc?.account?.nickname,
          uin: doc?.account?.uin,
          avatarUrl: doc?.account?.avatarUrl,
          accessToken,
          refreshToken: doc?.auth?.refreshToken,
          expiresAtMs: normalizeExpiry(doc?.auth?.expiresAt),
          refreshExpiresAtMs: normalizeExpiry(doc?.auth?.refreshExpiresAt),
          domain: doc?.auth?.domain,
          enterpriseId: doc?.auth?.enterpriseId,
        })
        imported.push(saved)
      } catch (error) {
        errors.push({ file: name, error: messageOf(error) })
      }
    }
  }

  return { imported, skipped, errors }
}
