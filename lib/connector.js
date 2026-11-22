/**
 * 凭据源：本插件自己的账号库优先，`dsh-connect-workbuddy` 的 vault 只当兼容层。
 *
 * 为什么分层而不是直接切干净：升级的用户机器上已经有那个插件登好的账号，
 * 直接"只认自己的库"等于让所有人重新扫码。所以顺序固定为
 *
 *   1. helper   —— `<dataDir>/accounts/<region>/<accountId>.json`（本插件写入、可刷新）
 *   2. vault    —— `$DSH_HOME/workbuddy-vault/<region>/<file>.json`（只读，从不改写）
 *   3. credential —— DSH credential service（`authMode=bearer/header/cookie` 时）
 *
 * 三条硬规矩：
 *   - vault 目录**永不写入**（那是别人的存储，有它自己的锁与日志）；
 *   - `status()` / `listAccounts()` 不返回 token，只返回布尔；
 *   - `resolveToken()` 是唯一读出明文的地方，调用方只该立刻塞进请求头。
 *
 * 本模块除 `wb-login.js` / `wb-vault.js` 外没有 DSH import，可离线单测。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { isExpired, mask, resolveDshHome } from './util.js'
import { refreshCredential } from './wb-login.js'
import { createAccountStore, normalizeExpiry } from './wb-vault.js'

const REGION_ORDER = ['cn', 'global']

/** 剩余寿命小于这个值就当作"该刷新了"，避免请求在路上过期。 */
const REFRESH_SKEW_MS = 60 * 1000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export class WorkBuddyConnector {
  constructor(options = {}) {
    this.dshHome = options.dshHome ?? resolveDshHome()
    this.vaultDir = options.vaultDir ?? path.join(this.dshHome, 'workbuddy-vault')
    this.explicitVault = options.vaultDir !== undefined
    // 字段叫 store 不叫 accounts：`accounts()` 是方法名，同名字段会把它遮住。
    this.store = options.accounts ?? createAccountStore({
      ...options.accountsDir === undefined ? {} : { dir: options.accountsDir },
      ...options.accountsDir === undefined ? { dataDir: options.dataDir ?? path.join(this.dshHome, 'workbuddy-helper') } : {},
    })
    this.refreshSkewMs = Number(options.refreshSkewMs ?? REFRESH_SKEW_MS)
    this.fetchImpl = options.fetchImpl
    this.now = options.now ?? (() => Date.now())
  }

  /** 兼容层是否装在这台机器上（只影响 status 里的一行展示，不影响可用性）。 */
  async detectInstalled() {
    const profilesDir = path.join(this.dshHome, 'profiles')
    let entries = []
    try {
      entries = await fs.readdir(profilesDir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(profilesDir, entry.name, 'node_modules', 'dsh-connect-workbuddy', 'package.json')
      try {
        const pkg = JSON.parse(await fs.readFile(candidate, 'utf8'))
        return { profile: entry.name, version: pkg.version, packageJson: candidate }
      } catch {
        continue
      }
    }
    return undefined
  }

  // ── 兼容层：读 dsh-connect-workbuddy 的 vault（只读） ────────────────────

  async listAccountFiles() {
    const files = []
    for (const region of REGION_ORDER) {
      const dir = path.join(this.vaultDir, region)
      let entries = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        files.push({ region, file: path.join(dir, entry.name) })
      }
    }
    if (files.length === 0) {
      let entries = []
      try {
        entries = await fs.readdir(this.vaultDir, { withFileTypes: true })
      } catch {
        return files
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        files.push({ region: 'legacy', file: path.join(this.vaultDir, entry.name) })
      }
    }
    return files
  }

  async listAccounts() {
    const files = await this.listAccountFiles()
    const accounts = []
    for (const { region, file } of files) {
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'))
        const auth = record.auth ?? {}
        const account = record.account ?? {}
        const expiresAt = normalizeExpiry(auth.expiresAt)
        accounts.push({
          source: 'vault',
          region,
          accountId: String(record.accountId ?? path.basename(file, '.json')),
          nickname: String(account.nickname ?? ''),
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
          expired: isExpired(expiresAt),
          hasToken: typeof auth.accessToken === 'string' && auth.accessToken.length > 0,
          hasRefreshToken: typeof auth.refreshToken === 'string' && auth.refreshToken.length > 0,
          file,
        })
      } catch {
        continue
      }
    }
    const order = item => {
      const index = REGION_ORDER.indexOf(item.region)
      return index === -1 ? REGION_ORDER.length : index
    }
    accounts.sort((a, b) => order(a) - order(b) || b.expiresAt - a.expiresAt)
    return accounts
  }

  // ── 自有账号库 ────────────────────────────────────────────────────────

  /** 本插件自己存的账号（脱敏）。 */
  async ownAccounts() {
    return this.store.all()
  }

  /**
   * 两个来源合并后的账号视图。`source` 明确标出这条是谁的，
   * 面板据此显示「本插件」还是「dsh-connect-workbuddy」。
   */
  async accounts() {
    const own = (await this.store.all()).map(item => ({ ...item, source: 'helper' }))
    const legacy = await this.listAccounts()
    return [...own, ...legacy]
  }

  /** 能用的账号数：refresh 还有效也算能用（resolveToken 会先刷新）。 */
  async usableAccounts() {
    const all = await this.accounts()
    return all.filter(item => item.hasToken && (!item.expired || this.canRefresh(item)))
  }

  canRefresh(item) {
    if (item.hasRefreshToken !== true) return false
    const refreshExpiresAt = Number(item.refreshExpiresAt ?? 0)
    return refreshExpiresAt === 0 || refreshExpiresAt > this.now()
  }

  /**
   * 取一条可用 token。
   *
   * 排序刻意是「自有库优先、区域匹配、再把最晚过期的排前面」：自有库是我们能刷新
   * 的那一份，优先它能让刷新结果落回可控的位置；兼容层的过期 token 只当最后手段。
   */
  async resolveToken(options = {}) {
    const preferred = options.region
    const all = await this.accounts()
    const ranked = all
      .filter(item => item.hasToken)
      .filter(item => preferred === undefined || item.region === preferred)
      .filter(item => options.includeExpired === true || !item.expired || this.canRefresh(item))
      .sort((a, b) => {
        const sourceRank = item => (item.source === 'helper' ? 0 : 1)
        return sourceRank(a) - sourceRank(b) || b.expiresAt - a.expiresAt
      })
    const chosen = ranked[0]
    if (chosen === undefined) return undefined
    return this.readToken(chosen)
  }

  /** 把一条账号视图读成明文 token（唯一的读秘密入口）。 */
  async readToken(item) {
    if (item.source === 'helper') {
      const raw = await this.store.raw(item.accountId)
      if (raw === undefined) return undefined
      const token = raw.auth?.accessToken
      if (typeof token !== 'string' || token === '') return undefined
      return {
        token,
        refreshToken: String(raw.auth?.refreshToken ?? ''),
        accountId: item.accountId,
        uid: String(raw.account?.uid ?? ''),
        nickname: String(raw.account?.nickname ?? ''),
        region: item.region,
        domain: typeof raw.auth?.domain === 'string' ? raw.auth.domain : undefined,
        expiresAt: item.expiresAt,
        source: 'helper',
      }
    }
    try {
      const record = JSON.parse(await fs.readFile(item.file, 'utf8'))
      const token = record.auth?.accessToken
      if (typeof token !== 'string' || token.length === 0) return undefined
      return {
        token,
        refreshToken: String(record.auth?.refreshToken ?? ''),
        accountId: item.accountId,
        uid: String(record.account?.uid ?? ''),
        nickname: String(record.account?.nickname ?? ''),
        region: item.region,
        domain: typeof record.auth?.domain === 'string' ? record.auth.domain : undefined,
        expiresAt: item.expiresAt,
        source: 'vault',
      }
    } catch {
      return undefined
    }
  }

  /**
   * 取一条**确定还活着**的 token：快过期就先刷新。
   *
   * 只有自有库的账号能刷新（兼容层的存储不归我们写）。刷新失败时：
   * 旧 token 若还没真过期就继续用它，否则返回 undefined 让调用方报"需要登录"——
   * 多试一次远好过把还有 30 秒寿命的 token 当成坏的。
   */
  async resolveFreshToken(options = {}) {
    const hit = await this.resolveToken(options)
    if (hit === undefined) return undefined
    const remaining = hit.expiresAt === 0 ? Number.POSITIVE_INFINITY : hit.expiresAt - this.now()
    if (remaining > this.refreshSkewMs) return { ...hit, refreshed: false }
    if (hit.source !== 'helper' || hit.refreshToken === '') {
      return remaining > 0 ? { ...hit, refreshed: false } : undefined
    }
    try {
      const next = await refreshCredential({
        credential: hit,
        fetchImpl: this.fetchImpl,
        now: this.now(),
      })
      await this.store.update(hit.accountId, {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAtMs: next.expiresAtMs,
        refreshExpiresAtMs: next.refreshExpiresAtMs,
        domain: next.domain,
      })
      return {
        ...hit,
        token: next.accessToken,
        refreshToken: next.refreshToken,
        domain: next.domain === '' ? hit.domain : next.domain,
        expiresAt: normalizeExpiry(next.expiresAtMs),
        refreshed: true,
      }
    } catch (error) {
      if (remaining > 0) return { ...hit, refreshed: false, refreshError: messageOf(error) }
      throw new Error(`the stored WorkBuddy token expired and could not be refreshed: ${messageOf(error)}`)
    }
  }

  /** 登录成功后落盘。region 由 accounts 自己按 domain 归一，这里只透传。 */
  async saveAccount(account) {
    return this.store.save(account)
  }

  /**
   * 强制刷新一条自有账号（面板上的「刷新」按钮、`accountAction=refresh`）。
   *
   * 与 `resolveFreshToken()` 的区别：那个是"顺手刷新"，只在快过期时动手；
   * 这个是用户明确要求，无论剩余寿命都要换一张新票，失败必须抛出原因。
   */
  async refreshAccount(accountId) {
    const raw = await this.store.raw(accountId)
    if (raw === undefined) throw new Error(`account not found: ${accountId}`)
    const refreshToken = String(raw.auth?.refreshToken ?? '')
    if (refreshToken === '') throw new Error('this account has no refresh token; sign in again')
    const next = await refreshCredential({
      credential: {
        refreshToken,
        domain: raw.auth?.domain,
        enterpriseId: raw.auth?.enterpriseId,
        base: undefined,
      },
      fetchImpl: this.fetchImpl,
      now: this.now(),
    })
    return this.store.update(accountId, {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAtMs: next.expiresAtMs,
      refreshExpiresAtMs: next.refreshExpiresAtMs,
      domain: next.domain,
    })
  }

  /**
   * 状态视图。`accountCount` / `usableAccountCount` / `accounts` 三个字段跨两个来源
   * 汇总（旧测试与旧调用方按这两个数字看"有几个账号"），另外开 `own` / `vault`
   * 两块给出分来源明细。
   */
  async status() {
    const installed = await this.detectInstalled()
    const own = await this.store.all()
    const legacy = await this.listAccounts()
    const merged = [...own.map(item => ({ ...item, source: 'helper' })), ...legacy]
    const usable = merged.filter(item => item.hasToken && (!item.expired || this.canRefresh(item)))
    const helperUsable = own.filter(item => item.usable)
    const best = usable.sort((a, b) => b.expiresAt - a.expiresAt)[0]
    return {
      // 保留旧字段：从 0.6.x 起的调用方都在读这几个键。
      connector: 'dsh-connect-workbuddy',
      installed: installed !== undefined,
      profile: installed?.profile ?? null,
      version: installed?.version ?? null,
      vaultPresent: legacy.length > 0,
      vaultDir: mask(this.vaultDir, 12),
      accountCount: merged.length,
      usableAccountCount: usable.length,
      tokenAvailable: usable.length > 0,
      // 新增：token 从哪来，以及自有库的位置与规模。
      source: best === undefined ? 'none' : best.source,
      regions: [...new Set(merged.map(item => item.region))],
      own: {
        dir: mask(this.store.root, 12),
        count: own.length,
        usableCount: helperUsable.length,
        accounts: own.map(item => ({
          accountId: mask(item.accountId, 4),
          nickname: mask(item.nickname, 2),
          region: item.region,
          domain: item.domain,
          expiresAt: item.expiresAt > 0 ? new Date(item.expiresAt).toISOString() : null,
          expired: item.expired,
          hasToken: item.hasToken,
          hasRefreshToken: item.hasRefreshToken,
          usable: item.usable,
        })),
      },
      accounts: merged.map(item => ({
        source: item.source,
        accountId: mask(item.accountId, 4),
        nickname: mask(item.nickname, 2),
        region: item.region,
        expiresAt: item.expiresAt > 0 ? new Date(item.expiresAt).toISOString() : null,
        expired: item.expired,
        hasToken: item.hasToken,
        hasRefreshToken: item.hasRefreshToken === true,
      })),
    }
  }
}
