import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  accountIdOf,
  createAccountStore,
  describeAccount,
  importFromVault,
  normalizeExpiry,
} from '../lib/wb-vault.js'

async function tempDir(prefix = 'wbh-vault-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

const HOUR = 3_600_000

function credential(overrides = {}) {
  return {
    uid: 'uid-demo',
    nickname: '不等时间',
    region: 'cn',
    accessToken: 'tok-demo',
    refreshToken: 'ref-demo',
    expiresAtMs: Date.now() + HOUR,
    domain: 'www.codebuddy.cn',
    ...overrides,
  }
}

test('normalizeExpiry treats values below 1e12 as seconds', () => {
  assert.equal(normalizeExpiry(1_700_000_000), 1_700_000_000_000)
  assert.equal(normalizeExpiry(1_700_000_000_500), 1_700_000_000_500)
  assert.equal(normalizeExpiry('1700000000'), 1_700_000_000_000)
  // 0 / 负数 / 垃圾一律当"没有到期时间"，而不是当成 1970 年已经过期。
  assert.equal(normalizeExpiry(0), 0)
  assert.equal(normalizeExpiry(-5), 0)
  assert.equal(normalizeExpiry('nope'), 0)
  assert.equal(normalizeExpiry(undefined), 0)
})

test('accountIdOf hashes the uid so a directory listing cannot leak it', () => {
  const id = accountIdOf('uid-demo')
  assert.match(id, /^[0-9a-f]{24}$/)
  assert.equal(id.includes('uid-demo'), false)
  // 稳定：同一个 uid 每次都得到同一个文件名，重登才是"覆盖"而不是"多一条"。
  assert.equal(accountIdOf('uid-demo'), id)
  // 没有 uid 时不能撞车：随机值，两次不同。
  assert.notEqual(accountIdOf(''), accountIdOf(''))
  assert.match(accountIdOf(undefined), /^[0-9a-f]{24}$/)
})

test('describeAccount never exposes a token', () => {
  const view = describeAccount({
    accountId: 'a1',
    region: 'cn',
    account: { uid: 'uid-demo', nickname: '不等时间', uin: '123' },
    auth: { accessToken: 'tok-secret', refreshToken: 'ref-secret', expiresAt: Math.floor((Date.now() + HOUR) / 1000), domain: 'www.codebuddy.cn' },
  })
  const text = JSON.stringify(view)
  assert.equal(text.includes('tok-secret'), false)
  assert.equal(text.includes('ref-secret'), false)
  assert.equal(view.hasToken, true)
  assert.equal(view.hasRefreshToken, true)
  assert.equal(view.usable, true)
  assert.equal(view.expired, false)
})

test('describeAccount calls an expired token usable when the refresh token still works', () => {
  const now = 1_700_000_000_000
  const view = describeAccount({
    accountId: 'a1',
    account: { uid: 'u' },
    auth: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Math.floor((now - HOUR) / 1000),
      refreshExpiresAt: Math.floor((now + HOUR) / 1000),
    },
  }, now)
  assert.equal(view.expired, true)
  assert.equal(view.refreshExpired, false)
  // 过期的 access + 还有效的 refresh 仍然算"能用"——调用方会先刷新。
  assert.equal(view.usable, true)
})

test('describeAccount refuses to call a tokenless record usable', () => {
  const view = describeAccount({ accountId: 'a1', account: {}, auth: { refreshToken: 'ref' } }, Date.now())
  assert.equal(view.hasToken, false)
  assert.equal(view.usable, false)
})

test('createAccountStore requires a dir or a dataDir', () => {
  assert.throws(() => createAccountStore({}), /requires a dir or a dataDir/)
})

test('createAccountStore saves a credential with private permissions', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const saved = await store.save(credential())

  assert.match(saved.accountId, /^[0-9a-f]{24}$/)
  assert.equal(saved.nickname, '不等时间')
  assert.equal(saved.region, 'cn')
  assert.equal(saved.usable, true)
  // 落盘位置：<dir>/<region>/<accountId>.json，文件名不含 uid。
  const file = path.join(dir, 'cn', `${saved.accountId}.json`)
  const stat = await fs.stat(file)
  const record = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(record.version, 1)
  assert.equal(record.account.uid, 'uid-demo')
  assert.equal(record.auth.accessToken, 'tok-demo')
  assert.equal(typeof record.refreshedAtMs, 'number')
  assert.equal('file' in record, false)
  // Windows 上 mode 位不可靠，只在 POSIX 上断言"至少不是所有人可读"。
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0)
})

