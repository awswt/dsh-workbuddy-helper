import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkBuddyConnector } from '../lib/connector.js'

const API = '/v2/plugin'
const HOUR = 3_600_000

async function tempDir(prefix = 'wbh-layer-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const record = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} }
    calls.push(record)
    const answer = await handler(record)
    if (answer instanceof Error) throw answer
    const payload = typeof answer?.body === 'string' ? answer.body : JSON.stringify(answer?.body ?? {})
    return new Response(payload, { status: answer?.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

/** 造一份 dsh-connect-workbuddy 风格的 vault 文件。 */
async function writeVault(vaultDir, region, name, overrides = {}) {
  const dir = path.join(vaultDir, region)
  await fs.mkdir(dir, { recursive: true })
  const record = {
    version: 1,
    accountId: overrides.accountId ?? `${region}-legacy`,
    account: { uid: overrides.uid ?? `uid-${region}`, nickname: overrides.nickname ?? `${region} 旧账号`, uin: '123' },
    auth: {
      accessToken: overrides.accessToken ?? `tok-${region}`,
      refreshToken: overrides.refreshToken ?? '',
      expiresAt: overrides.expiresAt ?? Math.floor((Date.now() + HOUR) / 1000),
      domain: overrides.domain ?? (region === 'global' ? 'www.workbuddy.ai' : 'www.workbuddy.cn'),
    },
  }
  const file = path.join(dir, name)
  await fs.writeFile(file, JSON.stringify(record))
  return { file, record }
}

test('the plugin own store wins over a legacy vault token', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await writeVault(vaultDir, 'cn', 'old.json', { accessToken: 'tok-legacy', expiresAt: Math.floor((Date.now() + HOUR * 5) / 1000) })

  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })
  await connector.saveAccount({
    uid: 'uid-own',
    nickname: '自己的',
    region: 'cn',
    accessToken: 'tok-own',
    refreshToken: 'ref-own',
    // 自己的这张反而更早过期——仍然要优先：它才是我们能刷新的那份。
    expiresAtMs: Date.now() + 60_000,
    domain: 'www.codebuddy.cn',
  })

  const hit = await connector.resolveToken({})
  assert.equal(hit.token, 'tok-own')
  assert.equal(hit.source, 'helper')
  assert.equal(hit.nickname, '自己的')
})

test('the vault is still read when the own store is empty', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await writeVault(vaultDir, 'cn', 'old.json', { accessToken: 'tok-legacy' })
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })
  const hit = await connector.resolveToken({})
  assert.equal(hit.token, 'tok-legacy')
  assert.equal(hit.source, 'vault')
  assert.equal(hit.accountId, 'cn-legacy')
})

test('resolveToken filters by region and reports nothing when the region has no account', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await writeVault(vaultDir, 'cn', 'cn.json', { accessToken: 'tok-cn' })
  await writeVault(vaultDir, 'global', 'global.json', { accessToken: 'tok-global' })
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })

  assert.equal((await connector.resolveToken({ region: 'cn' })).token, 'tok-cn')
  assert.equal((await connector.resolveToken({ region: 'global' })).token, 'tok-global')
  assert.equal(await connector.resolveToken({ region: 'nope' }), undefined)
})

test('accounts() labels every row with its source', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await writeVault(vaultDir, 'cn', 'old.json')
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })
  await connector.saveAccount({ uid: 'uid-own', accessToken: 'tok-own', refreshToken: 'ref', region: 'cn', expiresAtMs: Date.now() + HOUR })

  const rows = await connector.accounts()
  assert.deepEqual(rows.map(row => row.source).sort(), ['helper', 'vault'])
  // 面板靠 hasRefreshToken 决定是否给「刷新」按钮。
  assert.equal(rows.find(row => row.source === 'helper').hasRefreshToken, true)
  assert.equal(rows.find(row => row.source === 'vault').hasRefreshToken, false)
})

