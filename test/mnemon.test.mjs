import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMnemonDetector, detectMnemon, MNEMON_PACKAGE, mnemonCandidates, ownProfileDir } from '../lib/mnemon.js'

/** 造一个假的 `node_modules/dsh-mnemon`，内容只够探测器读。 */
async function makePackage(dir, pkg) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8')
}

/**
 * layout 的键是**相对 home 的文件路径**，值是该 package.json 的内容；
 * 值为 null 表示"目录在、文件不在"的半装状态。
 */
async function makeHome(layout) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wbh-mnemon-'))
  for (const [relative, pkg] of Object.entries(layout)) {
    const full = path.join(home, relative)
    if (pkg === null) {
      await fs.mkdir(path.dirname(full), { recursive: true })
    } else {
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, JSON.stringify(pkg), 'utf8')
    }
  }
  return home
}

test('mnemonCandidates looks at the current profile first, then the shared profiles layer', () => {
  const list = mnemonCandidates({ dshHome: 'C:\\home\\.dsh', profileDir: 'C:\\home\\.dsh\\profiles\\desktop' })
  assert.deepEqual(list.map(item => item.source), ['profile', 'shared'])
  assert.equal(list[0].dir, path.join('C:\\home\\.dsh', 'profiles', 'desktop', 'node_modules', MNEMON_PACKAGE))
  assert.equal(list[1].dir, path.join('C:\\home\\.dsh', 'profiles', 'node_modules', MNEMON_PACKAGE))

  // 没有 profileDir 时探共享层，并在"本插件真的装在某个 profile 里"时补一条 self。
  // 从工作树跑测试时 ownProfileDir() 是 undefined（那里没有 node_modules/dsh-workbuddy-helper），
  // 所以这条断言只钉住"不会凭空构造一个 <undefined> 路径"。
  const shared = mnemonCandidates({ dshHome: 'C:\\home\\.dsh' })
  const sources = shared.map(item => item.source)
  assert.equal(sources[0], 'shared')
  assert.equal(sources.includes('profile'), false)
  for (const item of shared) assert.equal(item.dir.includes('undefined'), false)
})

test('ownProfileDir only claims a directory that really is a profile', () => {
  // 单元测试从工作树跑：<repo>/lib 往上三层是 workspace 根，那里没有
  // node_modules/dsh-workbuddy-helper，所以必须返回 undefined，而不是把工作区
  // 当成 profile 去扫它的 node_modules。
  assert.equal(ownProfileDir(), undefined)
})

test('detectMnemon reports the installed version and which layer it came from', async () => {
  const home = await makeHome({
    'profiles/desktop/node_modules/dsh-mnemon/package.json': { name: 'dsh-mnemon', version: '0.5.52' },
  })
  const found = await detectMnemon({ dshHome: home, profileDir: path.join(home, 'profiles', 'desktop') })
  assert.equal(found.available, true)
  assert.equal(found.version, '0.5.52')
  assert.equal(found.source, 'profile')
  assert.equal(found.path, path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-mnemon'))

  // 兄弟 profile 装的不能算到当前 profile 头上：不传 profileDir 时只看共享层，
  // 而共享层这时是空的。这条断言防的是"扫错目录导致别的 profile 装了也显示"。
  assert.equal((await detectMnemon({ dshHome: home })).available, false)

  // 真的装在共享层时才认作 shared。
  const sharedHome = await makeHome({
    'profiles/node_modules/dsh-mnemon/package.json': { name: 'dsh-mnemon', version: '0.5.52' },
  })
  const viaShared = await detectMnemon({ dshHome: sharedHome })
  assert.equal(viaShared.available, true)
  assert.equal(viaShared.source, 'shared')
})
test('detectMnemon says no when the package is missing, broken, or the wrong package', async () => {
  const missing = await makeHome({})
  assert.deepEqual(await detectMnemon({ dshHome: missing }), {
    available: false, version: null, path: null, source: null,
  })

  // 目录存在但没有 package.json（安装中断）。
  const broken = await makeHome({ 'profiles/node_modules/dsh-mnemon/package.json': null })
  assert.equal((await detectMnemon({ dshHome: broken })).available, false)

  // 同名目录但 package.json 声明的是别的包：不能靠目录名认亲。
  const impostor = await makeHome({
    'profiles/node_modules/dsh-mnemon/package.json': { name: 'not-mnemon', version: '1.0.0' },
  })
  assert.equal((await detectMnemon({ dshHome: impostor })).available, false)

  // package.json 是坏 JSON。
  const garbage = await fs.mkdtemp(path.join(os.tmpdir(), 'wbh-mnemon-bad-'))
  const dir = path.join(garbage, 'profiles', 'node_modules', 'dsh-mnemon')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), '{ not json', 'utf8')
  assert.equal((await detectMnemon({ dshHome: garbage })).available, false)
})

test('detectMnemon tolerates a missing version field', async () => {
  const home = await makeHome({
    'profiles/node_modules/dsh-mnemon/package.json': { name: 'dsh-mnemon' },
  })
  const found = await detectMnemon({ dshHome: home })
  assert.equal(found.available, true)
  assert.equal(found.version, null)
})

test('createMnemonDetector caches, and resolves a lazily supplied profile dir', async () => {
  const home = await makeHome({})
  let calls = 0
  const detector = createMnemonDetector({
    dshHome: home,
    profileDir: () => {
      calls += 1
      return path.join(home, 'profiles', 'desktop')
    },
  })

  assert.equal((await detector()).available, false)
  assert.equal(calls, 1)
  // 缓存命中时连 profileDir 都不该再问一次。
  assert.equal((await detector()).available, false)
  assert.equal(calls, 1)

  // 装上之后，force 立即能看到（面板的"刷新"路径）。
  await makePackage(path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-mnemon'), {
    name: 'dsh-mnemon',
    version: '0.5.60',
  })
  assert.equal((await detector()).available, false)
  const forced = await detector(true)
  assert.equal(forced.available, true)
  assert.equal(forced.version, '0.5.60')
})

test('createMnemonDetector honours a custom ttl', async () => {
  const home = await makeHome({})
  const detector = createMnemonDetector({ dshHome: home, ttlMs: 0 })
  assert.equal((await detector()).available, false)
  await makePackage(path.join(home, 'profiles', 'node_modules', 'dsh-mnemon'), { name: 'dsh-mnemon', version: '1.0.0' })
  // ttl 0 = 每次都重新读盘。
  assert.equal((await detector()).available, true)
})
