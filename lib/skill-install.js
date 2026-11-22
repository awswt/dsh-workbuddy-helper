import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { assertAllowedUrl } from './auth.js'

/**
 * Install one WorkBuddy skill-market skill into the current workspace.
 *
 * Why a real install instead of "copy the ID": the skill loader
 * (`@deepseek-ai/dsh-skill-filesystem`) only discovers skills that sit in a
 * known root, and the *project* root that matters here is
 * `<projectRoot>/.dsh/skills` (`lib/index.js:150-188` of that package). A bare
 * ID is inert — nothing on disk means nothing in `<available_skills>`, so the
 * model never sees the skill. Writing `<workspace>/.dsh/skills/<slug>/SKILL.md`
 * makes the skill appear in the next session's catalog without any extra
 * index file: the directory watcher picks the new root entry up on its own.
 */

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 400
const MAX_TOTAL_BYTES = 96 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60000
const SKILL_DIR_NAME = path.join('.dsh', 'skills')

/** Skill ids look like `skill_2095070772061040640`; the slug is the market `name`. */
export function skillSlug(skill) {
  const candidate = typeof skill?.name === 'string' ? skill.name.trim() : ''
  if (candidate !== '' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate)) return candidate
  const fallback = String(skill?.skill_id ?? skill?.id ?? '').trim()
  const cleaned = fallback.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned === '') throw new Error('skill has no usable name or id')
  return cleaned.slice(0, 64)
}

/** Minimal YAML frontmatter reader: the few scalar keys a skill catalog needs. */
export function parseSkillFrontmatter(text) {
  const source = typeof text === 'string' ? text : ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  const result = { name: null, description: null, version: null, displayName: null }
  if (match === null) return result
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line)
    if (pair === null) continue
    const key = pair[1]
    const raw = pair[2].trim().replace(/^['"]|['"]$/g, '')
    if (key === 'name') result.name = raw
    else if (key === 'description') result.description = raw
    else if (key === 'version') result.version = raw
    else if (key === 'display_name') result.displayName = raw
  }
  return result
}

function skillsRoot(workspace) {
  const root = typeof workspace === 'string' && workspace.trim() !== '' ? workspace.trim() : process.cwd()
  return path.join(path.resolve(root), SKILL_DIR_NAME)
}

/**
 * The loader's project root is the nearest ancestor with a `.git` entry, not the
 * shell's cwd (`dsh-skill-filesystem` src/index.ts:937-947). A workspace nested
 * inside a repo therefore has to install into the REPO's `.dsh/skills`, or the
 * skill lands somewhere the loader never scans: "installed but invisible".
 */
