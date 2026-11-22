import { promises as fs } from 'node:fs'
import path from 'node:path'
import { x as extractTar } from 'tar'
import { parse as parseYaml } from 'yaml'
import { ensureDir, expandHome, readJson, safeJoin, sha256, truncate, writeJsonAtomic } from './util.js'

const PLUGIN_DIRS = ['.codebuddy-plugin', '.workbuddy-plugin']
const ALLOWED_PREFIXES = ['.codebuddy-plugin/', '.workbuddy-plugin/', 'agents/', 'skills/', 'avatars/', 'license/', 'README.md']
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function normalizeLocalText(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object') return value.zh ?? value.en ?? null
  return String(value)
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { meta: {}, body: text }
  try {
    const parsed = parseYaml(match[1])
    return { meta: parsed !== null && typeof parsed === 'object' ? parsed : {}, body: text.slice(match[0].length) }
  } catch {
    return { meta: {}, body: text.slice(match[0].length) }
  }
}

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(normalized)) return true
    if (['false', 'no', 'off', '0'].includes(normalized)) return false
  }
  return fallback
}

/**
 * Download, safely extract and parse a WorkBuddy expert bundle.
 *
 * A bundle is data, never code: only markdown, avatars and licenses are read,
 * symlinks and path traversal are rejected, and nothing is executed.
 */
