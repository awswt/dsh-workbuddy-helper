// 真实注册表形状的回归网：45/134 条连接器是 stdio + credentialBindings，
// 1 条用 headerCredentialBindings。索引里把它们漏掉过一次，这里钉住。
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConnectorController } from '../lib/connectors.js'
import { readMcpServers } from '../lib/mcp-patch.js'

function fakeToolsService(definitions = []) {
  return { definitions: () => definitions, restrict: () => () => {} }
}

/** 取自真实 catalog 的三种 server 形状（省略无关字段）。 */
function catalogFixture() {
  return {
    unit: { name: 'mcp_connector', version: 1 },
    tables: {
      catalog: {
        remote: {
          connectors: [
            {
              id: 'amap-like',
              name: '高德地图',
              category: '调研分析',
              summary: 'stdio + credentialBindings',
              auth: {
                mode: 'api-key',
                apiKeyHeader: 'X-Api-Key',
                credentialDescription: 'API Key 仅保存在 DSH 本机，并注入本地 MCP 进程。',
                credentialFields: [
                  { key: 'apiKey', label: '高德 Web 服务 API Key', placeholder: '请输入 API Key', required: true, secret: true },
                ],
              },
              servers: [
                {
                  serverKey: 'amap',
                  serverName: 'amap',
                  transport: 'stdio',
                  command: 'npx',
                  args: ['-y', '@amap/amap-maps-mcp-server'],
                  env: {},
                  credentialBindings: { AMAP_MAPS_API_KEY: 'apiKey' },
                  headers: {},
                },
              ],
            },
            {
              id: 'header-bound',
              name: '请求头绑定',
              category: '开发工具',
              summary: 'http + headerCredentialBindings',
              auth: {
                mode: 'api-key',
                apiKeyHeader: 'X-Ignored',
                credentialFields: [{ key: 'credential', label: 'Token', required: true, secret: true }],
              },
              servers: [
                {
                  serverKey: 'hb',
                  serverName: 'header_bound',
                  transport: 'streamable-http',
                  url: 'https://hb.test/mcp',
                  headerCredentialBindings: { 'X-Custom-Auth': 'credential' },
                },
              ],
            },
            {
              id: 'no-server',
              name: '坏条目',
              category: '其他',
              summary: '既没有 url 也没有 command',
              auth: { mode: 'none' },
              servers: [{ serverKey: 'x', serverName: 'broken', transport: 'streamable-http' }],
            },
          ],
        },
      },
      connections: {},
    },
  }
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wbh-shapes-'))
  const profileDir = path.join(root, 'profile')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const catalogFile = path.join(root, 'mcp_connector.json')
  await fs.writeFile(patchFile, ['- id: ui-settings-general', '  disabled: false', ''].join('\n'))
  await fs.writeFile(catalogFile, JSON.stringify(catalogFixture(), null, 2))
  const tools = fakeToolsService([])
  const controller = createConnectorController(
    { get: name => (name === 'tools' ? tools : undefined), tools },
    { profileDir, dataDir, patchFile, catalogFile, probeTimeoutMs: 40, probeIntervalMs: 10 },
  )
  return { root, patchFile, controller }
}

test('stdio connectors ask for the declared credential field, not a generic token', async () => {
  const { controller, patchFile } = await setup()
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('amap-like', { sessionId: 's1' })
  assert.equal(result.status, 'action-required')
  assert.deepEqual(result.action.fields.map(field => field.name), ['apiKey'])
  assert.equal(result.action.fields[0].label, '高德 Web 服务 API Key')
  assert.equal(result.action.fields[0].kind, 'secret')
  assert.match(result.action.description, /注入本地 MCP 进程/)
  // 早退状态不能自称「连接中」。
  assert.equal(result.state.connecting, false)
  assert.equal(result.state.credentialReady, false)
  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
  controller.dispose()
})

test('stdio credentialBindings land in env, not in headers', async () => {
  const { controller, patchFile } = await setup()
  const result = await controller.connect('amap-like', { sessionId: 's1', token: 'amap-key-1' })
  assert.equal(result.status, 'connecting')

  const parsed = readMcpServers(await fs.readFile(patchFile, 'utf8'))
  assert.equal(parsed.servers.length, 1)
  const server = parsed.servers[0]
  assert.equal(server.name, 'amap')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.command, 'npx')
  assert.deepEqual(server.args, ['-y', '@amap/amap-maps-mcp-server'])
  assert.equal(server.env.AMAP_MAPS_API_KEY, 'amap-key-1')
  assert.equal(server.headers, undefined)
  assert.equal(server.url, undefined)

  const state = await controller.stateOf('amap-like', 's1')
  assert.equal(state.credentialReady, true)
  assert.equal(state.reason.code, 'restart-required')
  controller.dispose()
})

test('headerCredentialBindings wins over auth.apiKeyHeader', async () => {
  const { controller, patchFile } = await setup()
  await controller.connect('header-bound', { sessionId: 's1', credentials: { credential: 'hb-secret' } })
  const parsed = readMcpServers(await fs.readFile(patchFile, 'utf8'))
  const server = parsed.servers[0]
  assert.equal(server.url, 'https://hb.test/mcp')
  assert.equal(server.headers['X-Custom-Auth'], 'hb-secret')
  assert.equal(server.headers['X-Ignored'], undefined)
  assert.equal(server.headers.Authorization, undefined)
  controller.dispose()
})

test('credentials supplied as a map satisfy multi-field auth', async () => {
  const { controller, patchFile } = await setup()
  const missing = await controller.connect('header-bound', { sessionId: 's1', credentials: {} })
  assert.equal(missing.status, 'action-required')
  assert.equal(missing.action.fields[0].present, false)

  await controller.connect('header-bound', { sessionId: 's1', credentials: { credential: 'k-2' } })
  const again = await controller.connect('header-bound', { sessionId: 's1' })
  // 已有凭据时不再要表单：直接复用落盘凭据。
  assert.notEqual(again.status, 'action-required')
  const parsed = readMcpServers(await fs.readFile(patchFile, 'utf8'))
  assert.equal(parsed.servers[0].headers['X-Custom-Auth'], 'k-2')
  controller.dispose()
})

test('a server with neither url nor command fails loudly instead of writing junk', async () => {
  const { controller, patchFile } = await setup()
  const before = await fs.readFile(patchFile, 'utf8')
  const result = await controller.connect('no-server', { sessionId: 's1' })
  assert.equal(result.status, 'failed')
  assert.match(result.error.message, /既没有 url 也没有 command/)
  assert.equal(await fs.readFile(patchFile, 'utf8'), before)
  controller.dispose()
})