export async function projectRootOf(workspace) {
  const start = path.resolve(
    typeof workspace === 'string' && workspace.trim() !== '' ? workspace.trim() : process.cwd(),
  )
  let current = start
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      const stat = await fs.stat(path.join(current, '.git'))
      if (stat !== null) return current
    } catch {
      // 没有 .git 就继续往上；到了根还没有就用起始目录。
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * Skills already on disk in the workspace, keyed by directory name.
 * Read-only: an empty list is a legitimate answer, a broken SKILL.md is skipped
 * rather than failing the whole listing.
 */
export async function listInstalledSkills(workspace) {
  // 和 installSkill 用同一个根：否则"装到 repo 根、却在子目录里列不出"。
  const root = skillsRoot(await projectRootOf(workspace))
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const installed = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    let text
    try {
      text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const meta = parseSkillFrontmatter(text)
    let stat
    try {
      stat = await fs.stat(path.join(dir, 'SKILL.md'))
    } catch {
      stat = undefined
    }
    installed.push({
      slug: entry.name,
      path: dir,
      name: meta.name ?? entry.name,
      displayName: meta.displayName ?? meta.name ?? entry.name,
      description: meta.description ?? '',
      version: meta.version ?? null,
      updatedAt: stat === undefined ? null : stat.mtimeMs,
    })
  }
  installed.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
  return installed
}

/* ───────────────────────── install serialization ───────────────────────── */

/**
 * Two concurrent installs of the same slug used to interleave `rm(target)` and
 * `rename(staging, target)`, which can leave a half-written skill or lose files
 * from the other install. Serialization happens on two levels because the panel
 * and the `workbuddy_helper` tool are different processes:
 *
 *   - in-process: a promise chain per target path (fast, no syscalls)
 *   - cross-process: `<root>/.lock-<slug>` created with `mkdir`, which is the
 *     one filesystem primitive that fails atomically with EEXIST on Windows,
 *     macOS and Linux alike
 *
 * The lock directory is dot-prefixed so `listInstalledSkills` skips it, and a
 * stale lock older than `LOCK_STALE_MS` is broken rather than wedging installs
 * forever after a crashed process.
 */
const LOCK_TIMEOUT_MS = 30000
const LOCK_STALE_MS = 5 * 60 * 1000
const LOCK_RETRY_MS = 40
const installQueues = new Map()

async function acquireDirLock(lockDir, options = {}) {
  const deadline = Date.now() + (Number(options.lockTimeoutMs) || LOCK_TIMEOUT_MS)
  const staleMs = Number(options.lockStaleMs) || LOCK_STALE_MS
  for (;;) {
    try {
      await fs.mkdir(lockDir, { recursive: false })
      await fs
        .writeFile(
          path.join(lockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          'utf8',
        )
        .catch(() => undefined)
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // ENOTDIR/EACCES: the parent is unusable, surface it instead of spinning.
        throw error
      }
      let stat
      try {
        stat = await fs.stat(lockDir)
      } catch {
        // The holder released it between mkdir and stat: try again immediately.
        continue
      }
      if (Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`another skill install is still running (${lockDir})`)
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}

async function releaseDirLock(lockDir) {
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Run `fn` while holding the install lock for `lockKey`. `lockDir` is the
 * cross-process handle; pass `undefined` to keep only the in-process queue
 * (tests do this so they never touch the real skills root).
 */
export async function withInstallLock(lockKey, fn, options = {}) {
  const previous = installQueues.get(lockKey) ?? Promise.resolve()
  const run = previous.then(async () => {
    const lockDir = typeof options.lockDir === 'string' && options.lockDir !== '' ? options.lockDir : undefined
    if (lockDir !== undefined) await acquireDirLock(lockDir, options)
    try {
      return await fn()
    } finally {
      if (lockDir !== undefined) await releaseDirLock(lockDir)
    }
  })
  // Keep the chain alive after a rejection, and drop the entry once it reaches
  // the tail so a long-lived process does not keep one promise per skill path.
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  installQueues.set(lockKey, settled)
  try {
    return await run
  } finally {
    if (installQueues.get(lockKey) === settled) installQueues.delete(lockKey)
  }
}

/** Zip entries arrive as `slug/SKILL.md`; strip the shared outer folder when present. */
function stripCommonRoot(names) {
  if (names.length === 0) return { prefix: '', names }
  const firstSegments = new Set(
    names.map(name => (name.includes('/') ? name.split('/')[0] : '')),
  )
  if (firstSegments.size !== 1) return { prefix: '', names }
  const [only] = [...firstSegments]
  if (only === '') return { prefix: '', names }
  return { prefix: `${only}/`, names: names.map(name => name.slice(only.length + 1)) }
}

function assertSafeEntry(name) {
  const normalized = String(name).replace(/\\/g, '/')
  if (normalized === '') throw new Error('skill package contains an empty path')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`skill package contains an absolute path: ${normalized}`)
  }
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..')) {
    throw new Error(`skill package path escapes its directory: ${normalized}`)
  }
  return normalized
}

async function fetchPackage(url, options) {
  assertAllowedUrl(url, { allowHosts: options.allowHosts ?? [], allowInsecureLoopback: options.allowInsecureLoopback === true })
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (response.status === 401 || response.status === 403) {
      throw new Error(`skill download was rejected (${response.status}); the signed link probably expired, retry the install`)
    }
    if (!response.ok) throw new Error(`skill download failed with HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) {
      throw new Error(`skill package is too large (${declared} bytes)`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error(`skill package is too large (${bytes.byteLength} bytes)`)
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch detail, download the signed package, unpack it into
 * `<workspace>/.dsh/skills/<slug>/`. Idempotent: an existing install is
 * replaced wholesale, so a re-install never leaves stale files behind.
 */
export async function installSkill(options = {}) {
  const { portal } = options
  const skillId = String(options.skillId ?? '').trim()
  if (skillId === '') throw new Error('skillId is required')
  if (portal === undefined || portal === null) throw new Error('portal client is not configured')
  const workspace = options.workspace
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('workspace is required: skills are installed into <workspace>/.dsh/skills')
  }

  const detail = await portal.post('/operation-platform/market/skill/get-by-ids', { skill_ids: [skillId] })
  const items = Array.isArray(detail?.data?.skills) ? detail.data.skills : []
  const skill = items.find(item => String(item?.skill_id ?? '') === skillId) ?? items[0]
  if (skill === undefined) throw new Error(`skill not found in market: ${skillId}`)

  let downloadUrl = typeof skill.download_url === 'string' ? skill.download_url.trim() : ''
  let filename = null
  let expiresAt = null
  if (downloadUrl === '') {
    const signed = await portal.post('/operation-platform/market/skill/download-url', { skill_id: skillId })
    downloadUrl = typeof signed?.data?.download_url === 'string' ? signed.data.download_url.trim() : ''
    filename = typeof signed?.data?.filename === 'string' ? signed.data.filename : null
    expiresAt = Number(signed?.data?.expires_at ?? 0) || null
  }
  if (downloadUrl === '') throw new Error(`market returned no download URL for ${skillId}`)

  const bytes = await fetchPackage(downloadUrl, options)
  // The market's `fingerprint` is the sha256 of the zip (`get-by-ids` returns it).
  // Verify it when it has that shape: the package is UGC and the SKILL.md lands
  // straight in the model's context, so a swapped transfer should fail loudly.
  const expected = typeof skill.fingerprint === 'string' ? skill.fingerprint.trim().toLowerCase() : ''
  const fingerprintChecked = /^[a-f0-9]{64}$/.test(expected)
  if (fingerprintChecked) {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expected) {
      throw new Error(`skill package failed its integrity check (sha256 ${actual} != fingerprint ${expected})`)
    }
  }
  let entries
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    throw new Error(`skill package is not a readable zip: ${error instanceof Error ? error.message : String(error)}`)
  }

  const names = Object.keys(entries).filter(name => !name.endsWith('/'))
  if (names.length === 0) throw new Error('skill package is empty')
  if (names.length > MAX_ENTRIES) throw new Error(`skill package has too many files (${names.length})`)
  const { prefix, names: stripped } = stripCommonRoot(names)
  const mapping = names.map((original, index) => ({ original, relative: assertSafeEntry(stripped[index]) }))
  if (!mapping.some(entry => /(^|\/)SKILL\.md$/i.test(entry.relative))) {
    throw new Error('skill package has no SKILL.md; nothing would be loadable')
  }

  const slug = skillSlug(skill)
  const projectRoot = await projectRootOf(workspace)
  const root = skillsRoot(projectRoot)
  const target = path.join(root, slug)
  const lockDir = path.join(root, `.lock-${slug}`)

  let totalBytes = 0
  const written = []
  // The lock lives inside the skills root, so the root has to exist before we
  // can take it — creating it is idempotent and cheap.
  await fs.mkdir(root, { recursive: true })
  await withInstallLock(
    target,
    async () => {
      const staging = path.join(root, `.staging-${slug}-${Date.now().toString(36)}`)
      try {
        await fs.mkdir(staging, { recursive: true })
        for (const entry of mapping) {
          const data = entries[entry.original]
          totalBytes += data.byteLength
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error('skill package expands too large')
          const destination = path.join(staging, entry.relative)
          const relativeCheck = path.relative(staging, destination)
          if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
            throw new Error(`skill package path escapes its directory: ${entry.relative}`)
          }
          await fs.mkdir(path.dirname(destination), { recursive: true })
          await fs.writeFile(destination, data)
          written.push(entry.relative)
        }
        await fs.rm(target, { recursive: true, force: true })
        await fs.mkdir(root, { recursive: true })
        await fs.rename(staging, target)
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    },
    { lockDir, lockTimeoutMs: options.lockTimeoutMs, lockStaleMs: options.lockStaleMs },
  )

  const skillMd = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8').catch(() => '')
  const meta = parseSkillFrontmatter(skillMd)
  return {
    ok: true,
    installed: {
      slug,
      path: target,
      name: meta.name ?? slug,
      displayName: meta.displayName ?? meta.name ?? slug,
      description: meta.description ?? (typeof skill.description_zh === 'string' ? skill.description_zh : ''),
      version: meta.version ?? (typeof skill.version === 'string' ? skill.version : null),
      skillId,
      marketName: typeof skill.display_name_zh === 'string' ? skill.display_name_zh : null,
      packagePrefix: prefix === '' ? null : prefix.slice(0, -1),
      filename,
      expiresAt,
    },
    files: written,
    bytes: totalBytes,
    packageBytes: bytes.byteLength,
    fingerprintChecked,
    workspaceRoot: path.resolve(workspace),
    projectRoot,
  }
}
