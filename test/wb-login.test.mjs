import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REGIONS,
  WB_CLIENT_UA,
  baseForRegion,
  collectAccount,
  createLoginStore,
  decodeJwtIdentity,
  expiryMs,
  firstString,
  pollLogin,
  refreshCredential,
  regionOfDomain,
  startLogin,
} from '../lib/wb-login.js'

const API = '/v2/plugin'

/** base64url 的 JWT 形状 token；签名段是假的——本模块只解载荷做身份展示。 */
function jwtToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.not-a-real-signature`
}

/**
 * 假 fetch：按 URL 分派固定答复，并把每次调用的入参记下来。
 * 返回真实的 `Response`，这样 `readEnvelope()` 的 `.text()` 路径也真的跑到。
 */
function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const record = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body }
    calls.push(record)
    const answer = await handler(record)
    if (answer instanceof Error) throw answer
    const status = answer?.status ?? 200
    const payload = answer?.body === undefined ? '{}' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

test('regionOfDomain routes both global brands to global and everything else to cn', () => {
  assert.equal(regionOfDomain('www.workbuddy.ai'), 'global')
  assert.equal(regionOfDomain('workbuddy.ai'), 'global')
  assert.equal(regionOfDomain('www.codebuddy.ai'), 'global')
  assert.equal(regionOfDomain('WWW.WORKBUDDY.AI'), 'global')
  assert.equal(regionOfDomain('www.codebuddy.cn'), 'cn')
  assert.equal(regionOfDomain('www.workbuddy.cn'), 'cn')
  assert.equal(regionOfDomain(''), 'cn')
  assert.equal(regionOfDomain(undefined), 'cn')
})

test('baseForRegion only accepts https hosts from the region allow-list', () => {
  assert.equal(baseForRegion('cn'), 'https://www.codebuddy.cn')
  assert.equal(baseForRegion('global'), 'https://www.workbuddy.ai')
  assert.equal(baseForRegion('cn', 'https://www.codebuddy.cn/'), 'https://www.codebuddy.cn')
  // 国际版两个品牌域名各自签发，都必须在白名单里。
  assert.equal(baseForRegion('global', 'https://www.codebuddy.ai'), 'https://www.codebuddy.ai')
  // 未知 region 落到国内版默认值，而不是抛错或拼出一个空 base。
  assert.equal(baseForRegion('nope'), 'https://www.codebuddy.cn')

  assert.throws(() => baseForRegion('cn', 'http://www.codebuddy.cn'), /HTTPS is required/)
  assert.throws(() => baseForRegion('cn', 'https://evil.example'), /is not a WorkBuddy 国内版 host/)
  // 跨区域：国内版 base 不能当国际版的起点。
  assert.throws(() => baseForRegion('cn', 'https://www.workbuddy.ai'), /is not a WorkBuddy 国内版 host/)
  assert.throws(() => baseForRegion('cn', 'not a url'), /not a URL/)
})

test('firstString accepts numbers and skips empty candidates', () => {
  assert.equal(firstString({ a: '', b: 'second' }, ['a', 'b']), 'second')
  assert.equal(firstString({ uin: 12345 }, ['uin']), '12345')
  assert.equal(firstString({ a: '   ' }, ['a']), '')
  assert.equal(firstString(null, ['a']), '')
  assert.equal(firstString({ a: 0 }, ['a']), '0')
})

test('expiryMs normalises seconds, milliseconds and TTLs', () => {
  const now = 1_700_000_000_000
  // 1e12 是秒/毫秒的分界：2023 年的秒级时间戳是 1.7e9，乘 1000 才对。
  assert.equal(expiryMs({ expiresAt: 1_700_000_000 }, ['expiresAt'], [], now), 1_700_000_000_000)
  assert.equal(expiryMs({ expiresAt: 1_700_000_000_500 }, ['expiresAt'], [], now), 1_700_000_000_500)
  assert.equal(expiryMs({ expiresIn: 3600 }, ['expiresAt'], ['expiresIn'], now), now + 3_600_000)
  assert.equal(expiryMs({}, ['expiresAt'], ['expiresIn'], now), undefined)
  assert.equal(expiryMs({ expiresAt: 0 }, ['expiresAt'], [], now), undefined)
  assert.equal(expiryMs({ expiresAt: '1700000000' }, ['expiresAt'], [], now), 1_700_000_000_000)
})

test('decodeJwtIdentity reads the payload but never claims to verify it', () => {
  const token = jwtToken({ sub: 'uid-1', nickname: '不等时间', uin: 987654321 })
  const identity = decodeJwtIdentity(token)
  assert.equal(identity.sub, 'uid-1')
  assert.equal(identity.nickname, '不等时间')
  assert.equal(identity.uin, '987654321')
  assert.deepEqual(decodeJwtIdentity('not-a-jwt'), { sub: '', nickname: '', uin: '', preferredUsername: '' })
  assert.deepEqual(decodeJwtIdentity(undefined), { sub: '', nickname: '', uin: '', preferredUsername: '' })
  // 载荷不是 JSON 时不能抛：这条路径只用来补展示字段。
  assert.deepEqual(decodeJwtIdentity('a.!!!.c'), { sub: '', nickname: '', uin: '', preferredUsername: '' })
})

test('collectAccount prefers /account and forwards the token domain', async () => {
  const fetchImpl = makeFetch(record => {
    if (record.url === `https://www.codebuddy.cn${API}/account`) {
      return { body: { code: 0, data: { uid: 'uid-1', nickname: '不等时间', uin: '123', avatarUrl: 'https://cdn/x.png' } } }
    }
    return { status: 404, body: { code: 404 } }
  })
  const account = await collectAccount({
    base: 'https://www.codebuddy.cn',
    accessToken: 'tok-1',
    tokenData: { domain: 'www.workbuddy.cn', expiresIn: 3600, refreshToken: 'ref-1' },
    fetchImpl,
    now: 1_700_000_000_000,
  })
  assert.equal(account.uid, 'uid-1')
  assert.equal(account.nickname, '不等时间')
  assert.equal(account.accessToken, 'tok-1')
  assert.equal(account.refreshToken, 'ref-1')
  assert.equal(account.expiresAtMs, 1_700_000_000_000 + 3_600_000)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer tok-1')
  assert.equal(fetchImpl.calls[0].headers['X-Domain'], 'www.workbuddy.cn')
  assert.equal(fetchImpl.calls[0].headers['User-Agent'], WB_CLIENT_UA)
})

