import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConnectorController } from '../lib/connectors.js'
import { readMcpServers } from '../lib/mcp-patch.js'

async function tempDir(prefix = 'wbh-flow-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function fakeToolsService(definitions = []) {
  const calls = []
  return {
    definitions: () => definitions,
    calls,
    restrict(patch) {
      calls.push(Array.isArray(patch?.deny) ? patch.deny : [])
      return () => {}
    },
  }
}

/** 造一份与 dsh-mcp-connector 同形的目录快照：三种认证方式各一个。 */
function catalogFixture() {
  return {
    unit: { name: 'mcp_connector', version: 1 },
    tables: {
      catalog: {
        remote: {
          connectors: [
            {
              id: 'open-http',
              name: '开放 HTTP',
              vendor: 'demo',
              category: '数据',
              summary: '无需凭据的公共 MCP',
              auth: { mode: 'none' },
              servers: [{ serverKey: 'default', serverName: 'open_http', url: 'https://open.test/mcp', transport: 'http' }],
              toolsSnapshot: [{ name: 'open_search' }],
            },
            {
              id: 'key-api',
              name: '密钥检索',
              vendor: 'demo',
              category: '搜索',
              summary: 'API Key 鉴权',
              auth: { mode: 'api-key', apiKeyHeader: 'Authorization', credentialName: 'KEY_API_TOKEN' },
              servers: [{ serverKey: 'default', serverName: 'key_api', url: 'https://key.test/mcp', transport: 'http' }],
            },
            {
              id: 'oauth-pkce',
              name: 'OAuth 连接器',
              vendor: 'demo',
              category: '设计',
              summary: 'PKCE 授权码流程',
              auth: { mode: 'oauth2-pkce', clientName: 'DSH' },
              servers: [{ serverKey: 'default', serverName: 'oauth_pkce', url: 'https://oauth.test/mcp', transport: 'http' }],
            },
          ],
        },
      },
      connections: {},
    },
  }
}

async function setup() {
  const root = await tempDir()
  const profileDir = path.join(root, 'profile')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const catalogFile = path.join(root, 'mcp_connector.json')
  await fs.writeFile(patchFile, ['- id: ui-settings-general', '  disabled: false', ''].join('\n'))
  await fs.writeFile(catalogFile, JSON.stringify(catalogFixture(), null, 2))
  const tools = fakeToolsService([])
  const ctx = { get: name => (name === 'tools' ? tools : undefined), tools }
  const controller = createConnectorController(ctx, {
    profileDir,
    dataDir,
    patchFile,
    catalogFile,
    probeTimeoutMs: 60,
    probeIntervalMs: 10,
  })
  return { root, profileDir, dataDir, patchFile, catalogFile, tools, controller }
}

test('configs merges the catalog and reports the three auth modes', async () => {
  const { controller } = await setup()
  const { items, total } = await controller.configs()
  assert.equal(total, 3)
  const byId = new Map(items.map(item => [item.id, item]))
  assert.equal(byId.get('open-http').auth.mode, 'none')
  assert.equal(byId.get('key-api').auth.mode, 'api-key')
  assert.equal(byId.get('oauth-pkce').auth.mode, 'oauth2-pkce')
  assert.equal(byId.get('key-api').source, 'catalog')
  assert.equal(byId.get('key-api').serverName, 'key_api')
  assert.equal(byId.get('key-api').prefix, 'mcp__key_api__')

  const states = await controller.states(undefined)
  assert.deepEqual(Object.keys(states).sort(), ['key-api', 'oauth-pkce', 'open-http'])
  assert.equal(states['key-api'].bound, false)
  assert.equal(states['key-api'].connected, false)
  assert.equal(states['key-api'].authMode, 'api-key')
  assert.equal(states['key-api'].reason.code, 'unbound')
  controller.dispose()
})

test('api-key connector without a token asks for the form and writes nothing', async () => {
  const { controller, patchFile } = await setup()
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('key-api', { action: 'connect', sessionId: 's1' })
  assert.equal(result.status, 'action-required')
  assert.equal(result.action.kind, 'form')
  assert.equal(result.action.fields[0].name, 'token')
  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
  controller.dispose()
})

test('api-key connector with a token lands in the patch and flags restart-required', async () => {
  const { controller, patchFile } = await setup()
  const result = await controller.connect('key-api', { action: 'connect', sessionId: 's1', token: 'sk-demo-123' })
  // 工具还没注册（宿主未重启），所以不能谎报 connected。
  assert.equal(result.status, 'connecting')

  const content = await fs.readFile(patchFile, 'utf8')
  const parsed = readMcpServers(content)
  assert.deepEqual(parsed.servers.map(server => server.name), ['key_api'])
  assert.equal(parsed.servers[0].url, 'https://key.test/mcp')
  assert.equal(parsed.servers[0].headers.Authorization, 'sk-demo-123')
  assert.match(content, /id: ui-settings-general/)

  const state = await controller.stateOf('key-api', 's1')
  assert.equal(state.bound, true)
  assert.equal(state.reason.code, 'restart-required')
  controller.dispose()
})

test('oauth connector hands off to the connector UI instead of guessing a token', async () => {
  const { controller, patchFile } = await setup()
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('oauth-pkce', { action: 'connect', sessionId: 's1' })
  assert.equal(result.status, 'action-required')
  assert.equal(result.action.kind, 'open_url')
  assert.match(result.action.url, /mcp-connector\/ui/)
  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
  controller.dispose()
})

test('none-auth connector writes a patch entry and reports the missing tools', async () => {
  const { controller, patchFile } = await setup()
  const result = await controller.connect('open-http', { action: 'connect', sessionId: 's1' })
  assert.equal(result.status, 'connecting')
  const parsed = readMcpServers(await fs.readFile(patchFile, 'utf8'))
  assert.deepEqual(parsed.servers.map(server => server.name), ['open_http'])
  assert.equal(parsed.servers[0].headers, undefined)
  controller.dispose()
})

test('disconnect removes the managed patch entry and clears the binding', async () => {
  const { controller, patchFile } = await setup()
  await controller.connect('open-http', { action: 'connect', sessionId: 's1' })
  const result = await controller.disconnect('open-http')
  assert.equal(result.success, true)
  assert.deepEqual(readMcpServers(await fs.readFile(patchFile, 'utf8')).servers, [])
  const state = await controller.stateOf('open-http', 's1')
  assert.equal(state.bound, false)
  controller.dispose()
})

test('a second connect while one is in flight is refused, not queued', async () => {
  const { controller } = await setup()
  const first = controller.connect('open-http', { action: 'connect', sessionId: 's1' })
  const second = await controller.connect('open-http', { action: 'connect', sessionId: 's1' })
  assert.equal(second.success, false)
  assert.equal(second.connecting, true)
  await first
  controller.dispose()
})

test('unknown connector ids are reported instead of silently created', async () => {
  const { controller } = await setup()
  const result = await controller.connect('does-not-exist', { action: 'connect' })
  assert.equal(result.success, false)
  assert.match(String(result.error?.message ?? result.error), /does-not-exist/)
  controller.dispose()
})
