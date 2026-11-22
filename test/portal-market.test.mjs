import assert from 'node:assert/strict'
import test from 'node:test'
import { PortalMarket } from '../lib/portal.js'

function fakePortal(handlers) {
  const calls = []
  const portal = new PortalMarket({
    baseUrl: 'https://www.workbuddy.cn',
    timeoutMs: 5000,
    retries: 0,
    allowHosts: ['www.workbuddy.cn'],
    authProvider: async () => ({ header: 'Authorization', value: 'Bearer test-token' }),
    fetchImpl: async (url, options) => {
      const parsed = JSON.parse(options.body ?? '{}')
      const urlText = String(url)
      calls.push({ url: urlText, body: parsed })
      for (const handler of handlers) {
        const result = handler(urlText, parsed)
        if (result !== undefined) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => result,
          }
        }
      }
      throw new Error('no handler for ' + url)
    },
  })
  return { portal, calls }
}

test('listSkills searches the WorkBuddy skill market under the portal prefix', async () => {
  const { portal, calls } = fakePortal([
    (urlText, body) => {
      if (!urlText.endsWith('/portal/operation-platform/market/skill/list')) return undefined
      return {
        code: 0,
        data: {
          total_count: 873,
          skills: [
            {
              skill_id: 'skill_1',
              name: 'browser-skill',
              display_name_zh: 'Web Access（浏览器自动化）',
              description_zh: '浏览器自动化技能',
              icon: 'https://cdn.example.com/icon.png',
              version: '1.2.0',
              lifecycle_status: 'published',
            },
          ],
        },
      }
    },
  ])
  const result = await portal.listSkills({ query: '浏览器', page: 1, pageSize: 12 })
  assert.equal(result.total, 873)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].name, 'Web Access（浏览器自动化）')
  assert.equal(result.items[0].id, 'skill_1')
  assert.equal(result.items[0].icon, 'https://cdn.example.com/icon.png')
  const call = calls[0]
  assert.equal(call.url.includes('/portal/operation-platform/market/skill/list'), true)
  assert.equal(call.body.keyword, '浏览器')
  assert.equal(call.body.page_size, 12)
})

test('listBuddyConnectors uses the open-platform buddy API without the portal prefix', async () => {
  const { portal, calls } = fakePortal([
    (urlText, body) => {
      if (!urlText.endsWith('/api/v2/open-platform/buddy/connector/list')) return undefined
      return {
        code: 0,
        data: {
          list: [
            {
              connector_id: 'github',
              display_name_zh: 'GitHub',
              description_zh: '克隆、推送代码',
              auth_type: 'oauth',
              version: '0.0.0+wb.15f749b7cfc4cc00',
              icon: 'https://cdn.example.com/github.png',
            },
          ],
          has_more: true,
        },
      }
    },
  ])
  const result = await portal.listBuddyConnectors({ page: 1, pageSize: 24 })
  assert.equal(result.total, 1)
  assert.equal(result.hasMore, true)
  assert.equal(result.items[0].id, 'github')
  assert.equal(result.items[0].name, 'GitHub')
  assert.equal(result.items[0].source, 'workbuddy')
  const call = calls[0]
  assert.equal(call.url.includes('/api/v2/open-platform/buddy/connector/list'), true)
  assert.equal(call.url.includes('/portal'), false)
  assert.equal(call.body.platform, 'desktop')
})

test('listBuddyConnectors switches to the search route when a keyword is given', async () => {
  const { portal, calls } = fakePortal([
    (urlText, body) => {
      if (!urlText.endsWith('/api/v2/open-platform/buddy/connector/search')) return undefined
      return { code: 0, data: { list: [{ connector_id: 'amap', display_name_zh: '高德地图' }], has_more: false } }
    },
  ])
  const result = await portal.listBuddyConnectors({ query: '地图', page: 1, pageSize: 12 })
  assert.equal(result.items[0].name, '高德地图')
  assert.equal(result.hasMore, false)
  const call = calls[0]
  assert.equal(call.url.endsWith('/api/v2/open-platform/buddy/connector/search'), true)
  assert.equal(call.body.keyword, '地图')
  assert.equal(call.body.platform, 'desktop')
})

test('skill market route serves normalized results and auth-required fallback', async () => {
  const sessions = { async panelState() { return { sessionId: 's1' } }, disabledOf: () => new Set(), setSession: () => [] }
  const market = {
    async listExperts() { return { source: 'portal', total: 0, items: [] } },
    async marketSize() { return 0 },
    async categories() { return [] },
  }
  const bundles = { async listLocal() { return [] } }
  const connector = { async status() { return { installed: true, accountCount: 1, usableAccountCount: 1 } } }
  const portal = {
    async listSkills() {
      return {
        total: 2,
        page: 1,
        pageSize: 12,
        items: [
          { id: 'skill_a', name: '技能A', description: '说明', version: '1.0.0', icon: null },
          { id: 'skill_b', name: '技能B', description: '', version: null, icon: null },
        ],
      }
    },
    async listBuddyConnectors() { return { total: 0, items: [], hasMore: false } },
  }
  const connectors = {
    connectorViews: async () => ({ items: [], total: 0 }),
    catalog: async () => ({ items: [], total: 0, categories: [] }),
    disabledOf: () => new Set(),
  }
  const routes = new Map()
  const ctx = {
    inject(names, callback) {
      callback({ webServer: { register(def) { routes.set(def.path, def.handler) } } })
    },
    logger: { warn() {} },
  }
  const { registerWebUi } = await import('../lib/webui.js')
  registerWebUi(ctx, { sessions, market, bundles, connector, portal, connectors })

  const handler = routes.get('/dsh-workbuddy-helper/skill-market')
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(payload) { this.body = payload },
  }
  const request = {
    method: 'GET',
    url: '/dsh-workbuddy-helper/skill-market?query=浏览器&page=1&pageSize=12',
    headers: { host: '127.0.0.1:3000' },
    async iterator() {},
    [Symbol.asyncIterator]() {
      return (async function* () { })()
    },
    on() {},
  }
  await handler(request, response)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.total, 2)
  assert.equal(body.items[0].name, '技能A')
})
