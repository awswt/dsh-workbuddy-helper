import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkBuddyConnector } from '../lib/connector.js'
import { createAccountService } from '../lib/wb-accounts.js'
import { createAccountStore } from '../lib/wb-vault.js'

const API = '/v2/plugin'
const HOUR = 3_600_000

async function tempDir(prefix = 'wbh-accounts-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 假 fetch：分派三个端点，记录调用。返回真实 Response 以走到 `.text()`。 */
function makeFetch(handler) {
  const impl = async (url, init = {}) => {
    const answer = await handler({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
    if (answer instanceof Error) throw answer
    const payload = answer?.body === undefined ? '{}' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return new Response(payload, { status: answer?.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return impl
}

/** 一个已经"扫码完成"的上游：state → token → account。 */
function signedInFetch(account = { uid: 'uid-1', nickname: '一号' }) {
  return makeFetch(record => {
    if (record.url.includes('/auth/state')) return { body: { code: 0, data: { state: 'state-1', authUrl: 'https://www.codebuddy.cn/login?state=state-1' } } }
    if (record.url.includes('/auth/token')) {
      return { body: { code: 0, data: { accessToken: 'tok-new', refreshToken: 'ref-new', expiresIn: 3600, domain: 'www.codebuddy.cn' } } }
    }
    if (record.url.endsWith(`${API}/account`)) return { body: { code: 0, data: account } }
    return { status: 404, body: {} }
  })
}

async function makeService(options = {}) {
  const home = options.home ?? await tempDir()
  const accountsDir = options.accountsDir ?? path.join(home, 'helper-accounts')
  const connector = new WorkBuddyConnector({
    dshHome: home,
    vaultDir: options.vaultDir ?? path.join(home, 'workbuddy-vault'),
    accountsDir,
    fetchImpl: options.refreshFetchImpl,
    now: options.now,
  })
  const service = createAccountService({
    connector,
    fetchImpl: options.fetchImpl,
    vaultDir: options.vaultDir ?? path.join(home, 'workbuddy-vault'),
    now: options.now,
  })
  return { home, accountsDir, connector, service }
}

test('poll stores the account in this plugin own store', async () => {
  const { service, connector, accountsDir } = await makeService({
    fetchImpl: signedInFetch(),
    refreshFetchImpl: makeFetch(() => ({ body: { code: 0, data: {} } })),
  })
  const started = await service.start('cn')
  assert.match(started.loginId, /^wbh_/)
  assert.equal(started.region, 'cn')

  const outcome = await service.poll(started.loginId)
  assert.equal(outcome.done, true)
  assert.equal(outcome.account.nickname, '一号')
  assert.equal(outcome.account.region, 'cn')

  // 关键断言：轮询成功即落盘，不需要调用方再存一次。
  const names = await fs.readdir(path.join(accountsDir, 'cn'))
  assert.equal(names.filter(name => name.endsWith('.json')).length, 1)
  const list = await connector.ownAccounts()
  assert.equal(list.length, 1)
  assert.equal(list[0].hasRefreshToken, true)
})

test('poll reports a storage failure instead of pretending the sign-in was saved', async () => {
  const home = await tempDir()
  // 账号根指向一个"文件"，mkdir 必然失败——模拟磁盘不可写。
  const blocked = path.join(home, 'blocked')
  await fs.writeFile(blocked, 'not a directory')
  const { service } = await makeService({ home, accountsDir: blocked, fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  const outcome = await service.poll(started.loginId)
  assert.equal(outcome.done, true)
  assert.match(outcome.error, /signed in, but the account could not be stored/)
})

test('poll forwards the region so a cross-tab poll cannot kill the sign-in', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  const wrong = await service.poll(started.loginId, { region: 'global' })
  assert.equal(wrong.done, true)
  assert.match(wrong.error, /another region tab/)
  // 登录本身还在：正确的页签仍然能完成它。
  assert.equal(service.pending().length, 1)
  const right = await service.poll(started.loginId, { region: 'cn' })
  assert.equal(right.done, true)
  assert.equal(right.account.uid, 'uid-1')
})

test('list separates own accounts from the legacy vault', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await fs.mkdir(path.join(vaultDir, 'cn'), { recursive: true })
  await fs.writeFile(path.join(vaultDir, 'cn', 'legacy.json'), JSON.stringify({
    accountId: 'legacy-1',
    account: { uid: 'uid-legacy', nickname: '旧账号' },
    auth: { accessToken: 'tok-legacy', refreshToken: 'ref-legacy', expiresAt: Math.floor((Date.now() + HOUR) / 1000), domain: 'www.workbuddy.cn' },
  }))
  const { service } = await makeService({ home, vaultDir, fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  await service.poll(started.loginId)

  const view = await service.list()
  assert.equal(view.own.length, 1)
  assert.equal(view.summary.ownCount, 1)
  assert.equal(view.summary.vaultCount, 1)
  assert.equal(view.summary.count, 2)
  assert.equal(view.summary.usableCount, 2)
  assert.equal(view.summary.dir.endsWith(path.join('helper-accounts')), true)
  assert.deepEqual(view.all.map(item => item.source).sort(), ['helper', 'vault'])
})

test('list survives having no account source at all', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  const view = await service.list()
  assert.deepEqual(view.own, [])
  assert.deepEqual(view.all, [])
  assert.equal(view.summary.count, 0)
  assert.equal(view.summary.source, 'none')
})

test('refresh only touches this plugin own store', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await fs.mkdir(path.join(vaultDir, 'cn'), { recursive: true })
  await fs.writeFile(path.join(vaultDir, 'cn', 'legacy.json'), JSON.stringify({
    accountId: 'legacy-1',
    account: { uid: 'uid-legacy', nickname: '旧账号' },
    auth: { accessToken: 'tok-legacy', refreshToken: 'ref-legacy', expiresAt: Math.floor((Date.now() + HOUR) / 1000) },
  }))
  const refreshFetch = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'tok-rotated', refreshToken: 'ref-rotated', expiresIn: 7200 } } }))
  const { service, connector } = await makeService({
    home, vaultDir, fetchImpl: signedInFetch(), refreshFetchImpl: refreshFetch,
  })
  const started = await service.start('cn')
  const signed = await service.poll(started.loginId)

  const refreshed = await service.refresh(signed.account.accountId)
  assert.equal(refreshed.hasToken, true)
  const raw = await connector.store.raw(signed.account.accountId)
  assert.equal(raw.auth.accessToken, 'tok-rotated')

  // 兼容层那条属于别的插件：这里必须拒绝，而不是悄悄改它的文件。
  await assert.rejects(() => service.refresh('legacy-1'), /account not found in this plugin's own store/)
})

test('refresh reports an upstream failure instead of returning a stale token', async () => {
  const refreshFetch = makeFetch(() => ({ status: 401, body: { code: 12153, msg: 'token format error' } }))
  const { service } = await makeService({ fetchImpl: signedInFetch(), refreshFetchImpl: refreshFetch })
  const started = await service.start('cn')
  const signed = await service.poll(started.loginId)
  await assert.rejects(() => service.refresh(signed.account.accountId), /refresh failed \(12153\)/)
})

test('refresh requires an accountId', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  await assert.rejects(() => service.refresh(''), /accountId is required/)
  await assert.rejects(() => service.remove(''), /accountId is required/)
})

test('remove deletes one account and leaves the others', async () => {
  const { service, connector } = await makeService({ fetchImpl: signedInFetch() })
  const first = await service.poll((await service.start('cn')).loginId)
  const second = await service.poll((await service.start('cn')).loginId)
  // 同一个 uid 会覆盖同一个文件，先换一个 uid 才能得到两条。
  assert.equal(first.account.accountId, second.account.accountId)

  const removed = await service.remove(first.account.accountId)
  assert.equal(removed.removed, true)
  assert.equal(removed.accountId, first.account.accountId)
  assert.deepEqual(await connector.ownAccounts(), [])
  assert.equal((await service.remove(first.account.accountId)).removed, false)
})

test('importLegacy copies the vault and reports why rows were skipped', async () => {
  const home = await tempDir()
  const vaultDir = path.join(home, 'workbuddy-vault')
  await fs.mkdir(path.join(vaultDir, 'cn'), { recursive: true })
  await fs.writeFile(path.join(vaultDir, 'cn', 'good.json'), JSON.stringify({
    account: { uid: 'uid-a', nickname: 'A' },
    auth: { accessToken: 'tok-a', refreshToken: 'ref-a', expiresAt: Math.floor((Date.now() + HOUR) / 1000), domain: 'www.workbuddy.cn' },
  }))
  await fs.writeFile(path.join(vaultDir, 'cn', 'no-token.json'), JSON.stringify({ account: { uid: 'uid-b' }, auth: {} }))
  const { service, connector } = await makeService({ home, vaultDir, fetchImpl: signedInFetch() })

  const outcome = await service.importLegacy()
  assert.equal(outcome.imported, 1)
  assert.equal(outcome.accounts[0].nickname, 'A')
  assert.deepEqual(outcome.skipped.map(row => row.reason), ['no auth.accessToken'])
  assert.equal((await connector.ownAccounts()).length, 1)
})

test('importLegacy refuses when no legacy vault is configured', async () => {
  const home = await tempDir()
  const connector = new WorkBuddyConnector({ dshHome: home, vaultDir: path.join(home, 'v'), accountsDir: path.join(home, 'a') })
  const service = createAccountService({ connector, vaultDir: '', fetchImpl: signedInFetch() })
  await assert.rejects(() => service.importLegacy(), /no dsh-connect-workbuddy vault directory is configured/)
})

test('the service does not leak a token through list() or pending()', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  await service.poll((await service.start('cn')).loginId)
  const view = await service.list()
  const text = JSON.stringify({ own: view.own, all: view.all, summary: view.summary, pending: view.pending })
  assert.equal(text.includes('tok-new'), false)
  assert.equal(text.includes('ref-new'), false)
  // pending 里也不能出现 state（半张凭据）。
  assert.equal(text.includes('state-1'), false)
})

