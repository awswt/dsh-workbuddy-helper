import assert from 'node:assert/strict'
import test from 'node:test'
import { registerWebUi } from '../lib/webui.js'

function deps() {
  return {
    sessions: {
      async panelState() { return { sessionId: 's1' } },
      disabledOf: () => new Set(),
      setSession: () => [],
      async select() { return {} },
      async setSkills() { return {} },
      async clear() { return {} },
    },
    market: {
      async listExperts() { return { source: 'portal', total: 0, items: [] } },
      async marketSize() { return 0 },
      async categories() { return [] },
    },
    bundles: { async listLocal() { return [] } },
    connector: { async status() { return { installed: true, accountCount: 1, usableAccountCount: 1 } } },
    portal: {
      async listSkills() { return { total: 0, items: [] } },
      async listBuddyConnectors() { return { total: 0, hasMore: false, items: [] } },
      async available() { return true },
    },
    connectors: {
      connectorViews: async () => ({ items: [], total: 0 }),
      catalog: async () => ({ items: [], total: 0, categories: [] }),
      disabledOf: () => new Set(),
    },
  }
}

test('web routes are replaced, not leaked, when the plugin reloads', () => {
  const routes = new Map()
  const scopedEffects = []
  const rootEffects = []
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    inject(names, callback) {
      callback({
        webServer,
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') scopedEffects.push(dispose)
        },
      })
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') rootEffects.push(dispose)
    },
    logger: { info() {}, warn() {} },
  }

  registerWebUi(ctx, deps())
  const first = [...routes.keys()]
  assert.ok(first.includes('/dsh-workbuddy-helper/state'))
  assert.ok(first.includes('/dsh-workbuddy-helper/skill-market'))

  // A reload re-runs the inject callback on the shared webServer.
  registerWebUi(ctx, deps())
  assert.deepEqual([...routes.keys()], first, 'second registration must not leave stale handlers')

  for (const dispose of rootEffects) dispose()
  assert.equal(routes.size, 0, 'plugin unload must release every registered route')
  assert.ok(scopedEffects.length > 0, 'scoped effect should also be registered')
})
