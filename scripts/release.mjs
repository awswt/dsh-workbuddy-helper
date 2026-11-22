#!/usr/bin/env node
/**
 * 一次改动 = 一个版本：跑测试 → bump 版本 → commit → push。
 *
 *   node scripts/release.mjs                # patch（0.6.0 → 0.6.1）
 *   node scripts/release.mjs --minor        # 0.6.1 → 0.7.0
 *   node scripts/release.mjs --major        # 0.7.0 → 1.0.0
 *   node scripts/release.mjs --dry-run      # 只打印将要发生什么
 *   node scripts/release.mjs --no-push      # 本地提交，不推
 *   node scripts/release.mjs -m "feat: xxx" # 自定义提交说明
 *
 * 为什么先跑测试再 bump：版本号是"这份代码可信"的唯一信号，测试挂了就不该有新版本号，
 * 否则别人装到的是带 bug 的版本，只会让人怀疑"是不是又没装新代码"。
 */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const packagePath = path.join(root, 'package.json')

function parseArgs(argv) {
  const options = { bump: 'patch', dryRun: false, push: true, message: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-push') options.push = false
    else if (arg === '--minor') options.bump = 'minor'
    else if (arg === '--major') options.bump = 'major'
    else if (arg === '--patch') options.bump = 'patch'
    else if (arg === '-m' || arg === '--message') {
      options.message = argv[index + 1] ?? null
      index += 1
    } else if (arg === '-h' || arg === '--help') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * 子进程一律"捕获后经 stdout 转发"，不用 stdio:'inherit'。
 *
 * 为什么：Windows 上 git 会把 `warning: in the working copy of 'X', LF will be replaced by
 * CRLF…` 这类提示写到 **stderr**，`git push` 成功时也会写 `Everything up-to-date`。
 * 透传出去后，外层 PowerShell 会把这些 stderr 行记成 NativeCommandError，
 * 于是整条 `node scripts/release.mjs` 的退出码变成 1 —— 发布明明成功，CI 却判失败。
 *
 * 用 spawnSync 而不是 execFileSync：后者成功时只回 stdout，子进程的 stderr 会直接丢掉。
 * 那些提示仍有诊断价值，只是必须走我们的 stdout，绝不能再出现在我们的 stderr 上
 * （`test/release-script.test.mjs` 对这条有断言）。
 */
function forward(text) {
  if (text !== undefined && text !== null && text !== '') process.stdout.write(text)
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`${command} ${args.join(' ')} could not start: ${result.error.message}`)
  }
  if (!capture) {
    forward(stdout)
    forward(stderr)
  }
  if (result.status !== 0) {
    const detail = (stderr.trim() || stdout.trim() || '(no output)').slice(-1200)
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? '?'}): ${detail}`)
  }
  return stdout
}

function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(version).trim())
  if (match === null) throw new Error(`not a semver version: ${version}`)
  const [, major, minor, patch] = match
  if (kind === 'major') return `${Number(major) + 1}.0.0`
  if (kind === 'minor') return `${major}.${Number(minor) + 1}.0`
  return `${major}.${minor}.${Number(patch) + 1}`
}

async function testFiles() {
  const entries = await fs.readdir(path.join(root, 'test'))
  return entries
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join('test', name))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('usage: node scripts/release.mjs [--patch|--minor|--major] [--dry-run] [--no-push] [-m message]')
    return
  }

  const raw = await readFile(packagePath, 'utf8')
  const manifest = JSON.parse(raw)
  const nextVersion = bumpVersion(manifest.version, options.bump)
  const files = await testFiles()
  if (files.length === 0) throw new Error('no test/*.test.mjs found — refusing to release untested code')

  console.log(`release ${manifest.version} -> ${nextVersion} (${options.bump}), ${files.length} test files`)
  if (options.dryRun) {
    console.log('dry run: would run tests, write package.json, git add -A, commit and push')
    return
  }

  console.log('\n[1/4] tests')
  run(process.execPath, ['--test', ...files])

  console.log('\n[2/4] bump version')
  // 只替换 version 这一行，保留原有缩进与字段顺序，diff 里不该出现大面积噪声。
  const nextRaw = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${nextVersion}$2`)
  if (nextRaw === raw) throw new Error('could not locate "version" in package.json')
  await writeFile(packagePath, nextRaw, 'utf8')

  console.log('\n[3/4] commit')
  run('git', ['add', '-A'])
  const staged = run('git', ['diff', '--cached', '--name-only'], { capture: true }).trim()
  if (staged === '') {
    console.log('nothing staged — reverting version and stopping')
    await writeFile(packagePath, raw, 'utf8')
    return
  }
  const message = options.message ?? `chore(release): v${nextVersion}`
  run('git', ['commit', '-m', message])

  if (options.push !== true) {
    console.log('skipped push (--no-push)')
    return
  }
  console.log('\n[4/4] push')
  run('git', ['push', 'origin', 'HEAD'])
  console.log(`\nreleased v${nextVersion}`)
}

// 只在被直接执行时跑发布；被 import（测试）时只暴露纯函数，否则一 import 就去 push。
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch(error => {
    console.error(`release failed: ${error?.message ?? error}`)
    process.exitCode = 1
  })
}

export { bumpVersion, parseArgs, run, forward }

