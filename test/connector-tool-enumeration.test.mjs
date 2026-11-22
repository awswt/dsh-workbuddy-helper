// 宿主的 tools 服务没有 definitions()，只有 schemas()/view()/get()。
// 旧代码只探测 definitions()，导致 toolCount 恒为 0、连接器永远显示"未连接"。
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConnectorController } from '../lib/connectors.js'

function catalog() {
  return {
    unit: { name: 'mcp_connector', version: 1 },
    tables: {
      catalog: {
        remote: {
          connectors: [
            {
              id: 'amap',
              name: '高德地图',
              auth: { mode: 'api-key', credentialFields: [{ key: 'apiKey', label: 'Key', required: true, secret: true }] },
              servers: [{ serverName: 'amap', transport: 'stdio', command: 'npx', args: ['-y', 'x'], credentialBindings: { K: 'apiKey' } }],
            },
          ],
        },
      },
    },
  }
}

async function setup(toolsService) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wbh-schemas-'))
  const profileDir = path.join(root, 'profile')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const catalogFile = path.join(root, 'mcp_connector.json')
  await fs.writeFile(patchFile, '[]')
  await fs.writeFile(catalogFile, JSON.stringify(catalog()))
  const controller = createConnectorController(
    { get: name => (name === 'tools' ? toolsService : undefined), tools: toolsService },
    { profileDir, dataDir, patchFile, catalogFile, probeTimeoutMs: 20, probeIntervalMs: 5 },
  )
  return { controller, dataDir }
}

test('tool enumeration falls back to schemas() when definitions() is absent', async () => {
  const toolsService = {
    // 只有宿主真实存在的公开面：
    schemas: () => [
      { name: 'mcp__amap__maps_weather' },
      { name: 'mcp__amap__maps_geo' },
      { name: 'workbuddy_helper' },
    ],
  }
  const { controller } = await setup(toolsService)
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.toolCount, 2)
  assert.deepEqual(state.tools, ['mcp__amap__maps_weather', 'mcp__amap__maps_geo'])
  assert.equal(state.connected, true)
  controller.dispose()
})

test('schemas() entries without a name are ignored instead of poisoning the count', async () => {
  const toolsService = { schemas: () => [{ name: 'mcp__amap__maps_weather' }, { description: 'no name' }, null] }
  const { controller } = await setup(toolsService)
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.toolCount, 1)
  controller.dispose()
})

test('a service exposing neither definitions() nor schemas() reports zero tools, not a crash', async () => {
  const { controller } = await setup({})
  const state = await controller.stateOf('amap', 's1')
  assert.equal(state.toolCount, 0)
  assert.equal(state.connected, false)
  assert.equal(state.reason.code, 'unbound')
  controller.dispose()
})