test('collectAccount falls back to /login/account when the new endpoint answers empty', async () => {
  // 实测结果：/v2/plugin/account 有时对有效 token 回空 data，旧端点才给身份。
  const fetchImpl = makeFetch(record => {
    if (record.url.endsWith(`${API}/account`)) return { body: { code: 0, data: {} } }
    if (record.url.endsWith(`${API}/login/account`)) return { body: { code: 0, data: { uid: 'uid-2', nickname: '二号' } } }
    return { status: 404, body: {} }
  })
  const account = await collectAccount({ base: 'https://www.codebuddy.cn', accessToken: 'tok-2', fetchImpl })
  assert.equal(account.uid, 'uid-2')
  assert.equal(account.nickname, '二号')
  assert.deepEqual(fetchImpl.calls.map(call => new URL(call.url).pathname), [`${API}/account`, `${API}/login/account`])
})

test('collectAccount reads the uid out of the token when both endpoints answer empty', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: {} } }))
  const account = await collectAccount({
    base: 'https://www.codebuddy.cn',
    accessToken: jwtToken({ sub: 'uid-from-jwt', preferred_username: 'jwt-name' }),
    fetchImpl,
  })
  assert.equal(account.uid, 'uid-from-jwt')
  // preferred_username 只是最后一级回退，不该压过 nickname。
  assert.equal(account.nickname, 'jwt-name')
})