test('createAccountStore reuses the same file when the same uid signs in again', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const first = await store.save(credential({ accessToken: 'tok-old' }))
  const second = await store.save(credential({ accessToken: 'tok-new' }))
  assert.equal(second.accountId, first.accountId)
  const names = await fs.readdir(path.join(dir, 'cn'))
  assert.deepEqual(names, [`${first.accountId}.json`])
  const resolved = await store.resolve({})
  assert.equal(resolved.token, 'tok-new')
})

test('createAccountStore lists usable accounts first and hides expired ones by default', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential({ uid: 'uid-old', nickname: '旧', expiresAtMs: Date.now() - HOUR, refreshToken: '', refreshExpiresAtMs: 0 }))
  await store.save(credential({ uid: 'uid-new', nickname: '新', expiresAtMs: Date.now() + HOUR * 2 }))
  await store.save(credential({ uid: 'uid-global', nickname: '国际', region: 'global', domain: 'www.workbuddy.ai', expiresAtMs: Date.now() + HOUR }))

  const listed = await store.list()
  assert.deepEqual(listed.map(item => item.nickname), ['新', '国际'])
  // all() 含过期项：先按区域（cn 在 global 前），区域内按 expiresAt 倒序。
  const all = await store.all()
  assert.equal(all.length, 3)
  assert.deepEqual(all.map(item => item.nickname), ['新', '旧', '国际'])
})

test('createAccountStore resolves by region and prefers the latest expiry', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential({ uid: 'u1', accessToken: 'tok-soon', expiresAtMs: Date.now() + 60_000 }))
  await store.save(credential({ uid: 'u2', accessToken: 'tok-late', expiresAtMs: Date.now() + HOUR * 5 }))
  await store.save(credential({ uid: 'u3', accessToken: 'tok-global', region: 'global', domain: 'www.workbuddy.ai' }))

  const cn = await store.resolve({ region: 'cn' })
  assert.equal(cn.token, 'tok-late')
  assert.equal(cn.region, 'cn')
  assert.equal(cn.base, 'https://www.codebuddy.cn')

  const global = await store.resolve({ region: 'global' })
  assert.equal(global.token, 'tok-global')
  assert.equal(global.base, 'https://www.workbuddy.ai')

  const any = await store.resolve({})
  assert.equal(any.token, 'tok-late')
  assert.equal((await store.resolve({ region: 'nope' })), undefined)
})

test('createAccountStore can resolve an expired account only when asked', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential({ accessToken: 'tok-dead', expiresAtMs: Date.now() - HOUR, refreshToken: '', refreshExpiresAtMs: 0 }))
  assert.equal(await store.resolve({}), undefined)
  const forced = await store.resolve({ includeExpired: true })
  assert.equal(forced.token, 'tok-dead')
})

test('createAccountStore updates only the fields it is given', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const saved = await store.save(credential())
  await store.update(saved.accountId, { accessToken: 'tok-rotated', expiresAtMs: Date.now() + HOUR * 3 })
  const raw = await store.raw(saved.accountId)
  assert.equal(raw.auth.accessToken, 'tok-rotated')
  // 没给的字段必须原地保留，否则一次刷新就把 refresh token 抹掉了。
  assert.equal(raw.auth.refreshToken, 'ref-demo')
  assert.equal(raw.account.nickname, '不等时间')
  assert.equal(raw.auth.domain, 'www.codebuddy.cn')
})

test('createAccountStore refuses to update an unknown account', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await assert.rejects(() => store.update('missing', { accessToken: 'x' }), /account not found: missing/)
})

test('createAccountStore removes an account and reports whether it existed', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const saved = await store.save(credential())
  assert.equal(await store.remove(saved.accountId), true)
  assert.equal(await store.remove(saved.accountId), false)
  assert.deepEqual(await store.all(), [])
  // 移除后 resolve 不能还返回旧值（缓存必须失效）。
  assert.equal(await store.resolve({}), undefined)
})

test('createAccountStore reports a summary without filesystem details', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential({ uid: 'u1' }))
  await store.save(credential({ uid: 'u2', region: 'global', domain: 'www.workbuddy.ai' }))
  const summary = await store.summary()
  assert.equal(summary.count, 2)
  assert.equal(summary.usableCount, 2)
  assert.deepEqual(summary.regions, ['cn', 'global'])
  assert.equal(summary.dir, dir)
  assert.equal(JSON.stringify(summary).includes('tok-demo'), false)
})

test('createAccountStore skips dotfiles and unreadable records instead of failing', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await store.save(credential())
  await fs.writeFile(path.join(dir, 'cn', 'broken.json'), '{not json')
  await fs.writeFile(path.join(dir, 'cn', '.hidden.json'), JSON.stringify({ accountId: 'x', auth: { accessToken: 'tok' } }))
  const all = await store.all()
  assert.equal(all.length, 1)
})

