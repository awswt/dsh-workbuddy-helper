import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createConnectorController } from '../lib/connectors.js'

async function tempDir(prefix = 'wbh-connector-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function fakeToolsService(definitions) {
  return {
    definitions: () => definitions,
    restrictCalls: [],
    restrict(patch) {
      const names = Array.isArray(patch?.deny) ? patch.deny : []
      this.restrictCalls.push(names)
      return () => {
        this.restrictCalls.push(['__disposed__'])
      }
    },
  }
}

test('connector controller scans profile plugins, maps tools and gates sessions', async () => {
  const profileDir = await tempDir()
  const pkgDir = path.join(profileDir, 'node_modules', 'dsh-demo-connector')
  await fs.mkdir(path.join(pkgDir, 'lib'), { recursive: true })
  await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'dsh-demo-connector',
    version: '1.2.3',
    description: 'MCP 连接器：演示外部工具桥',
  }))
  await fs.writeFile(path.join(pkgDir, 'lib', 'tools.js'), [
    'const BRIDGE = "mcp__demo__";',
    "const a = { name: 'demo_alpha' };",
    "const b = { name: 'demo_beta' };",
  ].join('\n'))

  const definitions = [
    { name: 'demo_alpha', description: 'Alpha' },
    { name: 'demo_beta', description: 'Beta' },
    { name: 'mcp__demo__search', description: 'Search' },
    { name: 'other_tool', description: 'Not a connector' },
  ]
  const tools = fakeToolsService(definitions)
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['tools'])
      callback({ tools })
    },
    on() {},
    logger: { warn() {} },
  }

  // The controller warms its plugin cache at creation, so the fixture must be
  // on disk before the controller exists.
  const controller = createConnectorController(ctx, { profileDir })
  const plugins = await controller.listPlugins()
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].id, 'dsh-demo-connector')
  assert.equal(plugins[0].prefixes.includes('demo_'), true)
  assert.equal(plugins[0].prefixes.includes('mcp__demo__'), true)

  const views = await controller.connectorViews()
  assert.equal(views.total, 1)
  assert.equal(views.items[0].toolCount, 3)
  assert.equal(views.items[0].sampleTool.name, 'demo_alpha')

  const agent = {
    id: 'sess-1',
    ctx: { get: (name) => (name === 'tools' ? tools : undefined) },
  }
  controller.setSession('sess-1', ['dsh-demo-connector'])
  await controller.reapply(agent)
  assert.equal(tools.restrictCalls.length, 1)
  assert.equal(tools.restrictCalls[0].length, 3)
  assert.equal(tools.restrictCalls[0].includes('other_tool'), false)

  controller.setSession('sess-1', [])
  await controller.reapply(agent)
  assert.equal(tools.restrictCalls.at(-1)[0], '__disposed__')
})

test('connector catalog reads the mcp-connector store without leaking secrets', async () => {
  const fakeHome = await tempDir('wbh-home-')
  await fs.mkdir(path.join(fakeHome, 'storages'), { recursive: true })
  await fs.writeFile(path.join(fakeHome, 'storages', 'mcp_connector.json'), JSON.stringify({
    unit: { name: 'unit', version: 1 },
    global: null,
    tables: {
      connections: { 'conn-1': { connectorId: 'amap' } },
      catalog: {
        remote: {
          connectors: [
            { id: 'amap', name: '高德地图', vendor: '高德开放平台', category: '效率工具', tags: ['地图'], summary: '地点搜索与路线规划', homepage: 'https://example.com', toolsSnapshot: { a: 1, b: 2 } },
            { id: 'akshare', name: 'AKShare', category: '金融投资', summary: '公开市场数据' },
          ],
        },
      },
    },
  }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  try {
    const ctx = { inject() {}, on() {}, logger: { warn() {} } }
    const controller = createConnectorController(ctx, { profileDir: await tempDir() })
    const catalog = await controller.catalog()
    assert.equal(catalog.total, 2)
    assert.equal(catalog.categories.includes('效率工具'), true)
    const amap = catalog.items.find(item => item.id === 'amap')
    assert.equal(amap.connected, true)
    assert.equal(amap.tools, 2)
    assert.equal(amap.homepage, 'https://example.com')
    assert.equal(JSON.stringify(catalog).includes('accessToken'), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('client primary button no longer relies on the flipping brand token', async () => {
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const primaryStart = source.indexOf("'.wbh-btn--primary{")
  assert.notEqual(primaryStart, -1, 'primary rule must exist')
  const primaryEnd = source.indexOf('.wbh-btn--quiet', primaryStart)
  const block = source.slice(primaryStart, primaryEnd)
  assert.equal(block.includes('--dsw-alias-brand-primary'), false)
  assert.equal(block.includes('--dsw-alias-label-primary'), true)
  assert.equal(block.includes('--dsw-alias-bg-layer-2'), true)
})

test('profile dir resolves from --profile argv even under pnpm realpath', async () => {
  const fakeHome = await tempDir('wbh-home2-')
  const profileDir = path.join(fakeHome, 'profiles', 'argv-prof')
  await fs.mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  const previousHome = process.env.DSH_HOME
  const previousArgv = process.argv
  process.env.DSH_HOME = fakeHome
  process.argv = ['dsh', '--profile', 'argv-prof', '--no-open']
  try {
    const ctx = { inject() {}, on() {}, logger: { warn() {} } }
    const controller = createConnectorController(ctx, {})
    assert.equal(controller.profileDir, profileDir)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    process.argv = previousArgv
  }
})
