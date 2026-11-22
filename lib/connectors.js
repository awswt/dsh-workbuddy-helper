import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './util.js'

const SELF_PACKAGE = 'dsh-workbuddy-helper'
const MAX_SCAN_FILES = 120
const MAX_SCAN_BYTES = 2 * 1024 * 1024
const PLUGIN_CACHE_TTL_MS = 60 * 1000
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000

function isConnectorPackage(name, pkg) {
  if (name === SELF_PACKAGE) return false
  if (pkg?.dsh?.connector === true) return true
  if (/(^dsh-(connect|ima)|mcp|connector|browser)/i.test(name)) return true
  const description = String(pkg?.description ?? '')
  return description.includes('连接器') || /MCP/i.test(description)
}

/** Collect tool-name prefixes a connector package registers. */
function extractPrefixes(text) {
  const set = new Set()
  for (const match of text.matchAll(/mcp__([a-z0-9_-]{1,40})__/gi)) {
    set.add(`mcp__${match[1]}__`)
  }
  const counts = new Map()
  for (const match of text.matchAll(/name:\s*['"]([a-z][a-z0-9_]{2,48})['"]/g)) {
    const name = match[1]
    if (!name.includes('_')) continue
    const segment = name.split('_')[0]
    counts.set(segment, (counts.get(segment) ?? 0) + 1)
  }
  for (const [segment, count] of counts) {
    if (count >= 2) set.add(`${segment}_`)
  }
  return [...set]
}

async function scanPackageLib(root) {
  const text = await (async () => {
    let total = 0
    let files = 0
    let collected = ''
    const walk = async dir => {
      if (files >= MAX_SCAN_FILES || total >= MAX_SCAN_BYTES) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (files >= MAX_SCAN_FILES || total >= MAX_SCAN_BYTES) return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue
        const content = await fs.readFile(full, 'utf8').catch(() => '')
        files += 1
        total += content.length
        collected += content
      }
    }
    await walk(root)
    return collected
  })()
  return extractPrefixes(text)
}

function connectorToolOwner(name, plugins) {
  for (const plugin of plugins) {
    for (const prefix of plugin.prefixes) {
      if (name.startsWith(prefix)) return plugin
    }
  }
  return undefined
}

/**
 * Connector registry and per-session tool gating.
 *
 * A "connector" is an installed DSH plugin that contributes external tools:
 * MCP bridges (`mcp__server__*`), the MCP connector (`mcp_connector_*`),
 * IMA knowledge tools (`ima_*`) and similar. The controller keeps one
 * allow/deny decision per session and mirrors it onto each live agent with
 * `tools.restrict({ deny })`, the same mechanism `dsh-windows-mcp` uses for
 * its Computer Use switch.
 */
/**
 * Locate the active profile directory.
 *
 * The plugin file is loaded through pnpm's content-addressable store, so
 * walking up from `import.meta.url` lands in `.pnpm`, not in the profile. The
 * one stable landmark is `$DSH_HOME/profiles/<name>`; the real module URL
 * always sits below it.
 */
function profileFromArgv() {
  const argv = Array.isArray(process.argv) ? process.argv : []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' && typeof argv[index + 1] === 'string') return argv[index + 1]
    if (typeof arg === 'string' && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  return undefined
}

function findProfileDir() {
  const profilesRoot = path.join(resolveDshHome(), 'profiles')
  const fromArgv = profileFromArgv()
  if (fromArgv !== undefined) {
    const candidate = path.join(profilesRoot, fromArgv)
    if (existsSync(path.join(candidate, 'node_modules'))) return candidate
  }
  let current = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 10; depth += 1) {
    if (path.dirname(current) === profilesRoot) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

export function createConnectorController(ctx, options = {}) {
  const profileDir = options.profileDir
    ?? findProfileDir()
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const disabled = new Map() // sessionId -> Set(connector id)
  const applied = new Map() // agent -> { key, dispose }
  const live = new Set()
  let applying = false
  let toolsService = null
  let pluginsCache
  let catalogCache
  let disposed = false

  try {
    ctx.inject?.(['tools'], scoped => {
      toolsService = scoped?.tools ?? null
    })
  } catch {
    toolsService = null
  }
  void listPlugins().catch(() => {})

  async function listPlugins() {
    if (pluginsCache !== undefined && Date.now() - pluginsCache.at < PLUGIN_CACHE_TTL_MS) {
      return pluginsCache.value
    }
    const root = path.join(profileDir, 'node_modules')
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const plugins = []
    for (const entry of entries) {
      if (!entry.name.startsWith('dsh-')) continue
      // pnpm links every dependency as a junction/symlink, so accept both.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const pkgPath = path.join(root, entry.name, 'package.json')
      let pkg
      try {
        pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'))
      } catch {
        continue
      }
      if (!isConnectorPackage(entry.name, pkg)) continue
      const prefixes = await scanPackageLib(path.join(root, entry.name, 'lib'))
      plugins.push({
        id: entry.name,
        name: String(pkg.displayName ?? pkg.name ?? entry.name),
        packageName: entry.name,
        version: typeof pkg.version === 'string' ? pkg.version : null,
        description: String(pkg.description ?? ''),
        prefixes,
        connector: pkg.dsh?.connector === true,
      })
    }
    pluginsCache = { at: Date.now(), value: plugins }
    return plugins
  }

  function definitionsOf() {
    try {
      return typeof toolsService?.definitions === 'function' ? toolsService.definitions() : []
    } catch {
      return []
    }
  }

  async function connectorViews() {
    const plugins = await listPlugins()
    const definitions = definitionsOf()
    const counts = new Map()
    const samples = new Map()
    for (const definition of definitions) {
      const owner = connectorToolOwner(definition.name, plugins)
      if (owner === undefined) continue
      counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1)
      if (!samples.has(owner.id)) {
        samples.set(owner.id, { name: definition.name, description: definition.description ?? null })
      }
    }
    const items = plugins.map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      packageName: plugin.packageName,
      version: plugin.version,
      description: plugin.description,
      toolCount: counts.get(plugin.id) ?? 0,
      sampleTool: samples.get(plugin.id) ?? null,
      prefixes: plugin.prefixes,
    }))
    return { items, total: items.length }
  }

  async function readCatalog() {
    if (catalogCache !== undefined && Date.now() - catalogCache.at < CATALOG_CACHE_TTL_MS) {
      return catalogCache.value
    }
    const file = path.join(resolveDshHome(), 'storages', 'mcp_connector.json')
    let connectors = []
    let connectedIds = new Set()
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      const remote = parsed?.tables?.catalog?.remote
      connectors = Array.isArray(remote?.connectors) ? remote.connectors : []
      const table = parsed?.tables?.connections
      if (table !== null && typeof table === 'object') {
        for (const record of Object.values(table)) {
          if (record !== null && typeof record === 'object' && typeof record.connectorId === 'string') {
            connectedIds.add(record.connectorId)
          }
        }
      }
    } catch {
      connectors = []
    }
    const categories = [...new Set(connectors.map(item => String(item.category ?? '')).filter(Boolean))].sort()
    const value = {
      items: connectors.map(item => ({
        id: String(item.id ?? ''),
        name: String(item.name ?? item.id ?? ''),
        vendor: String(item.vendor ?? ''),
        category: String(item.category ?? ''),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        summary: String(item.summary ?? item.description ?? ''),
        homepage: typeof item.homepage === 'string' ? item.homepage : null,
        auth: item.auth === null || item.auth === undefined ? null : String(item.auth),
        tools: Array.isArray(item.toolsSnapshot) ? item.toolsSnapshot.length : (typeof item.toolsSnapshot === 'object' && item.toolsSnapshot !== null ? Object.keys(item.toolsSnapshot).length : 0),
        connected: connectedIds.has(String(item.id ?? '')),
      })),
      total: connectors.length,
      categories,
    }
    catalogCache = { at: Date.now(), value }
    return value
  }

  function disabledOf(sessionId) {
    return disabled.get(sessionId) ?? new Set()
  }

  function setSession(sessionId, ids) {
    const set = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])
    if (set.size === 0) disabled.delete(sessionId)
    else disabled.set(sessionId, set)
    reapply()
    return [...set]
  }

  async function connectorNamesFor(agent) {
    const hidden = disabledOf(agent?.id)
    if (hidden.size === 0) return []
    const plugins = await listPlugins()
    if (plugins.length === 0) return []
    const definitions = definitionsOf()
    const names = []
    for (const definition of definitions) {
      const owner = connectorToolOwner(definition.name, plugins)
      if (owner !== undefined && hidden.has(owner.id)) names.push(definition.name)
    }
    return names
  }

  function release(agent) {
    const previous = applied.get(agent)
    if (previous === undefined) return
    applied.delete(agent)
    try {
      previous.dispose()
    } catch {
      // The agent scope may already be gone.
    }
  }

  async function applyToAgent(agent) {
    if (applying) return
    if (agent === null || typeof agent !== 'object') return
    live.add(agent)
    applying = true
    try {
      const scoped = agent?.ctx?.get?.('tools') ?? agent?.ctx?.tools
      if (scoped === null || scoped === undefined || typeof scoped.restrict !== 'function') return
      const deny = await connectorNamesFor(agent)
      const key = deny.slice().sort().join(',')
      const previous = applied.get(agent)
      if (previous !== undefined && previous.key === key) return
      release(agent)
      if (deny.length === 0) return
      try {
        applied.set(agent, { key, dispose: scoped.restrict({ deny }) })
      } catch (error) {
        ctx.logger?.warn?.('workbuddy-helper: could not restrict connector tools: %s', String(error))
      }
    } finally {
      applying = false
    }
  }

  function reapply(agent) {
    if (disposed) return
    if (agent !== undefined) return applyToAgent(agent)
    for (const candidate of live) void applyToAgent(candidate)
    try {
      const registry = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
      const listed = typeof registry?.list === 'function' ? registry.list() : []
      if (Array.isArray(listed)) {
        for (const candidate of listed) void applyToAgent(candidate)
      }
    } catch {
      // The registry is optional; lifecycle events already track agents.
    }
    return Promise.resolve()
  }

  function init() {
    if (typeof ctx?.on !== 'function') return
    const hook = (event, handler) => {
      try {
        ctx.on(event, handler)
      } catch (error) {
        ctx.logger?.warn?.('workbuddy-helper: connector hook %s failed: %s', event, String(error))
      }
    }
    hook('agent/created', payload => {
      void applyToAgent(payload?.agent)
    })
    hook('agent/disposed', payload => {
      release(payload?.agent)
      live.delete(payload?.agent)
    })
    hook('agent/pre-step', async (payload, next) => {
      try {
        await applyToAgent(payload?.agent)
      } catch {
        // A connector gate failure must never break the step.
      }
      return typeof next === 'function' ? next() : undefined
    })
    hook('tools/change', () => {
      reapply()
    })
  }

  function dispose() {
    disposed = true
    for (const agent of [...live]) release(agent)
    live.clear()
    applied.clear()
    disabled.clear()
  }

  return {
    init,
    dispose,
    get profileDir() {
      return profileDir
    },
    listPlugins,
    connectorViews,
    catalog: readCatalog,
    disabledOf,
    setSession,
    reapply,
  }
}
