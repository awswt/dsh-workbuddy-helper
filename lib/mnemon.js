/**
 * `dsh-mnemon` 是否装在当前这份 DSH 里。
 *
 * 面板里的「记忆系统技能市场」不是本插件的能力，它只是把用户送到 `dsh-mnemon`
 * 自己的技能管理页。所以只有那个包真的装着、侧边栏入口真的存在时，这个页签才该出现；
 * 否则点进去是一片空白，比没有这个按钮更糟。
 *
 * 判定只看**当前 profile**（以及 pnpm 把它提升到的共享 `profiles/node_modules`），
 * 不去扫兄弟 profile：别的 profile 装了 mnemon 不代表当前这个会话有那个侧边栏入口。
 */

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './util.js'

export const MNEMON_PACKAGE = 'dsh-mnemon'

/** 探测结果缓存时长：装/卸载插件本来就要求重启 DSH，一分钟足够挡住密集刷新。 */
const DETECT_TTL_MS = 60 * 1000

/**
 * 本插件自己所在的那个 profile。
 *
 * `<profile>/node_modules/dsh-workbuddy-helper/lib/mnemon.js` 往上三层就是 `<profile>`。
 * 这条路径不依赖 `--profile` 参数，也不依赖连接器控制器算出来的目录——两者都可能
 * 因为启动方式不同而落空，而"我自己装在哪"永远是对的。
 *
 * 只有那个目录**真的是一个 profile**（有 `node_modules/dsh-workbuddy-helper`）时才认，
 * 否则从工作树直接运行时 `E:\DSH\workspace\migrate\lib` 会往上算出无关目录。
 */
export function ownProfileDir() {
  try {
    const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    return existsSync(path.join(candidate, 'node_modules', 'dsh-workbuddy-helper')) ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * 候选安装位置，按可信度排序。
 * `profile` = 当前 profile 自己装的；`shared` = pnpm 提升到 profiles 层的共享依赖；
 * `self` = 退到本插件自己的安装位置反推出来的 profile（前两条都拿不到时兜底）。
 */
export function mnemonCandidates(options = {}) {
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? options.dshHome : resolveDshHome()
  const profileDir = typeof options.profileDir === 'string' && options.profileDir !== '' ? options.profileDir : undefined
  const candidates = []
  if (profileDir !== undefined) {
    candidates.push({ dir: path.join(profileDir, 'node_modules', MNEMON_PACKAGE), source: 'profile' })
  }
  candidates.push({ dir: path.join(dshHome, 'profiles', 'node_modules', MNEMON_PACKAGE), source: 'shared' })
  const selfDir = ownProfileDir()
  // 只在没能从外面拿到 profileDir 时才补这条：同一个目录探两遍没有意义。
  if (profileDir === undefined && selfDir !== undefined) {
    candidates.push({ dir: path.join(selfDir, 'node_modules', MNEMON_PACKAGE), source: 'self' })
  }
  return candidates
}

function absent() {
  return { available: false, version: null, path: null, source: null }
}

/** 读一个候选目录的 package.json；名字对不上也算没装（防止同名的空壳目录）。 */
async function readCandidate(candidate) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(candidate.dir, 'package.json'), 'utf8'))
    if (pkg === null || typeof pkg !== 'object' || pkg.name !== MNEMON_PACKAGE) return undefined
    return {
      available: true,
      version: typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : null,
      path: candidate.dir,
      source: candidate.source,
    }
  } catch {
    return undefined
  }
}

/**
 * 一次性探测（不缓存）。读盘失败一律当"没装"——这个判断只影响一个页签是否显示，
 * 不该因为它读不到文件就让整个面板报错。
 */
export async function detectMnemon(options = {}) {
  for (const candidate of mnemonCandidates(options)) {
    const found = await readCandidate(candidate)
    if (found !== undefined) return found
  }
  return absent()
}

/**
 * 带 TTL 缓存的探测器。
 *
 * `profileDir` 允许传函数：profile 目录在 controller 里是惰性确定的，
 * 传字符串会在构造顺序上埋一个"拿不到就永远 false"的坑。
 */
export function createMnemonDetector(options = {}) {
  const resolveProfileDir = typeof options.profileDir === 'function'
    ? options.profileDir
    : () => options.profileDir
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DETECT_TTL_MS
  let cache

  return async function mnemonState(force = false) {
    if (force !== true && cache !== undefined && Date.now() - cache.at < ttlMs) return cache.value
    const value = await detectMnemon({ dshHome: options.dshHome, profileDir: resolveProfileDir() })
    cache = { at: Date.now(), value }
    return value
  }
}
