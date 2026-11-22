/**
 * lib/connector-flow.js — 连接器连接动作的"单飞"状态机与结果归一化。
 *
 * 语义取自 WorkBuddy 主进程 `createConnectorService` 的连接门面（见
 * docs/workbuddy-connector-reverse-engineering.md 的逆向结论）：
 *
 *  1. 同一条连接在同一时刻只允许一个连接动作（single-flight）。重复点击不排队、
 *     不并发，直接返回 `{success:false, connecting:true}`。
 *  2. 每个动作有 opId = `${configId}#${序号}`；异步阶段每推进一步都要校验自己仍是
 *     当前动作（isCurrent），被别人取代则返回 `cancelled`，避免旧回调把新状态改回去。
 *  3. 结果归一为四种之一：success / cancelled / needs-token-config / needs-auth / failed，
 *     再映射到渲染层联合类型 connected | connecting | cancelled | action-required。
 */

/** 连接动作的来源，用于区分"首次连接"和"修复重连"。 */
export const CONNECT_ACTIONS = Object.freeze(['connect', 'repairConnect', 'reauthorize'])

let sequence = 0

/**
 * 单飞登记表。按 configId 记录当前在跑的动作；序号单调递增，永不复用。
 */
export function createOperationRegistry() {
  /** @type {Map<string, {opId: string, action: string, startedAt: number, requestId: string}>} */
  const active = new Map()

  return {
    /**
     * 尝试占用一条连接的连接动作。
     * @param {string} configId
     * @param {{action?: string, requestId?: string}} [options]
     * @returns {{granted: boolean, opId?: string, requestId?: string, current?: string}}
     */
    claim(configId, options = {}) {
      const existing = active.get(configId)
      if (existing !== undefined) {
        return { granted: false, current: existing.opId, requestId: existing.requestId }
      }
      const action = CONNECT_ACTIONS.includes(options.action) ? options.action : 'connect'
      const opId = `${configId}#${++sequence}`
      const requestId = options.requestId ?? opId
      active.set(configId, { opId, action, startedAt: Date.now(), requestId })
      return { granted: true, opId, requestId }
    },

    /** 该动作是否仍是这条连接的当前动作。 */
    isCurrent(configId, opId) {
      return active.get(configId)?.opId === opId
    },

    /** 动作结束时释放；只释放自己持有的那个 opId，避免误清别人的。 */
    release(configId, opId) {
      if (active.get(configId)?.opId !== opId) return false
      active.delete(configId)
      return true
    },

    /** 主动取消（用户点"取消"）：立即摘牌，后续 async 阶段会因 isCurrent 失败而停下。 */
    cancel(configId) {
      const existing = active.get(configId)
      if (existing === undefined) return undefined
      active.delete(configId)
      return existing
    },

    /** 当前所有 pending 的 configId（用于把重启前的中间态收尾）。 */
    pending() {
      return [...active.keys()]
    },

    get size() {
      return active.size
    },

    /** 仅用于测试：清空登记表。 */
    reset() {
      active.clear()
    },
  }
}

/**
 * 把内部连接执行结果归一为 WorkBuddy 的 `describeConnectorResult` 五分类。
 * @param {{
 *   requestId?: string,
 *   success?: boolean,
 *   cancelled?: boolean,
 *   connecting?: boolean,
 *   needsAuth?: boolean,
 *   needsTokenConfig?: boolean,
 *   viaForm?: boolean,
 *   authStart?: Record<string, unknown>,
 *   form?: Record<string, unknown>,
 *   state?: Record<string, unknown>,
 *   error?: unknown,
 * }} input
 */
