/**
 * Credential resolution and request-header injection.
 *
 * This module has no DSH imports so it can be unit-tested without a running
 * harness. The host passes `{ credentials, connector }` as sources.
 *
 * Security rules:
 *   - configuration never contains a token;
 *   - a token is only attached to an allow-listed HTTPS host;
 *   - `auto` asks the connector, which reads this plugin's own account store
 *     first and only falls back to a `dsh-connect-workbuddy` vault;
 *   - errors and logs carry the credential reference, never the value.
 */

export class AuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

function rejectInlineSecret(config) {
  if (typeof config.token === 'string' && config.token.length > 0) {
    throw new AuthError(
      'WORKBUDDY_HELPER_AUTH_INLINE',
      'inline tokens are not accepted; sign in through this plugin (action=account) or use the DSH credential service',
    )
  }
}

/**
 * @param {{
 *   mode?: 'none'|'bearer'|'header'|'cookie'|'workbuddy-connector',
 *   credentialRef?: string,
 *   headerName?: string,
 *   headerPrefix?: string,
 *   connectorRegion?: 'cn'|'global',
 *   allowHosts?: string[],
 *   allowInsecureLoopback?: boolean,
 *   token?: string
 * }} config
 * @param {{credentials?: {resolve: Function}, connector?: {resolveToken: Function}}} sources
 * @returns {Promise<{header: string, value: string} | undefined>}
 */
export async function resolveAuth(config = {}, sources = {}) {
  const mode = config.mode ?? 'none'
  rejectInlineSecret(config)
  if (mode === 'none') return undefined

  if (mode === 'auto') {
    if (sources.connector === undefined) return undefined
    let hit
    try {
      hit = await sources.connector.resolveToken({ region: config.connectorRegion })
    } catch {
      return undefined
    }
    if (hit === undefined) return undefined
    // Portal market endpoints live on www.workbuddy.cn; the token's own domain
    // (often www.codebuddy.cn) is the account realm, not the market host, and
    // following it trips the URL allowlist.
    return {
      header: config.headerName ?? 'Authorization',
      value: `${config.headerPrefix ?? 'Bearer '}${hit.token}`,
    }
  }

  if (mode === 'workbuddy-connector') {
    if (sources.connector === undefined) {
      throw new AuthError('WORKBUDDY_HELPER_CONNECTOR_MISSING', 'no WorkBuddy account source is available')
    }
    const hit = await sources.connector.resolveToken({ region: config.connectorRegion })
    if (hit === undefined) {
      throw new AuthError(
        'WORKBUDDY_HELPER_CONNECTOR_NO_TOKEN',
        'no usable WorkBuddy account token; sign in from the assistant panel (or workbuddy_helper action=account accountAction=login)',
      )
    }
    // Same rule as auto mode: market endpoints live on www.workbuddy.cn.
    return {
      header: config.headerName ?? 'Authorization',
      value: `${config.headerPrefix ?? 'Bearer '}${hit.token}`,
    }
  }

  if (sources.credentials === undefined) {
    throw new AuthError('WORKBUDDY_HELPER_CREDENTIALS_MISSING', 'DSH credential service is not available')
  }
  const name = config.credentialRef ?? 'WB_EXPERT_TOKEN'
  const hit = await sources.credentials.resolve(name)
  if (hit === undefined || typeof hit.value !== 'string' || hit.value.trim() === '') {
    throw new AuthError(
      'WORKBUDDY_HELPER_AUTH_MISSING',
      `credential "${name}" is not configured`,
    )
  }
  const token = hit.value.trim()

  if (mode === 'bearer') {
    return {
      header: config.headerName ?? 'Authorization',
      value: `${config.headerPrefix ?? 'Bearer '}${token}`,
    }
  }
  if (mode === 'header') {
    if (typeof config.headerName !== 'string' || config.headerName.trim() === '') {
      throw new AuthError('WORKBUDDY_HELPER_AUTH_HEADER_MISSING', 'headerName is required for auth.mode=header')
    }
    return { header: config.headerName, value: `${config.headerPrefix ?? ''}${token}` }
  }
  if (mode === 'cookie') {
    return { header: 'Cookie', value: token }
  }
  throw new AuthError('WORKBUDDY_HELPER_AUTH_MODE', `unsupported auth mode: ${String(mode)}`)
}

/**
 * Report status without returning any secret value.
 *
 * @param {object} config
 * @param {{credentials?: {describe: Function}, connector?: {status: Function}}} sources
 */
export async function describeAuth(config = {}, sources = {}) {
  const mode = config.mode ?? 'none'
  if (mode === 'none') return { mode, configured: true, source: 'none', writable: false }
  if (mode === 'auto') {
    if (sources.connector === undefined) return { mode, configured: false, source: 'connector-missing', writable: false }
    const status = await sources.connector.status()
    const usable = status.tokenAvailable === true
    return {
      mode,
      configured: usable,
      // 说清 token 来自哪里：本插件自己的账号库优先，旧插件 vault 只是回落。
      source: usable ? (status.source === 'vault' ? 'dsh-connect-workbuddy' : 'helper-accounts') : 'snapshot-only',
      writable: false,
      accounts: status.accountCount,
      usableAccounts: status.usableAccountCount,
      note: usable ? 'live market enabled' : 'no account token; the published snapshot is used',
    }
  }
  if (mode === 'workbuddy-connector') {
    if (sources.connector === undefined) return { mode, configured: false, source: 'connector-missing', writable: false }
    const status = await sources.connector.status()
    return {
      mode,
      configured: status.tokenAvailable === true,
      source: status.tokenAvailable === true
        ? (status.source === 'vault' ? 'dsh-connect-workbuddy' : 'helper-accounts')
        : 'connector-missing',
      writable: false,
      accounts: status.accountCount,
      usableAccounts: status.usableAccountCount,
    }
  }
  if (sources.credentials === undefined) return { mode, configured: false, source: 'credentials-missing', writable: false }
  const name = config.credentialRef ?? 'WB_EXPERT_TOKEN'
  const info = await sources.credentials.describe(name)
  return { mode, ...info }
}

/**
 * Enforce HTTPS and a host allow-list before a credential-bearing request.
 *
 * @param {string} raw
 * @param {{allowHosts?: string[], allowInsecureLoopback?: boolean}} config
 * @returns {URL}
 */
export function assertAllowedUrl(raw, config = {}) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new AuthError('WORKBUDDY_HELPER_URL_INVALID', `invalid URL: ${String(raw)}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new AuthError('WORKBUDDY_HELPER_URL_USERINFO', 'credentials in URLs are not allowed')
  }
  const host = url.hostname.toLowerCase()
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  const insecureAllowed = config.allowInsecureLoopback === true && loopback
  if (url.protocol !== 'https:' && !insecureAllowed) {
    throw new AuthError('WORKBUDDY_HELPER_URL_INSECURE', `HTTPS is required: ${url.origin}`)
  }
  const allowed = Array.isArray(config.allowHosts) ? config.allowHosts.map(item => String(item).toLowerCase()) : []
  if (!allowed.includes(host)) {
    throw new AuthError('WORKBUDDY_HELPER_HOST_DENIED', `host is not allowed: ${host}`)
  }
  return url
}

/**
 * Remove known secret values from a string before logging or returning it.
 *
 * @param {unknown} value
 * @param {Array<string | undefined | null>} secrets
 */
export function redact(value, secrets = []) {
  let text = String(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      text = text.split(secret).join('[REDACTED]')
    }
  }
  return text
}
