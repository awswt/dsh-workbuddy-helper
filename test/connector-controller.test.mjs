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

test('recordUiOpen persists the jump so the state shows it across restarts', async () => {
  const { controller, dataDir, catalogFile, profileDir } = await setup()
  // 第一次：没有记录。
  assert.equal((await controller.states('s1'))['key-api'].uiOpen, null)

  const entry = await controller.recordUiOpen('key-api', { serverName: 'key_api', sessionId: 's1' })
  assert.equal(entry.configId, 'key-api')
  assert.equal(entry.serverName, 'key_api')
  assert.equal(entry.sessionId, 's1')
  assert.equal(entry.count, 1)
  assert.equal(typeof entry.at, 'number')

  // 计数累加而不是覆盖：用户可能反复去管理页。
  const second = await controller.recordUiOpen('key-api', { serverName: 'key_api' })
  assert.equal(second.count, 2)
  const state = (await controller.states('s1'))['key-api']
  assert.equal(state.uiOpen.count, 2)
  // 埋点绝不能改变连接语义。
  assert.equal(state.bound, false)
  assert.equal(state.connected, false)
  assert.equal(state.reason.code, 'unbound')

  // 空 id 是无效输入，不写任何东西。
  assert.equal(await controller.recordUiOpen('', {}), null)

  // 落盘后可被新进程读回（模拟重启）。
  const store = JSON.parse(await fs.readFile(path.join(dataDir, 'connectors.json'), 'utf8'))
  assert.equal(store.uiOpens['key-api'].count, 2)
  controller.dispose()

  const fresh = createConnectorController(
    { get: name => (name === 'tools' ? fakeToolsService([]) : undefined) },
    { dataDir, patchFile: path.join(profileDir, 'cordis.patch.yml'), catalogFile },
  )
  const reloaded = (await fresh.states('s1'))['key-api']
  assert.equal(reloaded.uiOpen.count, 2, 'uiOpen must survive a controller restart')
  fresh.dispose()
})

test('the OAuth handoff upgrades to a deep link once the connector UI can read one', async () => {
  const { controller, profileDir } = await setup()
  // 现在装的 dsh-mcp-connector 不支持深链：交接地址只带可观测参数。
  const plain = await controller.connect('oauth-pkce', { action: 'connect', sessionId: 's1' })
  assert.equal(plain.action.kind, 'open_url')
  // 探测结果为不支持时连参数都不带：带了也没人读，只会让人误以为能定位。
  assert.equal(plain.action.url, "/mcp-connector/ui")
  assert.equal((await controller.uiCapability()).supported, false)
  controller.dispose()

  // 模拟上游某天开始读 ?connector=：同一个控制器应自动切换，不需要改代码。
  const uiDir = path.join(profileDir, 'node_modules', 'dsh-mcp-connector', 'ui')
  await fs.mkdir(uiDir, { recursive: true })
  await fs.writeFile(
    path.join(uiDir, 'index.html'),
    '<script>const wanted = new URLSearchParams(location.search).get("connector")</script>',
    'utf8',
  )
  const upgraded = createConnectorController(
    { get: name => (name === 'tools' ? fakeToolsService([]) : undefined) },
    { profileDir, dataDir: path.join(profileDir, '..', 'data2'), patchFile: path.join(profileDir, 'cordis.patch.yml'), catalogFile: path.join(profileDir, '..', 'mcp_connector.json') },
  )
  const capability = await upgraded.uiCapability()
  assert.equal(capability.supported, true)
  assert.equal(capability.param, 'connector')
  const result = await upgraded.connect('oauth-pkce', { action: 'connect', sessionId: 's1' })
  assert.match(result.action.url, /mcp-connector\/ui\?.*connector=oauth-pkce/)
  assert.match(result.action.url, /from=dsh-workbuddy-helper/)
  upgraded.dispose()
})
