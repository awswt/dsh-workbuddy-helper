import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AuthError, describeAuth, redact, resolveAuth } from './auth.js'
import { BundleStore } from './bundle.js'
import { createConnectorController } from './connectors.js'
import { WorkBuddyConnector } from './connector.js'
import { MarketClient } from './market.js'
import { createMnemonDetector } from './mnemon.js'
import { PortalMarket } from './portal.js'
import { SessionManager } from './session.js'
import { installSkill, listInstalledSkills } from './skill-install.js'
import { expandHome, resolveDshHome } from './util.js'
import { createAccountService } from './wb-accounts.js'
import { createAccountStore } from './wb-vault.js'
import { registerWebUi } from './webui.js'

const DEFAULT_HOST = 'acc-1258344699.cos.accelerate.myqcloud.com'
const DEFAULT_BASE = `https://${DEFAULT_HOST}/workbuddy/expert-marketplace`
const PORTAL_HOSTS = ['www.workbuddy.cn', 'www.workbuddy.ai']
const CDN_HOSTS = ['openplatform-cdn.codebuddy.cn']
const USAGE = [
  'workbuddy_helper actions:',
  '  status',
  '  expert <expertId>',
  '  off',
  '  skills',
  '  set-skills <mode=all|selected> [names=a,b] [expertNames=c,d]',
  '  connector [connectorAction=list|state|connect|repair|cancel|disconnect|unbind|enable|disable] [connectorId]',
  '  account [accountAction=list|login|poll|cancel|refresh|remove|import] [accountId] [region=cn|global] [loginId=...]',
  '  market [query]',
  '  categories',
].join('\n')

