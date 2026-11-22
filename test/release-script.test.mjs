/**
 * `scripts/release.mjs` 的回归测试。
 *
 * 背景（真踩过的坑）：Windows 上 git 把 `warning: … LF will be replaced by CRLF` 与
 * `Everything up-to-date` 写到 **stderr**，脚本用 `stdio: 'inherit'` 透传后，
 * 外层 PowerShell 把这些 stderr 记成 NativeCommandError，于是
 * `node scripts/release.mjs` 退出码变成 1——三次"发布成功却报 exit 1"。
 * 这里直接对退出码与两路输出下断言，而不是靠人眼判断"看着像成功"。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { bumpVersion, parseArgs, run } from '../scripts/release.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptPath = path.join(root, 'scripts', 'release.mjs')

test('run() forwards a child\'s stdout but never its stderr', async () => {
  // 真回归：用一个子进程写 stderr 模拟 git 的 CRLF 警告，走**不 capture** 的那条路径
  // （正是它曾经把警告透传给 PowerShell）。断言：警告出现在 stdout，本进程 stderr 为空。
  const harness = `
    const { run } = await import(${JSON.stringify(new URL('../scripts/release.mjs', import.meta.url).href)})
    run(process.execPath, ['-e', ${JSON.stringify("process.stdout.write('visible\\n'); process.stderr.write('warning: LF will be replaced by CRLF\\n')")}])
  `
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=module', '-e', harness], { cwd: root })
  assert.match(stdout, /visible/)
  assert.match(stdout, /warning: LF will be replaced by CRLF/)
  // 这一条是核心：子进程的 stderr 不得出现在我们的 stderr 上。
  assert.equal(stderr, '')
})

test('run() keeps a captured call quiet so callers can parse the output', () => {
  const stdout = run(process.execPath, [
    '-e',
    "process.stdout.write('visible\\n'); process.stderr.write('warning: LF will be replaced by CRLF\\n')",
  ], { capture: true })
  assert.equal(stdout, 'visible\n')
})

test('run() turns a non-zero child into a readable error instead of a silent return', () => {
  assert.throws(
    () => run(process.execPath, ['-e', "process.stderr.write('ERR_PNPM_FETCH_404 nope\\n'); process.exit(3)"], { capture: true }),
    error => {
      // 报错要带命令、退出码、以及子进程真正说的话——否则又回到"截出一段临时路径当原因"。
      assert.match(error.message, /failed \(exit 3\)/)
      assert.match(error.message, /ERR_PNPM_FETCH_404/)
      assert.doesNotMatch(error.message, /undefined/)
      return true
    },
  )
})

test('the script exits 0 on a dry run even with a child process that writes to stderr', async () => {
  // --dry-run 不碰 git，但这条断言守的是"脚本自己不能因为输出被误判而失败"。
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--dry-run'], { cwd: root })
  assert.match(stdout, /^release \d+\.\d+\.\d+ -> \d+\.\d+\.\d+ \(patch\), \d+ test files$/m)
  assert.match(stdout, /dry run:/)
  assert.equal(stderr, '')
})

test('bumpVersion walks patch, minor and major without inventing a prerelease', () => {
  assert.equal(bumpVersion('0.6.14', 'patch'), '0.6.15')
  assert.equal(bumpVersion('0.6.14', 'minor'), '0.7.0')
  assert.equal(bumpVersion('0.6.14', 'major'), '1.0.0')
  // 带 prerelease 的版本被视作同一条线：bump 后清掉后缀，避免 0.6.0-rc.1 → 0.6.0-rc.2 这种永远发不出去的循环。
  assert.equal(bumpVersion('0.6.0-rc.1', 'patch'), '0.6.1')
  assert.equal(bumpVersion('1.2.3-rc.4', 'patch'), '1.2.4')
  assert.throws(() => bumpVersion('not-a-version', 'patch'), /not a semver version/)
})

test('parseArgs defaults to a patch release that pushes', () => {
  assert.deepEqual(parseArgs([]), { bump: 'patch', dryRun: false, push: true, message: null })
  assert.deepEqual(parseArgs(['--minor', '--dry-run', '--no-push', '-m', 'feat: x']), {
    bump: 'minor',
    dryRun: true,
    push: false,
    message: 'feat: x',
  })
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/)
})
