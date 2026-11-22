/**
 * lib/connectors.js — 连接器注册表、连接动作与会话级工具门控。
 *
 * 这一版把连接器管理对齐到 WorkBuddy 的数据模型（逆向结论见
 * docs/workbuddy-connector-reverse-engineering.md）：
 *
 *   配置（config）  连接器的静态描述：id / 名称 / 图标 / 认证方式 / server 列表。
 *   状态（state）   运行时视图：bound / enabled / connected / connecting / pending /
 *                   reason / tools。UI 只读状态，不读配置去推断。
 *   动作（action）  connect / repairConnect / reauthorize / disconnect / unbind /
 *                   cancelConnect / updateHeaders / updateEnv。同一条连接单飞。
 *
 * 两个来源（source）：
 *   catalog  来自本机 `storages/mcp_connector.json` 的连接器目录。真正落地靠把
 *            server 写进 profile 的 cordis patch 层，由宿主的
 *            `@deepseek-ai/dsh-mcp-client` 去连（见 lib/mcp-patch.js）。
 *   plugin   已装在本 profile 的 DSH 连接器插件，工具已经由宿主注册过，只需按会话
 *            决定可见性。
 *
 * 会话门控走 `tools.restrict({ deny })`——和 `dsh-windows-mcp` 的 Computer Use
 * 开关同一机制，只在当前 agent 的工具视图上收窄，不改全局注册。
 */

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './util.js'
import { normalizeConnectResult, createOperationRegistry, tokenConfigAction, oauthHandoffAction, credentialFieldsOf, credentialsSatisfied, credentialsRequired, detectConnectorUiDeepLink, connectorUiUrl as connectorUiUrlFor } from './connector-flow.js'
import { readMcpServers, upsertMcpServers, setMcpDisabled, removeMcpServer, validateServerName } from './mcp-patch.js'

const SELF_PACKAGE = 'dsh-workbuddy-helper'
const MAX_SCAN_FILES = 120
const MAX_SCAN_BYTES = 2 * 1024 * 1024
const PLUGIN_CACHE_TTL_MS = 60 * 1000
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_PROBE_TIMEOUT_MS = 8000
const DEFAULT_PROBE_INTERVAL_MS = 250
const PATCH_FILE = 'cordis.patch.yml'
const STORE_FILE = 'connectors.json'
/** 对方存储（mcp_connector.json + grant journal）的读取缓存：134 条状态共用一次读盘。 */
const SHARED_STATE_TTL_MS = 5000
/** 管理页深链能力的探测缓存：升级 `dsh-mcp-connector` 后一分钟内自动生效。 */
const UI_CAPABILITY_TTL_MS = 60 * 1000
/** `handoff()` 里"不要深链"的哨兵值，与真实参数名区分开。 */
const DEEP_LINK_PARAM_OFF = '\u0000off'
/** 目录连接器落地到 patch 后，宿主 MCP 桥的工具前缀。 */
const MCP_PREFIX = 'mcp__'

/** 只保留字符串值：目录里的 env/headers/bindings 都应是 map<string,string>。 */
function plainStringMap(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

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

/** 目录项 `servers` 里的第一个 server，用来算工具前缀与默认传输。 */
function primaryServer(connector) {
  const list = Array.isArray(connector?.servers) ? connector.servers : []
  const first = list.find(item => item !== null && typeof item === 'object')
  if (first === undefined) return undefined
  return first
}

/**
 * 目录连接器的 patch serverName：优先复用目录里声明的 serverName，
 * 否则从连接器 id 收敛成合法 serverName（工具前缀会变成 `mcp__<name>__`）。
 */
function serverNameOf(connector) {
  const server = primaryServer(connector)
  const declared = typeof server?.serverName === 'string' ? server.serverName : ''
  const candidate = declared !== '' ? declared : String(connector?.id ?? '')
  const safe = candidate.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
  return safe === '' ? undefined : safe
}

/** 该连接器（落地到 patch 后）的工具前缀。 */
function mcpPrefixOf(connector) {
  const name = serverNameOf(connector)
  return name === undefined ? undefined : `${MCP_PREFIX}${name}__`
}

/** 认证方式归一：目录里 `auth` 是对象，历史数据里可能是字符串。 */
function authOf(connector) {
  const raw = connector?.auth
  if (raw !== null && typeof raw === 'object') {
    const mode = typeof raw.mode === 'string' && raw.mode !== '' ? raw.mode : 'none'
    return { ...raw, mode }
  }
  if (typeof raw === 'string' && raw !== '') return { mode: raw }
  return { mode: 'none' }
}

function nowMs() {
  return Date.now()
}

/**
 * 读取 `dsh-mcp-connector` 自己的存储，得到「连接器管理页里已经连接了什么」。
 *
 * 为什么需要这条桥：连接器有两套入口——本插件（写 profile patch）与
 * `dsh-mcp-connector` 的 `/mcp-connector/ui`（写 `storages/mcp_connector.json`
 * 的 connections/grants，OAuth 也由它完成）。两边都能让宿主的
 * `@deepseek-ai/dsh-mcp-client` 挂上同一批 `mcp__<serverName>__*` 工具，但状态
 * 各自存一份。不读这一份，用户明明在管理页授权成功，本插件却显示"尚未连接"。
 *
 * 只读：不写对方任何表；读不到就当没有（返回 available:false），绝不因此报错。
 * 表结构见 dsh-mcp-connector `lib/schema.js`：
 *   connections[key] = {key, connectorId, kind, auth{mode,grantKey}, serverName,
 *                        enabled, pendingAuthorization, lastError, updatedAt}
 *   grants[key]      = {key, accessToken, accessTokenExpiresAt, refreshToken,
 *                        connectorIds[], account, scope, updatedAt}
 * 另外 grants 还有跨进程日志 `storages/mcp_connector_grants_v1/<sha256(key)>.json`，
 * 内容是 `{version:1, grant:{...}}`，比表里更新，所以按 key 覆盖。
 */
async function readSharedConnectorState(dshHome) {
  const file = path.join(dshHome, 'storages', 'mcp_connector.json')
  const journalDir = path.join(dshHome, 'storages', 'mcp_connector_grants_v1')
  const empty = { available: false, file, journalDir, connections: new Map(), grants: new Map(), byConnector: new Map() }
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return empty
  }
  const tables = parsed?.tables
  const connectionsRaw = tables?.connections
  const grantsRaw = tables?.grants
  const grantMap = new Map()
  const collectGrant = grant => {
    if (grant === null || typeof grant !== 'object') return
    const key = typeof grant.key === 'string' ? grant.key : ''
    if (key !== '') grantMap.set(key, grant)
  }
  if (grantsRaw !== null && typeof grantsRaw === 'object') {
    for (const value of Object.values(grantsRaw)) collectGrant(value)
  }
  try {
    for (const name of await fs.readdir(journalDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const doc = JSON.parse(await fs.readFile(path.join(journalDir, name), 'utf8'))
        collectGrant(doc?.grant)
      } catch {
        // 单个日志文件坏了不影响整张视图：它的 grant 只是"未知"，不是"未授权"。
      }
    }
  } catch {
    // 没有 journal 目录是老版本/首次运行的常态。
  }

  const connections = new Map()
  const byConnector = new Map()
  if (connectionsRaw !== null && typeof connectionsRaw === 'object') {
    for (const value of Object.values(connectionsRaw)) {
      if (value === null || typeof value !== 'object') continue
      const key = typeof value.key === 'string' ? value.key : ''
      const connectorId = typeof value.connectorId === 'string' ? value.connectorId : ''
      if (key === '' || connectorId === '') continue
      connections.set(key, value)
      const auth = value.auth !== null && typeof value.auth === 'object' ? value.auth : {}
      const grantKey = typeof auth.grantKey === 'string' ? auth.grantKey : ''
      const grant = grantMap.get(grantKey)
      const expiresAt = Number(grant?.accessTokenExpiresAt ?? 0) || 0
      const refreshable = typeof grant?.refreshToken === 'string' && grant.refreshToken !== ''
      const authorized = auth.mode === 'oauth'
        ? (grant !== undefined && (expiresAt > nowMs() || refreshable))
        : (typeof auth.bearerToken === 'string' && auth.bearerToken !== '')
          || (typeof auth.apiKeyValue === 'string' && auth.apiKeyValue !== '')
      const entry = {
        key,
        connectorId,
        serverName: typeof value.serverName === 'string' ? value.serverName : connectorId,
        kind: typeof value.kind === 'string' ? value.kind : 'manual',
        transport: typeof value.transport === 'string' ? value.transport : null,
        authMode: typeof auth.mode === 'string' ? auth.mode : 'none',
        enabled: value.enabled !== false,
        pendingAuthorization: value.pendingAuthorization === true,
        lastError: typeof value.lastError === 'string' ? value.lastError : null,
        authorized,
        grantKey: grantKey === '' ? null : grantKey,
        grantExpiresAt: expiresAt === 0 ? null : expiresAt,
        grantExpired: expiresAt !== 0 && expiresAt <= nowMs(),
        updatedAt: Number(value.updatedAt ?? 0) || 0,
      }
      connections.set(key, entry)
      const previous = byConnector.get(connectorId)
      // 同一连接器可能有多条连接（多 server/multi-region）：保留能力最强的那个。
      if (previous === undefined || (entry.authorized && !previous.authorized) || (entry.enabled && !previous.enabled)) {
        byConnector.set(connectorId, entry)
      }
    }
  }
  return { available: true, file, journalDir, connections, grants: grantMap, byConnector }
}

