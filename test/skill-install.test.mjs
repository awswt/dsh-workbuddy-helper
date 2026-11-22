import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'

import {
  installSkill,
  listInstalledSkills,
  parseSkillFrontmatter,
  projectRootOf,
  skillSlug,
} from '../lib/skill-install.js'

const CDN_HOST = 'cdn.example.com'
const DOWNLOAD_URL = `https://${CDN_HOST}/skills/word-docx-v1.0.0.zip`

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wbh-skill-'))
}

/** A market zip: one outer folder holding SKILL.md plus caller extras. */
function packageBytes(files = {}) {
  const entries = {}
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text)
  return zipSync(entries)
}

const SKILL_MD = [
  '---',
  'name: word-docx',
  'display_name: Word 文档处理',
  'description: 创建、读取与编辑 DOCX',
  'version: 1.0.0',
  '---',
  '',
  '# Word 文档处理',
  '',
].join('\n')

function fakeFetch(bytes) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(bytes.byteLength) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  impl.calls = calls
  return impl
}

function fakePortal(skill, extra = {}) {
  const posts = []
  return {
    posts,
    async post(route, body) {
      posts.push({ route, body })
      if (route.endsWith('/skill/get-by-ids')) return { success: true, data: { total_count: 1, skills: [skill] } }
      if (route.endsWith('/skill/download-url')) return { success: true, data: extra.signed ?? {} }
      throw new Error(`unexpected portal route: ${route}`)
    },
  }
}

test('skillSlug prefers the market name and sanitises the id fallback', () => {
  assert.equal(skillSlug({ name: 'word-docx', skill_id: 'skill_1' }), 'word-docx')
  assert.equal(skillSlug({ name: '  ', skill_id: 'skill_2095070772061040640' }), 'skill_2095070772061040640')
  assert.equal(skillSlug({ name: 'bad name!', skill_id: 'skill:1/2' }), 'skill-1-2')
  assert.throws(() => skillSlug({}), /no usable name or id/)
})

test('parseSkillFrontmatter reads the four scalars a catalog needs', () => {
  const meta = parseSkillFrontmatter(SKILL_MD)
  assert.deepEqual(meta, {
    name: 'word-docx',
    description: '创建、读取与编辑 DOCX',
    version: '1.0.0',
    displayName: 'Word 文档处理',
  })
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter'), {
    name: null,
    description: null,
    version: null,
    displayName: null,
  })
  assert.equal(parseSkillFrontmatter('---\r\nname: "quoted"\r\n---\r\n').name, 'quoted')
})

test('listInstalledSkills returns an empty list for a workspace with no skills dir', async () => {
  const root = await workspace()
  assert.deepEqual(await listInstalledSkills(root), [])
  // 空 workspace 会回退到 process.cwd()，那里可能真的有技能，所以只断言形状。
  assert.ok(Array.isArray(await listInstalledSkills('')))
})

test('listInstalledSkills reports on-disk skills and skips unusable directories', async () => {
  const root = await workspace()
  const skills = path.join(root, '.dsh', 'skills')
  await fs.mkdir(path.join(skills, 'word-docx'), { recursive: true })
  await fs.writeFile(path.join(skills, 'word-docx', 'SKILL.md'), SKILL_MD)
  await fs.mkdir(path.join(skills, 'no-manifest'), { recursive: true })
  await fs.mkdir(path.join(skills, '.staging-leftover'), { recursive: true })
  await fs.writeFile(path.join(skills, '.staging-leftover', 'SKILL.md'), SKILL_MD)

  const installed = await listInstalledSkills(root)
  assert.equal(installed.length, 1)
  assert.equal(installed[0].slug, 'word-docx')
  assert.equal(installed[0].displayName, 'Word 文档处理')
  assert.equal(installed[0].version, '1.0.0')
  assert.equal(installed[0].path, path.join(skills, 'word-docx'))
  assert.equal(typeof installed[0].updatedAt, 'number')
})