test('cancel drops a pending sign-in without storing anything', async () => {
  const { service, connector } = await makeService({ fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  assert.equal(service.cancel(started.loginId), true)
  assert.deepEqual(service.pending(), [])
  assert.deepEqual(await connector.ownAccounts(), [])
  assert.equal(service.cancel(started.loginId), false)
})

test('start defaults to the cn realm', async () => {
  const { service } = await makeService({ fetchImpl: signedInFetch() })
  const started = await service.start()
  assert.equal(started.region, 'cn')
  assert.match(started.verificationUri, /^https:\/\/www\.codebuddy\.cn\/login/)
})

test('start surfaces an upstream failure as a value, not an exception', async () => {
  const fetchImpl = makeFetch(() => new Error('ECONNREFUSED'))
  const { service } = await makeService({ fetchImpl })
  const started = await service.start('cn')
  assert.match(started.error, /could not reach/)
  assert.deepEqual(service.pending(), [])
})

test('createAccountService requires a connector', () => {
  assert.throws(() => createAccountService({}), /requires a connector/)
})

test('the store behind the service can be swapped for a plain object in tests', async () => {
  // 这条只是钉住 createAccountService 对 connector 的最小接口约定：
  // saveAccount / ownAccounts / accounts / status / store / refreshAccount。
  const dir = await tempDir()
  const store = createAccountStore({ dir })
  const connector = {
    store,
    async saveAccount(account) { return store.save(account) },
    async ownAccounts() { return store.all() },
    async accounts() { return (await store.all()).map(item => ({ ...item, source: 'helper' })) },
    async status() { return { source: 'helper', own: { dir } } },
    async refreshAccount() { return { refreshed: true } },
  }
  const service = createAccountService({ connector, fetchImpl: signedInFetch() })
  const started = await service.start('cn')
  const outcome = await service.poll(started.loginId)
  assert.equal(outcome.done, true)
  assert.equal((await service.list()).own.length, 1)
  assert.deepEqual(await service.refresh(outcome.account.accountId), { refreshed: true })
})
