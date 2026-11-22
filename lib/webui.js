import { AuthError } from './auth.js'

const PREFIX = '/dsh-workbuddy-helper'
const ROUTES = {
  state: `${PREFIX}/state`,
  experts: `${PREFIX}/experts`,
  connectors: `${PREFIX}/connectors`,
  connectorsSession: `${PREFIX}/connectors/session`,
  skillMarket: `${PREFIX}/skill-market`,
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
  try {
    ctx.inject(['webServer'], scoped => {
      const webServer = scoped?.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger?.warn?.('workbuddy-helper: webServer.register is unavailable')
        return
      }
      const register = webServer.register.bind(webServer)
      try {
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
          return { disabled: [], pluginCount: 0, catalogCount: 0, catalogSource: 'none', connectedCount: 0 }
        }
        const [plugins, catalogInfo] = await Promise.all([
          Promise.resolve().then(() => controller.connectorViews()).catch(() => ({ items: [], total: 0 })),
          catalogSummary(),
        ])
        return {
          disabled: [...controller.disabledOf(sessionId)],
          pluginCount: plugins.total ?? plugins.items.length,
          catalogCount: catalogInfo.count,
          catalogSource: catalogInfo.source,
          connectedCount: 0,
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
            send(response, 200, {
              ok: true,
              source: 'workbuddy',
              total: market.total,
              page,
              pageSize,
              hasMore: page * pageSize < market.total,
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
}

export { ROUTES }