test('installSkill unpacks the package into <workspace>/.dsh/skills/<slug>', async () => {
  const root = await workspace()
  const bytes = packageBytes({
    'word-docx/SKILL.md': SKILL_MD,
    'word-docx/references/checklist.md': '- 标题层级\n',
  })
  const fetchImpl = fakeFetch(bytes)
  const portal = fakePortal({
    skill_id: 'skill_1',
    name: 'word-docx',
    version: '1.0.0',
    display_name_zh: 'Word 文档处理',
    description_zh: '市场描述',
    download_url: DOWNLOAD_URL,
  })

  const result = await installSkill({
    portal,
    skillId: 'skill_1',
    workspace: root,
    allowHosts: [CDN_HOST],
    fetchImpl,
  })

  assert.equal(result.ok, true)
  assert.equal(result.installed.slug, 'word-docx')
  assert.equal(result.installed.path, path.join(root, '.dsh', 'skills', 'word-docx'))
  assert.equal(result.installed.displayName, 'Word 文档处理')
  assert.equal(result.installed.version, '1.0.0')
  assert.equal(result.installed.packagePrefix, 'word-docx')
  assert.deepEqual(result.files.sort(), ['SKILL.md', 'references/checklist.md'])
  assert.equal(result.packageBytes, bytes.byteLength)
  assert.deepEqual(fetchImpl.calls, [DOWNLOAD_URL])
  assert.equal(portal.posts.length, 1, 'a detail response carrying download_url needs no second round trip')

  const onDisk = await fs.readFile(path.join(root, '.dsh', 'skills', 'word-docx', 'SKILL.md'), 'utf8')
  assert.match(onDisk, /^---\nname: word-docx/)
  const listing = await listInstalledSkills(root)
  assert.deepEqual(listing.map(skill => skill.slug), ['word-docx'])
})

test('installSkill signs a fresh download URL when the detail has none', async () => {
  const root = await workspace()
  const bytes = packageBytes({ 'word-docx/SKILL.md': SKILL_MD })
  const portal = fakePortal(
    { skill_id: 'skill_1', name: 'word-docx' },
    { signed: { download_url: DOWNLOAD_URL, filename: 'word-docx-v1.0.0.zip', expires_at: 1795355917 } },
  )

  const result = await installSkill({
    portal,
    skillId: 'skill_1',
    workspace: root,
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(bytes),
  })

  assert.equal(portal.posts.length, 2)
  assert.deepEqual(portal.posts[1].body, { skill_id: 'skill_1' })
  assert.equal(result.installed.filename, 'word-docx-v1.0.0.zip')
  assert.equal(result.installed.expiresAt, 1795355917)
})

test('installSkill replaces an existing install so stale files never survive', async () => {
  const root = await workspace()
  await installSkill({
    portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL }),
    skillId: 'skill_1',
    workspace: root,
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(packageBytes({
      'word-docx/SKILL.md': SKILL_MD,
      'word-docx/stale.md': 'old\n',
    })),
  })
  const target = path.join(root, '.dsh', 'skills', 'word-docx')
  assert.equal(await fs.readFile(path.join(target, 'stale.md'), 'utf8'), 'old\n')

  await installSkill({
    portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL }),
    skillId: 'skill_1',
    workspace: root,
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(packageBytes({ 'word-docx/SKILL.md': SKILL_MD })),
  })
  await assert.rejects(fs.stat(path.join(target, 'stale.md')), /ENOENT/)
  assert.match(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), /name: word-docx/)
})

test('installSkill refuses a zip entry that escapes the skill directory', async () => {
  const root = await workspace()
  await assert.rejects(
    installSkill({
      portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL }),
      skillId: 'skill_1',
      workspace: root,
      allowHosts: [CDN_HOST],
      fetchImpl: fakeFetch(packageBytes({
        'pkg/SKILL.md': SKILL_MD,
        'pkg/../../escaped.txt': 'pwned\n',
      })),
    }),
    /escapes its directory/,
  )
  await assert.rejects(fs.stat(path.join(root, 'escaped.txt')), /ENOENT/)
  await assert.rejects(fs.stat(path.join(os.tmpdir(), 'escaped.txt')), /ENOENT/)
})

test('installSkill refuses absolute paths inside the package', async () => {
  const root = await workspace()
  await assert.rejects(
    installSkill({
      portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL }),
      skillId: 'skill_1',
      workspace: root,
      allowHosts: [CDN_HOST],
      fetchImpl: fakeFetch(packageBytes({ '/abs/SKILL.md': SKILL_MD })),
    }),
    /absolute path/,
  )
})

test('installSkill refuses a package without SKILL.md', async () => {
  const root = await workspace()
  await assert.rejects(
    installSkill({
      portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL }),
      skillId: 'skill_1',
      workspace: root,
      allowHosts: [CDN_HOST],
      fetchImpl: fakeFetch(packageBytes({ 'word-docx/README.md': 'no manifest\n' })),
    }),
    /no SKILL\.md/,
  )
  await assert.rejects(fs.stat(path.join(root, '.dsh')), /ENOENT/, 'a rejected package leaves no directory behind')
})

