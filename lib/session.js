import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SessionExpertPlugin } from './session-plugin.js'
import { ensureDir, nowIso, readJson, sha256, writeJsonAtomic } from './util.js'

const SCHEMA_VERSION = 1

function defaultSkills() {
  return { globalMode: 'all', globalNames: [], expertNames: [] }
}

/**
 * Owns the per-session lifecycle: resolve an expert, mount the agent-scoped
 * child plugin, persist the selection, and dispose it on clear or shutdown.
 *
 * Every mutation for one session is serialized through a promise queue. A new
 * child plugin is mounted before the old one is disposed; because provider and
 * prompt-section names carry a generation suffix, a failed mount leaves the
 * previous persona untouched.
 */
export class SessionManager {
  constructor(options) {
    this.ctx = options.ctx
    this.market = options.market
    this.bundles = options.bundles
    this.config = options.config ?? {}
    this.sessionsDir = path.join(this.config.dataDir, 'sessions')
    this.maxSelectedSkills = this.config.maxSelectedSkills ?? 64
    this.states = new Map()
    this.live = new Map()
    this.warnings = new Map()
    this.queues = new Map()
    this.generation = 0
  }

  defaultState(sessionId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      revision: 0,
      expert: null,
      skills: defaultSkills(),
      updatedAt: nowIso(),
    }
  }

  stateFile(sessionId) {
    return path.join(this.sessionsDir, `${sha256(sessionId)}.json`)
  }

  async loadState(sessionId) {
    if (this.states.has(sessionId)) return this.states.get(sessionId)
    const stored = await readJson(this.stateFile(sessionId))
    const state = this.normalizeState(stored, sessionId)
    this.states.set(sessionId, state)
    return state
  }

  normalizeState(value, sessionId) {
    if (value === null || typeof value !== 'object') return this.defaultState(sessionId)
    const skills = value.skills !== null && typeof value.skills === 'object' ? value.skills : {}
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      revision: Number.isFinite(Number(value.revision)) ? Number(value.revision) : 0,
      expert: value.expert !== null && typeof value.expert === 'object'
        ? { ...value.expert, displayName: displayNameOf(value.expert) }
        : null,
      skills: {
        globalMode: skills.globalMode === 'selected' ? 'selected' : 'all',
        globalNames: Array.isArray(skills.globalNames) ? skills.globalNames.filter(item => typeof item === 'string') : [],
        expertNames: Array.isArray(skills.expertNames) ? skills.expertNames.filter(item => typeof item === 'string') : [],
      },
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
    }
  }

  async saveState(state) {
    state.revision += 1
    state.updatedAt = nowIso()
    await ensureDir(this.sessionsDir)
    await writeJsonAtomic(this.stateFile(state.sessionId), state)
    this.states.set(state.sessionId, state)
  }

  queue(sessionId, task) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(sessionId, next.catch(() => undefined))
    return next
  }


  async resolveExpert(idOrPlugin) {
    const needle = String(idOrPlugin ?? '').trim()
    if (needle !== '' && !needle.startsWith('ex_')) {
      const locals = await this.bundles.listLocal()
      const installed = locals.find(item => {
        return [item.id, item.plugin, item.agentName]
          .filter(Boolean)
          .some(value => String(value).toLowerCase() === needle.toLowerCase())
      })
      if (installed !== undefined) {
        return { expert: installed, stale: false, marketSource: 'local' }
      }
    }
    try {
      return await this.market.getExpert(needle)
    } catch (error) {
      const local = await this.bundles.findLocal({ id: needle, plugin: needle, agentName: needle })
      if (local === undefined) throw error
      return {
        expert: {
          id: needle,
          plugin: needle,
          agentName: needle,
          displayName: needle,
        },
        marketSource: 'local',
        stale: false,
      }
    }
  }

  async selectExpert(sessionId, expertId) {
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      const before = structuredClone(state)
      const resolved = await this.resolveExpert(expertId)
      const pkg = await this.bundles.ensure(resolved.expert)
      const agent = this.ctx.agents.get(sessionId)

      state.expert = {
        id: resolved.expert.id,
        plugin: resolved.expert.plugin ?? resolved.expert.agentName ?? resolved.expert.id,
        version: pkg.version,
        displayName: displayNameOf({ displayName: pkg.displayName ?? resolved.expert.displayName, id: resolved.expert.id }),
        root: pkg.root,
        source: pkg.source,
        promptChars: pkg.promptChars,
        promptTruncated: pkg.promptTruncated,
      }
      state.skills.expertNames = pkg.skills.map(skill => skill.name).slice(0, this.maxSelectedSkills)

      if (agent !== undefined) {
        try {
          await this.apply(agent, state, pkg)
        } catch (error) {
          Object.assign(state, before)
          throw error
        }
      }
      await this.saveState(state)
      this.warnings.delete(sessionId)
      return this.view(sessionId)
    })
  }

  async clear(sessionId) {
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      await this.disposeLive(sessionId)
      state.expert = null
      state.skills = defaultSkills()
      await this.saveState(state)
      this.warnings.delete(sessionId)
      return this.view(sessionId)
    })
  }

  async setSkills(sessionId, patch = {}) {
    return this.queue(sessionId, async () => {
      const state = await this.loadState(sessionId)
      const mode = patch.globalMode === 'selected' ? 'selected' : patch.globalMode === 'all' ? 'all' : state.skills.globalMode
      const globalNames = Array.isArray(patch.globalNames)
        ? uniqueStrings(patch.globalNames).slice(0, this.maxSelectedSkills)
        : state.skills.globalNames
      const expertNames = Array.isArray(patch.expertNames)
        ? uniqueStrings(patch.expertNames).slice(0, this.maxSelectedSkills)
        : state.skills.expertNames
      state.skills = { globalMode: mode, globalNames, expertNames }
      this.live.get(sessionId)?.refresh?.()
      await this.saveState(state)
      return this.view(sessionId)
    })
  }

  async apply(agent, state, pkg) {
    const sessionId = agent.id
    const generation = String(++this.generation)
    let ready
    const fiber = await agent.ctx.plugin(SessionExpertPlugin, {
      state,
      expert: state.expert,
      prompt: pkg.prompt,
      expertSkills: pkg.skills,
      globalSkills: this.ctx.skills,
      generation,
      onReady(handle) {
        ready = handle
      },
    })

    const previous = this.live.get(sessionId)
    this.live.set(sessionId, {
      fiber,
      state,
      pkg,
      refresh: typeof ready?.refreshSkills === 'function' ? ready.refreshSkills : undefined,
      generation,
    })
    if (previous !== undefined) {
      try {
        await previous.fiber.dispose()
      } catch (error) {
        this.ctx.logger?.warn?.('workbuddy-helper: previous fiber dispose failed: %s', String(error))
      }
    }
  }

  async disposeLive(sessionId) {
    const live = this.live.get(sessionId)
    if (live === undefined) return
    this.live.delete(sessionId)
    await live.fiber.dispose()
  }

  view(sessionId) {
    const state = this.states.get(sessionId) ?? this.defaultState(sessionId)
    const live = this.live.get(sessionId)
    return {
      sessionId,
      revision: state.revision,
      applied: live !== undefined,
      expert: state.expert,
      skills: state.skills,
      skillCount: (state.skills.globalMode === 'all' ? null : state.skills.globalNames.length) + state.skills.expertNames.length,
      warning: this.warnings.get(sessionId) ?? null,
    }
  }

  async listSkills(sessionId) {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`session is not live: ${sessionId}`)
    const state = await this.loadState(sessionId)
    const live = this.live.get(sessionId)
    const cwd = agent.session?.header?.cwd ?? process.cwd()
    const global = await this.ctx.skills.list({ cwd, scope: undefined })
    return {
      globalMode: state.skills.globalMode,
      global: global.map(skill => ({
        name: skill.name,
        description: skill.description,
        enabled: state.skills.globalMode === 'all' || state.skills.globalNames.includes(skill.name),
      })),
      expert: (live?.pkg?.skills ?? []).map(skill => ({
        name: skill.name,
        description: skill.description,
        enabled: state.skills.expertNames.includes(skill.name),
      })),
    }
  }

  /**
   * Read-only snapshot for the composer panel.
   *
   * Unlike `listSkills`, this works before the session has an Agent: a blank
   * conversation can open the panel, pick an expert and toggle global skills.
   */
  async panelState(sessionId) {
    const state = await this.loadState(sessionId)
    const live = this.live.get(sessionId)
    const agent = this.ctx.agents.get(sessionId)
    const cwd = agent?.session?.header?.cwd ?? process.cwd()
    let global = []
    try {
      global = await this.ctx.skills.list({ cwd, scope: undefined })
    } catch {
      global = []
    }
    const enabled = name => state.skills.globalMode === 'all' || state.skills.globalNames.includes(name)
    return {
      ...this.view(sessionId),
      globalSkills: global.map(skill => ({
        name: skill.name,
        description: skill.description,
        enabled: enabled(skill.name),
      })),
      expertSkills: (live?.pkg?.skills ?? []).map(skill => ({
        name: skill.name,
        description: skill.description,
        enabled: state.skills.expertNames.includes(skill.name),
      })),
    }
  }

  async onAgentCreated(agent) {    return this.queue(agent.id, async () => {
      const state = await this.loadState(agent.id)
      if (state.expert === null) return
      try {
        const resolved = await this.resolveExpert(state.expert.id)
        const pkg = await this.bundles.ensure(resolved.expert)
        await this.apply(agent, state, pkg)
        this.warnings.delete(agent.id)
      } catch (error) {
        const message = `expert "${state.expert.displayName ?? state.expert.id}" could not be restored: ${error instanceof Error ? error.message : String(error)}`
        this.warnings.set(agent.id, message)
        this.ctx.logger?.warn?.('workbuddy-helper: %s', message)
      }
    })
  }

  onAgentDisposed(sessionId) {
    const live = this.live.get(sessionId)
    if (live !== undefined) {
      this.live.delete(sessionId)
      void live.fiber.dispose().catch(() => undefined)
    }
  }

  async reconcile() {
    for (const agent of this.ctx.agents.list()) {
      if (!this.live.has(agent.id)) {
        await this.onAgentCreated(agent).catch(() => undefined)
      }
    }
  }

  async disposeAll() {
    const entries = [...this.live.values()]
    this.live.clear()
    for (const entry of entries) {
      try {
        await entry.fiber.dispose()
      } catch {
        continue
      }
    }
  }
}

function displayNameOf(expert) {
  const value = expert.displayName
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return value.zh ?? value.en ?? expert.id
  return expert.id
}

function uniqueStrings(values) {
  return [...new Set(values.filter(item => typeof item === 'string' && item !== ''))]
}