export class BundleStore {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir
    this.market = options.market
    this.localRoots = (options.localRoots ?? []).map(expandHome)
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024
    this.maxFiles = options.maxFiles ?? 2000
    this.maxPromptChars = options.maxPromptChars ?? 60000
    this.maxSkillBodyChars = options.maxSkillBodyChars ?? 200000
    this.bundlesDir = path.join(this.cacheDir, 'bundles')
    this.downloadsDir = path.join(this.cacheDir, 'downloads')
  }


  async listLocal() {
    const found = []
    const seen = new Set()
    for (const root of this.localRoots) {
      let entries = []
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const candidate = path.join(root, entry.name)
        for (const dir of PLUGIN_DIRS) {
          try {
            const pluginJson = JSON.parse(await fs.readFile(path.join(candidate, dir, 'plugin.json'), 'utf8'))
            const plugin = String(pluginJson.plugin ?? pluginJson.name ?? entry.name)
            if (seen.has(plugin)) break
            seen.add(plugin)
            found.push({
              id: String(pluginJson.name ?? entry.name),
              plugin,
              agentName: pluginJson.agentName ?? plugin,
              displayName: normalizeLocalText(pluginJson.displayName),
              profession: normalizeLocalText(pluginJson.profession),
              description: normalizeLocalText(pluginJson.displayDescription ?? pluginJson.description),
              version: typeof pluginJson.version === 'string' ? pluginJson.version : null,
              source: 'local',
              path: candidate,
            })
            break
          } catch {
            continue
          }
        }
      }
    }
    return found
  }

  async ensure(expert) {
    const local = await this.findLocal(expert)
    if (local !== undefined) {
      return this.parse(local.root, expert, 'local')
    }

    const plugin = expert?.plugin ?? expert?.agentName ?? expert?.id
    const cacheKey = sha256(`${plugin}@${expert?.updatedAt ?? expert?.id ?? ''}`).slice(0, 16)
    const safePlugin = String(plugin).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'expert'
    const root = path.join(this.bundlesDir, `${safePlugin}-${cacheKey}`)
    const meta = await readJson(path.join(root, '.workbuddy-helper-bundle.json'))
    if (meta !== undefined) {
      return this.parse(root, expert, meta.source ?? 'market')
    }

    const url = this.market.bundleUrl(expert)
    const tarPath = path.join(this.downloadsDir, `${safePlugin}-${cacheKey}.tar.gz`)
    const downloaded = await this.market.download(url, tarPath, this.maxBytes)
    const tempRoot = `${root}.tmp-${process.pid}-${Date.now().toString(36)}`
    await fs.rm(tempRoot, { recursive: true, force: true })
    await ensureDir(tempRoot)
    try {
      await this.extractSafely(tarPath, tempRoot)
      await fs.rm(root, { recursive: true, force: true })
      await ensureDir(path.dirname(root))
      await fs.rename(tempRoot, root)
      await writeJsonAtomic(path.join(root, '.workbuddy-helper-bundle.json'), {
        source: 'market',
        url,
        sha256: downloaded.sha256,
        bytes: downloaded.bytes,
        expertId: expert.id,
        plugin,
        extractedAt: new Date().toISOString(),
      })
    } catch (error) {
      await fs.rm(tempRoot, { recursive: true, force: true })
      throw error
    }
    return this.parse(root, expert, 'market')
  }

  async findLocal(expert) {
    const plugin = expert?.plugin ?? expert?.agentName ?? expert?.id
    if (typeof plugin !== 'string' || plugin.trim() === '') return undefined
    for (const root of this.localRoots) {
      const candidate = safeJoin(root, plugin)
      if (candidate === undefined) continue
      for (const dir of PLUGIN_DIRS) {
        try {
          await fs.access(path.join(candidate, dir, 'plugin.json'))
          return { root: candidate }
        } catch {
          continue
        }
      }
    }
    return undefined
  }

  async extractSafely(tarPath, destination) {
    let entries = 0
    let total = 0
    await extractTar({
      file: tarPath,
      cwd: destination,
      strip: 1,
      preservePaths: false,
      noChmod: true,
      filter: (entryPath, entry) => {
        const normalized = entryPath.replaceAll('\\', '/').replace(/^\.\//, '')
        if (normalized.startsWith('/') || normalized.split('/').includes('..')) return false
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') return false
        if (!ALLOWED_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(prefix))) return false
        entries += 1
        if (entries > this.maxFiles) return false
        return true
      },
      onentry: entry => {
        total += Number(entry.size ?? 0)
        if (total > this.maxBytes) throw new Error('bundle exceeds the uncompressed size limit')
      },
    })
  }

  async parse(root, expert, source) {
    const pluginJson = await this.readPluginJson(root)
    const promptRel = await this.resolvePromptPath(root, pluginJson, expert)
    if (promptRel === undefined) throw new Error('expert bundle has no agent prompt')
    const rawPrompt = await fs.readFile(promptRel, 'utf8')
    const prompt = truncate(rawPrompt, this.maxPromptChars)

    const skillPaths = Array.isArray(pluginJson.skills) ? pluginJson.skills : await this.scanSkills(root)
    const warnings = []
    const skills = []
    for (const rel of skillPaths) {
      try {
        const skill = await this.readSkill(root, rel)
        if (skill !== undefined) skills.push(skill)
      } catch (error) {
        warnings.push(`skill skipped: ${rel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      expert,
      source,
      root,
      displayName: pluginJson.displayName ?? pluginJson.profession ?? null,
      version: typeof pluginJson.version === 'string' ? pluginJson.version : null,
      prompt: prompt.text,
      promptChars: rawPrompt.length,
      promptTruncated: prompt.truncated,
      skills: skills.slice(0, 64),
      warnings,
    }
  }

  async readPluginJson(root) {
    for (const dir of PLUGIN_DIRS) {
      const file = path.join(root, dir, 'plugin.json')
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
      } catch {
        continue
      }
    }
    throw new Error('expert bundle has no .codebuddy-plugin/plugin.json')
  }

  async resolvePromptPath(root, pluginJson, expert) {
    const agents = Array.isArray(pluginJson.agents) ? pluginJson.agents : []
    if (agents.length > 0 && typeof agents[0] === 'string') {
      const target = safeJoin(root, agents[0])
      if (target !== undefined) {
        try {
          await fs.access(target)
          return target
        } catch {
          // fall through to the manifest promptFile
        }
      }
    }
    if (typeof expert?.promptFile === 'string') {
      const plugin = expert.plugin ?? expert.agentName ?? expert.id
      const prefix = `/plugins/${plugin}/`
      const rel = expert.promptFile.startsWith(prefix) ? expert.promptFile.slice(prefix.length) : expert.promptFile.replace(/^\/+/, '')
      const target = safeJoin(root, rel)
      if (target !== undefined) {
        try {
          await fs.access(target)
          return target
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  async scanSkills(root) {
    const dir = path.join(root, 'skills')
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => `skills/${entry.name}`)
  }

  async readSkill(root, relative) {
    let target = safeJoin(root, relative)
    if (target === undefined) throw new Error('skill path escapes the bundle root')
    let stat = await fs.stat(target).catch(() => undefined)
    if (stat === undefined) throw new Error('skill path does not exist')
    if (stat.isDirectory()) {
      target = path.join(target, 'SKILL.md')
      stat = await fs.stat(target).catch(() => undefined)
      if (stat === undefined) throw new Error('skill directory has no SKILL.md')
    }
    if (!stat.isFile()) throw new Error('skill path is not a file')

    const text = await fs.readFile(target, 'utf8')
    const { meta, body } = frontmatter(text)
    const base = path.basename(target)
    const fallbackName = base === 'SKILL.md' ? path.basename(path.dirname(target)) : path.basename(target, path.extname(target))
    const name = String(meta.name ?? fallbackName)
    if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name: ${name}`)
    const description = String(meta.description ?? '').trim()
    if (description === '') throw new Error(`skill ${name} has no description`)

    const modelInvocable = asBoolean(meta['disable-model-invocation'], false) ? false : true
    const userInvocable = asBoolean(meta['user-invocable'], true)
    const content = truncate(body, this.maxSkillBodyChars)

    return {
      name,
      description,
      whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
      content: content.text,
      path: target,
      root: path.dirname(target),
      invocation: { modelInvocable, userInvocable },
    }
  }
}