test('installSkill gates the signed download URL by host and scheme', async () => {
  const root = await workspace()
  const portal = fakePortal({
    skill_id: 'skill_1',
    name: 'word-docx',
    download_url: 'https://evil.example.net/skill.zip',
  })
  await assert.rejects(
    installSkill({ portal, skillId: 'skill_1', workspace: root, allowHosts: [CDN_HOST], fetchImpl: fakeFetch(packageBytes({})) }),
    /host is not allowed/,
  )
  await assert.rejects(
    installSkill({
      portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: `http://${CDN_HOST}/skill.zip` }),
      skillId: 'skill_1',
      workspace: root,
      allowHosts: [CDN_HOST],
      fetchImpl: fakeFetch(packageBytes({})),
    }),
    /HTTPS is required/,
  )
})

test('installSkill rejects a not-a-zip payload with an actionable message', async () => {
  const root = await workspace()
  await assert.rejects(
    installSkill({
      portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL }),
      skillId: 'skill_1',
      workspace: root,
      allowHosts: [CDN_HOST],
      fetchImpl: fakeFetch(strToU8('<html>not a zip</html>')),
    }),
    /not a readable zip/,
  )
})

test('installSkill requires a skillId, a portal client and a workspace', async () => {
  await assert.rejects(installSkill({}), /skillId is required/)
  await assert.rejects(
    installSkill({ skillId: 'skill_1', workspace: os.tmpdir() }),
    /portal client is not configured/,
  )
  await assert.rejects(
    installSkill({ skillId: 'skill_1', portal: fakePortal({}) }),
    /workspace is required/,
  )
})

test('installSkill verifies the market fingerprint when it is a sha256', async () => {
  const root = await workspace()
  const bytes = packageBytes({ 'word-docx/SKILL.md': SKILL_MD })
  const good = createHash('sha256').update(bytes).digest('hex')

  const installed = await installSkill({
    portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL, fingerprint: good }),
    skillId: 'skill_1',
    workspace: root,
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(bytes),
  })
  assert.equal(installed.fingerprintChecked, true)

  const other = await workspace()
  await assert.rejects(
    installSkill({
      portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL, fingerprint: 'f'.repeat(64) }),
      skillId: 'skill_1',
      workspace: other,
      allowHosts: [CDN_HOST],
      fetchImpl: fakeFetch(bytes),
    }),
    /integrity check/,
  )
  await assert.rejects(fs.stat(path.join(other, '.dsh')), /ENOENT/)

  // 非 sha256 形状的指纹（例如带算法前缀）不做强校验，但要如实报告"没校验"。
  const unchecked = await installSkill({
    portal: fakePortal({ skill_id: 'skill_1', name: 'word-docx', download_url: DOWNLOAD_URL, fingerprint: 'sha256:abc' }),
    skillId: 'skill_1',
    workspace: await workspace(),
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(bytes),
  })
  assert.equal(unchecked.fingerprintChecked, false)
})

test('installSkill accepts a flat package with no outer folder', async () => {
  const root = await workspace()
  const result = await installSkill({
    portal: fakePortal({ skill_id: 'skill_1', name: 'docx', download_url: DOWNLOAD_URL }),
    skillId: 'skill_1',
    workspace: root,
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(packageBytes({
      'SKILL.md': SKILL_MD,
      'references/checklist.md': '- 标题层级\n',
    })),
  })
  assert.equal(result.installed.packagePrefix, null)
  assert.deepEqual(result.files.sort(), ['SKILL.md', 'references/checklist.md'])
  assert.match(await fs.readFile(path.join(root, '.dsh', 'skills', 'docx', 'SKILL.md'), 'utf8'), /name: word-docx/)
})

test('installSkill targets the git project root, which is what the loader scans', async () => {
  const repo = await workspace()
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  const nested = path.join(repo, 'packages', 'app')
  await fs.mkdir(nested, { recursive: true })

  assert.equal(await projectRootOf(nested), repo)

  const result = await installSkill({
    portal: fakePortal({ skill_id: 'skill_1', name: 'docx', download_url: DOWNLOAD_URL }),
    skillId: 'skill_1',
    workspace: nested,
    allowHosts: [CDN_HOST],
    fetchImpl: fakeFetch(packageBytes({ 'docx/SKILL.md': SKILL_MD })),
  })
  assert.equal(result.projectRoot, repo)
  assert.equal(result.installed.path, path.join(repo, '.dsh', 'skills', 'docx'))
  await assert.rejects(fs.stat(path.join(nested, '.dsh')), /ENOENT/, 'never install into a directory the loader skips')
  assert.deepEqual((await listInstalledSkills(nested)).map(skill => skill.slug), ['docx'])
})