test('collectAccount refuses to invent a uid', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: {} } }))
  await assert.rejects(
    () => collectAccount({ base: 'https://www.codebuddy.cn', accessToken: jwtToken({}), fetchImpl }),
    /无法识别这个账号/,
  )
})

test('startLogin returns the upstream verification URL and the region it belongs to', async () => {
  const fetchImpl = makeFetch(() => ({
    body: { code: 0, data: { state: 'state-abc', authUrl: 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-abc' } },
  }))
  const started = await startLogin('cn', { fetchImpl })
  assert.equal(started.state, 'state-abc')
  assert.equal(started.verificationUri, 'https://www.codebuddy.cn/login?platform=workbuddy&state=state-abc')
  assert.equal(started.region, 'cn')
  assert.equal(started.base, 'https://www.codebuddy.cn')
  assert.equal(started.expiresIn, 600)
  assert.equal(fetchImpl.calls[0].method, 'POST')
  assert.equal(fetchImpl.calls[0].url, `https://www.codebuddy.cn${API}/auth/state?platform=workbuddy`)
})

test('startLogin synthesises the login URL when the upstream omits authUrl', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { state: 'state xyz' } } }))
  const started = await startLogin('global', { fetchImpl })
  assert.equal(started.region, 'global')
  // state 必须被编码：里面可能出现空格与 & 之类的字符。
  assert.equal(started.verificationUri, 'https://www.workbuddy.ai/login?platform=workbuddy&state=state%20xyz')
})

test('startLogin reports a reachability failure instead of throwing', async () => {
  const fetchImpl = makeFetch(() => new Error('ECONNREFUSED'))
  const started = await startLogin('cn', { fetchImpl })
  assert.match(started.error, /could not reach https:\/\/www\.codebuddy\.cn/)
  assert.match(started.error, /ECONNREFUSED/)
})

test('startLogin refuses a base outside the region allow-list', async () => {
  const started = await startLogin('cn', { fetchImpl: makeFetch(() => ({ body: {} })), base: 'https://evil.example' })
  assert.match(started.error, /is not a WorkBuddy 国内版 host/)
})

test('startLogin reports a non-JSON answer without pretending it has a state', async () => {
  const fetchImpl = makeFetch(() => ({ body: '<html>gateway</html>' }))
  const started = await startLogin('cn', { fetchImpl })
  assert.match(started.error, /non-JSON body/)
})

test('pollLogin gives up before any request when the session already expired', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: {} } }))
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://www.codebuddy.cn', state: 's', expiresAtMs: 1_000 },
    { fetchImpl, now: 2_000 },
  )
  assert.deepEqual(outcome, { done: true, error: 'the sign-in timed out; start again' })
  assert.equal(fetchImpl.calls.length, 0)
})

test('pollLogin treats 11217 as "still waiting" rather than a failure', async () => {
  // 上游对"还没扫码"和"state 不认识"都回 11217，所以它只能是 pending。
  const fetchImpl = makeFetch(() => ({ body: { code: 11217, msg: 'login ing...' } }))
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://www.codebuddy.cn', state: 's', expiresAtMs: Date.now() + 60_000 },
    { fetchImpl },
  )
  assert.equal(outcome.done, false)
  assert.equal(outcome.pending, true)
  assert.equal(outcome.code, 11217)
  assert.equal(fetchImpl.calls[0].url, `https://www.codebuddy.cn${API}/auth/token?state=s`)
})

test('pollLogin ends the attempt on a terminal code', async () => {
  const fetchImpl = makeFetch(() => ({ status: 401, body: { code: 12153, msg: '12153:refresh token failed' } }))
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://www.codebuddy.cn', state: 's', expiresAtMs: Date.now() + 60_000 },
    { fetchImpl },
  )
  assert.equal(outcome.done, true)
  assert.match(outcome.error, /12153/)
})

