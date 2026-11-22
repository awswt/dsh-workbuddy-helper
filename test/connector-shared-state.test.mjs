import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/**
 * 桥接测试：连接由 `dsh-mcp-connector` 的管理页建立时，本插件的状态视图
 * 必须显示"已连接/需授权"，而不是"尚未连接"，并且绝不重复写 patch。
 *
 * `WBH_LIB_ROOT` 让同一批断言可以跑在**已装进 profile 的包**上（`scripts/e2e.mjs`
 * 的回归门就是这么用的）。默认指向仓库工作树，所以 `node --test` 的行为不变。
 * 这不是重复劳动：装进去的 tgz 与工作树同版本号却可能内容不同（0.5.0 就出现过
 * 14165B vs 13793B），只有对磁盘上的产物断言才抓得到。
 */
const libRoot = process.env.WBH_LIB_ROOT
const connectorsUrl = libRoot === undefined || libRoot === ''
  ? new URL('../lib/connectors.js', import.meta.url)
  : new URL('connectors.js', pathToFileURL(path.resolve(libRoot) + path.sep))
const { createConnectorController } = await import(connectorsUrl.href)

const AMAP_CONNECTORS = [
    {
      id: 'amap',
      name: '高德地图',
      vendor: 'amap',
      category: '地图出行',
      summary: '地图与路径规划',
      auth: { mode: 'api-key', apiKeyHeader: 'Authorization', credentialFields: [{ key: 'apiKey', label: 'Key', required: true, secret: true }] },
      servers: [{ serverKey: 'main', serverName: 'amap', transport: 'streamable-http', url: 'https://example.com/mcp' }],
    },
    {
      id: 'bocha-search',
      name: '博查搜索',
      vendor: 'bocha',
      category: '调研分析',
      summary: '网页搜索',
      auth: { mode: 'none' },
      servers: [{ serverKey: 'main', serverName: 'bocha', transport: 'streamable-http', url: 'https://example.com/bocha' }],
    },
]

/** 目录快照与 dsh-mcp-connector 同形：真正的数据在 tables.catalog.remote.connectors。 */
const AMAP_CATALOG = {
  unit: { name: 'mcp_connector', version: 1 },
  tables: { catalog: { remote: { connectors: AMAP_CONNECTORS } }, connections: {} },
}

function toolsService(names) {
  return {
    schemas: () => names.map(name => ({ name, description: name })),
  }
}

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wbh-shared-'))
  const dshHome = path.join(root, 'home')
  const storages = path.join(dshHome, 'storages')
  await fs.mkdir(storages, { recursive: true })
  const catalogFile = path.join(root, 'catalog.json')
  await fs.writeFile(catalogFile, JSON.stringify(AMAP_CATALOG), 'utf8')
  const patchFile = path.join(root, 'cordis.patch.yml')
  await fs.writeFile(patchFile, '[]\n', 'utf8')
  if (options.connectorJson !== undefined) {
    await fs.writeFile(path.join(storages, 'mcp_connector.json'), JSON.stringify(options.connectorJson), 'utf8')
  }
  if (options.journal !== undefined) {
    const journalDir = path.join(storages, 'mcp_connector_grants_v1')
    await fs.mkdir(journalDir, { recursive: true })
    await fs.writeFile(path.join(journalDir, 'deadbeef.json'), JSON.stringify(options.journal), 'utf8')
  }
  const controller = createConnectorController(
    { tools: toolsService(options.tools ?? []) },
    {
      catalogFile,
      patchFile,
      dshHome,
      dataDir: path.join(root, 'data'),
      probeTimeoutMs: 40,
      probeIntervalMs: 10,
    },
  )
  return { root, dshHome, patchFile, controller }
}

const FUTURE = Date.now() + 3600_000

/** connections/grants 都是 key → record 的 map，与 dsh-mcp-connector 的 storage-domain 一致。 */
function connectorJson({ mode = 'oauth', grant = null, pending = false, lastError, enabled = true } = {}) {
  const connection = {
    key: 'amap-1',
    connectorId: 'amap',
    kind: mode === 'oauth' ? 'oauth' : 'manual',
    name: '高德地图',
    serverName: 'amap',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    auth: mode === 'oauth' ? { mode: 'oauth', grantKey: 'g1' } : { mode: 'bearer', bearerToken: 'sk-x' },
    enabled,
    createdAt: 1,
    updatedAt: 2,
  }
  if (pending) connection.pendingAuthorization = true
  if (lastError !== undefined) connection.lastError = lastError
  const tables = { connections: { 'amap-1': connection }, grants: {} }
  if (grant !== null) tables.grants = { g1: { key: 'g1', issuer: 'https://issuer', clientId: 'c', scope: 's', account: 'u', ...grant, connectorIds: ['amap'], updatedAt: 3 } }
  return { unit: { name: 'mcp_connector', version: 1 }, global: {}, tables }
}

test('a connection made in the connector UI shows as connected, with its real tool count', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' } }),
    tools: ['mcp__amap__maps_geo', 'mcp__amap__maps_weather'],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.source, 'shared')
  assert.equal(state.bound, true)
  assert.equal(state.connected, true)
  assert.equal(state.toolCount, 2)
  assert.deepEqual(state.tools, ['mcp__amap__maps_geo', 'mcp__amap__maps_weather'])
  assert.equal(state.reason, null)
  assert.equal(state.authMode, 'oauth')
  assert.equal(state.external.via, 'connector-ui')
  assert.equal(state.external.serverName, 'amap')
  assert.equal(state.external.authorized, true)
  assert.equal(state.external.key, 'amap-1')
})