test('createAccountStore serialises concurrent saves of the same uid', async () => {
  // 两个并发写同一账号：锁要保证最后落盘的是一条完整记录，不是两次 rename 交错。
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const results = await Promise.all([
    store.save(credential({ accessToken: 'tok-a' })),
    store.save(credential({ accessToken: 'tok-b' })),
    store.save(credential({ accessToken: 'tok-c' })),
  ])
  assert.equal(new Set(results.map(item => item.accountId)).size, 1)
  const raw = await store.raw(results[0].accountId)
  assert.equal(['tok-a', 'tok-b', 'tok-c'].includes(raw.auth.accessToken), true)
  const names = await fs.readdir(path.join(dir, 'cn'))
  assert.equal(names.filter(name => name.startsWith('.lock')).length, 0)
  assert.equal(names.filter(name => name.includes('.tmp-')).length, 0)
})

test('createAccountStore breaks a stale lock instead of hanging forever', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir, lockTimeoutMs: 400, lockStaleMs: 1 })
  const lockDir = path.join(dir, '.lock', 'cn-stale')
  await fs.mkdir(lockDir, { recursive: true })
  // 把锁目录的 mtime 推到很久以前，模拟上次进程崩在锁里。
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(lockDir, old, old)
  const saved = await store.save(credential())
  assert.equal(saved.usable, true)
})

test('createAccountStore fails loudly when a live lock never clears', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir, lockTimeoutMs: 120, lockStaleMs: 60_000 })
  // 锁名是 `<region>-<accountId>`，accountId 是 uid 的哈希——不是 uid 原文。
  const lockDir = path.join(dir, '.lock', `cn-${accountIdOf('uid-demo')}`)
  await fs.mkdir(lockDir, { recursive: true })
  await assert.rejects(() => store.save(credential()), /another account operation is still running/)
})

test('importFromVault copies a dsh-connect-workbuddy vault without touching it', async () => {
  const vault = await tempDir('legacy-vault-')
  await fs.mkdir(path.join(vault, 'cn'), { recursive: true })
  await fs.mkdir(path.join(vault, 'global'), { recursive: true })
  const cnFile = path.join(vault, 'cn', 'a.json')
  const cnBody = JSON.stringify({
    version: 1,
    accountId: 'account-1',
    account: { uid: 'uid-legacy', nickname: '旧账号', uin: '111' },
    auth: { accessToken: 'tok-legacy', refreshToken: 'ref-legacy', expiresAt: Math.floor((Date.now() + HOUR) / 1000), domain: 'www.workbuddy.cn' },
  })
  await fs.writeFile(cnFile, cnBody)
  await fs.writeFile(path.join(vault, 'global', 'b.json'), JSON.stringify({ account: {}, auth: {} }))

  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const outcome = await importFromVault({ vaultDir: vault, store })

  assert.equal(outcome.imported.length, 1)
  assert.equal(outcome.imported[0].nickname, '旧账号')
  assert.deepEqual(outcome.skipped.map(item => item.reason), ['no account.uid'])
  assert.deepEqual(outcome.errors, [])
  // 源文件必须一个字节都没变——那边还有它自己的锁与日志。
  assert.equal(await fs.readFile(cnFile, 'utf8'), cnBody)
  // 导入后就能从本插件的库解析出 token。
  const resolved = await store.resolve({})
  assert.equal(resolved.token, 'tok-legacy')
  assert.equal(resolved.nickname, '旧账号')
})

test('importFromVault records parse errors and keeps going', async () => {
  const vault = await tempDir('legacy-bad-')
  await fs.mkdir(path.join(vault, 'cn'), { recursive: true })
  await fs.writeFile(path.join(vault, 'cn', 'broken.json'), '{not json')
  await fs.writeFile(path.join(vault, 'cn', 'no-token.json'), JSON.stringify({ account: { uid: 'u' }, auth: {} }))
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const outcome = await importFromVault({ vaultDir: vault, store })
  assert.equal(outcome.imported.length, 0)
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0].error, /JSON/)
  assert.deepEqual(outcome.skipped.map(item => item.reason), ['no auth.accessToken'])
})

test('importFromVault tolerates a missing vault directory', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const outcome = await importFromVault({ vaultDir: path.join(dir, 'nope'), store })
  assert.deepEqual(outcome, { imported: [], skipped: [], errors: [] })
})

test('importFromVault validates its arguments', async () => {
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  await assert.rejects(() => importFromVault({ store }), /requires a vaultDir/)
  await assert.rejects(() => importFromVault({ vaultDir: dir }), /requires a store/)
})
