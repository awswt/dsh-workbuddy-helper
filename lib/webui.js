import { AuthError } from './auth.js'
import { connectorUiHint, connectorUiUrl } from './connector-flow.js'
import { installSkill, listInstalledSkills } from './skill-install.js'

const PREFIX = '/dsh-workbuddy-helper'
/**
 * 一个进程里 webServer 是共享的，而插件热重载会重新执行 registerWebUi：上一轮
 * 注册时拿到的 dispose 函数只存在于上一轮的闭包里。把 release 挂在 webServer 上，
 * 新一轮就能先撤掉旧路由——否则 webServer.register 因路径重复抛错，宿主继续用
 * 那个已经 dispose 掉的 handler 应答。
 */
const routeOwners = new WeakMap()
const ROUTES = {
  state: `${PREFIX}/state`,
  experts: `${PREFIX}/experts`,
  connectors: `${PREFIX}/connectors`,
  connectorsSession: `${PREFIX}/connectors/session`,
  connectorsAction: `${PREFIX}/connectors/action`,
  connectorsState: `${PREFIX}/connectors/state`,
  skillMarket: `${PREFIX}/skill-market`,
  skillInstall: `${PREFIX}/skill-install`,
  select: `${PREFIX}/select`,
  skills: `${PREFIX}/skills`,
  off: `${PREFIX}/off`,
}
const MAX_BODY_BYTES = 64 * 1024
const CATEGORY_TTL_MS = 10 * 60 * 1000

function send(response, status, body) {
  try {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  } catch {
    // The socket may already be gone; there is nothing useful to do.
  }
}

function readBody(request) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let failed = false
    request.on('data', chunk => {
      if (failed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        request.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (failed) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => {
      if (!failed) {
        failed = true
        resolve(undefined)
      }
    })
  })
}

function sessionIdOf(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '' || text.length > 256) return undefined
  return text
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function list(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : undefined
}

/**
 * Same-origin guard for the two write routes.
 *
 * A browser always sends `Origin` on a cross-site POST. Requiring it to match
 * `Host` keeps a random web page from switching experts in the local DSH
 * window, without needing the browser-session cookie (which headless hosts do
 * not mint).
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function createCategoryCache(market) {
  let cache
  return async () => {
    if (cache !== undefined && Date.now() - cache.at < CATEGORY_TTL_MS) return cache.value
    let value = []
    try {
      value = await market.categories()
    } catch {
      value = []
    }
    cache = { at: Date.now(), value }
    return value
  }
}

function matchesLocal(item, query, categoryId) {
  if (categoryId !== undefined && item.categoryId !== categoryId) return false
  if (query === '') return true
  return [
    item.id,
    item.plugin,
    item.agentName,
    item.displayName,
    item.profession,
    item.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

/**
 * Merge the live market with locally installed experts.
 *
 * Remote rows win on plugin name so the UI shows the market metadata; a local
 * install only adds `installed: true` instead of a duplicate row.
 */
function mergeExperts(remoteItems, localItems, query, categoryId) {
  const localPlugins = new Set(localItems.map(item => item.plugin))
  const remote = remoteItems.map(item => ({
    ...item,
    installed: localPlugins.has(item.plugin),
  }))
  const localOnly = localItems
    .filter(item => !remote.some(row => row.plugin === item.plugin || row.id === item.id))
    .filter(item => matchesLocal(item, query, categoryId))
    .map(item => ({
      ...item,
      source: 'local',
      installed: true,
      marketExpertId: null,
      avatar: null,
    }))
  return [...localOnly, ...remote]
}

/**
 * Register the composer panel's JSON routes on the shared DSH web server.
 *
 * The client half is served from the same origin, so relative `fetch` calls
 * carry the host's session and no CORS handling is needed.
 */