test('pollLogin collects the account once a token arrives', async () => {
  const fetchImpl = makeFetch(record => {
    if (record.url.includes('/auth/token')) {
      return { body: { code: 0, data: { accessToken: 'tok-9', refreshToken: 'ref-9', expiresIn: 7200, domain: 'www.codebuddy.cn' } } }
    }
    if (record.url.endsWith(`${API}/account`)) return { body: { code: 0, data: { uid: 'uid-9', nickname: '九号' } } }
    return { status: 404, body: {} }
  })
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://www.codebuddy.cn', state: 's', expiresAtMs: Date.now() + 60_000 },
    { fetchImpl, now: 1_700_000_000_000 },
  )
  assert.equal(outcome.done, true)
  assert.equal(outcome.account.uid, 'uid-9')
  assert.equal(outcome.account.accessToken, 'tok-9')
  assert.equal(outcome.account.refreshToken, 'ref-9')
  assert.equal(outcome.account.expiresAtMs, 1_700_000_000_000 + 7_200_000)
})

test('pollLogin stays pending when the code is ok but no token is there yet', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { stage: 'scanning' } } }))
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://www.codebuddy.cn', state: 's', expiresAtMs: Date.now() + 60_000 },
    { fetchImpl },
  )
  assert.equal(outcome.done, false)
  assert.equal(outcome.pending, true)
})

test('pollLogin survives a transport error by staying pending', async () => {
  const fetchImpl = makeFetch(() => new Error('socket hang up'))
  const outcome = await pollLogin(
    { region: 'cn', base: 'https://www.codebuddy.cn', state: 's', expiresAtMs: Date.now() + 60_000 },
    { fetchImpl },
  )
  assert.deepEqual(outcome, { done: false, pending: true })
})

test('refreshCredential sends the refresh token in its own header, never Authorization', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'tok-new', refreshToken: 'ref-new', expiresIn: 3600 } } }))
  const next = await refreshCredential({
    credential: { refreshToken: 'ref-old', domain: 'www.codebuddy.cn' },
    fetchImpl,
    now: 1_700_000_000_000,
  })
  assert.equal(next.accessToken, 'tok-new')
  assert.equal(next.refreshToken, 'ref-new')
  assert.equal(next.expiresAtMs, 1_700_000_000_000 + 3_600_000)

  const call = fetchImpl.calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, `https://www.codebuddy.cn${API}/auth/token/refresh`)
  assert.equal(call.headers['X-Refresh-Token'], 'ref-old')
  assert.equal(call.headers['X-Auth-Refresh-Source'], 'workbuddy')
  assert.equal(call.headers.Origin, 'https://www.codebuddy.cn')
  assert.equal(call.headers.Referer, 'https://www.codebuddy.cn/')
  // 刷新只需要 refresh token；同时递旧 access token 会让"失败=掉登录"更难排查。
  assert.equal(call.headers.Authorization, undefined)
  assert.equal(call.headers['X-Enterprise-Id'], undefined)
})

test('refreshCredential keeps the old refresh token when the answer omits one', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'tok-2' } } }))
  const next = await refreshCredential({ credential: { refreshToken: 'ref-keep', domain: 'www.codebuddy.cn' }, fetchImpl })
  assert.equal(next.refreshToken, 'ref-keep')
  assert.equal(next.domain, 'www.codebuddy.cn')
})

test('refreshCredential targets the global host for a global account', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { accessToken: 'tok-g' } } }))
  await refreshCredential({
    credential: { refreshToken: 'ref-g', domain: 'www.workbuddy.ai', enterpriseId: 'ent-1' },
    fetchImpl,
  })
  assert.equal(fetchImpl.calls[0].url, `https://www.workbuddy.ai${API}/auth/token/refresh`)
  assert.equal(fetchImpl.calls[0].headers['X-Enterprise-Id'], 'ent-1')
})