export function normalizeConnectResult(input = {}) {
  const requestId = input.requestId
  const error = input.error === undefined ? undefined : describeConnectorError(input.error)
  const extra = {}
  if (input.state !== undefined) extra.state = input.state
  if (input.authStart !== undefined) extra.authStart = input.authStart
  if (error !== undefined) extra.error = error

  if (input.cancelled === true) {
    return { requestId, status: 'cancelled', success: false, cancelled: true, connecting: false, needsAuth: false, needsTokenConfig: false, viaForm: false, ...extra }
  }
  if (input.needsTokenConfig === true) {
    return {
      requestId,
      status: 'action-required',
      success: false,
      cancelled: false,
      connecting: false,
      needsAuth: false,
      needsTokenConfig: true,
      viaForm: true,
      action: input.form ?? { kind: 'form', fields: [] },
      ...extra,
    }
  }
  if (input.needsAuth === true) {
    const authStart = input.authStart ?? {}
    return {
      requestId,
      status: 'action-required',
      success: false,
      cancelled: false,
      connecting: false,
      needsAuth: true,
      needsTokenConfig: false,
      viaForm: false,
      action: { kind: 'open_url', url: authStart.authorizeUrl ?? authStart.url ?? '', nextAction: authStart.nextAction ?? 'redirect' },
      ...extra,
    }
  }
  if (input.connecting === true) {
    return { requestId, status: 'connecting', success: false, cancelled: false, connecting: true, needsAuth: false, needsTokenConfig: false, viaForm: false, ...extra }
  }
  // 断开是一条独立的终态：之前借用 success:true 会让 UI 显示"已连接"，
  // 而实际刚刚把 patch 条目删掉了。
  if (input.disconnected === true) {
    return { requestId, status: 'disconnected', success: true, cancelled: false, connecting: false, needsAuth: false, needsTokenConfig: false, viaForm: false, ...extra }
  }
  if (input.success === true) {
    return { requestId, status: 'connected', success: true, cancelled: false, connecting: false, needsAuth: false, needsTokenConfig: false, viaForm: input.viaForm === true, ...extra }
  }
  return { requestId, status: 'failed', success: false, cancelled: false, connecting: false, needsAuth: false, needsTokenConfig: false, viaForm: false, ...extra }
}

/**
 * 错误归一化：`getConnectorErrorDisplayKind` 的等价实现。
 * code 决定 UI 该显示"去授权 / 去配置 / 升级版本 / 找管理员 / 重试"。
 * @param {unknown} error
 * @returns {{kind: string, code: string, message: string}}
 */
export function describeConnectorError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const rawCode = (error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '') || ''
  const text = `${rawCode} ${message}`.toLowerCase()
  let kind = 'retry'
  if (/authoriz|unauthor|401|oauth/.test(text)) kind = 'authorize'
  else if (/token|api[-_ ]?key|credential|config/.test(text)) kind = 'configure'
  else if (/version|incompatib|upgrade/.test(text)) kind = 'upgrade'
  else if (/admin|governance|policy|forbidden|403/.test(text)) kind = 'contact-admin'
  const code = rawCode !== '' ? rawCode : kind
  return { kind, code, message }
}

/**
 * 需要手工令牌的连接器：生成 `action.kind === 'form'` 的表单描述。
 * 只描述字段，绝不预填、不猜测真实值。
 * @param {{id: string, name: string, auth?: Record<string, unknown>}} config
 * @param {{existing?: Record<string, string>}} [options]
 */
/**
 * 目录条目声明的凭据字段。真实注册表里 `auth.credentialFields` 是
 * `[{key,label,placeholder,description,helpLabel,required,secret}]`；
 * 声明为空时退回单字段 `token`，保持对旧目录的兼容。
 */
export function credentialFieldsOf(config) {
  const declared = Array.isArray(config?.auth?.credentialFields) ? config.auth.credentialFields : []
  const fields = declared
    .filter(field => field !== null && typeof field === 'object' && typeof field.key === 'string' && field.key !== '')
    .map(field => ({
      key: field.key,
      label: typeof field.label === 'string' && field.label !== '' ? field.label : field.key,
      placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
      description: typeof field.description === 'string' ? field.description : '',
      required: field.required !== false,
      secret: field.secret !== false,
    }))
  if (fields.length > 0) return fields
  return [{ key: 'token', label: '凭据', placeholder: '粘贴凭据', description: '', required: true, secret: true }]
}