test('resolveFreshToken refreshes an own account that is about to expire', async () => {
  const home = await tempDir()
  const refreshFetch = makeFetch(() => ({
    body: { code: 0, data: { accessToken: 'tok-rotated', refreshToken: 'ref-rotated', expiresIn: 3600 } },
  }))
  const connector = new WorkBuddyConnector({
    dshHome: home,
    vaultDir: path.join(home, 'vault'),
    accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch,
    refreshSkewMs: 120_000,
  })
  const saved = await connector.saveAccount({
    uid: 'uid-own', accessToken: 'tok-stale', refreshToken: 'ref-own', region: 'cn',
    expiresAtMs: Date.now() + 30_000, domain: 'www.codebuddy.cn',
  })

  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.refreshed, true)
  assert.equal(hit.token, 'tok-rotated')
  // 刷新的结果必须写回库，否则下一个进程又拿到旧票。
  const raw = await connector.store.raw(saved.accountId)
  assert.equal(raw.auth.accessToken, 'tok-rotated')
  assert.equal(raw.auth.refreshToken, 'ref-rotated')
})

test('resolveFreshToken leaves a healthy token alone', async () => {
  const refreshFetch = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'never' } } }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own'), fetchImpl: refreshFetch,
  })
  await connector.saveAccount({
    uid: 'uid-own', accessToken: 'tok-good', refreshToken: 'ref', region: 'cn',
    expiresAtMs: Date.now() + HOUR, domain: 'www.codebuddy.cn',
  })
  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.refreshed, false)
  assert.equal(hit.token, 'tok-good')
  assert.equal(refreshFetch.calls.length, 0)
})

test('resolveFreshToken keeps a still-valid token when the refresh fails', async () => {
  const refreshFetch = makeFetch(() => ({ status: 401, body: { code: 12153, msg: 'token format error' } }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch, refreshSkewMs: 120_000,
  })
  await connector.saveAccount({
    uid: 'uid-own', accessToken: 'tok-alive', refreshToken: 'ref', region: 'cn',
    expiresAtMs: Date.now() + 60_000, domain: 'www.codebuddy.cn',
  })
  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.refreshed, false)
  assert.equal(hit.token, 'tok-alive')
  assert.match(hit.refreshError, /refresh failed \(12153\)/)
})

test('resolveFreshToken throws when the token is dead and cannot be refreshed', async () => {
  const refreshFetch = makeFetch(() => ({ status: 401, body: { code: 12153, msg: 'nope' } }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch, refreshSkewMs: 120_000,
  })
  await connector.saveAccount({
    uid: 'uid-own', accessToken: 'tok-dead', refreshToken: 'ref', region: 'cn',
    expiresAtMs: Date.now() - 60_000, refreshExpiresAtMs: Date.now() + HOUR, domain: 'www.codebuddy.cn',
  })
  await assert.rejects(() => connector.resolveFreshToken({}), /could not be refreshed/)
})

test('resolveFreshToken never tries to refresh a vault account', async () => {
  const refreshFetch = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'never' } } }))
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  // 那边的 access 快过期，但它还有 refresh token——我们仍然不能刷（那是别人的文件）。
  await writeVault(vaultDir, 'cn', 'old.json', {
    accessToken: 'tok-legacy',
    refreshToken: 'ref-legacy',
    expiresAt: Math.floor((Date.now() + 30_000) / 1000),
  })
  const connector = new WorkBuddyConnector({
    dshHome: home, vaultDir, accountsDir: path.join(home, 'own'),
    fetchImpl: refreshFetch, refreshSkewMs: 120_000,
  })
  const hit = await connector.resolveFreshToken({})
  assert.equal(hit.source, 'vault')
  assert.equal(hit.token, 'tok-legacy')
  assert.equal(refreshFetch.calls.length, 0)
})

