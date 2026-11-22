import { AuthError, assertAllowedUrl } from './auth.js'
import { sleep } from './util.js'

const DEFAULT_BASE = 'https://www.workbuddy.cn'
const DEFAULT_PREFIX = '/portal'

function joinUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative
  return `${String(base).replace(/\/+$/, '')}/${String(relative).replace(/^\/+/, '')}`
}

function pick(zh, en) {
  const zhText = typeof zh === 'string' ? zh.trim() : ''
  if (zhText !== '') return zhText
  return typeof en === 'string' ? en.trim() : ''
}

function pickFirst(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function localizedList(zh, en) {
  return [zh, en].filter(value => typeof value === 'string' && value.trim() !== '')
}

function normalizePortalSkill(item) {
  return {
    id: String(item?.skill_id ?? item?.id ?? ''),
    name: pick(item?.display_name_zh, item?.display_name_en, item?.name) || String(item?.name ?? ''),
    description: pick(item?.description_zh, item?.description_en, item?.description) || '',
    icon: typeof item?.icon === 'string' ? item.icon : null,
    version: typeof item?.version === 'string' ? item.version : null,
    lifecycle: typeof item?.lifecycle_status === 'string' ? item.lifecycle_status : null,
    source: 'portal',
  }
}

function normalizeBuddyConnector(item) {
  return {
    id: String(item?.connector_id ?? item?.name ?? ''),
    name: pick(item?.display_name_zh, item?.display_name_en) || String(item?.name ?? item?.connector_id ?? ''),
    vendor: pickFirst(item?.publisher?.nickname, item?.publisher_name, item?.vendor),
    category: pickFirst(item?.category, item?.category_name),
    tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
    summary: pickFirst(item?.description_zh, item?.description_en, item?.description) ?? '',
    icon: typeof item?.icon === 'string' ? item.icon : null,
    authType: typeof item?.auth_type === 'string' ? item.auth_type : null,
    version: typeof item?.version === 'string' ? item.version : null,
    homepage: typeof item?.homepage === 'string' ? item.homepage : null,
    tools: Number(item?.tool_count ?? 0) || 0,
    connected: item?.connected === true || item?.is_connected === true,
    source: 'workbuddy',
  }
}

/**
 * Map one `operation-platform` market record to the shape used by this plugin.
 *
 * The live market calls the plugin slug `plugin_name`; the COS manifest calls
 * it `plugin`. Both end up as `plugin` so the session layer does not care
 * which source produced the record.
 */
export function normalizePortalExpert(item) {
  const id = String(item?.expert_id ?? item?.id ?? '').trim()
  const plugin = String(item?.plugin_name ?? item?.agent_name ?? id).trim()
  const categories = Array.isArray(item?.categories_detail)
    ? item.categories_detail.map(category => ({
      id: String(category.id ?? ''),
      name: pick(category.name_zh, category.name_en),
    }))
    : []
  return {
    id,
    marketExpertId: id,
    plugin,
    agentName: String(item?.agent_name ?? plugin),
    expertType: String(item?.expert_type ?? 'agent'),
    displayName: pick(item?.display_name_zh, item?.display_name_en),
    profession: pick(item?.profession_zh, item?.profession_en),
    description: pick(item?.description_zh, item?.description_en),
    version: typeof item?.plugin_version === 'string' ? item.plugin_version : (typeof item?.version === 'string' ? item.version : null),
    avatar: typeof item?.icon === 'string' ? item.icon : null,
    categoryId: Array.isArray(item?.categories) && item.categories.length > 0 ? String(item.categories[0]) : null,
    categories,
    tags: localizedList(item?.tags_zh, item?.tags_en),
    useCount: Number(item?.use_count ?? 0),
    developer: typeof item?.developer?.display_nickname === 'string' ? item.developer.display_nickname : null,
    bundleUrl: typeof item?.download_url === 'string' ? item.download_url : null,
    source: 'portal',
  }
}

class RetryableError extends Error {
  constructor(code, message, retryAfterMs = 0) {
    super(message)
    this.name = 'RetryableError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Client for the live WorkBuddy expert marketplace.
 *
 * The public COS manifest is a periodically published snapshot (429 experts at
 * the time of writing). The app itself reads the live market from
 * `POST /portal/operation-platform/market/expert/list`, which requires a
 * signed-in WorkBuddy account. This client talks to that endpoint with the
 * token read from the `dsh-connect-workbuddy` vault.
 */
export class PortalMarket {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
    this.prefix = String(options.prefix ?? DEFAULT_PREFIX).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 20000
    this.retries = options.retries ?? 1
    this.baseDelayMs = options.baseDelayMs ?? 400
    this.maxDelayMs = options.maxDelayMs ?? 4000
    this.allowHosts = (options.allowHosts ?? []).map(host => String(host).toLowerCase())
    this.allowInsecureLoopback = options.allowInsecureLoopback === true
    this.authProvider = options.authProvider ?? (async () => undefined)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.sizeCache = undefined
  }

  get urlConfig() {
    return { allowHosts: this.allowHosts, allowInsecureLoopback: this.allowInsecureLoopback }
  }

  async available() {
    try {
      const auth = await this.authProvider()
      return auth !== undefined && auth !== null
    } catch {
      return false
    }
  }

  async listExperts(options = {}) {
    const pageSize = Math.max(1, Math.min(Number(options.pageSize ?? options.limit ?? 50), 100))
    const page = Math.max(1, Number(options.page ?? 1))
    const payload = {
      page,
      page_size: pageSize,
      sort_by: options.sortBy ?? 'reco_rank',
      sort_order: options.sortOrder ?? 'desc',
    }
    const query = String(options.query ?? '').trim()
    if (query !== '') payload.keyword = query
    if (Array.isArray(options.categories) && options.categories.length > 0) payload.categories = options.categories
    if (typeof options.expertType === 'string' && options.expertType !== '') payload.expert_type = options.expertType
    if (options.needPayAssets === true) payload.need_pay_assets = true

    const response = await this.post('/operation-platform/market/expert/list', payload)
    const data = response.data ?? {}
    const experts = Array.isArray(data.experts) ? data.experts : (Array.isArray(data.items) ? data.items : [])
    return {
      total: Number(data.total_count ?? data.total ?? experts.length),
      matched: experts.length,
      page,
      pageSize,
      source: 'portal',
      stale: false,
      fetchedAt: new Date().toISOString(),
      items: experts.map(normalizePortalExpert),
    }
  }

  /**
   * Total number of published experts, independent of any keyword filter.
   *
   * `total_count` in the list response counts the current filter, so an
   * unfiltered one-row query is the only reliable way to read the market size.
   */
  async marketSize(options = {}) {
    const ttl = options.ttlMs ?? 10 * 60 * 1000
    if (this.sizeCache !== undefined && Date.now() - this.sizeCache.at < ttl) {
      return this.sizeCache.value
    }
    const response = await this.post('/operation-platform/market/expert/list', {
      page: 1,
      page_size: 1,
      sort_by: 'reco_rank',
      sort_order: 'desc',
    })
    const value = Number(response.data?.total_count ?? 0)
    this.sizeCache = { value, at: Date.now() }
    return value
  }

  async categories() {    const response = await this.get('/operation-platform/market/expert-categories')
    const items = Array.isArray(response.data?.items) ? response.data.items : []
    return items
      .slice()
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map(item => ({
        id: String(item.id ?? ''),
        name: pick(item.name_zh, item.name_en),
        count: Number(item.expert_count ?? 0),
      }))
  }

  /**
   * WorkBuddy 技能市场（/portal/operation-platform/market/skill/list）。
   * 与专家市场同一个鉴权来源：WorkBuddy 连接器账号池的 Bearer。
   */
  async listSkills(options = {}) {
    const pageSize = Math.max(1, Math.min(Number(options.pageSize ?? options.limit ?? 24), 50))
    const page = Math.max(1, Number(options.page ?? 1))
    const payload = { page, page_size: pageSize }
    const query = String(options.query ?? '').trim()
    if (query !== '') payload.keyword = query
    const response = await this.post('/operation-platform/market/skill/list', payload)
    const data = response.data ?? {}
    const skills = Array.isArray(data.skills) ? data.skills : (Array.isArray(data.items) ? data.items : [])
    return {
      total: Number(data.total_count ?? data.total ?? skills.length),
      page,
      pageSize,
      source: 'portal',
      items: skills.map(normalizePortalSkill),
    }
  }

  /**
   * WorkBuddy 连接器市场（/api/v2/open-platform/buddy/connector/{list,search}）。
   * 与技能市场同一 Bearer；无 keyword 用 list，有关键字用 search。
   */
  async listBuddyConnectors(options = {}) {
    const platform = typeof options.platform === 'string' && options.platform !== '' ? options.platform : 'desktop'
    const pageSize = Math.max(1, Math.min(Number(options.pageSize ?? options.limit ?? 24), 50))
    const page = Math.max(1, Number(options.page ?? 1))
    const keyword = String(options.query ?? '').trim()
    const route = keyword !== ''
      ? '/api/v2/open-platform/buddy/connector/search'
      : '/api/v2/open-platform/buddy/connector/list'
    const payload = { platform, page, page_size: pageSize }
    if (keyword !== '') payload.keyword = keyword
    const response = await this.postPath(route, payload)
    const data = response.data ?? {}
    const connectors = Array.isArray(data.list) ? data.list : (Array.isArray(data.connectors) ? data.connectors : [])
    return {
      total: Number(data.total_count ?? data.total ?? connectors.length),
      page,
      pageSize,
      hasMore: data.has_more === true,
      source: 'workbuddy',
      items: connectors.map(normalizeBuddyConnector),
    }
  }

  async getExpert(idOrSlug) {    const needle = String(idOrSlug ?? '').trim()
    if (needle === '') throw new Error('expert id is required')

    if (needle.startsWith('ex_')) {
      const expert = await this.getById(needle)
      if (expert !== undefined) return expert
    }

    const search = await this.listExperts({ query: needle, pageSize: 20 })
    const exact = search.items.find(item => {
      return [item.id, item.plugin, item.agentName]
        .filter(Boolean)
        .some(value => String(value).toLowerCase() === needle.toLowerCase())
    })
    if (exact !== undefined) return exact
    throw new Error(`expert not found: ${idOrSlug}`)
  }

  async getById(expertId) {
    const response = await this.post('/operation-platform/market/expert/get-by-ids', {
      expert_ids: [expertId],
      include_invisible: true,
    })
    const items = Array.isArray(response.data?.experts)
      ? response.data.experts
      : (Array.isArray(response.data?.items) ? response.data.items : [])
    const found = items.find(item => String(item.expert_id ?? item.id ?? '') === expertId) ?? items[0]
    return found === undefined ? undefined : normalizePortalExpert(found)
  }

  async downloadInfo(expertId) {
    const response = await this.post('/operation-platform/market/expert/download-url', { expert_id: expertId })
    const url = response.data?.download_url
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error(`market returned no download URL for ${expertId}`)
    }
    return {
      url: url.trim(),
      kind: /\.zip(?:$|\?)/i.test(url) ? 'zip' : 'tar',
      filename: typeof response.data?.filename === 'string' ? response.data.filename : null,
      expiresAt: Number(response.data?.expires_at ?? 0),
    }
  }

  async post(route, payload) {
    return this.request(route, { method: 'POST', body: JSON.stringify(payload) })
  }

  /** POST a base-relative route (bypasses the /portal prefix), for open-platform endpoints. */
  async postPath(route, payload) {
    return this.request(route, { method: 'POST', body: JSON.stringify(payload) }, { noPrefix: true })
  }

  async get(route) {
    return this.request(route, { method: 'GET' })
  }

  async request(route, options = {}, { noPrefix = false } = {}) {
    const auth = await this.authProvider()
    if (auth === undefined || auth === null) {
      throw new AuthError(
        'WORKBUDDY_HELPER_PORTAL_AUTH_REQUIRED',
        'the live WorkBuddy market needs a signed-in account; run `dsh-connect-workbuddy` login or set authMode=bearer with a credential',
      )
    }
    const base = auth.baseUrl === undefined ? this.baseUrl : String(auth.baseUrl).replace(/\/+$/, '')
    const url = joinUrl(base, noPrefix ? route : `${this.prefix}${route}`)
    assertAllowedUrl(url, this.urlConfig)

    const attempts = Math.max(0, Number(this.retries ?? 0)) + 1
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        return await this.requestFollowingRedirects(url, auth, options, controller.signal)
      } catch (error) {
        lastError = error
        if (error instanceof AuthError) throw error
        const retryable = error instanceof RetryableError || error?.name === 'AbortError' || error instanceof TypeError
        if (!retryable || attempt + 1 >= attempts) break
        const baseDelay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
        const extra = error instanceof RetryableError ? error.retryAfterMs : 0
        await sleep(Math.max(extra, Math.round(baseDelay * (0.8 + Math.random() * 0.4))))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }

  async requestFollowingRedirects(input, auth, options, signal, depth = 0) {
    if (depth > 3) throw new Error('too many redirects')
    const url = assertAllowedUrl(input, this.urlConfig)
    const headers = {
      Accept: 'application/json',
      ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      [auth.header]: auth.value,
    }
    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
      signal,
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null || location === '') throw new Error('redirect without location')
      const next = new URL(location, url).toString()
      assertAllowedUrl(next, this.urlConfig)
      return this.requestFollowingRedirects(next, auth, options, signal, depth + 1)
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        'WORKBUDDY_HELPER_MARKET_AUTH_REQUIRED',
        `WorkBuddy market rejected the account token (${response.status}); sign in again in the connector`,
      )
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000
      throw new RetryableError('WORKBUDDY_HELPER_MARKET_RATE_LIMITED', 'market rate limited', Number.isFinite(retryAfter) ? retryAfter : 0)
    }
    if (response.status >= 500) {
      throw new RetryableError('WORKBUDDY_HELPER_MARKET_UNAVAILABLE', `market returned ${response.status}`)
    }
    if (!response.ok) {
      throw new Error(`market returned ${response.status}`)
    }
    const payload = await response.json().catch(() => undefined)
    if (payload === undefined || typeof payload !== 'object') {
      throw new Error('market returned a non-JSON response')
    }
    if (Number(payload.code ?? 0) !== 0) {
      throw new Error(`market error ${payload.code}: ${String(payload.msg ?? 'unknown')}`)
    }
    return payload
  }
}