test('an expired access token with a refresh token still counts as authorized', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: 1, refreshToken: 'r' } }),
    tools: ['mcp__amap__maps_geo'],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.external.authorized, true)
  assert.equal(state.external.grantExpired, true)
  assert.equal(state.connected, true)
  assert.equal(state.reason, null)
})

test('a shared oauth connection without any grant asks for authorization', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: null }),
    tools: [],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.source, 'shared')
  assert.equal(state.bound, true)
  assert.equal(state.connected, false)
  assert.equal(state.external.authorized, false)
  assert.equal(state.reason.code, 'authorize')
  assert.match(state.reason.message, /连接器管理页/)
})

test('pendingAuthorization in the connector UI surfaces as a waiting-for-authorization reason', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: null, pending: true }),
    tools: [],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.external.pendingAuthorization, true)
  assert.equal(state.reason.code, 'authorize')
  assert.match(state.reason.message, /等待授权/)
})

test('an authorized shared connection with no visible tools explains the session-activation mode', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' } }),
    tools: [],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.external.authorized, true)
  assert.equal(state.connected, false)
  assert.equal(state.reason.code, 'no-tools')
  assert.match(state.reason.message, /按会话激活/)
})

test('a lastError recorded by the connector UI wins over the generic no-tools reason', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' }, lastError: 'HTTP 502 from upstream' }),
    tools: [],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.reason.code, 'error')
  assert.equal(state.reason.message, 'HTTP 502 from upstream')
})

test('a grant journal file overrides a stale table grant', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 'old', accessTokenExpiresAt: 1, refreshToken: '' } }),
    journal: {
      version: 1,
      grant: { key: 'g1', issuer: 'https://issuer', clientId: 'c', scope: 's', account: 'u', accessToken: 'new', accessTokenExpiresAt: FUTURE, refreshToken: '', authorizedResources: [], connectorIds: ['amap'], updatedAt: 9 },
    },
    tools: ['mcp__amap__maps_geo'],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.external.authorized, true)
  assert.equal(state.external.grantExpiresAt, FUTURE)
  assert.equal(state.connected, true)
})

test('a disabled connection in the connector UI is not treated as a live bridge', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' }, enabled: false }),
    tools: [],
  })
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.source, 'catalog')
  assert.equal(state.reason.code, 'unbound')
})

test('connect() on a connector the UI already manages reports success without writing a patch', async () => {
  const { controller, patchFile } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' } }),
    tools: ['mcp__amap__maps_geo'],
  })
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('amap', { sessionId: 's1', token: 'sk-should-not-be-used' })
  assert.equal(result.status, 'connected')
  assert.equal(result.success, true)
  assert.equal(await fs.readFile(patchFile, 'utf8'), before, 'the patch is the connector UI’s business, not ours')
})

test('connect() on an unauthorized shared connection hands off to the connector UI page', async () => {
  const { controller, patchFile } = await fixture({
    connectorJson: connectorJson({ grant: null }),
    tools: [],
  })
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('amap', { sessionId: 's1' })
  assert.equal(result.needsAuth, true)
  assert.equal(result.action.kind, 'open_url')
  assert.match(result.action.url, /mcp-connector\/ui/)
  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
})

test('connect() refuses to duplicate a live shared connection that exposes no tools', async () => {
  const { controller, patchFile } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' } }),
    tools: [],
  })
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('amap', { sessionId: 's1', token: 'sk-x' })
  assert.equal(result.success, false)
  assert.match(String(result.error.message), /连接器管理页/)
  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
})

test('disconnect() and unbind() refuse to pretend they removed a connector-UI connection', async () => {
  const { controller, patchFile } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' } }),
    tools: ['mcp__amap__maps_geo'],
  })
  const before = await fs.readFile(patchFile, 'utf8')

  const disconnected = await controller.disconnect('amap')
  assert.equal(disconnected.success, false)
  assert.match(String(disconnected.error.message), /连接器管理页/)
  assert.equal(disconnected.state.source, 'shared')

  const unbound = await controller.unbind('amap')
  assert.equal(unbound.success, false)
  assert.match(String(unbound.error.message), /解绑请在那边操作/)

  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
})

test('without a connector store every catalog connector keeps the plain unbound state', async () => {
  const { controller } = await fixture({ tools: [] })
  const shared = await controller.shared()
  assert.equal(shared.available, false)
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.source, 'catalog')
  assert.equal(state.bound, false)
  assert.equal(state.reason.code, 'unbound')
  assert.equal(state.external, undefined)
})

test('states() bridges only the connectors the UI actually holds', async () => {
  const { controller } = await fixture({
    connectorJson: connectorJson({ grant: { accessToken: 't', accessTokenExpiresAt: FUTURE, refreshToken: 'r' } }),
    tools: ['mcp__amap__maps_geo'],
  })
  const states = await controller.states('s1')
  assert.equal(states.amap.source, 'shared')
  assert.equal(states.amap.connected, true)
  assert.equal(states['bocha-search'].source, 'catalog')
  assert.equal(states['bocha-search'].reason.code, 'unbound')
})