export const name = 'dsh-workbuddy-helper'
export const inject = ['tools', 'agents', 'systemPrompt', 'skills']

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const settings = {
    marketMode: config.marketMode ?? 'auto',
    marketBaseUrl: config.marketBaseUrl ?? DEFAULT_BASE,
    manifestPath: config.manifestPath ?? '/expert_center.json',
    portalBaseUrl: config.portalBaseUrl ?? 'https://www.workbuddy.cn',
    portalPrefix: config.portalPrefix ?? '/portal',
    timeoutMs: config.timeoutMs ?? 20000,
    retries: config.retries ?? 1,
    cacheTtlMs: config.cacheTtlMs ?? 6 * 60 * 60 * 1000,
    staleWhileErrorMs: config.staleWhileErrorMs ?? 7 * 24 * 60 * 60 * 1000,
    authMode: config.authMode ?? 'auto',
    credentialRef: config.credentialRef ?? 'WB_EXPERT_TOKEN',
    headerName: config.headerName ?? 'Authorization',
    headerPrefix: config.headerPrefix ?? 'Bearer ',
    connectorRegion: config.connectorRegion,
    allowHosts: config.allowHosts ?? [DEFAULT_HOST, ...PORTAL_HOSTS, ...CDN_HOSTS],
    allowInsecureLoopback: config.allowInsecureLoopback === true,
    maxPromptChars: config.maxPromptChars ?? 60000,
    maxSelectedSkills: config.maxSelectedSkills ?? 64,
    dataDir: expandHome(config.dataDir ?? path.join(resolveDshHome(), 'workbuddy-helper')),
    dshHome: expandHome(config.dshHome ?? resolveDshHome()),
    // 账号库放哪。刻意与 dsh-connect-workbuddy 的 vault 分开，两个插件都装时
    // 各写各的，谁也不改对方的文件。
    accountsDir: expandHome(config.accountsDir ?? path.join(config.dataDir ?? path.join(resolveDshHome(), 'workbuddy-helper'), 'accounts')),
    legacyVaultDir: config.legacyVaultDir === undefined
      ? path.join(expandHome(config.dshHome ?? resolveDshHome()), 'workbuddy-vault')
      : expandHome(config.legacyVaultDir),
    localRoots: config.localRoots ?? [
      path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins'),
      path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'my-experts'),
    ],
  }

  if (settings.authMode === 'workbuddy-connector' && config.allowPublicMarketAuth !== true) {
    try {
      if (new URL(settings.marketBaseUrl).hostname.toLowerCase() === DEFAULT_HOST) {
        throw new Error('refusing to send a WorkBuddy token to the public market host; use authMode=none, or set allowPublicMarketAuth=true only if the market operator requires it')
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('refusing')) throw error
    }
  }

  const connector = new WorkBuddyConnector({
    dshHome: settings.dshHome,
    vaultDir: config.vaultDir === undefined ? undefined : expandHome(config.vaultDir),
    // 本插件自己的账号库目录（默认 `<dataDir>/accounts`），与兼容层 vault 完全分开。
    accountsDir: settings.accountsDir,
  })
  // 登录、刷新、迁移都收敛在这里；webui 与工具走同一个实例，避免两处状态机。
  const accounts = createAccountService({
    connector,
    vaultDir: settings.legacyVaultDir,
    // 测试与自建部署可以换掉 fetch；正常运行时用全局 fetch。
    fetchImpl: config.fetchImpl,
  })

  const credentialsService = ctx.get('credentials')
  const credentials = credentialsService === undefined ? undefined : {
    async resolve(ref) {
      try {
        return await credentialsService.resolve(ref)
      } catch {
        return undefined
      }
    },
    async describe(ref) {
      try {
        return await credentialsService.describe(ref)
      } catch {
        return { configured: false, source: 'unavailable', writable: false }
      }
    },
  }

  const authConfig = {
    mode: settings.authMode,
    credentialRef: settings.credentialRef,
    headerName: settings.headerName,
    headerPrefix: settings.headerPrefix,
    connectorRegion: settings.connectorRegion,
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
  }
  const sources = { credentials, connector }

  const portalAuthMode = settings.authMode === 'auto' || settings.authMode === 'workbuddy-connector'
    ? 'auto'
    : settings.authMode
  const portal = new PortalMarket({
    baseUrl: settings.portalBaseUrl,
    prefix: settings.portalPrefix,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
    authProvider: () => resolveAuth({ ...authConfig, mode: portalAuthMode }, sources),
  })

  const market = new MarketClient({
    baseUrl: settings.marketBaseUrl,
    manifestPath: settings.manifestPath,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    cacheTtlMs: settings.cacheTtlMs,
    staleWhileErrorMs: settings.staleWhileErrorMs,
    cacheDir: path.join(settings.dataDir, 'cache'),
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
    mode: settings.marketMode,
    portal,
    authProvider: () => resolveAuth({
      ...authConfig,
      mode: settings.authMode === 'auto' || settings.authMode === 'workbuddy-connector' ? 'none' : settings.authMode,
    }, sources),
  })

  const bundles = new BundleStore({
    cacheDir: path.join(settings.dataDir, 'cache'),
    market,
    localRoots: settings.localRoots,
    maxPromptChars: settings.maxPromptChars,
  })

  const sessions = new SessionManager({
    ctx,
    market,
    bundles,
    config: settings,
  })

  const connectors = createConnectorController(ctx, { dataDir: settings.dataDir })
  // 连接器的会话门控全靠这几个生命周期钩子（agent/created、agent/pre-step、
  // agent/disposed、tools/change）。忘记 init() 的后果是：一切"看起来正常"，
  // 但 tools.restrict 永远不会被调用——停用的连接器工具照样能被模型调到。
  connectors.init()

  // 「记忆系统技能市场」只有在 dsh-mnemon 真的装在当前 profile 时才有意义：
  // 它指向那个插件自己的技能管理页。profileDir 传函数是因为连接器控制器是惰性
  // 定位 profile 的，这里跟着它走，避免两边算出不同目录。缓存 60s，装/卸插件
  // 本来就要重启 DSH。
  const mnemonState = createMnemonDetector({
    dshHome: resolveDshHome(),
    profileDir: () => connectors.profileDir,
  })

  registerWebUi(ctx, {
    sessions,
    market,
    bundles,
    connector,
    portal,
    connectors,
    mnemon: mnemonState,
    // 面板的「账号」区：扫码登录、刷新、删除、迁移旧 vault。
    accounts,
    // 技能真实安装要自己 fetch 签名 CDN 链接，必须带上与 portal 相同的白名单。
    allowHosts: settings.allowHosts,
    allowInsecureLoopback: settings.allowInsecureLoopback,
  })

  const run = async (agent, action, args = {}) => {
    switch (action) {
      case 'status': {
        const view = sessions.view(agent.id)
        const [connectorStatus, accountView] = await Promise.all([
          connector.status(),
          accounts.list().catch(() => undefined),
        ])
        const authStatus = await describeAuth(authConfig, sources)
        return {
          ok: true,
          data: {
            ...view,
            connector: connectorStatus,
            // 账号来源与规模：本插件自己的库是主，兼容层只做回落。
            accounts: accountView === undefined ? null : {
              ownCount: accountView.summary.ownCount,
              vaultCount: accountView.summary.vaultCount,
              usableCount: accountView.summary.usableCount,
              dir: accountView.summary.dir,
              source: accountView.summary.source,
              pending: accountView.pending.length,
            },
            auth: authStatus,
            market: {
              mode: settings.marketMode,
              portal: await portal.available(),
              snapshotBaseUrl: settings.marketBaseUrl,
            },
            // 面板的「记忆系统技能市场」页签靠这个决定是否出现；模型也能据此知道
            // 本机有没有那套技能管理页可指路。
            mnemon: await mnemonState(),
          },
        }
      }
      case 'expert': {
        if (typeof args.expertId !== 'string' || args.expertId.trim() === '') {
          return { ok: false, text: 'expertId is required for action=expert' }
        }
        return { ok: true, data: await sessions.selectExpert(agent.id, args.expertId.trim()) }
      }
      case 'off':
        return { ok: true, data: await sessions.clear(agent.id) }
      case 'skills': {
        // skillAction=install 直接把市场技能装进当前工作区；默认只列会话里的技能。
        if (args.skillAction === 'install') {
          const skillId = typeof args.skillId === 'string' ? args.skillId.trim() : ''
          if (skillId === '') return { ok: false, text: 'skillId is required for action=skills, skillAction=install' }
          const workspace = agent?.session?.header?.cwd ?? process.cwd()
          try {
            const result = await installSkill({
              portal,
              skillId,
              workspace,
              allowHosts: settings.allowHosts,
              allowInsecureLoopback: settings.allowInsecureLoopback,
              // force=true 只在操作者明确知道残留锁是自己的死进程留下时使用；
              // 它跳过 stale 等待直接破锁，代价是可能打断另一个真在跑的安装。
              force: args.force === true,
            })
            return { ok: true, data: { action: 'skills', subaction: 'install', workspace, ...result } }
          } catch (error) {
            return { ok: false, text: `skill install failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        }
        if (args.skillAction === 'installed') {
          const workspace = agent?.session?.header?.cwd ?? process.cwd()
          return { ok: true, data: { action: 'skills', subaction: 'installed', workspace, items: await listInstalledSkills(workspace) } }
        }
        return { ok: true, data: await sessions.listSkills(agent.id) }
      }
      case 'skill-market': {
        const page = Math.max(1, Number(args.page ?? 1) || 1)
        const pageSize = Math.max(1, Math.min(Number(args.pageSize ?? 12) || 12, 24))
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        return { ok: true, data: await portal.listSkills({ query, page, pageSize }) }
      }
      case 'set-skills': {
        const mode = args.mode === 'selected' ? 'selected' : args.mode === 'all' ? 'all' : undefined
        const globalNames = parseList(args.names)
        const expertNames = parseList(args.expertNames)
        return {
          ok: true,
          data: await sessions.setSkills(agent.id, {
            globalMode: mode,
            globalNames,
            expertNames,
          }),
        }
      }
      case 'connector': {
        const sub = String(args.connectorAction ?? (typeof args.connectorId === 'string' ? 'status' : 'list')).trim()
        const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : ''
        if (sub === 'list' || sub === 'catalog' || sub === 'status') {
          const [view, catalog, states, accounts, shared] = await Promise.all([
            connectors.connectorViews(),
            connectors.catalog(),
            connectors.states(agent.id),
            connector.status().catch(() => undefined),
            connectors.shared().catch(() => undefined),
          ])
          const connected = Object.values(states).filter(state => state?.connected === true)
          return {
            ok: true,
            data: {
              action: 'connector',
              subaction: sub,
              catalogTotal: catalog.total,
              categories: catalog.categories,
              pluginTotal: view.total,
              plugins: view.items,
              accounts: accounts === undefined ? null : {
                installed: accounts.installed,
                accountCount: accounts.accountCount,
                usableAccountCount: accounts.usableAccountCount,
              },
              // 连接器管理页（dsh-mcp-connector）那边的连接；两边共用同一批 mcp__ 工具。
              connectorUi: shared === undefined
                ? null
                : {
                  available: shared.available,
                  file: shared.file,
                  connectionCount: shared.connections.size,
                  connectors: [...shared.byConnector.keys()],
                },
              connectedCount: connected.length,
              connected: connected.map(state => ({ id: state.configId, source: state.source, toolCount: state.toolCount, tools: state.tools })),
              disabled: [...connectors.disabledOf(agent.id)],
              pending: connectors.pendingOperations(),
              patchPath: connectors.patchPath,
            },
          }
        }
        if (connectorId === '') return { ok: false, text: `connectorId is required for connectorAction=${sub}` }
        const sessionId = agent.id
        switch (sub) {
          case 'connect':
          case 'repair':
          case 'repairConnect':
          case 'reauthorize':
            return {
              ok: true,
              data: await connectors.connect(connectorId, {
                action: sub === 'connect' ? 'connect' : sub === 'reauthorize' ? 'reauthorize' : 'repairConnect',
                sessionId,
                token: typeof args.token === 'string' ? args.token : undefined,
              }),
            }
          case 'disconnect':
            return { ok: true, data: await connectors.disconnect(connectorId) }
          case 'cancel':
            return { ok: true, data: await connectors.cancelConnect(connectorId) }
          case 'unbind':
            return { ok: true, data: await connectors.unbind(connectorId) }
          case 'enable':
          case 'disable':
            return { ok: true, data: await connectors.setEnabled(connectorId, sub === 'enable', sessionId) }
          case 'state':
            return { ok: true, data: await connectors.stateOf(connectorId, sessionId) }
          default:
            return { ok: false, text: `unknown connectorAction: ${sub}` }
        }
      }
      case 'account': {
        const sub = String(args.accountAction ?? 'list').trim()
        switch (sub) {
          case 'list': {
            const view = await accounts.list()
            return {
              ok: true,
              data: {
                action: 'account',
                subaction: sub,
                ...view.summary,
                own: view.own,
                all: view.all,
                pending: view.pending,
              },
            }
          }
          case 'login': {
            // 返回给人打开的 URL。模型不能替人扫码，所以这里只把链路递出去。
            const started = await accounts.start(args.region === 'global' ? 'global' : 'cn')
            if (started.error !== undefined) return { ok: false, text: `could not start the WorkBuddy sign-in: ${started.error}` }
            return {
              ok: true,
              data: {
                action: 'account',
                subaction: sub,
                loginId: started.loginId,
                verificationUri: started.verificationUri,
                expiresIn: started.expiresIn,
                region: started.region,
                next: 'open verificationUri in a browser, then poll with accountAction=poll and this loginId',
              },
            }
          }
          case 'poll': {
            const loginId = String(args.loginId ?? '').trim()
            if (loginId === '') return { ok: false, text: 'loginId is required for accountAction=poll' }
            const outcome = await accounts.poll(loginId, {
              ...args.region === 'global' || args.region === 'cn' ? { region: args.region } : {},
            })
            return { ok: outcome.error === undefined, data: { action: 'account', subaction: sub, loginId, ...outcome } }
          }
          case 'cancel': {
            const cancelled = accounts.cancel(String(args.loginId ?? '').trim())
            return { ok: cancelled, data: { action: 'account', subaction: sub, cancelled } }
          }
          case 'refresh': {
            const accountId = String(args.accountId ?? '').trim()
            if (accountId === '') return { ok: false, text: 'accountId is required for accountAction=refresh' }
            return { ok: true, data: { action: 'account', subaction: sub, account: await accounts.refresh(accountId) } }
          }
          case 'remove': {
            const accountId = String(args.accountId ?? '').trim()
            if (accountId === '') return { ok: false, text: 'accountId is required for accountAction=remove' }
            return { ok: true, data: { action: 'account', subaction: sub, ...await accounts.remove(accountId) } }
          }
          case 'import': {
            // 一次性把 dsh-connect-workbuddy 的 vault 搬进本插件自己的库（只读那边）。
            return { ok: true, data: { action: 'account', subaction: sub, ...await accounts.importLegacy() } }
          }
          default:
            return { ok: false, text: `unknown accountAction: ${sub}\n${USAGE}` }
        }
      }
      case 'market': {
        const query = String(args.query ?? '').trim().toLowerCase()
        const [remote, local, portalAvailable] = await Promise.all([
          market.listExperts({ query: args.query ?? '', limit: 10 }),
          bundles.listLocal(),
          portal.available(),
        ])
        const localPlugins = new Set(local.map(item => item.plugin))
        const remoteItems = remote.items.map(item => ({
          ...item,
          installed: localPlugins.has(item.plugin),
        }))
        const localOnly = local
          .filter(item => !remoteItems.some(remoteItem => remoteItem.plugin === item.plugin || remoteItem.id === item.id))
          .filter(item => query === '' || [item.id, item.plugin, item.agentName, item.displayName, item.profession, item.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query))
          .slice(0, 10)
        const items = [
          ...localOnly.map(item => ({ ...item, source: 'local' })),
          ...remoteItems,
        ].slice(0, 20)
        const marketTotal = portalAvailable ? await market.marketSize() : remote.total
        return {
          ok: true,
          data: {
            source: remote.source,
            marketTotal,
            matchedTotal: remote.total,
            publicTotal: marketTotal,
            localTotal: local.length,
            matched: items.length,
            portalAvailable,
            stale: remote.stale,
            fetchedAt: remote.fetchedAt,
            warning: remote.warning,
            items,
          },
        }
      }
      case 'categories': {
        return {
          ok: true,
          data: {
            source: (await portal.available()) ? 'portal' : 'cos',
            items: await market.categories(),
          },
        }
      }
      default:
        return { ok: false, text: USAGE }
    }
  }

  const format = result => {
    if (result.ok === false) return result.text ?? 'ERROR: request failed'
    return JSON.stringify(result.data, null, 2)
  }

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    ctx.tools.register(defineTool({
      name: 'workbuddy_helper',
      description:
        'Inspect or change the expert, skill and connector selection of the CALLING session. '
        + 'Actions: status, expert <expertId>, off, skills, set-skills, skill-market, connector, account, market, categories. '
        + 'accountAction=list|login|poll|cancel|refresh|remove|import signs in to WorkBuddy in-process (no dsh-connect-workbuddy needed), stores the token in this plugin\'s own account store, and can migrate a legacy vault. '
        + 'market queries the live WorkBuddy marketplace when the connector has an account token, and falls back to the published snapshot otherwise. '
        + 'The selection is session-scoped: it never changes another session and never writes global configuration. '
        + 'connectorAction=list|state|connect|repair|cancel|disconnect|unbind|enable|disable drives the WorkBuddy connector catalog for this session; '
        + 'connect returns status connected|connecting|action-required|failed, and action-required carries the token form or OAuth handoff to finish.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'status | expert | off | skills | set-skills | skill-market | connector | account | market | categories',
        },
        skillAction: {
          type: 'string',
          description: 'Skill sub-action for action=skills: install (needs skillId) | installed (list what is on disk in the workspace).',
        },
        skillId: {
          type: 'string',
          description: 'Market skill id (skill_...) used with action=skills, skillAction=install.',
        },
        force: {
          type: 'boolean',
          description: 'Skill install: break a leftover .lock-<slug> directory instead of waiting it out. Use only when you know the previous install died; it can interrupt a live one.',
        },
        page: {
          type: 'number',
          description: 'Page number for action=skill-market (default 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Page size for action=skill-market (default 12, max 24).',
        },
        expertId: {
          type: 'string',
          description: 'Expert id, plugin slug or agentName used by action=expert.',
        },
        connectorAction: {
          type: 'string',
          description: 'Connector sub-action for action=connector: list (default) | state | connect | repair | cancel | disconnect | unbind | enable | disable.',
        },
        connectorId: {
          type: 'string',
          description: 'Connector id from the catalog or a connector plugin name, used with connectorAction.',
        },
        accountAction: {
          type: 'string',
          description: 'Account sub-action for action=account: list (default) | login | poll | cancel | refresh | remove | import. login returns a verificationUri a human must open; poll with the returned loginId stores the token in this plugin\'s own account store; import migrates a dsh-connect-workbuddy vault read-only.',
        },
        accountId: {
          type: 'string',
          description: 'Account id from accountAction=list, used with accountAction=refresh or remove.',
        },
        loginId: {
          type: 'string',
          description: 'Login id returned by accountAction=login, used with accountAction=poll or cancel.',
        },
        region: {
          type: 'string',
          description: 'WorkBuddy realm for accountAction=login/poll: cn (default) or global. A token issued by one realm is rejected by the other, so pick the realm the human actually uses.',
        },
        token: {
          type: 'string',
          description: 'Credential for connectorAction=connect when the connector authorises by api-key or bearer token.',
        },
        query: {
          type: 'string',
          description: 'Search text used by action=market.',
        },
        mode: {
          type: 'string',
          description: 'Global skill mode for action=set-skills: all or selected.',
        },
        names: {
          type: 'string',
          description: 'Comma-separated global skill names for action=set-skills.',
        },
        expertNames: {
          type: 'string',
          description: 'Comma-separated expert skill names for action=set-skills.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) return 'ERROR: workbuddy_helper requires a calling session'
        try {
          const result = await run(agent, args.action, args)
          return format(result)
        } catch (error) {
          const message = error instanceof AuthError
            ? `${error.code}: ${redact(error.message, [])}`
            : redact(error instanceof Error ? error.message : String(error), [])
          return `ERROR: ${message}`
        }
      },
    }))
  }

  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      name: 'workbuddy-helper',
      description: 'Select or inspect this session\'s expert, skills and connectors.',
      input: { hint: 'status | expert <id> | off | skills [install <skillId> [--force] | installed] | connector <list|connect|disconnect|cancel|state> [id] | account <list|login|poll|refresh|remove|import> [id] | market <query>' },
      async handler({ agent, rawInput }) {
        if (agent === undefined) return { kind: 'error', text: 'no calling session' }
        const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const action = tokens.shift() ?? 'status'
        const args = {}
        if (action === 'expert') args.expertId = tokens.join(' ')
        if (action === 'market') args.query = tokens.join(' ')
        if (action === 'skills') {
          // skills install <skillId> [--force] / skills installed
          const sub = tokens.shift()
          if (sub === 'install' || sub === 'installed') {
            args.skillAction = sub
            const rest = tokens.filter(token => token !== '--force')
            if (sub === 'install') args.skillId = rest.shift() ?? ''
            args.force = tokens.indexOf('--force') >= 0
          }
        }
        if (action === 'connector') {
          args.connectorAction = tokens.shift() ?? 'list'
          const rest = tokens.join(' ').trim()
          if (rest !== '') args.connectorId = rest
        }
        if (action === 'account') {
          // account <sub> [accountId|loginId] [region=cn|global]
          args.accountAction = tokens.shift() ?? 'list'
          for (const token of [...tokens]) {
            const [key, value] = token.split('=')
            if (key === 'region') {
              args.region = value
              tokens.splice(tokens.indexOf(token), 1)
            }
            if (key === 'loginId') {
              args.loginId = value
              tokens.splice(tokens.indexOf(token), 1)
            }
          }
          const target = tokens.join(' ').trim()
          if (target !== '') {
            if (args.accountAction === 'poll' || args.accountAction === 'cancel') args.loginId = target
            else args.accountId = target
          }
        }
        if (action === 'set-skills') {
          for (const token of tokens) {
            const [key, value] = token.split('=')
            if (key === 'mode') args.mode = value
            if (key === 'names') args.names = value
            if (key === 'expertNames') args.expertNames = value
          }
        }
        try {
          return { kind: 'success', text: format(await run(agent, action, args)) }
        } catch (error) {
          return { kind: 'error', text: redact(error instanceof Error ? error.message : String(error), []) }
        }
      },
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    void sessions.onAgentCreated(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    sessions.onAgentDisposed(agent.id)
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      connectors.dispose()
      void sessions.disposeAll()
    }, 'workbuddy-helper: dispose session fibers')
  }

  queueMicrotask(() => {
    void sessions.reconcile().catch(error => {
      ctx.logger?.warn?.('workbuddy-helper: reconcile failed: %s', String(error))
    })
  })
}

function parseList(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.split(',').map(item => item.trim()).filter(Boolean)
}
