// 会话门控的真实路径：controller.init() 注册生命周期钩子，
// pre-step 时把"停用的连接器工具"用 agent 作用域的 tools.restrict 藏掉。
// 这条链路一旦断掉，插件所有状态显示都正常，但模型照样能调到已停用的工具。
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConnectorController } from '../lib/connectors.js'

async function build() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wbh-gate-'))
  const profileDir = path.join(root, 'profile')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const catalogFile = path.join(root, 'mcp_connector.json')
  await fs.writeFile(patchFile, '[]')
  await fs.writeFile(catalogFile, JSON.stringify({
    unit: { name: 'mcp_connector', version: 1 },
    tables: {
      catalog: {
        remote: {
          connectors: [
            {
              id: 'amap',
              name: '高德地图',
              auth: { mode: 'none' },
              servers: [{ serverName: 'amap', transport: 'stdio', command: 'npx', args: ['-y', 'x'] }],
            },
          ],
        },
      },
    },
  }))

  const pluginTools = {
    schemas: () => [{ name: 'mcp__amap__maps_weather' }, { name: 'mcp__amap__maps_geo' }, { name: 'workbuddy_helper' }],
  }
  const agentRestrict = []
  const agentTools = {
    restrict(patch) {
      agentRestrict.push(patch.deny.slice())
      return () => agentRestrict.push(['__disposed__'])
    },
  }
  const handlers = new Map()
  const ctx = {
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    get(name) {
      return name === 'tools' ? pluginTools : undefined
    },
    logger: { warn() {} },
  }
  const controller = createConnectorController(ctx, {
    profileDir,
    dataDir,
    patchFile,
    catalogFile,
    probeTimeoutMs: 20,
    probeIntervalMs: 5,
  })
  controller.init()
  const agent = { id: 'sess-gate', ctx: { get: name => (name === 'tools' ? agentTools : undefined) } }
  const preStep = handlers.get('agent/pre-step') ?? []
  return { controller, agent, preStep, agentRestrict, handlers }
}

test('init() registers the connector lifecycle hooks', async () => {
  const { controller, handlers, preStep } = await build()
  for (const event of ['agent/created', 'agent/disposed', 'agent/pre-step', 'tools/change']) {
    assert.equal(handlers.get(event)?.length, 1, `missing hook for ${event}`)
  }
  assert.equal(preStep.length, 1)
  controller.dispose()
})

test('disabling a connector hides its tools from the agent scope at pre-step', async () => {
  const { controller, agent, preStep, agentRestrict } = await build()
  const step = async () => preStep[0]({ agent, messages: [] }, () => {})

  await step()
  assert.deepEqual(agentRestrict, [], 'nothing disabled yet, so no restriction')

  await controller.setEnabled('amap', false)
  await step()
  assert.equal(agentRestrict.length, 1)
  assert.deepEqual(agentRestrict[0].sort(), ['mcp__amap__maps_geo', 'mcp__amap__maps_weather'])

  await controller.setEnabled('amap', true)
  await step()
  assert.deepEqual(agentRestrict.at(-1), ['__disposed__'], 're-enabling must release the restriction')
  controller.dispose()
})

test('the pre-step hook still calls next() when the gate throws', async () => {
  const { controller, preStep } = await build()
  let called = false
  const broken = {
    id: 'sess-broken',
    ctx: {
      get() {
        throw new Error('agent scope already gone')
      },
    },
  }
  await preStep[0]({ agent: broken, messages: [] }, () => {
    called = true
  })
  assert.equal(called, true, 'a broken agent scope must not stall the step')
  controller.dispose()
})
