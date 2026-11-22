import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AuthError, describeAuth, redact, resolveAuth } from './auth.js'
import { BundleStore } from './bundle.js'
import { WorkBuddyConnector } from './connector.js'
import { MarketClient } from './market.js'
import { SessionManager } from './session.js'
import { expandHome, resolveDshHome } from './util.js'

const DEFAULT_HOST = 'acc-1258344699.cos.accelerate.myqcloud.com'
const DEFAULT_BASE = `https://${DEFAULT_HOST}/workbuddy/expert-marketplace`
const USAGE = [
  'workbuddy_helper actions:',
  '  status',
  '  expert <expertId>',
  '  off',
  '  skills',
  '  set-skills <mode=all|selected> [names=a,b] [expertNames=c,d]',
  '  connector',
  '  market [query]',
].join('\n')

export const name = 'dsh-workbuddy-helper'
export const inject = ['tools', 'agents', 'systemPrompt', 'skills']

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const settings = {
    marketBaseUrl: config.marketBaseUrl ?? DEFAULT_BASE,
    manifestPath: config.manifestPath ?? '/expert_center.json',
    timeoutMs: config.timeoutMs ?? 20000,
    retries: config.retries ?? 1,
    cacheTtlMs: config.cacheTtlMs ?? 6 * 60 * 60 * 1000,
    staleWhileErrorMs: config.staleWhileErrorMs ?? 7 * 24 * 60 * 60 * 1000,
    authMode: config.authMode ?? 'none',
    credentialRef: config.credentialRef ?? 'WB_EXPERT_TOKEN',
    headerName: config.headerName ?? 'Authorization',
    headerPrefix: config.headerPrefix ?? 'Bearer ',
    connectorRegion: config.connectorRegion,
    allowHosts: config.allowHosts ?? [DEFAULT_HOST],
    allowInsecureLoopback: config.allowInsecureLoopback === true,
    maxPromptChars: config.maxPromptChars ?? 60000,
    maxSelectedSkills: config.maxSelectedSkills ?? 64,
    dataDir: expandHome(config.dataDir ?? path.join(resolveDshHome(), 'workbuddy-helper')),
    dshHome: expandHome(config.dshHome ?? resolveDshHome()),
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
    authProvider: () => resolveAuth(authConfig, sources),
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

  const run = async (agent, action, args = {}) => {
    switch (action) {
      case 'status': {
        const view = sessions.view(agent.id)
        const connectorStatus = await connector.status()
        const authStatus = await describeAuth(authConfig, sources)
        return { ok: true, data: { ...view, connector: connectorStatus, auth: authStatus } }
      }
      case 'expert': {
        if (typeof args.expertId !== 'string' || args.expertId.trim() === '') {
          return { ok: false, text: 'expertId is required for action=expert' }
        }
        return { ok: true, data: await sessions.selectExpert(agent.id, args.expertId.trim()) }
      }
      case 'off':
        return { ok: true, data: await sessions.clear(agent.id) }
      case 'skills':
        return { ok: true, data: await sessions.listSkills(agent.id) }
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
      case 'connector':
        return { ok: true, data: await connector.status() }
      case 'market': {
        const query = String(args.query ?? '').trim().toLowerCase()
        const [remote, local] = await Promise.all([
          market.listExperts({ query: args.query ?? '', limit: 10 }),
          bundles.listLocal(),
        ])
        const localItems = local
          .filter(item => query === '' || [item.id, item.plugin, item.agentName, item.displayName, item.profession, item.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query))
          .slice(0, 10)
        const items = [
          ...localItems.map(item => ({ ...item, source: 'local' })),
          ...remote.items.map(item => ({ ...item, source: 'market' })),
        ].slice(0, 20)
        return {
          ok: true,
          data: {
            publicTotal: remote.total,
            localTotal: local.length,
            matched: items.length,
            stale: remote.stale,
            fetchedAt: remote.fetchedAt,
            items,
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
        'Inspect or change the expert and skill selection of the CALLING session. '
        + 'Actions: status, expert <expertId>, off, skills, set-skills, connector, market. '
        + 'The selection is session-scoped: it never changes another session and never writes global configuration. '
        + 'Use connector to inspect the WorkBuddy connector account pool without revealing tokens.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'status | expert | off | skills | set-skills | connector | market',
        },
        expertId: {
          type: 'string',
          description: 'Expert id, plugin slug or agentName used by action=expert.',
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
      description: 'Select or inspect this session\'s expert and skills.',
      input: { hint: 'status | expert <id> | off | skills | connector | market <query>' },
      async handler({ agent, rawInput }) {
        if (agent === undefined) return { kind: 'error', text: 'no calling session' }
        const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const action = tokens.shift() ?? 'status'
        const args = {}
        if (action === 'expert') args.expertId = tokens.join(' ')
        if (action === 'market') args.query = tokens.join(' ')
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