export function registerWebUi(ctx, deps) {
  if (typeof ctx?.inject !== 'function') return
  const categories = createCategoryCache(deps.market)
  ctx.logger?.info?.('workbuddy-helper: registering web UI routes')
  const routeDisposers = []
  const releaseRoutes = () => {
    while (routeDisposers.length > 0) {
      const dispose = routeDisposers.pop()
      try {
        dispose()
      } catch {
        // A route may already have been removed by the host.
      }
    }
  }
  try {
    ctx.inject(['webServer'], scoped => {
      const webServer = scoped?.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger?.warn?.('workbuddy-helper: webServer.register is unavailable')
        return
      }
      // HMR / plugin reload tears down the old fiber but keeps the shared
      // webServer alive. Dispose our previous routes first, then make sure the
      // new scoped context releases these routes when it goes inactive;
      // otherwise stale handlers keep answering with a disposed ctx and the
      // panel sees "cannot get required service ... in inactive context".
      // The previous call's disposers live on the webServer itself, because a
      // reload builds a NEW closure and would otherwise lose track of them —
      // then the second register() hits "duplicate route" and the host keeps
      // serving the dead handler.
      const priorRelease = routeOwners.get(webServer)
      if (typeof priorRelease === 'function') {
        try {
          priorRelease()
        } catch {
          // already released
        }
      }
      routeOwners.set(webServer, releaseRoutes)
      // Older versions of this plugin never released their registrations. The
      // host's exact table is a plain Map in JS; evict stale entries owned by
      // this PREFIX so a reload in an already-running process self-heals
      // without a full DSH restart. Never touch routes from other plugins.
      try {
        const table = webServer.exact
        if (table instanceof Map) {
          for (const key of [...table.keys()]) {
            if (typeof key === 'string' && key.startsWith(PREFIX)) table.delete(key)
          }
        }
      } catch {
        // Host internals are optional; the normal dispose path still works.
      }
      try {
        if (typeof scoped.effect === 'function') {
          scoped.effect(() => () => releaseRoutes(), 'workbuddy-helper: web routes')
        }
      } catch {
        // Older hosts may not expose effect on the injected scope; the root
        // context effect below still covers plugin unload.
      }
      const register = route => {
        const dispose = webServer.register(route)
        if (typeof dispose === 'function') routeDisposers.push(dispose)
        return dispose
      }
      try {
      /**
       * 技能安装根目录：优先会话自身的工作区。
       * `<workspace>/.dsh/skills` 正是 dsh-skill-filesystem 的 project-dsh 根
       * （该包 lib/index.js:150-165），写进去下一轮 `<available_skills>` 就能发现；
       * 只有拿不到会话 cwd 时才退回服务端进程目录。
       */
      const workspaceOf = sessionId => {
        const agent = sessionId === undefined ? undefined : deps.sessions.getAgent?.(sessionId)
        const cwd = agent?.session?.header?.cwd
        return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd()
      }

      const panelState = async sessionId => {
        const state = await deps.sessions.panelState(sessionId)
        const [items, marketTotal, portalAvailable, connectorStatus, connectorsView] = await Promise.all([
          categories(),
          deps.market.marketSize().catch(() => null),
          deps.portal?.available?.().catch(() => false) ?? false,
          deps.connector.status().catch(() => undefined),
          connectorSummary(sessionId),
        ])
        return {
          ...state,
          categories: items,
          market: {
            source: portalAvailable ? 'portal' : 'cos',
            marketTotal,
            portalAvailable,
          },
          connector: connectorStatus === undefined ? null : {
            installed: connectorStatus.installed,
            accountCount: connectorStatus.accountCount,
            usableAccountCount: connectorStatus.usableAccountCount,
          },
          connectors: connectorsView,
        }
      }

      /** 连接器目录：优先 WorkBuddy 连接器市场（需要登录态），失败退回本地快照。 */
      async function catalogSummary() {
        try {
          const market = await deps.portal.listBuddyConnectors({ page: 1, pageSize: 1 })
          return { count: market.total, source: 'workbuddy' }
        } catch {
          try {
            const local = await deps.connectors.catalog()
            return { count: local.total, source: 'local' }
          } catch {
            return { count: 0, source: 'none' }
          }
        }
      }

      async function connectorSummary(sessionId) {
        const controller = deps.connectors
        if (controller === undefined) {
          return { disabled: [], pluginCount: 0, catalogCount: 0, catalogSource: 'none', connectedCount: 0, boundCount: 0 }
        }
        const [plugins, catalogInfo, stateMap] = await Promise.all([
          Promise.resolve().then(() => controller.connectorViews()).catch(() => ({ items: [], total: 0 })),
          catalogSummary(),
          Promise.resolve().then(() => controller.states?.(sessionId)).catch(() => ({})),
        ])
        const states = Object.values(stateMap ?? {})
        return {
          disabled: [...controller.disabledOf(sessionId)],
          pluginCount: plugins.total ?? plugins.items.length,
          catalogCount: catalogInfo.count,
          catalogSource: catalogInfo.source,
          connectedCount: states.filter(state => state?.connected === true).length,
          boundCount: states.filter(state => state?.bound === true).length,
        }
      }

      const handle = fn => async (request, response) => {
        try {
          await fn(request, response)
        } catch (error) {
          if (error instanceof AuthError) {
            send(response, 401, { ok: false, error: `${error.code}: ${error.message}` })
            return
          }
          send(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      register({
        kind: 'exact',
        path: ROUTES.state,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          if (sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectors,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const controller = deps.connectors
          if (controller === undefined) {
            send(response, 200, { ok: true, view: 'plugins', items: [], total: 0, disabled: [] })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const view = url.searchParams.get('view') === 'catalog' ? 'catalog' : 'plugins'
          const query = text(url.searchParams.get('query')).trim().toLowerCase()
          const category = text(url.searchParams.get('category')).trim() || undefined
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
          const pageSize = Math.max(1, Math.min(Number(url.searchParams.get('pageSize') ?? 24) || 24, 60))

          if (view === 'catalog') {
            let source = 'workbuddy'
            let items = []
            let total = 0
            let categories = []
            let hasMore = false
            try {
              const market = await deps.portal.listBuddyConnectors({ query, page, pageSize })
              items = market.items
              total = market.total
              hasMore = market.hasMore === true
            } catch (error) {
              ctx.logger?.warn?.('workbuddy-helper: connector market fallback: %s', error instanceof Error ? error.message : String(error))
              source = 'local'
              const catalog = await Promise.resolve()
                .then(() => controller.catalog())
                .catch(() => ({ items: [], total: 0, categories: [] }))
              const filtered = catalog.items
                .filter(item => category === undefined || item.category === category)
                .filter(item => {
                  if (query === '') return true
                  return [item.id, item.name, item.vendor, item.summary, item.category, ...item.tags]
                    .join(' ')
                    .toLowerCase()
                    .includes(query)
                })
              total = filtered.length
              items = filtered.slice((page - 1) * pageSize, page * pageSize)
              categories = catalog.categories
              hasMore = page * pageSize < filtered.length
            }
            send(response, 200, {
              ok: true,
              view,
              source,
              total,
              categories,
              page,
              pageSize,
              hasMore,
              items,
            })
            return
          }

          const pluginsView = await Promise.resolve()
            .then(() => controller.connectorViews())
            .catch(() => ({ items: [], total: 0 }))
          const filtered = pluginsView.items
            .filter(item => {
              if (query === '') return true
              return [item.id, item.name, item.packageName, item.description]
                .join(' ')
                .toLowerCase()
                .includes(query)
            })
          send(response, 200, {
            ok: true,
            view,
            total: filtered.length,
            items: filtered,
            disabled: [...controller.disabledOf(sessionId)],
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectorsSession,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const controller = deps.connectors
          const sessionId = sessionIdOf(body.sessionId)
          if (controller === undefined || sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const appliedIds = controller.setSession(sessionId, body.disabled)
          send(response, 200, {
            ok: true,
            disabled: appliedIds,
            state: await panelState(sessionId),
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectorsState,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const controller = deps.connectors
          if (controller === undefined || typeof controller.states !== 'function') {
            send(response, 200, { ok: true, configs: [], states: {} })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
          const [configs, states] = await Promise.all([
            controller.configs(),
            controller.states(sessionId),
          ])
          send(response, 200, {
            ok: true,
            total: configs.total,
            configs: configs.items,
            states,
            pending: controller.pendingOperations(),
            patchPath: controller.patchPath,
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.connectorsAction,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const controller = deps.connectors
          if (controller === undefined) {
            send(response, 200, { ok: false, error: 'connector controller unavailable' })
            return
          }
          const connectorId = text(body.connectorId ?? body.id).trim()
          if (connectorId === '') {
            send(response, 400, { ok: false, error: 'connectorId is required' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          const action = text(body.action ?? 'connect').trim()
          // 埋点：用户从本面板跳到连接器管理页去授权/断开。管理页不接受深链，
          // 所以"去过"这件事只能记在我们自己这边，面板回来后才解释得清。
          if (action === 'openConnectorUi') {
            const config = typeof controller.configs === 'function'
              ? (await controller.configs()).items.find(item => item.id === connectorId)
              : undefined
            const serverName = text(body.serverName).trim() !== ''
              ? text(body.serverName).trim()
              : text(config?.serverName).trim()
            const entry = typeof controller.recordUiOpen === 'function'
              ? await controller.recordUiOpen(connectorId, { serverName, sessionId })
              : null
            // 上游 UI 支持深链就用深链，否则退回"跳过去 + 让用户搜索"。
            const capability = typeof controller.uiCapability === 'function'
              ? await controller.uiCapability()
              : { supported: false, param: null }
            const stateMap = typeof controller.states === 'function' ? await controller.states(sessionId) : {}
            send(response, 200, {
              ok: true,
              action,
              connectorId,
              url: connectorUiUrl({
                serverName,
                configId: connectorId,
                deepLinkParam: capability.supported === true ? capability.param : '',
              }),
              hint: connectorUiHint(config, stateMap[connectorId], { deepLink: capability.supported === true }),
              deepLink: capability.supported === true,
              uiOpen: entry,
              state: stateMap[connectorId] ?? null,
            })
            return
          }
          let result
          switch (action) {
            case 'connect':
            case 'repairConnect':
            case 'reauthorize':
              result = await controller.connect(connectorId, {
                action,
                sessionId,
                token: typeof body.token === 'string' ? body.token : undefined,
                header: typeof body.header === 'string' ? body.header : undefined,
                headers: body.headers,
                env: body.env,
                credentials: body.credentials,
              })
              break
            case 'cancel':
              result = await controller.cancelConnect(connectorId)
              break
            case 'disconnect':
              result = await controller.disconnect(connectorId)
              break
            case 'unbind':
              result = await controller.unbind(connectorId)
              break
            case 'updateHeaders':
              result = await controller.updateHeaders(connectorId, body.headers)
              break
            case 'updateEnv':
              result = await controller.updateEnv(connectorId, body.env)
              break
            case 'setEnabled':
              result = await controller.setEnabled(connectorId, body.enabled !== false, sessionId)
              break
            case 'setPatchedDisabled':
              result = await controller.setPatchedDisabled(connectorId, body.disabled === true)
              break
            default:
              send(response, 400, { ok: false, error: `unknown action: ${action}` })
              return
          }
          send(response, 200, {
            ok: result?.success === true || result?.status === 'connecting' || result?.status === 'action-required',
            action,
            connectorId,
            result,
            state: await controller.stateOf(connectorId, sessionId),
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.experts,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const query = text(url.searchParams.get('query')).trim()
          const categoryId = text(url.searchParams.get('categoryId')).trim() || undefined
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
          const pageSize = Math.max(1, Math.min(Number(url.searchParams.get('pageSize') ?? 24) || 24, 60))
          const localItems = await deps.bundles.listLocal().catch(() => [])
          const remote = await deps.market.listExperts({
            query,
            page,
            pageSize,
            categoryId,
            categories: categoryId === undefined ? undefined : [categoryId],
          })
          const items = mergeExperts(remote.items, localItems, query.toLowerCase(), categoryId)
          const matchedTotal = remote.source === 'portal'
            ? remote.total
            : (remote.matchedTotal ?? remote.items.length)
          send(response, 200, {
            ok: true,
            source: remote.source,
            matchedTotal,
            warning: remote.warning,
            page,
            pageSize,
            hasMore: page * pageSize < matchedTotal,
            items: items.slice(0, pageSize),
          })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.skillMarket,
        handler: handle(async (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const url = new URL(request.url ?? '/', 'http://localhost')
          const query = text(url.searchParams.get('query')).trim()
          const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
          const pageSize = Math.max(1, Math.min(Number(url.searchParams.get('pageSize') ?? 12) || 12, 24))
          try {
            const market = await deps.portal.listSkills({ query, page, pageSize })
            const workspace = workspaceOf(sessionIdOf(url.searchParams.get('sessionId')))
            let installed = []
            try {
              installed = await listInstalledSkills(workspace)
            } catch (error) {
              ctx.logger?.warn?.('workbuddy-helper: cannot list installed skills: %s', String(error))
            }
            send(response, 200, {
              ok: true,
              source: 'workbuddy',
              total: market.total,
              page,
              pageSize,
              hasMore: page * pageSize < market.total,
              workspace,
              installed: installed.map(skill => skill.slug),
              items: market.items,
            })
          } catch (error) {
            if (error instanceof AuthError) {
              ctx.logger?.warn?.('workbuddy-helper: skill market auth required: %s', error.message)
              send(response, 200, { ok: true, authRequired: true, total: 0, page, pageSize, hasMore: false, items: [] })
              return
            }
            throw error
          }
        }),
      })

      /**
       * 真实安装技能：拉市场详情 → 下载签名 zip → 解包到
       * `<workspace>/.dsh/skills/<slug>/`。不再只是"复制 ID"。
       */
      register({
        kind: 'exact',
        path: ROUTES.skillInstall,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const skillId = text(body.skillId).trim()
          if (skillId === '') {
            send(response, 400, { ok: false, error: 'skillId is required' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          const workspace = workspaceOf(sessionId)
          try {
            const result = await installSkill({
              portal: deps.portal,
              skillId,
              workspace,
              allowHosts: deps.allowHosts,
              allowInsecureLoopback: deps.allowInsecureLoopback,
              // force 由面板上的「强制重试」按钮显式传入，正常重装不带。
              force: body.force === true,
            })
            ctx.logger?.info?.(
              'workbuddy-helper: installed skill %s -> %s (%d files)',
              result.installed.slug,
              result.installed.path,
              result.files.length,
            )
            send(response, 200, { ok: true, ...result })
          } catch (error) {
            if (error instanceof AuthError) {
              send(response, 200, { ok: false, authRequired: true, error: error.message })
              return
            }
            ctx.logger?.warn?.('workbuddy-helper: skill install failed: %s', String(error))
            send(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.select,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          const expertId = text(body.expertId).trim()
          if (sessionId === undefined || expertId === '') {
            send(response, 400, { ok: false, error: 'sessionId and expertId are required' })
            return
          }
          await deps.sessions.selectExpert(sessionId, expertId)
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.skills,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          if (body === undefined) {
            send(response, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
          const sessionId = sessionIdOf(body.sessionId)
          if (sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          await deps.sessions.setSkills(sessionId, {
            globalMode: body.globalMode === 'selected' ? 'selected' : body.globalMode === 'all' ? 'all' : undefined,
            globalNames: list(body.globalNames),
            expertNames: list(body.expertNames),
          })
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })

      register({
        kind: 'exact',
        path: ROUTES.off,
        handler: handle(async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!sameOrigin(request)) {
            send(response, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }
          const body = await readBody(request)
          const sessionId = sessionIdOf(body?.sessionId)
          if (sessionId === undefined) {
            send(response, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          await deps.sessions.clear(sessionId)
          send(response, 200, { ok: true, state: await panelState(sessionId) })
        }),
      })
      ctx.logger?.info?.('workbuddy-helper: web UI routes registered')
      } catch (error) {
        console.error('[workbuddy-helper] route registration failed', error)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.('workbuddy-helper: web UI routes failed: %s', String(error))
  }
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => releaseRoutes(), 'workbuddy-helper: dispose web routes')
    }
  } catch {
    // The scoped effect above is the primary path.
  }
}

export { ROUTES }
