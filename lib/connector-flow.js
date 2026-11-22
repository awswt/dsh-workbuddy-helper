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

/**
 * 连接器管理页（`dsh-mcp-connector` 的 `/mcp-connector/ui`）的跳转地址。
 *
 * 那份 UI 目前只读 `location.search` 的 `uiLocale` / `locale`（`ui/index.html:1235`、
 * `:1252`），**不支持** `?connector=<id>` 深链 —— 传进去也不会定位到某一行。
 * 所以这个函数不假装能深链：它只把"从哪个面板跳出来、要去哪条连接器"写成
 * 查询参数，让跳转本身可被观测（服务端 `openConnectorUi` 记录同一条信息），
 * 同时给用户一个能在管理页里搜索的名字。
 *
 * 参数名与"是否深链"由调用方经 `detectConnectorUiDeepLink()` 探测后传入，
 * 这样上游哪天真的支持了 `?connector=`，本插件不用改代码就会开始用（见
 * `DEEP_LINK_PARAM_CANDIDATES`）。
 */
export function connectorUiUrl(params = {}) {
  const base = typeof params.base === 'string' && params.base.trim() !== ''
    ? params.base.trim()
    : '/mcp-connector/ui'
  const url = new URL(base, 'http://localhost')
  const serverName = typeof params.serverName === 'string' ? params.serverName.trim() : ''
  const configId = typeof params.configId === 'string' ? params.configId.trim() : ''
  const param = typeof params.deepLinkParam === 'string' && params.deepLinkParam.trim() !== ''
    ? params.deepLinkParam.trim()
    : DEEP_LINK_PARAM_CANDIDATES[0]
  // 只带非空值：空的查询参数会让服务端记录里出现一堆无意义字段。
  if (serverName !== '') url.searchParams.set('serverName', serverName)
  if (configId !== '') url.searchParams.set(param, configId)
  url.searchParams.set('from', typeof params.from === 'string' && params.from !== '' ? params.from : 'dsh-workbuddy-helper')
  // 返回相对路径，避免把内部 host 写进可复制的链接。
  return `${url.pathname}${url.search}`
}

/** 管理页不接受深链，所以要在界面上明确告诉用户去搜什么。 */
export function connectorUiHint(config, state, options = {}) {
  const name = typeof config?.name === 'string' && config.name !== ''
    ? config.name
    : (typeof config?.id === 'string' ? config.id : '')
  const serverName = typeof state?.external?.serverName === 'string' ? state.external.serverName : ''
  if (options.deepLink === true) {
    return serverName !== ''
      ? `已在管理页打开「${name}」（server: ${serverName}）；找不到就用搜索框搜它`
      : `已在管理页打开「${name}」；找不到就用搜索框搜它`
  }
  if (serverName !== '') return `在管理页搜索「${name}」（server: ${serverName}）完成授权或断开`
  return `在管理页搜索「${name}」完成授权或断开`
}

/**
 * 深链候选参数名。上游 UI 一旦开始读其中任意一个，本插件就自动升级为深链，
 * 不需要改代码——只需要重新探测一次页面文本。
 */
export const DEEP_LINK_PARAM_CANDIDATES = Object.freeze(['connector', 'connectorId', 'configId'])

/**
 * 从管理页的 `ui/index.html` 文本判断它是否已经支持按 id 定位。
 *
 * 判定不做模糊"包含 connector 字样"这种脆弱匹配（那份 HTML 里本来就有大量
 * connector 字样），只认两种确凿证据：
 *   1. 显式读取查询参数：`searchParams.get('connector')` / `URLSearchParams` 取值；
 *   2. 以 `?connector=` 形式拼进链接或从 `location.search` 解析。
 * 找不到就返回 `supported: false`，调用方继续用"跳过去 + 让用户搜索"的老路。
 */
export function detectConnectorUiDeepLink(html) {
  const source = typeof html === 'string' ? html : ''
  if (source === '') return { supported: false, param: null, evidence: null }
  for (const param of DEEP_LINK_PARAM_CANDIDATES) {
    const patterns = [
      // searchParams.get('connector') / params.get("connector") / query.get('connector')
      new RegExp(`(?:searchParams|params|query)\\.get\\(\\s*['"\`]${param}['"\`]\\s*\\)`),
      // new URLSearchParams(location.search).get('connector') —— 最常见的写法之一，
      // 接收者不是裸标识符，所以上面那条匹配不到。
      new RegExp(`URLSearchParams\\([^)]*\\)\\s*\\.get\\(\\s*['"\`]${param}['"\`]\\s*\\)`),
      // 直接把 ?connector= 拼进地址
      new RegExp(`[?&]${param}=\\$\\{`),
      new RegExp(`['"\`]\\?${param}=`),
    ]
    for (const pattern of patterns) {
      const match = source.match(pattern)
      if (match !== null) {
        return { supported: true, param, evidence: match[0].slice(0, 120) }
      }
    }
  }
  return { supported: false, param: null, evidence: null }
}
