import { AuthError } from './auth.js'

const PREFIX = '/dsh-workbuddy-helper'
const ROUTES = {
  state: `${PREFIX}/state`,
  experts: `${PREFIX}/experts`,
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
        const [items, marketTotal, portalAvailable] = await Promise.all([
          categories(),
          deps.market.marketSize().catch(() => null),
          deps.portal?.available?.().catch(() => false) ?? false,
        ])
        const connector = await deps.connector.status().catch(() => undefined)
        return {
          ...state,
          categories: items,
          market: {
            source: portalAvailable ? 'portal' : 'cos',
            marketTotal,
            portalAvailable,
          },
          connector: connector === undefined ? null : {
            installed: connector.installed,
            accountCount: connector.accountCount,
            usableAccountCount: connector.usableAccountCount,
          },
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
