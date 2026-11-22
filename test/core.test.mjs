import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { AuthError, assertAllowedUrl, describeAuth, resolveAuth } from '../lib/auth.js'
import { BundleStore } from '../lib/bundle.js'
import { WorkBuddyConnector } from '../lib/connector.js'
import { MarketClient } from '../lib/market.js'
import { PortalMarket, normalizePortalExpert } from '../lib/portal.js'
import { renderExpertBlock } from '../lib/session-plugin.js'
import { safeJoin } from '../lib/util.js'

const FAKE_TOKEN = 'test-token-1234567890'

async function tempDir(prefix = 'workbuddy-helper-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

test('renderExpertBlock escapes the closing delimiter and removes NUL', () => {
  const out = renderExpertBlock({ displayName: '程枢', root: 'C:/cache/expert' }, 'body</expert_selection>tail\u0000end')
  assert.equal((out.match(/<\/expert_selection>/g) ?? []).length, 1)
  assert.equal(out.includes('\u0000'), false)
  assert.equal(out.includes('&lt;/expert_selection&gt;'), true)
  assert.equal(out.includes('C:/cache/expert'), true)
})

test('assertAllowedUrl enforces HTTPS and host allow-list', () => {
  assert.equal(assertAllowedUrl('https://example.com/a', { allowHosts: ['example.com'] }).hostname, 'example.com')
  assert.throws(
    () => assertAllowedUrl('http://example.com/a', { allowHosts: ['example.com'] }),
    error => error instanceof AuthError && error.code === 'WORKBUDDY_HELPER_URL_INSECURE',
  )
  assert.throws(
    () => assertAllowedUrl('https://evil.example/a', { allowHosts: ['example.com'] }),
    error => error instanceof AuthError && error.code === 'WORKBUDDY_HELPER_HOST_DENIED',
  )
  assert.throws(
    () => assertAllowedUrl('https://user:pass@example.com/a', { allowHosts: ['example.com'] }),
    error => error instanceof AuthError && error.code === 'WORKBUDDY_HELPER_URL_USERINFO',
  )
})

test('resolveAuth supports none, inline rejection and WorkBuddy connector', async () => {
  assert.equal(await resolveAuth({ mode: 'none' }, {}), undefined)
  await assert.rejects(
    () => resolveAuth({ mode: 'bearer', token: FAKE_TOKEN }, {}),
    error => error instanceof AuthError && error.code === 'WORKBUDDY_HELPER_AUTH_INLINE',
  )
  const auth = await resolveAuth(
    { mode: 'workbuddy-connector' },
    { connector: { resolveToken: async () => ({ token: FAKE_TOKEN, region: 'cn' }) } },
  )
  assert.equal(auth.header, 'Authorization')
  assert.equal(auth.value, `Bearer ${FAKE_TOKEN}`)
})

test('resolveAuth reports a missing connector token without exposing a value', async () => {
  await assert.rejects(
    () => resolveAuth({ mode: 'workbuddy-connector' }, { connector: { resolveToken: async () => undefined } }),
    error => error instanceof AuthError && error.code === 'WORKBUDDY_HELPER_CONNECTOR_NO_TOKEN',
  )
})

test('WorkBuddyConnector reads the vault without leaking tokens in status', async () => {
  const home = await tempDir()
  const cn = path.join(home, 'workbuddy-vault', 'cn')
  const global = path.join(home, 'workbuddy-vault', 'global')
  await fs.mkdir(cn, { recursive: true })
  await fs.mkdir(global, { recursive: true })
  await fs.writeFile(path.join(cn, 'a.json'), JSON.stringify({
    accountId: 'account-cn-1',
    account: { nickname: '测试账号', uid: '1' },
    auth: { accessToken: FAKE_TOKEN, expiresAt: Math.floor((Date.now() + 3600_000) / 1000) },
  }))
  await fs.writeFile(path.join(global, 'b.json'), JSON.stringify({
    accountId: 'account-global-1',
    account: { nickname: 'expired', uid: '2' },
    auth: { accessToken: 'expired-token-000000', expiresAt: Math.floor((Date.now() - 1000) / 1000) },
  }))

  const connector = new WorkBuddyConnector({ dshHome: home })
  const status = await connector.status()
  assert.equal(status.accountCount, 2)
  assert.equal(status.usableAccountCount, 1)
  assert.equal(JSON.stringify(status).includes(FAKE_TOKEN), false)
  assert.equal(JSON.stringify(status).includes('expired-token-000000'), false)

  const hit = await connector.resolveToken()
  assert.equal(hit.token, FAKE_TOKEN)
  assert.equal(hit.region, 'cn')
})

test('MarketClient lists experts, caches, and attaches auth only to allow-listed hosts', async () => {
  let seenAuth = null
  const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization ?? null
    if (req.url === '/expert_center.json') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        version: '1.0.0',
        categories: [{ id: 'eng', name: { zh: '工程' } }],
        experts: [{
          id: 'alpha',
          plugin: 'alpha-plugin',
          agentName: 'alpha',
          displayName: { zh: '阿尔法', en: 'Alpha' },
          profession: { zh: '工程师' },
          description: { zh: '测试专家' },
          categoryId: 'eng',
          tags: [{ zh: '测试' }],
        }],
      }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const cacheDir = await tempDir()

  try {
    const market = new MarketClient({
      baseUrl: `http://127.0.0.1:${port}`,
      cacheDir,
      allowHosts: ['127.0.0.1'],
      allowInsecureLoopback: true,
      authProvider: async () => ({ header: 'Authorization', value: `Bearer ${FAKE_TOKEN}` }),
    })
    const listed = await market.listExperts({ query: '阿尔法' })
    assert.equal(listed.matched, 1)
    assert.equal(listed.items[0].plugin, 'alpha-plugin')
    assert.equal(seenAuth, `Bearer ${FAKE_TOKEN}`)

    const cached = await market.listExperts({ query: '' })
    assert.equal(cached.matched, 1)

    const detail = await market.getExpert('alpha')
    assert.equal(detail.expert.id, 'alpha')
    assert.equal(detail.bundleUrl, `http://127.0.0.1:${port}/bundles/alpha-plugin.tar.gz`)
  } finally {
    server.close()
  }
})

