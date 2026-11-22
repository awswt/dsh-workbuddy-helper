import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { registerWebUi } from '../lib/webui.js'

function makeHarness(options = {}) {
  const routes = new Map()
  const calls = []
  const sessions = {
    async panelState(sessionId) {
      return {
        sessionId,
        applied: true,
        expert: {
          id: 'ex_demo',
          displayName: '演示专家',
          profession: '演示工程师',
          plugin: 'demo-plugin',
        },
        skills: { globalMode: 'selected', globalNames: ['xlsx'], expertNames: ['demo-skill'] },
        globalSkills: [
          { name: 'xlsx', description: 'Spreadsheet', enabled: true },
          { name: 'docx', description: 'Document', enabled: false },
        ],
        expertSkills: [{ name: 'demo-skill', description: 'Demo', enabled: true }],
      }
    },
    async selectExpert(sessionId, expertId) {
      calls.push(['select', sessionId, expertId])
    },
    async setSkills(sessionId, patch) {
      calls.push(['skills', sessionId, patch])
    },
    async clear(sessionId) {
      calls.push(['clear', sessionId])
    },
  }
  const market = {
    async listExperts(options) {
      calls.push(['list', options])
      return {
        source: 'portal',
        total: 10000,
        stale: false,
        items: [{
          id: 'ex_demo',
          plugin: 'demo-plugin',
          displayName: '演示专家',
          profession: '演示工程师',
          source: 'portal',
        }],
      }
    },
    async categories() {
      return [{ id: 'eng', name: '技术工程', count: 0 }]
    },
    async marketSize() {
      return 10000
    },
  }
  const bundles = {
    async listLocal() {
      return [{
        id: 'local-demo',
        plugin: 'local-demo',
        displayName: '本地专家',
        profession: '本地工程师',
        categoryId: 'eng',
      }]
    },
  }
  const connector = {
    async status() {
      return { installed: true, accountCount: 3, usableAccountCount: 3 }
    },
  }
  const portal = { async available() { return true } }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback({
        webServer: {
          register(definition) {
            routes.set(definition.path, definition.handler)
          },
        },
      })
    },
    logger: { warn() {} },
  }
  registerWebUi(ctx, { sessions, market, bundles, connector, portal, mnemon: options.mnemon })
  return { routes, calls }
}

function mockRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }
  return stream
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload
    },
  }
}

async function call(handler, method, url, body) {
  const response = mockResponse()
  await handler(mockRequest(method, url, body), response)
  return { status: response.statusCode, body: JSON.parse(response.body), headers: response.headers }
}

test('web UI state route returns session, skills, categories and market totals', async () => {
  const { routes } = makeHarness()
  const handler = routes.get('/dsh-workbuddy-helper/state')
  assert.equal(typeof handler, 'function')
  const result = await call(handler, 'GET', '/dsh-workbuddy-helper/state?sessionId=sess-1')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.state.expert.displayName, '演示专家')
  assert.equal(result.body.state.globalSkills.length, 2)
  assert.equal(result.body.state.market.marketTotal, 10000)
  assert.equal(result.body.state.categories[0].name, '技术工程')
  assert.equal(result.body.state.connector.usableAccountCount, 3)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('web UI experts route merges local installs without duplicating market rows', async () => {
  const { routes } = makeHarness()
  const handler = routes.get('/dsh-workbuddy-helper/experts')
  const result = await call(handler, 'GET', '/dsh-workbuddy-helper/experts?query=&page=1&pageSize=24')
  assert.equal(result.status, 200)
  assert.equal(result.body.source, 'portal')
  assert.equal(result.body.items.some(item => item.id === 'local-demo' && item.source === 'local'), true)
  assert.equal(result.body.items.some(item => item.id === 'ex_demo' && item.installed === false), true)
})

test('web UI select route rejects cross-origin POST and accepts same-origin', async () => {
  const { routes, calls } = makeHarness()
  const handler = routes.get('/dsh-workbuddy-helper/select')

  const bad = mockResponse()
  const badRequest = mockRequest('POST', '/dsh-workbuddy-helper/select', { sessionId: 's1', expertId: 'ex_demo' })
  badRequest.headers.origin = 'https://evil.example'
  await handler(badRequest, bad)
  assert.equal(bad.statusCode, 403)

  const good = await call(handler, 'POST', '/dsh-workbuddy-helper/select', { sessionId: 's1', expertId: 'ex_demo' })
  assert.equal(good.status, 200)
  assert.deepEqual(calls.at(-1), ['select', 's1', 'ex_demo'])
})

test('web UI skills and off routes forward the panel patch', async () => {
  const { routes, calls } = makeHarness()
  const skills = await call(routes.get('/dsh-workbuddy-helper/skills'), 'POST', '/dsh-workbuddy-helper/skills', {
    sessionId: 's1',
    globalMode: 'selected',
    globalNames: ['xlsx'],
    expertNames: ['demo-skill'],
  })
  assert.equal(skills.status, 200)
  assert.deepEqual(calls.at(-1), ['skills', 's1', { globalMode: 'selected', globalNames: ['xlsx'], expertNames: ['demo-skill'] }])

  const off = await call(routes.get('/dsh-workbuddy-helper/off'), 'POST', '/dsh-workbuddy-helper/off', { sessionId: 's1' })
  assert.equal(off.status, 200)
  assert.deepEqual(calls.at(-1), ['clear', 's1'])
})

test('web UI routes require a session id and reject unknown methods', async () => {
  const { routes } = makeHarness()
  const missing = await call(routes.get('/dsh-workbuddy-helper/state'), 'GET', '/dsh-workbuddy-helper/state')
  assert.equal(missing.status, 400)
  const method = await call(routes.get('/dsh-workbuddy-helper/select'), 'GET', '/dsh-workbuddy-helper/select')
  assert.equal(method.status, 405)
})

test('the state route always reports whether dsh-mnemon is installed', async () => {
  // 未注入探测器：客户端必须能靠 available:false 决定不渲染那个页签，
  // 而不是拿到 undefined 后自己去猜。
  const bare = makeHarness()
  const withoutDetector = await call(bare.routes.get('/dsh-workbuddy-helper/state'), 'GET', '/dsh-workbuddy-helper/state?sessionId=s1')
  assert.deepEqual(withoutDetector.body.state.mnemon, {
    available: false, version: null, path: null, source: null,
  })

  const installed = makeHarness({
    mnemon: async () => ({ available: true, version: '0.5.52', path: 'C:\\x\\dsh-mnemon', source: 'profile' }),
  })
  const withDetector = await call(installed.routes.get('/dsh-workbuddy-helper/state'), 'GET', '/dsh-workbuddy-helper/state?sessionId=s1')
  assert.equal(withDetector.body.state.mnemon.available, true)
  assert.equal(withDetector.body.state.mnemon.version, '0.5.52')
})

test('a failing mnemon detector degrades to unavailable instead of failing the route', async () => {
  const { routes } = makeHarness({
    mnemon: async () => { throw new Error('EACCES: permission denied') },
  })
  const result = await call(routes.get('/dsh-workbuddy-helper/state'), 'GET', '/dsh-workbuddy-helper/state?sessionId=s1')
  assert.equal(result.status, 200)
  assert.equal(result.body.state.mnemon.available, false)
  // 其余字段不能被这次失败带塌。
  assert.equal(result.body.state.expert.displayName, '演示专家')
})