/** 必填凭据是否都已就位。 */
export function credentialsSatisfied(config, credentials) {
  const present = credentials !== null && typeof credentials === 'object' ? credentials : {}
  return credentialFieldsOf(config).every(field => {
    if (field.required !== true) return true
    const value = present[field.key]
    return typeof value === 'string' && value !== ''
  })
}

/** 是否需要向用户索取凭据（仅 token 类认证需要，none/oauth 不需要）。 */
export function credentialsRequired(config) {
  const mode = config?.auth?.mode
  return mode === 'api-key' || mode === 'bearer'
}

export function tokenConfigAction(config, options = {}) {
  const auth = config.auth ?? {}
  const server = Array.isArray(config.servers) && config.servers.length > 0 ? config.servers[0] : {}
  const header = typeof auth.apiKeyHeader === 'string' && auth.apiKeyHeader !== '' ? auth.apiKeyHeader : 'Authorization'
  const existing = options.existing ?? {}
  const present = {}
  if (existing.credentials !== null && typeof existing.credentials === 'object') {
    for (const [key, value] of Object.entries(existing.credentials)) {
      if (typeof value === 'string' && value !== '') present[key] = value
    }
  }
  const declaredFields = credentialFieldsOf(config)
  // 旧记录只有 token 字段；把它当成主凭据字段，避免升级后误报"未配置"。
  const primaryKey = declaredFields[0].key
  if (present[primaryKey] === undefined && typeof existing.token === 'string' && existing.token !== '') {
    present[primaryKey] = existing.token
  }
  const fields = declaredFields.map(field => ({
    name: field.key,
    label: field.label,
    kind: field.secret === true ? 'secret' : 'text',
    required: field.required === true,
    placeholder: field.placeholder,
    description: field.description,
    value: '',
    present: typeof present[field.key] === 'string' && present[field.key] !== '',
  }))
  // 走 HTTP 且目录没有把凭据绑定到固定请求头时，允许用户覆盖头名。
  const boundHeaders = server !== null && typeof server === 'object' && server.headerCredentialBindings !== null && typeof server.headerCredentialBindings === 'object'
    ? Object.keys(server.headerCredentialBindings).length
    : 0
  // 只有 stdio 不需要头名；缺 server 信息的老目录按 HTTP 处理，保留头名覆盖字段。
  const viaStdio = typeof server?.command === 'string' && server.command !== ''
  const viaHttp = viaStdio !== true
  if (viaHttp && boundHeaders === 0) {
    fields.push({
      name: 'header',
      label: '请求头名',
      kind: 'text',
      required: false,
      placeholder: header,
      description: '',
      value: typeof existing.headers?.__headerName === 'string' ? existing.headers.__headerName : header,
      present: true,
    })
  }
  const description = typeof auth.credentialDescription === 'string' && auth.credentialDescription !== ''
    ? auth.credentialDescription
    : '凭据只写入本机 profile 的连接器存储，不会出现在对话或日志里。'
  const action = {
    kind: 'form',
    configId: config.id,
    title: `${config.name} 需要访问凭据`,
    description,
    fields,
  }
  if (typeof auth.credentialHelpLabel === 'string' && auth.credentialHelpLabel !== '') {
    action.help = { label: auth.credentialHelpLabel, url: typeof auth.credentialHelpUrl === 'string' ? auth.credentialHelpUrl : '' }
  }
  return action
}

/**
 * OAuth 连接器：生成跳转动作。
 * @param {{id: string, name: string}} config
 * @param {{url: string, expireAt?: number, nextAction?: string}} params
 */
export function oauthHandoffAction(config, params) {
  return {
    kind: 'open_url',
    configId: config.id,
    title: `${config.name} 需要在授权页完成授权`,
    url: params.url,
    nextAction: params.nextAction ?? 'redirect',
    expireAt: params.expireAt,
  }
}