test('refreshAccount rotates an own credential on demand and rejects an unknown id', async () => {
  const refreshFetch = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'tok-manual', refreshToken: 'ref-manual', expiresIn: 7200 } } }))
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own'), fetchImpl: refreshFetch,
  })
  const saved = await connector.saveAccount({
    uid: 'uid-own', accessToken: 'tok-start', refreshToken: 'ref-start', region: 'cn',
    expiresAtMs: Date.now() + HOUR, domain: 'www.codebuddy.cn',
  })
  const rotated = await connector.refreshAccount(saved.accountId)
  assert.equal(rotated.hasToken, true)
  assert.equal((await connector.store.raw(saved.accountId)).auth.accessToken, 'tok-manual')

  await assert.rejects(() => connector.refreshAccount('nope'), /account not found: nope/)
})

test('refreshAccount refuses an account that has no refresh token', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({
    dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own'),
    fetchImpl: makeFetch(() => ({ body: {} })),
  })
  const saved = await connector.saveAccount({
    uid: 'uid-own', accessToken: 'tok', refreshToken: '', region: 'cn', expiresAtMs: Date.now() + HOUR,
  })
  await assert.rejects(() => connector.refreshAccount(saved.accountId), /no refresh token; sign in again/)
})

test('status keeps the legacy shape and adds the source split', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await writeVault(vaultDir, 'cn', 'old.json')
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })
  await connector.saveAccount({
    uid: 'uid-own', nickname: '自己的', accessToken: 'tok-own', refreshToken: 'ref', region: 'cn',
    expiresAtMs: Date.now() + HOUR, domain: 'www.codebuddy.cn',
  })

  const status = await connector.status()
  // 0.6.x 的调用方还在读这几个键，别删。
  assert.equal(status.connector, 'dsh-connect-workbuddy')
  assert.equal(status.accountCount, 2)
  assert.equal(status.usableAccountCount, 2)
  assert.equal(status.tokenAvailable, true)
  // 新增的：token 从哪来 + 自有库的规模。
  assert.equal(status.source, 'helper')
  assert.equal(status.own.count, 1)
  assert.equal(status.own.usableCount, 1)
  assert.equal(status.accounts.length, 2)
  // 模型能看到的这份摘要里不能有明文 token。
  assert.equal(JSON.stringify(status).includes('tok-own'), false)
  assert.equal(JSON.stringify(status).includes('tok-cn'), false)
})

test('status reports source none when nothing is signed in', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own') })
  const status = await connector.status()
  assert.equal(status.source, 'none')
  assert.equal(status.tokenAvailable, false)
  assert.equal(status.accountCount, 0)
})

test('detectInstalled still looks for dsh-connect-workbuddy in sibling profiles', async () => {
  const home = await tempDir()
  const profileDir = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-connect-workbuddy')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-connect-workbuddy', version: '9.9.9' }))
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir: path.join(home, 'vault'), accountsDir: path.join(home, 'own') })
  const installed = await connector.detectInstalled()
  assert.equal(installed.profile, 'desktop')
  assert.equal(installed.version, '9.9.9')
  assert.equal((await connector.status()).installed, true)
})

test('a malformed vault file is ignored instead of breaking resolveToken', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await fs.mkdir(path.join(vaultDir, 'cn'), { recursive: true })
  await fs.writeFile(path.join(vaultDir, 'cn', 'broken.json'), '{not json')
  await writeVault(vaultDir, 'cn', 'good.json', { accessToken: 'tok-good' })
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })
  const hit = await connector.resolveToken({})
  assert.equal(hit.token, 'tok-good')
})

test('the vault root fallback still reads a pre-region layout', async () => {
  // 旧版本把 json 直接放在 vault 根；`listAccountFiles()` 只在两个子目录都空时回退。
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await fs.mkdir(vaultDir, { recursive: true })
  await fs.writeFile(path.join(vaultDir, 'flat.json'), JSON.stringify({
    accountId: 'flat-1',
    account: { uid: 'uid-flat', nickname: '扁平' },
    auth: { accessToken: 'tok-flat', expiresAt: Math.floor((Date.now() + HOUR) / 1000) },
  }))
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir, accountsDir: path.join(home, 'own') })
  const rows = await connector.listAccounts()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].region, 'legacy')
  assert.equal((await connector.resolveToken({})).token, 'tok-flat')
})