test('refreshCredential fails loudly instead of returning a stale token', async () => {
  await assert.rejects(
    () => refreshCredential({ credential: { domain: 'www.codebuddy.cn' }, fetchImpl: makeFetch(() => ({ body: {} })) }),
    /no refresh token/,
  )
  await assert.rejects(
    () => refreshCredential({
      credential: { refreshToken: 'ref', domain: 'www.codebuddy.cn' },
      fetchImpl: makeFetch(() => ({ status: 401, body: { code: 12153, msg: 'token format error' } })),
    }),
    /refresh failed \(12153\): token format error/,
  )
  await assert.rejects(
    () => refreshCredential({
      credential: { refreshToken: 'ref', domain: 'www.codebuddy.cn' },
      fetchImpl: makeFetch(() => ({ body: { code: 0, data: {} } })),
    }),
    /returned no accessToken/,
  )
})

test('createLoginStore keeps sessions in memory and hides the state', async () => {
  const store = createLoginStore({ ttlMs: 60_000 })
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { state: 'state-1', authUrl: 'https://www.codebuddy.cn/login?state=state-1' } } }))
  const started = await store.start('cn', { fetchImpl })
  assert.match(started.loginId, /^wbh_[0-9a-f]{32}$/)
  assert.equal(store.size, 1)

  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].loginId, started.loginId)
  // state 是半张凭据：对外视图里不能出现。
  assert.equal('state' in listed[0], false)

  assert.equal(store.cancel(started.loginId), true)
  assert.equal(store.size, 0)
  assert.equal(store.cancel(started.loginId), false)
})

test('createLoginStore refuses to poll a session from another region tab', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { state: 's' } } }))
  const store = createLoginStore({})
  const started = await store.start('cn', { fetchImpl })
  const outcome = await store.poll(started.loginId, { region: 'global', fetchImpl })
  assert.deepEqual(outcome, { done: true, error: 'this sign-in started in another region tab' })
  // 一次来自别的页签的误轮询不该杀掉这次登录：正确的页签还要继续等。
  assert.equal(store.size, 1)
  assert.equal(fetchImpl.calls.length, 1)
})

test('createLoginStore reports an unknown login id without calling upstream', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: {} } }))
  const store = createLoginStore({})
  const outcome = await store.poll('wbh_missing', { fetchImpl })
  assert.deepEqual(outcome, { done: true, error: 'sign-in session not found; start a new one' })
  assert.equal(fetchImpl.calls.length, 0)
})

test('createLoginStore drops a session as soon as polling finishes it', async () => {
  const fetchImpl = makeFetch(record => {
    if (record.url.includes('/auth/state')) return { body: { code: 0, data: { state: 's' } } }
    if (record.url.includes('/auth/token')) return { body: { code: 0, data: { accessToken: 'tok', domain: 'www.codebuddy.cn' } } }
    return { body: { code: 0, data: { uid: 'uid-1' } } }
  })
  const store = createLoginStore({})
  const started = await store.start('cn', { fetchImpl })
  const outcome = await store.poll(started.loginId, { fetchImpl })
  assert.equal(outcome.done, true)
  assert.equal(outcome.account.uid, 'uid-1')
  assert.equal(store.size, 0)
})

test('createLoginStore prunes sessions past their TTL', async () => {
  const fetchImpl = makeFetch(() => ({ body: { code: 0, data: { state: 's' } } }))
  let clock = 1_000_000
  const store = createLoginStore({ ttlMs: 5_000 })
  const started = await store.start('cn', { fetchImpl, now: clock })
  assert.equal(store.size, 1)
  clock += 10_000
  assert.deepEqual(store.list(clock), [])
  const outcome = await store.poll(started.loginId, { fetchImpl, now: clock })
  assert.deepEqual(outcome, { done: true, error: 'sign-in session not found; start a new one' })
})

test('the region table stays the single source of truth for hosts', () => {
  assert.deepEqual(Object.keys(REGIONS).sort(), ['cn', 'global'])
  assert.deepEqual(REGIONS.cn.hosts, ['www.codebuddy.cn'])
  assert.deepEqual(REGIONS.global.hosts, ['www.workbuddy.ai', 'www.codebuddy.ai'])
})