/** 统计某个工具前缀下的工具名；shared 连接要按对方声明的 serverName 前缀找。 */
function toolNamesForPrefix(definitions, prefix) {
  if (prefix === undefined || prefix === '') return []
  const names = []
  for (const definition of definitions) {
    const name = typeof definition?.name === 'string' ? definition.name : ''
    if (name.startsWith(prefix)) names.push(name)
  }
  return names
}

/**
 * @param {import('./types.js').PluginContext} ctx
 * @param {{profileDir?: string, dataDir?: string, connectorUiPath?: string, publicOrigin?: string, probeTimeoutMs?: number, probeIntervalMs?: number, patchFile?: string}} [options]
 */
export function createConnectorController(ctx, options = {}) {
  const profileDir = options.profileDir
    ?? findProfileDir()
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const dataDir = options.dataDir ?? path.join(resolveDshHome(), 'workbuddy-helper')
  const patchPath = options.patchFile ?? path.join(profileDir, PATCH_FILE)
  const catalogFile = typeof options.catalogFile === 'string' && options.catalogFile !== ''
    ? options.catalogFile
    : undefined
  const connectorUiPath = options.connectorUiPath ?? '/mcp-connector/ui'
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) ? options.probeTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const probeIntervalMs = Number.isFinite(options.probeIntervalMs) ? options.probeIntervalMs : DEFAULT_PROBE_INTERVAL_MS
  const dshHome = options.dshHome ?? resolveDshHome()

  /**
   * `dsh-mcp-connector` 的 UI 目录。它可能被装在当前 profile 的 node_modules
   * （常见），也可能被提到 profiles 层共享（pnpm hoisting），两处都看。
   */
  function connectorUiHtmlDir() {
    const candidates = [
      path.join(profileDir, 'node_modules', 'dsh-mcp-connector', 'ui'),
      path.join(dshHome, 'profiles', 'node_modules', 'dsh-mcp-connector', 'ui'),
      path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-mcp-connector', 'ui'),
    ]
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, 'index.html'))) return candidate
    }
    return candidates[0]
  }

  /**
   * 连接器管理页的深链能力探测。
   *
   * 上游 `dsh-mcp-connector` 现在的 UI 不读 `?connector=`，但这件事会变，而本插件
   * 不该为了它改两次代码。做法：装 `dsh-mcp-connector` 时顺手读一次它的
   * `ui/index.html`，用 `detectConnectorUiDeepLink()` 找确凿的读取证据；找到就把
   * 参数名记下来，`connectorUiUrl()` 自动换成深链，找不到就保持"跳过去 + 让用户搜"。
   *
   * 探测是惰性且失败的（读不到 HTML 就当不支持），因为这条信息只影响体验，不该
   * 让面板打不开。结果缓存 `UI_CAPABILITY_TTL_MS`，升级包后一分钟内自动生效。
   */
  let uiCapabilityCache = { at: 0, value: undefined }
  async function uiCapability() {
    if (options.deepLinkParam === false) return { supported: false, param: null, evidence: null }
    if (typeof options.deepLinkParam === 'string' && options.deepLinkParam !== '') {
      return { supported: true, param: options.deepLinkParam, evidence: 'injected' }
    }
    const now = nowMs()
    if (uiCapabilityCache.value !== undefined && now - uiCapabilityCache.at < UI_CAPABILITY_TTL_MS) {
      return uiCapabilityCache.value
    }
    let value = { supported: false, param: null, evidence: null }
    try {
      const html = await fs.readFile(path.join(connectorUiHtmlDir(), 'index.html'), 'utf8')
      value = detectConnectorUiDeepLink(html)
    } catch {
      // 没装 dsh-mcp-connector，或它的 UI 不在预期路径：当作不支持。
    }
    uiCapabilityCache = { at: now, value }
    return value
  }

  /**
   * 连接器管理页（`dsh-mcp-connector`）那边的状态视图，带短 TTL 缓存：
   * 一次 `states()` 会问 134 次"对方连了吗"，不能每次都把那 480KB 的表读一遍。
   */
  let sharedCache = { at: 0, value: undefined }
  async function sharedState(force = false) {
    const now = nowMs()
    if (force !== true && sharedCache.value !== undefined && now - sharedCache.at < SHARED_STATE_TTL_MS) {
      return sharedCache.value
    }
    let value
    try {
      value = await readSharedConnectorState(dshHome)
    } catch (error) {
      ctx.logger?.warn?.(`[workbuddy-helper] 读取连接器管理页状态失败: ${error instanceof Error ? error.message : String(error)}`)
      value = { available: false, file: path.join(dshHome, 'storages', 'mcp_connector.json'), journalDir: '', connections: new Map(), grants: new Map(), byConnector: new Map() }
    }
    sharedCache = { at: now, value }
    return value
  }

  const disabled = new Map() // sessionId -> Set(connector id)
  const applied = new Map() // agent -> { key, dispose }
  const live = new Set()
  const operations = createOperationRegistry()
  const stateListeners = new Set()
  const applyQueue = new WeakMap() // agent -> Promise（串行化 restrict 重放）
  // tools 服务的获取有两条路：`ctx.tools` / `ctx.get('tools')` 是同步直取，
  // `ctx.inject(['tools'], …)` 是 cordis 的按需注入（宿主里更常见）。
  // 只走 inject 会让没有 ctx.inject 的环境（单元测试、老宿主）拿不到服务，
  // 于是 toolCount 恒为 0、连接器永远显示"未连接"——真实踩过这个坑。
  let toolsService = (() => {
    try {
      const direct = ctx?.tools ?? ctx?.get?.('tools')
      return direct ?? null
    } catch {
      return null
    }
  })()
  let pluginsCache
  let catalogCache
  let storeCache
  let storeQueue = Promise.resolve()
  let disposed = false

  if (toolsService === null) {
    try {
      ctx.inject?.(['tools'], scoped => {
        toolsService = scoped?.tools ?? null
      })
    } catch {
      toolsService = null
    }
  }
  void listPlugins().catch(() => {})

  // ---------------------------------------------------------------- 存储

  function storePath() {
    return path.join(dataDir, STORE_FILE)
  }

  function emptyStore() {
    return { version: 1, configs: {}, sessions: {}, uiOpens: {} }
  }

  async function loadStore() {
    if (storeCache !== undefined) return storeCache
    try {
      const parsed = JSON.parse(await fs.readFile(storePath(), 'utf8'))
      const configs = parsed !== null && typeof parsed.configs === 'object' && parsed.configs !== null ? parsed.configs : {}
      const sessions = parsed !== null && typeof parsed.sessions === 'object' && parsed.sessions !== null ? parsed.sessions : {}
      // uiOpens 是埋点记录，重启后必须还在，否则"上次去过管理页"永远读不到。
      const uiOpens = parsed !== null && typeof parsed.uiOpens === 'object' && parsed.uiOpens !== null ? parsed.uiOpens : {}
      storeCache = { version: 1, configs, sessions, uiOpens }
    } catch {
      storeCache = emptyStore()
    }
    return storeCache
  }

  /** 串行化写入：并发点击不会交错覆盖，写临时文件后 rename 保持原子性。 */
  function saveStore() {
    const snapshot = JSON.stringify(storeCache ?? emptyStore(), null, 2)
    storeQueue = storeQueue.then(async () => {
      await fs.mkdir(dataDir, { recursive: true }).catch(() => {})
      const tmp = `${storePath()}.${process.pid}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, storePath())
    }).catch(error => {
      ctx.logger?.warn?.('workbuddy-helper: could not persist connector store: %s', String(error))
    })
    return storeQueue
  }

  function defaultRecord() {
    return { bound: false, enabled: true, headers: {}, env: {}, credentials: {}, token: '', patchManaged: false, updatedAt: 0 }
  }
  /** 只读：不往存储里塞空记录，避免只为渲染状态就把 134 条目录全落盘。 */
  async function peekRecord(id) {
    const store = await loadStore()
    const record = store.configs[id]
    return record === undefined ? defaultRecord() : { ...defaultRecord(), ...record }
  }

  /** 读写：真正要改状态时才落一条记录。 */
  async function configRecord(id) {
    const store = await loadStore()
    if (store.configs[id] === undefined) store.configs[id] = defaultRecord()
    return store.configs[id]
  }

  function emitState(id) {
    if (stateListeners.size === 0) return
    const payload = { id, at: nowMs() }
    for (const listener of [...stateListeners]) {
      try {
        listener(payload)
      } catch {
        // A listener must never break a state transition.
      }
    }
  }

  // ------------------------------------------------------------ 管理页跳转埋点

  /**
   * 记一次「去连接器管理页」的跳转。
   *
   * 为什么要落盘：管理页（`dsh-mcp-connector`）不接受深链，用户点完跳转就离开了
   * 本面板；回到面板时如果没有任何痕迹，用户和排查者都无法知道"这一行已经去授权
   * 过了"，只能再点一次。所以把 `{configId, serverName, at, sessionId}` 记进
   * 本插件自己的 store（**不写对方的表**，见 AGENTS.md §8），面板下次读
   * `connectors/state` 就能显示"上次去过管理页 / 已授权"。
   *
   * 只保留每个连接器最近一次，写在 `store.uiOpens` 里；条目本身是幂等的，
   * 不改变 bound/enabled/connected 任何语义。
   */
  async function recordUiOpen(configId, params = {}) {
    const id = String(configId ?? '').trim()
    if (id === '') return null
    const store = await loadStore()
    if (store.uiOpens === undefined || store.uiOpens === null || typeof store.uiOpens !== 'object') {
      store.uiOpens = {}
    }
    const entry = {
      configId: id,
      serverName: typeof params.serverName === 'string' ? params.serverName : '',
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
      count: Number(store.uiOpens[id]?.count ?? 0) + 1,
      at: nowMs(),
    }
    store.uiOpens[id] = entry
    await saveStore()
    emitState(id)
    return entry
  }

  function uiOpenOf(id) {
    return storeCache?.uiOpens?.[id] ?? null
  }

  // ---------------------------------------------------------------- 插件与目录

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

  /**
   * 枚举当前注册的工具定义。
   *
   * 宿主 `tools` 服务的公开面是 `register/restrict/guard/view/get/schemas/schemaOf`，
   * 没有 `definitions()`（早期版本有）。只按 `definitions` 探测会让 toolCount 恒为 0、
   * 连接器永远显示"未连接"——真实踩过这个坑，这里按可用性依次回退。
   */
  function definitionsOf() {
    const service = toolsService
    if (service === null || service === undefined) return []
    try {
      if (typeof service.definitions === 'function') return service.definitions()
      if (typeof service.schemas === 'function') {
        const schemas = service.schemas()
        return Array.isArray(schemas) ? schemas.filter(schema => typeof schema?.name === 'string') : []
      }
    } catch {
      return []
    }
    return []
  }

  async function readCatalog() {
    if (catalogCache !== undefined && Date.now() - catalogCache.at < CATALOG_CACHE_TTL_MS) {
      return catalogCache.value
    }
    const file = catalogFile ?? path.join(resolveDshHome(), 'storages', 'mcp_connector.json')
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
    const raw = new Map(connectors.map(item => [String(item.id ?? ''), item]))
    const value = {
      items: connectors.map(item => {
        const auth = authOf(item)
        return {
          id: String(item.id ?? ''),
          name: String(item.name ?? item.id ?? ''),
          vendor: String(item.vendor ?? ''),
          category: String(item.category ?? ''),
          icon: typeof item.icon === 'string' ? item.icon : null,
          featured: item.featured === true,
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
          summary: String(item.summary ?? item.description ?? ''),
          homepage: typeof item.homepage === 'string' ? item.homepage : null,
          auth: auth.mode,
          authDetail: auth,
          serverName: serverNameOf(item) ?? null,
          servers: Array.isArray(item.servers) ? item.servers.map(server => ({
            serverKey: server?.serverKey ?? 'main',
            serverName: server?.serverName ?? null,
            transport: server?.transport ?? null,
            url: typeof server?.url === 'string' && server.url !== '' ? server.url : null,
            // stdio 连接器靠 command/args/env 启动，凭据通过 credentialBindings 注入 env。
            command: typeof server?.command === 'string' && server.command !== '' ? server.command : null,
            args: Array.isArray(server?.args) ? server.args.map(String) : [],
            cwd: typeof server?.cwd === 'string' && server.cwd !== '' ? server.cwd : null,
            env: plainStringMap(server?.env),
            headers: plainStringMap(server?.headers),
            credentialBindings: plainStringMap(server?.credentialBindings),
            headerCredentialBindings: plainStringMap(server?.headerCredentialBindings),
          })) : [],
          tools: Array.isArray(item.toolsSnapshot) ? item.toolsSnapshot.length : (typeof item.toolsSnapshot === 'object' && item.toolsSnapshot !== null ? Object.keys(item.toolsSnapshot).length : 0),
          connected: connectedIds.has(String(item.id ?? '')),
          source: 'catalog',
        }
      }),
      total: connectors.length,
      categories,
      raw,
    }
    catalogCache = { at: Date.now(), value }
    return value
  }

  // ---------------------------------------------------------------- 配置与状态

  /** 目录 + 插件合成一份配置表；插件优先，避免同名时被目录覆盖掉本地工具。 */
  async function configMap() {
    const [catalog, plugins] = await Promise.all([readCatalog(), listPlugins()])
    const map = new Map()
    for (const item of catalog.items) {
      if (item.id === '') continue
      map.set(item.id, {
        id: item.id,
        name: item.name,
        description: item.summary,
        summary: item.summary,
        icon: item.icon,
        vendor: item.vendor,
        category: item.category,
        tags: item.tags,
        homepage: item.homepage,
        auth: item.authDetail,
        servers: item.servers,
        serverName: item.serverName,
        tools: item.tools,
        skills: [],
        examples: [],
        source: 'catalog',
        prefix: mcpPrefixOf(catalog.raw.get(item.id)),
      })
    }
    for (const plugin of plugins) {
      map.set(plugin.id, {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        summary: plugin.description,
        icon: null,
        vendor: 'DSH 插件',
        category: '已装插件',
        tags: [plugin.packageName],
        homepage: null,
        auth: { mode: 'none' },
        servers: [],
        serverName: null,
        tools: 0,
        skills: [],
        examples: [],
        source: 'plugin',
        packageName: plugin.packageName,
        version: plugin.version,
        prefixes: plugin.prefixes,
        prefix: plugin.prefixes[0],
      })
    }
    return map
  }

  async function configs() {
    const map = await configMap()
    return { items: [...map.values()], total: map.size }
  }

  async function readPatch() {
    try {
      return { path: patchPath, content: await fs.readFile(patchPath, 'utf8'), exists: true }
    } catch {
      return { path: patchPath, content: '', exists: false }
    }
  }

  async function writePatch(content) {
    await fs.mkdir(path.dirname(patchPath), { recursive: true }).catch(() => {})
    const tmp = `${patchPath}.${process.pid}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, patchPath)
  }

  /** 目录连接器的 server 规格：把 token 折进 headers，env 原样带过去。 */
  /** 选中要落地的 server：优先带 url 或 command 的那条。 */
  function pickServer(config) {
    const servers = Array.isArray(config.servers) ? config.servers : []
    return servers.find(item =>
      (typeof item.url === 'string' && item.url !== '')
      || (typeof item.command === 'string' && item.command !== '')
    ) ?? servers[0] ?? {}
  }

  /**
   * 把目录条目 + 本地凭据折叠成一条 MCP server 配置（armory 的 patch 约定）。
   *
   * 凭据投放位置由目录声明决定，不是猜的：
   *   stdio   → server.credentialBindings {ENV_NAME: fieldKey} 注入 env
   *   http    → server.headerCredentialBindings {Header: fieldKey} 注入 headers
   *             没有绑定表时按 auth.mode 落到 apiKeyHeader 或 Authorization: Bearer
   */
  function specFor(config, record) {
    const server = pickServer(config)
    const auth = config.auth ?? { mode: 'none' }
    const fieldKeys = credentialFieldsOf(config).map(field => field.key)
    const primaryKey = fieldKeys[0] ?? 'token'

    const credentials = { ...(record.credentials ?? {}) }
    if (typeof record.token === 'string' && record.token !== '' && typeof credentials[primaryKey] !== 'string') {
      credentials[primaryKey] = record.token
    }
    const primary = typeof credentials[primaryKey] === 'string' ? credentials[primaryKey] : ''

    const name = validateServerName(
      server.serverName
      ?? config.serverName
      ?? config.id.replace(/[^A-Za-z0-9_-]/g, '-')
    )

    if (typeof server.command === 'string' && server.command !== '') {
      const env = { ...plainStringMap(server.env), ...plainStringMap(record.env) }
      for (const [envName, fieldKey] of Object.entries(plainStringMap(server.credentialBindings))) {
        const value = credentials[fieldKey]
        if (typeof value === 'string' && value !== '') env[envName] = value
      }
      const spec = {
        name,
        transport: 'stdio',
        command: server.command,
        args: Array.isArray(server.args) ? server.args.map(String) : [],
        env,
      }
      if (typeof server.cwd === 'string' && server.cwd !== '') spec.cwd = server.cwd
      return spec
    }

    if (typeof server.url === 'string' && server.url !== '') {
      const headers = { ...plainStringMap(server.headers), ...plainStringMap(record.headers) }
      delete headers.__headerName
      const bindings = plainStringMap(server.headerCredentialBindings)
      if (Object.keys(bindings).length > 0) {
        for (const [headerName, fieldKey] of Object.entries(bindings)) {
          const value = credentials[fieldKey]
          if (typeof value === 'string' && value !== '') headers[headerName] = value
        }
      } else if (primary !== '') {
        const override = typeof record.headers?.__headerName === 'string' ? record.headers.__headerName : ''
        if (auth.mode === 'bearer') {
          headers.Authorization = `Bearer ${primary.replace(/^Bearer\s+/i, '')}`
        } else {
          const headerName = override !== '' ? override : (typeof auth.apiKeyHeader === 'string' && auth.apiKeyHeader !== '' ? auth.apiKeyHeader : 'X-Api-Key')
          headers[headerName] = primary
        }
      }
      return {
        name,
        transport: server.transport ?? 'streamable-http',
        url: server.url,
        headers,
      }
    }

    throw new Error(`连接器 ${config.id} 的目录条目既没有 url 也没有 command`)
  }

  function toolNamesFor(config, definitions) {
    if (config.source === 'plugin') {
      const names = []
      for (const definition of definitions) {
        const owner = connectorToolOwner(definition.name, [{ id: config.id, prefixes: config.prefixes ?? [] }])
        if (owner !== undefined) names.push(definition.name)
      }
      return names
    }
    if (typeof config.prefix === 'string' && config.prefix !== '') {
      return definitions.filter(definition => definition.name.startsWith(config.prefix)).map(definition => definition.name)
    }
    return []
  }

  function isSessionEnabled(sessionId, id) {
    return !disabledOf(sessionId).has(id)
  }

  async function stateOf(id, sessionId, overrides) {
    const state = await computeState(id, sessionId)
    if (state === undefined || overrides === undefined) return state
    return { ...state, ...overrides }
  }

  async function computeState(id, sessionId, provided, shared) {
    const map = await configMap()
    const config = map.get(id)
    if (config === undefined) return undefined
    const record = await peekRecord(id)
    // 一次 states() 会算 134 条，definitions 与 shared 由调用方共享，避免重复深拷贝/重复读盘。
    const definitions = Array.isArray(provided) ? provided : definitionsOf()
    const tools = toolNamesFor(config, definitions)
    const op = operations.pending().includes(id)
    const enabled = record.enabled !== false && isSessionEnabled(sessionId, id)
    const base = {
      configId: id,
      source: config.source,
      bound: record.bound === true,
      enabled: record.enabled !== false,
      connected: false,
      connecting: op,
      pending: op,
      reason: null,
      toolCount: tools.length,
      tools: tools.slice(0, 12),
      authMode: config.auth?.mode ?? 'none',
      credentialReady: credentialsSatisfied(config, record.credentials),
      updatedAt: record.updatedAt ?? 0,
      // 用户上次从本面板跳到连接器管理页的记录（没有就是 null）。管理页不接受
      // 深链，所以"去过没有"只能由我们自己记；这条不参与 connected 判定。
      uiOpen: uiOpenOf(id),
    }
    if (!enabled) return { ...base, reason: { code: record.enabled === false ? 'disabled' : 'session-disabled', message: record.enabled === false ? '连接器已停用' : '本会话已停用该连接器' } }
    if (config.source === 'plugin') {
      const connected = tools.length > 0
      return {
        ...base,
        connected,
        reason: connected ? null : { code: 'no-tools', message: '插件已安装但宿主尚未注册工具' },
      }
    }
    // 桥接：连接可能由 `dsh-mcp-connector` 的管理页建立（OAuth 也在那边完成）。
    // 本插件没写过 patch，但对方已经连上——按对方声明的 serverName 数工具，
    // 让"管理页已连接"这件事在同一个状态视图里显形，而不是显示"尚未连接"。
    const sharedView = shared ?? await sharedState()
    const externalEntry = record.bound === true ? undefined : sharedView?.byConnector?.get(id)
    if (externalEntry !== undefined && externalEntry.enabled) {
      const externalTools = toolNamesForPrefix(definitions, `${MCP_PREFIX}${externalEntry.serverName}__`)
      const connected = externalTools.length > 0
      const external = {
        via: 'connector-ui',
        serverName: externalEntry.serverName,
        key: externalEntry.key,
        kind: externalEntry.kind,
        transport: externalEntry.transport,
        authMode: externalEntry.authMode,
        authorized: externalEntry.authorized,
        grantExpiresAt: externalEntry.grantExpiresAt,
        grantExpired: externalEntry.grantExpired,
        pendingAuthorization: externalEntry.pendingAuthorization,
        lastError: externalEntry.lastError,
      }
      let reason = null
      if (externalEntry.pendingAuthorization) {
        reason = { code: 'authorize', message: '连接器管理页正在等待授权完成' }
      } else if (externalEntry.lastError !== null) {
        reason = { code: 'error', message: externalEntry.lastError }
      } else if (!externalEntry.authorized && externalEntry.authMode === 'oauth') {
        reason = { code: 'authorize', message: '连接器管理页里还没有有效授权，去那边完成授权' }
      } else if (!connected) {
        reason = {
          code: 'no-tools',
          message: '连接器管理页已连接，但宿主当前没有暴露它的工具（可能处于按会话激活模式）',
        }
      }
      return {
        ...base,
        source: 'shared',
        bound: true,
        connected,
        authMode: externalEntry.authMode,
        toolCount: externalTools.length,
        tools: externalTools.slice(0, 12),
        external,
        reason,
      }
    }
    // 工具已经出现在宿主视图里就是真的连上了：运行时的注册结果比本地 record 更权威。
    // record.bound 只表示"我们写过连接意图"，patch 可能由别的 profile/上一次会话落地。
    if (tools.length > 0) return { ...base, connected: true, reason: null }
    if (record.bound !== true) return { ...base, reason: { code: 'unbound', message: '尚未连接' } }
    return { ...base, reason: { code: 'restart-required', message: '连接配置已写入 profile，重启 DSH 后生效' } }
  }

  async function states(sessionId) {
    const map = await configMap()
    const definitions = definitionsOf()
    const shared = await sharedState()
    const out = {}
    for (const id of map.keys()) {
      const state = await computeState(id, sessionId, definitions, shared)
      if (state !== undefined) out[id] = state
    }
    return out
  }

  // ---------------------------------------------------------------- 会话门控

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
    const sessionHidden = disabledOf(agent?.id)
    const map = await configMap()
    if (map.size === 0) return []
    const store = await loadStore()
    // 全局停用（record.enabled === false）也必须让工具从会话里消失，
    // 否则"停用"只是个显示状态，模型照样能调到工具。
    const hidden = new Set(sessionHidden)
    for (const [id, record] of Object.entries(store.configs ?? {})) {
      if (record !== null && typeof record === 'object' && record.enabled === false) hidden.add(id)
    }
    if (hidden.size === 0) return []
    const definitions = definitionsOf()
    const names = []
    for (const id of hidden) {
      const config = map.get(id)
      if (config === undefined) continue
      names.push(...toolNamesFor(config, definitions))
    }
    return [...new Set(names)]
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

  /**
   * 按 agent 串行化地重放工具限制。
   *
   * 旧实现用一个模块级 `applying` 布尔做重入保护：`setSession()` 自己会调一次
   * `reapply()`，紧接着调用方的 `reapply(agent)` 就会命中这个布尔而直接返回，
   * 于是"取消本会话停用"这类真实变更被静默丢掉——deny 一直是旧的。
   * 这里改成每个 agent 一条 promise 队列：并发调用排队，谁也不会被吞。
   */
  function applyToAgent(agent) {
    if (disposed) return Promise.resolve()
    if (agent === null || typeof agent !== 'object') return Promise.resolve()
    live.add(agent)
    const tail = applyQueue.get(agent) ?? Promise.resolve()
    const next = tail
      .then(() => applyNow(agent))
      .catch(error => {
        ctx.logger?.warn?.('workbuddy-helper: could not restrict connector tools: %s', String(error))
      })
    applyQueue.set(agent, next)
    return next
  }

  async function applyNow(agent) {
    const scoped = agent?.ctx?.get?.('tools') ?? agent?.ctx?.tools
    if (scoped === null || scoped === undefined || typeof scoped.restrict !== 'function') return
    const deny = await connectorNamesFor(agent)
    const key = deny.slice().sort().join(',')
    const previous = applied.get(agent)
    if (previous !== undefined && previous.key === key) return
    release(agent)
    if (deny.length === 0) return
    applied.set(agent, { key, dispose: scoped.restrict({ deny }) })
  }

  function reapply(agent) {
    if (disposed) return
    if (agent !== undefined) return applyToAgent(agent)
    // Only agents seen through lifecycle events are tracked. Calling
    // ctx.get('agents') from a plugin scope that may already be inactive
    // throws "cannot get required service ... in inactive context" during
    // hot reloads, so never use the registry as a safety net here.
    for (const candidate of live) void applyToAgent(candidate)
    return Promise.resolve()
  }

  // ---------------------------------------------------------------- 连接动作

  async function waitForTools(config, timeoutMs) {
    const started = nowMs()
    for (;;) {
      const tools = toolNamesFor(config, definitionsOf())
      if (tools.length > 0) return tools
      if (nowMs() - started >= timeoutMs) return []
      await new Promise(resolve => setTimeout(resolve, probeIntervalMs))
    }
  }

  function handoff(config, capability) {
    const origin = typeof options.publicOrigin === 'string' ? options.publicOrigin.replace(/\/$/, '') : ''
    const base = origin === '' ? connectorUiPath : `${origin}${connectorUiPath}`
    // 管理页支持深链时直接把 id 带过去；不支持就保持原样，靠 connectorUiHint 让
    // 用户搜索——两种情况上层看到的结构一致，只是 url 里多一个参数。
    const deepLinkParam = capability !== undefined && capability.supported === true
      ? capability.param
      : DEEP_LINK_PARAM_OFF
    const url = deepLinkParam === DEEP_LINK_PARAM_OFF
      ? base
      : connectorUiUrlFor({
        base,
        serverName: typeof config?.serverName === 'string' ? config.serverName : '',
        configId: typeof config?.id === 'string' ? config.id : '',
        deepLinkParam,
      })
    return oauthHandoffAction(config, { url, nextAction: 'redirect', expireAt: nowMs() + 300000 })
  }

  /**
   * 连接一条连接器。WorkBuddy 语义：同一条连接同时只有一个动作在跑。
   * @param {string} id
   * @param {{action?: string, token?: string, header?: string, headers?: Record<string,string>, env?: Record<string,string>}} [input]
   */
  async function connect(id, input = {}) {
    const map = await configMap()
    const config = map.get(id)
    const claim = operations.claim(id, { action: input.action })
    if (!claim.granted) {
      return normalizeConnectResult({ requestId: claim.requestId, connecting: true, state: await stateOf(id, undefined) })
    }
    const { opId, requestId } = claim
    const stillCurrent = () => operations.isCurrent(id, opId)
    try {
      if (config === undefined) {
        return normalizeConnectResult({ requestId, error: new Error(`未知连接器：${id}`) })
      }
      // 只有 oauth 交接才需要它，但探测本身是缓存 + 失败即"不支持"，代价可忽略。
      const capability = await uiCapability()
      // 桥接的前置判断：这条连接如果已经由连接器管理页建好，就不要再写一份 patch。
      // 同一个 serverName 写两处，重启后两份配置会互相覆盖，谁后加载谁说了算。
      const externalEntry = config.source === 'catalog'
        ? (await sharedState())?.byConnector?.get(id)
        : undefined
      if (externalEntry !== undefined && externalEntry.enabled) {
        const settledState = await stateOf(id, input.sessionId, { connecting: false, pending: false })
        if (settledState?.connected === true) {
          return normalizeConnectResult({ requestId, success: true, state: settledState })
        }
        if (externalEntry.authMode === 'oauth' && externalEntry.authorized !== true) {
          return normalizeConnectResult({
            requestId,
            needsAuth: true,
            authStart: handoff(config, capability),
            state: settledState,
          })
        }
        return normalizeConnectResult({
          requestId,
          error: new Error(
            `该连接器由连接器管理页（${connectorUiPath}）管理，请在那里完成连接或修复；`
            + `本插件不改写它的配置（serverName: ${externalEntry.serverName}）`,
          ),
          state: settledState,
        })
      }
      const record = await configRecord(id)
      const sessionId = input.sessionId

      // 显式补进来的凭据优先落库，再谈连接。字段名取自目录的 credentialFields。
      const primaryKey = credentialFieldsOf(config)[0]?.key ?? 'token'
      if (input.credentials !== null && typeof input.credentials === 'object') {
        record.credentials = { ...plainStringMap(record.credentials), ...plainStringMap(input.credentials) }
      }
      if (typeof input.token === 'string' && input.token.trim() !== '') {
        record.credentials = { ...plainStringMap(record.credentials), [primaryKey]: input.token.trim() }
        record.token = input.token.trim()
      }
      if (typeof input.header === 'string' && input.header.trim() !== '') {
        record.headers = { ...(record.headers ?? {}), __headerName: input.header.trim() }
      }
      if (input.headers !== undefined) record.headers = { ...(record.headers ?? {}), ...input.headers }
      if (input.env !== undefined) record.env = { ...(record.env ?? {}), ...input.env }

      if (config.source === 'plugin') {
        record.bound = true
        record.enabled = true
        record.updatedAt = nowMs()
        await saveStore()
        if (typeof sessionId === 'string') {
          const next = new Set(disabledOf(sessionId))
          next.delete(id)
          setSession(sessionId, [...next])
        }
        const tools = await waitForTools(config, probeTimeoutMs)
        if (!stillCurrent()) return normalizeConnectResult({ requestId, cancelled: true })
        emitState(id)
        if (tools.length > 0) return normalizeConnectResult({ requestId, success: true, state: await stateOf(id, sessionId) })
        return normalizeConnectResult({ requestId, error: new Error('插件已启用，但宿主没有注册任何工具'), state: await stateOf(id, sessionId) })
      }

      // 目录连接器：OAuth 走授权页；token 类要有凭据；其余直接落 patch。
      const auth = config.auth ?? { mode: 'none' }
      const settled = { connecting: false, pending: false }
      if (auth.mode === 'oauth2-pkce' && record.bound !== true) {
        return normalizeConnectResult({ requestId, needsAuth: true, authStart: handoff(config, capability), state: await stateOf(id, sessionId, settled) })
      }
      // 走到这一步说明本次动作自己就持有 pending 位，早退状态里不该再显示"连接中"。
      if (credentialsRequired(config) && !credentialsSatisfied(config, record.credentials)) {
        return normalizeConnectResult({
          requestId,
          needsTokenConfig: true,
          form: tokenConfigAction(config, { existing: record }),
          state: await stateOf(id, sessionId, settled),
        })
      }

      // specFor 已经把凭据按目录声明的绑定位置折叠进 headers/env。
      const spec = specFor(config, record)
      const patch = await readPatch()
      const written = upsertMcpServers(patch.content, [spec])
      if (!stillCurrent()) return normalizeConnectResult({ requestId, cancelled: true })
      await writePatch(written.content)
      record.bound = true
      record.enabled = true
      record.patchManaged = true
      record.patchName = spec.name
      record.updatedAt = nowMs()
      delete record.lastReason
      await saveStore()
      emitState(id)

      const probed = { ...config, prefix: `${MCP_PREFIX}${spec.name}__` }
      const tools = await waitForTools(probed, probeTimeoutMs)
      if (!stillCurrent()) return normalizeConnectResult({ requestId, cancelled: true })
      if (tools.length > 0) {
        return normalizeConnectResult({ requestId, success: true, state: await stateOf(id, sessionId) })
      }
      // patch 已写但宿主尚未挂载：这是"待重启"，不是失败。
      record.lastReason = { code: 'restart-required', message: '连接配置已写入 profile，重启 DSH 后生效' }
      await saveStore()
      return normalizeConnectResult({ requestId, connecting: true, state: await stateOf(id, sessionId, { connecting: false, pending: false }) })
    } catch (error) {
      emitState(id)
      return normalizeConnectResult({ requestId, error })
    } finally {
      operations.release(id, opId)
    }
  }

  async function repairConnect(id, input = {}) {
    return connect(id, { ...input, action: 'repairConnect' })
  }

  async function cancelConnect(id) {
    const cancelled = operations.cancel(id)
    if (cancelled === undefined) {
      return normalizeConnectResult({ error: new Error('没有正在进行的连接动作') })
    }
    emitState(id)
    return normalizeConnectResult({ requestId: cancelled.requestId, cancelled: true, state: await stateOf(id, undefined) })
  }

  async function disconnect(id) {
    const map = await configMap()
    const config = map.get(id)
    if (config === undefined) return normalizeConnectResult({ error: new Error(`未知连接器：${id}`) })
    // 管理页建立的连接，凭据与 patch 都在对方那边：本地删不掉，也不该假装删掉了。
    const externalEntry = config.source === 'catalog'
      ? (await sharedState(true))?.byConnector?.get(id)
      : undefined
    if (externalEntry !== undefined) {
      return normalizeConnectResult({
        error: new Error(
          `该连接由连接器管理页（${connectorUiPath}）建立，请在那边断开（key: ${externalEntry.key}）`,
        ),
        state: await stateOf(id, undefined),
      })
    }
    const record = await configRecord(id)
    try {
      if (record.patchManaged === true && typeof record.patchName === 'string') {
        const patch = await readPatch()
        const result = removeMcpServer(patch.content, record.patchName)
        if (result.removed) await writePatch(result.content)
      }
      record.bound = false
      record.patchManaged = false
      record.lastReason = { code: 'unbound', message: '尚未连接' }
      record.updatedAt = nowMs()
      await saveStore()
      emitState(id)
      return normalizeConnectResult({ disconnected: true, state: await stateOf(id, undefined) })
    } catch (error) {
      return normalizeConnectResult({ error })
    }
  }

  /** 解绑：撤销本地凭据 + 断开 + 清掉 patch 残留。 */
  async function unbind(id) {
    const map = await configMap()
    const config = map.get(id)
    const externalEntry = config !== undefined && config.source === 'catalog'
      ? (await sharedState(true))?.byConnector?.get(id)
      : undefined
    if (externalEntry !== undefined) {
      // 本地没有凭据可清；远端 revoke 属于管理页的职责，这里只把话说清楚。
      return normalizeConnectResult({
        error: new Error(
          `该连接由连接器管理页（${connectorUiPath}）持有授权，解绑请在那边操作，否则远端 token 仍有效`,
        ),
        state: await stateOf(id, undefined),
      })
    }
    const record = await configRecord(id)
    record.token = ''
    record.headers = {}
    record.env = {}
    await saveStore()
    const result = await disconnect(id)
    emitState(id)
    return result
  }

  async function updateHeaders(id, headers) {
    const record = await configRecord(id)
    record.headers = headers !== null && typeof headers === 'object' ? { ...headers } : {}
    record.updatedAt = nowMs()
    await saveStore()
    if (record.bound === true && record.patchManaged === true && typeof record.patchName === 'string') {
      return connect(id, { action: 'repairConnect' })
    }
    emitState(id)
    return normalizeConnectResult({ success: true, state: await stateOf(id, undefined) })
  }

  async function updateEnv(id, env) {
    const record = await configRecord(id)
    record.env = env !== null && typeof env === 'object' ? { ...env } : {}
    record.updatedAt = nowMs()
    await saveStore()
    if (record.bound === true && record.patchManaged === true && typeof record.patchName === 'string') {
      return connect(id, { action: 'repairConnect' })
    }
    emitState(id)
    return normalizeConnectResult({ success: true, state: await stateOf(id, undefined) })
  }

  /** 会话内启用/停用一条连接器（不写 patch，只影响当前会话可见性）。 */
  async function setEnabled(id, enabled, sessionId) {
    const record = await configRecord(id)
    record.enabled = enabled !== false
    record.updatedAt = nowMs()
    await saveStore()
    if (typeof sessionId === 'string') {
      const next = new Set(disabledOf(sessionId))
      if (enabled === false) next.add(id)
      else next.delete(id)
      setSession(sessionId, [...next])
    }
    emitState(id)
    return { id, enabled: record.enabled, disabled: [...disabledOf(sessionId)] }
  }

  async function setPatchedDisabled(id, disabledFlag) {
    const record = await configRecord(id)
    if (record.patchManaged !== true || typeof record.patchName !== 'string') {
      throw new Error(`连接器 ${id} 没有受管的 patch 条目`)
    }
    const patch = await readPatch()
    const content = setMcpDisabled(patch.content, record.patchName, disabledFlag === true)
    await writePatch(content)
    record.enabled = disabledFlag !== true
    record.updatedAt = nowMs()
    await saveStore()
    emitState(id)
    return { id, disabled: disabledFlag === true }
  }

  // ---------------------------------------------------------------- 目录网关

  function matchQuery(item, query) {
    if (query === '') return true
    return [item.id, item.name, item.vendor, item.summary, item.category, ...(item.tags ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(query)
  }

  /** 等价于 WorkBuddy 的 `createConnectorCatalogGateway`：list / listPage / search / lookup。 */
  function gateway() {
    return {
      async list({ query = '', category, page = 1, pageSize = 24, includeStateful = false, sessionId } = {}) {
        const { items } = await configs()
        const needle = String(query).trim().toLowerCase()
        const filtered = items
          .filter(item => category === undefined || item.category === category)
          .filter(item => matchQuery(item, needle))
        const start = (page - 1) * pageSize
        const slice = filtered.slice(start, start + pageSize)
        const pageItems = includeStateful
          ? await Promise.all(slice.map(async item => ({ ...item, state: await stateOf(item.id, sessionId) })))
          : slice
        return {
          items: pageItems,
          total: filtered.length,
          page,
          pageSize,
          hasMore: start + pageSize < filtered.length,
        }
      },
      async listPage(start = 0, limit = 50, { includeStateful = false, sessionId } = {}) {
        const { items } = await configs()
        const slice = items.slice(start, start + limit)
        const pageItems = includeStateful
          ? await Promise.all(slice.map(async item => ({ ...item, state: await stateOf(item.id, sessionId) })))
          : slice
        return { items: pageItems, total: items.length, start, limit, hasMore: start + limit < items.length }
      },
      async search(query, { limit = 20, sessionId } = {}) {
        const needle = String(query ?? '').trim().toLowerCase()
        const { items } = await configs()
        const hits = items.filter(item => matchQuery(item, needle)).slice(0, limit)
        return { items: await Promise.all(hits.map(async item => ({ ...item, state: await stateOf(item.id, sessionId) }))), total: hits.length }
      },
      async lookup(ids, { sessionId } = {}) {
        const map = await configMap()
        const items = []
        for (const id of Array.isArray(ids) ? ids : []) {
          const config = map.get(id)
          if (config === undefined) continue
          items.push({ ...config, state: await stateOf(id, sessionId) })
        }
        return { items, total: items.length }
      },
    }
  }

  // ---------------------------------------------------------------- 视图（兼容旧调用）

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

  // ---------------------------------------------------------------- 生命周期

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

  function onStateChange(listener) {
    if (typeof listener !== 'function') return () => {}
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  }

  function dispose() {
    disposed = true
    for (const agent of [...live]) release(agent)
    live.clear()
    applied.clear()
    disabled.clear()
    stateListeners.clear()
    operations.reset()
  }

  return {
    init,
    dispose,
    get profileDir() {
      return profileDir
    },
    get patchPath() {
      return patchPath
    },
    get dataDir() {
      return dataDir
    },
    listPlugins,
    connectorViews,
    catalog: readCatalog,
    configs,
    states,
    /** 连接器管理页（dsh-mcp-connector）的存储视图，供工具/UI 排查"为什么显示已连接"。 */
    shared: () => sharedState(true),
    /** 管理页是否已支持按 id 深链；面板据此决定提示文案与跳转参数。 */
    uiCapability,
    stateOf,
    gateway,
    connect,
    repairConnect,
    cancelConnect,
    disconnect,
    unbind,
    updateHeaders,
    updateEnv,
    setEnabled,
    setPatchedDisabled,
    recordUiOpen,
    onStateChange,
    pendingOperations: () => operations.pending(),
    disabledOf,
    setSession,
    reapply,
  }
}