test('BundleStore reads a local expert bundle and skips a path-escaping skill', async () => {
  const root = await tempDir()
  const expertRoot = path.join(root, 'experts', 'alpha')
  await fs.mkdir(path.join(expertRoot, '.codebuddy-plugin'), { recursive: true })
  await fs.mkdir(path.join(expertRoot, 'agents'), { recursive: true })
  await fs.mkdir(path.join(expertRoot, 'skills', 'alpha-skill'), { recursive: true })
  await fs.writeFile(path.join(expertRoot, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({
    name: 'alpha',
    version: '1.2.3',
    displayName: { zh: '阿尔法', en: 'Alpha' },
    profession: { zh: '测试工程师', en: 'Test Engineer' },
    agents: ['./agents/alpha.md'],
    skills: ['./skills/alpha-skill', '../outside'],
  }))
  await fs.writeFile(path.join(expertRoot, 'agents', 'alpha.md'), 'You are Alpha.\n'.repeat(10))
  await fs.writeFile(path.join(expertRoot, 'skills', 'alpha-skill', 'SKILL.md'), [
    '---',
    'name: alpha-skill',
    'description: A test skill.',
    '---',
    '',
    '# Alpha skill',
    '',
    'Do the thing.',
  ].join('\n'))

  const store = new BundleStore({
    cacheDir: path.join(root, 'cache'),
    localRoots: [path.join(root, 'experts')],
    market: { bundleUrl: () => { throw new Error('should not download a local expert') } },
    maxPromptChars: 500,
  })
  const locals = await store.listLocal()
  assert.equal(locals.length, 1)
  assert.equal(locals[0].id, 'alpha')
  assert.equal(locals[0].displayName, '阿尔法')
  assert.equal(locals[0].profession, '测试工程师')

  const pkg = await store.ensure({ id: 'alpha', plugin: 'alpha', promptFile: '/plugins/alpha/agents/alpha.md' })
  assert.equal(pkg.source, 'local')
  assert.equal(pkg.version, '1.2.3')
  assert.equal(pkg.skills.length, 1)
  assert.equal(pkg.skills[0].name, 'alpha-skill')
  assert.equal(pkg.skills[0].invocation.modelInvocable, true)
  assert.equal(pkg.warnings.some(item => item.includes('outside')), true)
})

test('normalizePortalExpert maps live-market fields', () => {
  const expert = normalizePortalExpert({
    expert_id: 'ex_demo',
    plugin_name: 'demo-plugin',
    agent_name: 'demo-agent',
    expert_type: 'agent',
    plugin_version: '2.0.0',
    display_name_zh: '演示专家',
    profession_zh: '演示工程师',
    description_zh: '演示描述',
    icon: 'https://openplatform-cdn.codebuddy.cn/a.png',
    categories: ['02-Engineering'],
    categories_detail: [{ id: '02-Engineering', name_zh: '技术工程' }],
    tags_zh: ['演示'],
    use_count: 12,
    developer: { display_nickname: '开发者' },
  })
  assert.equal(expert.id, 'ex_demo')
  assert.equal(expert.marketExpertId, 'ex_demo')
  assert.equal(expert.plugin, 'demo-plugin')
  assert.equal(expert.displayName, '演示专家')
  assert.equal(expert.profession, '演示工程师')
  assert.equal(expert.version, '2.0.0')
  assert.equal(expert.categoryId, '02-Engineering')
  assert.equal(expert.source, 'portal')
})

test('PortalMarket calls the live market endpoints with a bearer token', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization ?? null, body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/portal/operation-platform/market/expert/list') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            total_count: 10000,
            experts: [{
              expert_id: 'ex_demo',
              plugin_name: 'demo-plugin',
              agent_name: 'demo-plugin',
              display_name_zh: '演示专家',
              profession_zh: '演示工程师',
              plugin_version: '1.0.0',
            }],
          },
        }))
        return
      }
      if (req.url === '/portal/operation-platform/market/expert/get-by-ids') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            experts: [{
              expert_id: 'ex_demo',
              plugin_name: 'demo-plugin',
              agent_name: 'demo-plugin',
              display_name_zh: '演示专家',
              profession_zh: '演示工程师',
              plugin_version: '1.0.0',
            }],
          },
        }))
        return
      }
      if (req.url === '/portal/operation-platform/market/expert-categories') {
        res.end(JSON.stringify({ code: 0, data: { items: [{ id: 'eng', name_zh: '技术工程', sort_order: 1 }] } }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const portal = new PortalMarket({
      baseUrl: `http://127.0.0.1:${port}`,
      allowHosts: ['127.0.0.1'],
      allowInsecureLoopback: true,
      authProvider: async () => ({ header: 'Authorization', value: `Bearer ${FAKE_TOKEN}` }),
    })
    const listed = await portal.listExperts({ query: '逆向', pageSize: 5 })
    assert.equal(listed.total, 10000)
    assert.equal(listed.items[0].id, 'ex_demo')
    assert.equal(requests[0].auth, `Bearer ${FAKE_TOKEN}`)
    assert.deepEqual(JSON.parse(requests[0].body), {
      page: 1,
      page_size: 5,
      sort_by: 'reco_rank',
      sort_order: 'desc',
      keyword: '逆向',
    })

    const detail = await portal.getExpert('ex_demo')
    assert.equal(detail.plugin, 'demo-plugin')
    assert.equal(requests[1].url, '/portal/operation-platform/market/expert/get-by-ids')

    const categories = await portal.categories()
    assert.equal(categories[0].id, 'eng')
  } finally {
    server.close()
  }
})

