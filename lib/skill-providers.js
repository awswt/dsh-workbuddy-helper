/**
 * Session-scoped skill providers.
 *
 * Two layers are installed through `agent.ctx`:
 *
 *   workbuddy-helper-expert-<gen>   rank 200   skills shipped by the expert
 *   workbuddy-helper-filter-<gen>   rank 1000  shadows every global skill and
 *                                              flips invocation flags for the
 *                                              session selection
 *
 * The generation suffix lets a switch mount the new child plugin before the
 * old one is disposed, so a failed switch leaves the previous persona intact.
 *
 * The native `dsh-tool-skill` consumer reads the catalog with `scope: agent`,
 * so both providers are visible to that agent only. No global skill file is
 * touched and no `skill` tool is shadowed.
 */

const EXPERT_RANK = 200
const FILTER_RANK = 1000
const HIDDEN = Object.freeze({ modelInvocable: false, userInvocable: false })

function selectedSet(mode, names) {
  if (mode !== 'selected') return undefined
  return new Set(Array.isArray(names) ? names : [])
}

function expertSet(state) {
  const names = state.skills.expertNames
  return Array.isArray(names) ? new Set(names) : undefined
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx agent-scoped context
 * @param {Array<{name: string, description: string, whenToUse?: string, content: string, path?: string, root: string, invocation?: {modelInvocable: boolean, userInvocable: boolean}}>} expertSkills
 * @param {{skills: {expertNames: string[]}}} state mutable session state
 * @param {string} suffix generation suffix
 * @returns {() => void} invalidates the provider catalog after a selection change
 */
export function installExpertSkillProvider(ctx, expertSkills, state, suffix = '0') {
  if (!Array.isArray(expertSkills) || expertSkills.length === 0) return () => {}
  const providerName = `workbuddy-helper-expert-${suffix}`
  const byName = new Map(expertSkills.map(skill => [skill.name, skill]))
  let invalidate = () => {}

  const provider = {
    name: providerName,
    async list() {
      const enabled = expertSet(state)
      return {
        candidates: expertSkills.map(skill => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          invocation: enabled === undefined || enabled.has(skill.name)
            ? (skill.invocation ?? { modelInvocable: true, userInvocable: true })
            : HIDDEN,
          source: 'custom',
          provider: providerName,
          path: skill.path,
          resourceBase: { kind: 'directory', path: skill.root },
          rank: EXPERT_RANK,
          locator: { name: skill.name },
        })),
        complete: true,
      }
    },
    async get(candidate) {
      const enabled = expertSet(state)
      if (enabled !== undefined && !enabled.has(candidate.name)) return undefined
      const skill = byName.get(candidate.name)
      if (skill === undefined) return undefined
      return {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.content,
        path: skill.path,
        resourceBase: { kind: 'directory', path: skill.root },
        invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
        source: 'custom',
        provider: providerName,
      }
    },
  }

  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    return provider
  })

  return () => invalidate()
}

/**
 * Shadow every skill in the global catalog with an agent-local candidate.
 *
 * - selected skill   -> keep the original invocation policy
 * - unselected skill -> both invocation flags false, so neither the model
 *                       catalog nor the `/name` gesture can see it
 *
 * `scope: undefined` reads the global layer only and avoids recursing into
 * this provider.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx agent-scoped context
 * @param {{snapshot: Function, get: Function}} globalSkills host-level skill registry
 * @param {{skills: {globalMode: 'all'|'selected', globalNames: string[]}}} state mutable session state
 * @param {string} suffix generation suffix
 * @returns {() => void} invalidates the provider catalog after a selection change
 */
export function installGlobalSkillFilter(ctx, globalSkills, state, suffix = '0') {
  if (globalSkills === undefined || globalSkills === null) {
    throw new Error('workbuddy-helper: global skill registry is unavailable')
  }
  const providerName = `workbuddy-helper-filter-${suffix}`
  let invalidate = () => {}

  const provider = {
    name: providerName,
    async list(options) {
      const snapshot = await globalSkills.snapshot({
        cwd: options.cwd,
        signal: options.signal,
        scope: undefined,
      })
      const enabled = selectedSet(state.skills.globalMode, state.skills.globalNames)
      return {
        candidates: snapshot.skills.map(skill => ({
          ...skill,
          rank: FILTER_RANK,
          locator: { name: skill.name },
          invocation: enabled === undefined || enabled.has(skill.name)
            ? skill.invocation
            : HIDDEN,
        })),
        complete: snapshot.complete,
      }
    },
    async get(candidate, options) {
      const enabled = selectedSet(state.skills.globalMode, state.skills.globalNames)
      if (enabled !== undefined && !enabled.has(candidate.name)) return undefined
      return globalSkills.get(candidate.name, {
        cwd: options.cwd,
        signal: options.signal,
        scope: undefined,
      })
    },
  }

  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    return provider
  })

  return () => invalidate()
}
