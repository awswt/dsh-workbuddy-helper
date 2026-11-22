/**
 * 子进程执行的共用封装：**一律捕获两路输出，只把结果写到我们自己的 stdout**。
 *
 * 为什么不用 `stdio: 'inherit'`：Windows 上 git 会把
 * `warning: in the working copy of 'X', LF will be replaced by CRLF…` 之类提示写到 stderr，
 * `git push` 成功时也会写 `Everything up-to-date`。透传后外层 PowerShell 会把这些行记成
 * NativeCommandError，整条命令退出码变成 1 —— 发布明明成功却报失败。
 *
 * 为什么不用 `execFileSync`：它成功时只回 stdout，子进程的 stderr 会被直接丢掉，而那些提示
 * 仍有诊断价值。`spawnSync` 才能同时拿到两路，再由调用方决定转发还是静默
 * （`test/release-script.test.mjs` 对这条有断言）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function forward(text) {
  if (text !== undefined && text !== null && text !== '') process.stdout.write(text)
}

/**
 * 造一个绑定到某个工作目录的 run()。
 * @param {string} cwd 子进程工作目录（通常是仓库根）
 */
export function createRunner(cwd) {
  return function run(command, args, { capture = false } = {}) {
    const result = spawnSync(command, args, {
      cwd,
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
}

/** 从 TAP 输出里读通过条数，读不到就给 null（不让发布因为解析失败而中断）。 */
export function tapPassCount(output) {
  const match = /^# pass (\d+)$/m.exec(String(output ?? ''))
  return match === null ? null : Number(match[1])
}

/**
 * 找到 npm 的 CLI 入口（`npm-cli.js`），返回 `{ command, args }` 供 spawnSync 直接执行。
 *
 * 为什么不能直接 spawn `npm` / `npm.cmd`：Windows 上 npm 是 `.cmd` 包装脚本，
 * `spawnSync('npm.cmd', …)` 不带 `shell: true` 会 `EINVAL`；带 `shell: true` 又会把
 * 参数交给 cmd.exe 重新解析（路径里的空格与 `--pack-destination` 都可能被吃掉）。
 * 用当前 node 直接跑 `npm-cli.js` 两个问题都没有，也让 node 版本与 npm 版本对齐。
 */
export function npmInvocation(args) {
  const candidates = []
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.endsWith('.js') && existsSync(execpath)) {
    candidates.push(execpath)
  }
  const nodeDir = path.dirname(process.execPath)
  candidates.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  const cli = candidates.find(candidate => existsSync(candidate))
  if (cli === undefined) {
    throw new Error(`could not locate npm-cli.js; looked in ${candidates.join(', ')}`)
  }
  return { command: process.execPath, args: [cli, ...args] }
}
