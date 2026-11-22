import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AuthError, assertAllowedUrl } from './auth.js'
import { ensureDir, readJson, sha256, sleep, writeJsonAtomic } from './util.js'

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

class RetryableError extends Error {
  constructor(code, message, retryAfterMs = 0) {
    super(message)
    this.name = 'RetryableError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

function joinUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative
  return `${String(base).replace(/\/+$/, '')}/${String(relative).replace(/^\/+/, '')}`
}

function normalizeText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return [value.zh, value.en].filter(Boolean).join(' ')
  return String(value)
}

/**
 * WorkBuddy expert market client.
 *
 * The manifest and bundle endpoints are public today, so `authMode: none` is
 * the default. When auth is enabled, the token is resolved per request and is
 * only attached after an HTTPS + host allow-list check.
 */
export class MarketClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
    this.manifestPath = options.manifestPath ?? '/expert_center.json'
    this.timeoutMs = options.timeoutMs ?? 20000
    this.retries = options.retries ?? 1
    this.baseDelayMs = options.baseDelayMs ?? 400
    this.maxDelayMs = options.maxDelayMs ?? 4000
    this.cacheDir = options.cacheDir
    this.cacheTtlMs = options.cacheTtlMs ?? 6 * 60 * 60 * 1000
    this.staleWhileErrorMs = options.staleWhileErrorMs ?? 7 * 24 * 60 * 60 * 1000
    this.allowHosts = options.allowHosts ?? []
    this.allowInsecureLoopback = options.allowInsecureLoopback === true
    this.authProvider = options.authProvider ?? (async () => undefined)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.manifestFile = path.join(this.cacheDir, 'manifest.json')
    this.metaFile = path.join(this.cacheDir, 'manifest.meta.json')
  }

  get urlConfig() {
    return {
      allowHosts: this.allowHosts,
      allowInsecureLoopback: this.allowInsecureLoopback,
    }
  }

  manifestUrl() {
    return joinUrl(this.baseUrl, this.manifestPath)
  }

  bundleUrl(expert) {
    const explicit = typeof expert?.bundleUrl === 'string' ? expert.bundleUrl.trim() : ''
    if (explicit !== '') {
      const resolved = joinUrl(this.baseUrl, explicit)
      assertAllowedUrl(resolved, this.urlConfig)
      return resolved
    }
    const plugin = expert?.plugin ?? expert?.agentName ?? expert?.id
    if (typeof plugin !== 'string' || plugin.trim() === '') {
      throw new Error('expert has no plugin/agentName/id, cannot build bundle URL')
    }
    return joinUrl(this.baseUrl, `/bundles/${encodeURIComponent(plugin)}.tar.gz`)
  }

  async getManifest(options = {}) {
    const force = options.force === true
    const cached = await readJson(this.manifestFile)
    const meta = await readJson(this.metaFile, {})
    const age = Date.now() - Number(meta.fetchedAtMs ?? 0)
    if (!force && cached && age >= 0 && age < this.cacheTtlMs) {
      return { manifest: cached, stale: false, fetchedAt: meta.fetchedAt ?? null }
    }

    try {
      const manifest = await this.fetchJson(this.manifestUrl(), MAX_MANIFEST_BYTES)
      this.validateManifest(manifest)
      await ensureDir(this.cacheDir)
      await writeJsonAtomic(this.manifestFile, manifest)
      await writeJsonAtomic(this.metaFile, {
        fetchedAtMs: Date.now(),
        fetchedAt: new Date().toISOString(),
        sourceUrl: this.manifestUrl(),
        version: manifest.version ?? null,
      })
      return { manifest, stale: false, fetchedAt: new Date().toISOString() }
    } catch (error) {
      if (cached && age >= 0 && age < this.staleWhileErrorMs) {
        return {
          manifest: cached,
          stale: true,
          fetchedAt: meta.fetchedAt ?? null,
          warning: error instanceof Error ? error.message : String(error),
        }
      }
      throw error
    }
  }

  validateManifest(manifest) {
    if (manifest === null || typeof manifest !== 'object') {
      throw new Error('market manifest is not an object')
    }
    if (!Array.isArray(manifest.experts)) {
      throw new Error('market manifest has no experts array')
    }
    if (manifest.categories !== undefined && !Array.isArray(manifest.categories)) {
      throw new Error('market manifest categories is not an array')
    }
  }

  async listExperts(options = {}) {
    const { manifest, stale, fetchedAt } = await this.getManifest()
    const query = String(options.query ?? '').trim().toLowerCase()
    const categoryId = options.categoryId
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 100))
    const items = manifest.experts
      .filter(item => categoryId === undefined || item.categoryId === categoryId)
      .filter(item => {
        if (query === '') return true
        const haystack = [
          item.id,
          item.plugin,
          item.agentName,
          normalizeText(item.displayName),
          normalizeText(item.profession),
          normalizeText(item.description),
          ...(Array.isArray(item.tags) ? item.tags.map(normalizeText) : []),
        ].join(' ').toLowerCase()
        return haystack.includes(query)
      })
      .slice(0, limit)
      .map(item => ({
        id: item.id,
        plugin: item.plugin ?? item.agentName ?? item.id,
        displayName: normalizeText(item.displayName),
        profession: normalizeText(item.profession),
        description: normalizeText(item.description),
        categoryId: item.categoryId ?? null,
        avatar: item.avatar ? joinUrl(this.baseUrl, item.avatar) : null,
        tags: Array.isArray(item.tags) ? item.tags.map(normalizeText) : [],
      }))
    return {
      total: manifest.experts.length,
      matched: items.length,
      stale,
      fetchedAt,
      items,
    }
  }

  async getExpert(idOrPlugin) {
    const { manifest, stale, fetchedAt } = await this.getManifest()
    const needle = String(idOrPlugin ?? '').trim().toLowerCase()
    const expert = manifest.experts.find(item => {
      return [item.id, item.plugin, item.agentName]
        .filter(Boolean)
        .some(value => String(value).toLowerCase() === needle)
    })
    if (expert === undefined) {
      throw new Error(`expert not found: ${idOrPlugin}`)
    }
    return {
      expert,
      stale,
      fetchedAt,
      bundleUrl: this.bundleUrl(expert),
      baseUrl: this.baseUrl,
    }
  }

  async resolveAuthHeader() {
    return this.authProvider()
  }

  async fetchJson(url, maxBytes) {
    const auth = await this.resolveAuthHeader()
    const response = await this.requestWithRetry(url, auth)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} bytes`)
    }
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch {
      throw new Error('response is not valid JSON')
    }
  }

  async download(url, destination, maxBytes) {
    const auth = await this.resolveAuthHeader()
    const response = await this.requestWithRetry(url, auth)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`bundle exceeds ${maxBytes} bytes`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new Error(`bundle exceeds ${maxBytes} bytes`)
    }
    await ensureDir(path.dirname(destination))
    await fs.writeFile(destination, buffer, { mode: 0o600 })
    return { bytes: buffer.byteLength, sha256: sha256(buffer) }
  }

  async requestWithRetry(url, auth) {
    const attempts = Math.max(0, Number(this.retries ?? 0)) + 1
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        return await this.requestFollowingRedirects(url, auth, controller.signal)
      } catch (error) {
        lastError = error
        if (error instanceof AuthError) throw error
        const retryable = error instanceof RetryableError || error?.name === 'AbortError' || error instanceof TypeError
        if (!retryable || attempt + 1 >= attempts) break
        const base = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
        const extra = error instanceof RetryableError ? error.retryAfterMs : 0
        await sleep(Math.max(extra, Math.round(base * (0.8 + Math.random() * 0.4))))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError
  }

  async requestFollowingRedirects(input, auth, signal, depth = 0) {
    if (depth > 3) throw new Error('too many redirects')
    const url = assertAllowedUrl(input, this.urlConfig)
    const headers = {}
    if (auth !== undefined) headers[auth.header] = auth.value
    const response = await this.fetchImpl(url, { headers, redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null || location === '') throw new Error('redirect without location')
      const next = new URL(location, url).toString()
      assertAllowedUrl(next, this.urlConfig)
      return this.requestFollowingRedirects(next, auth, signal, depth + 1)
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('WORKBUDDY_HELPER_MARKET_AUTH_REQUIRED', `market rejected the credential (${response.status})`)
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
    return response
  }
}