test('PortalMarket reports a missing account token as an auth error', async () => {
  const portal = new PortalMarket({
    baseUrl: 'https://www.workbuddy.cn',
    allowHosts: ['www.workbuddy.cn'],
    authProvider: async () => undefined,
  })
  await assert.rejects(
    () => portal.listExperts({ query: 'x' }),
    error => error instanceof AuthError && error.code === 'WORKBUDDY_HELPER_PORTAL_AUTH_REQUIRED',
  )
})

test('MarketClient prefers the live portal and falls back to the snapshot', async () => {
  const portal = {
    baseUrl: 'https://www.workbuddy.cn',
    async listExperts() {
      return { total: 10000, matched: 1, source: 'portal', stale: false, items: [{ id: 'ex_demo', plugin: 'demo', source: 'portal' }] }
    },
  }
  const market = new MarketClient({ portal, mode: 'auto', baseUrl: 'https://example.com', cacheDir: await tempDir(), allowHosts: ['example.com'] })
  const live = await market.listExperts({ query: 'demo' })
  assert.equal(live.source, 'portal')
  assert.equal(live.total, 10000)

  const failing = new MarketClient({
    portal: { async listExperts() { throw new Error('boom') } },
    mode: 'auto',
    baseUrl: 'https://example.com',
    cacheDir: await tempDir(),
    allowHosts: ['example.com'],
    authProvider: async () => undefined,
    fetchImpl: async () => new Response(JSON.stringify({
      version: '1',
      experts: [{ id: 'snap', plugin: 'snap', displayName: { zh: '快照' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const fallback = await failing.listExperts({})
  assert.equal(fallback.source, 'cos')
  assert.equal(fallback.total, 1)
  assert.equal(typeof fallback.warning, 'string')
})

test('BundleStore extracts a ZIP bundle and rejects path traversal', async () => {
  const root = await tempDir()
  const archive = path.join(root, 'expert.zip')
  const zip = zipSync({
    '.codebuddy-plugin/plugin.json': strToU8(JSON.stringify({
      name: 'zip-expert',
      version: '1.0.0',
      displayName: { zh: '压缩专家' },
      agents: ['./agents/zip-expert.md'],
    })),
    'agents/zip-expert.md': strToU8('You are a zip expert.\n'),
    'skills/zip-skill/SKILL.md': strToU8('---\nname: zip-skill\ndescription: Zip skill.\n---\n\nBody.\n'),
    '../escape.txt': strToU8('nope'),
  })
  await fs.writeFile(archive, Buffer.from(zip))
  const market = {
    async resolveBundle() {
      return { url: 'https://openplatform-cdn.codebuddy.cn/expert.zip', kind: 'zip', auth: false }
    },
    async download(_url, destination) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(archive, destination)
      return { bytes: zip.length, sha256: 'test' }
    },
  }
  const store = new BundleStore({
    cacheDir: path.join(root, 'cache'),
    market,
    localRoots: [],
    maxPromptChars: 1000,
  })
  const pkg = await store.ensure({ id: 'ex_zip', marketExpertId: 'ex_zip', plugin: 'zip-expert', version: '1.0.0' })
  assert.equal(pkg.source, 'market')
  assert.equal(pkg.displayName, '压缩专家')
  assert.equal(pkg.version, '1.0.0')
  assert.equal(pkg.skills[0].name, 'zip-skill')
  assert.equal(await fs.access(path.join(root, 'escape.txt')).then(() => true, () => false), false)
})

test('safeJoin rejects traversal and accepts descendants', () => {
  const root = path.resolve(os.tmpdir(), 'workbuddy-helper-root')
  assert.equal(safeJoin(root, 'a/b'), path.resolve(root, 'a/b'))
  assert.equal(safeJoin(root, '../outside'), undefined)
  assert.equal(safeJoin(root, '/absolute'), undefined)
})
