/**
 * 把工作区里的文本文件统一成 LF。
 *
 * 为什么需要：`.gitattributes` 的 `eol=lf` 只约束 git 的转换方向，不会改工作区字节。
 * 只要文件在盘上还是 CRLF，git 每次碰它都会打印
 * `warning: in the working copy of 'X', CRLF will be replaced by LF…` —— 那行走 stderr，
 * 外层 PowerShell 记成 NativeCommandError，命令退出码就变 1（release.mjs 三次"假失败"的根因）。
 *
 * 只处理 `git ls-files --eol` 里 attr 为 text 的文件，二进制（png 等）跳过。
 * 默认 dry-run，打印将要改的文件数与字节差；加 --write 才真写。
 */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const write = process.argv.includes('--write')

const listed = spawnSync('git', ['ls-files', '--eol', '-z'], { cwd: root, encoding: 'utf8' })
if (listed.status !== 0) {
  console.error(`git ls-files failed: ${(listed.stderr || '').trim()}`)
  process.exit(1)
}

const rows = listed.stdout.split('\u0000').filter(entry => entry !== '')
let scanned = 0
let changed = 0
let savedBytes = 0
const samples = []

for (const row of rows) {
  // 形如：`i/lf    w/crlf  attr/text=auto eol=lf \tlib/market.js`
  // 注意 attr 那一段本身含空格（`attr/text=auto eol=lf`），所以先按 \t 切文件名，再把左边按空格切。
  const tab = row.indexOf('\t')
  if (tab < 0) continue
  const name = row.slice(tab + 1)
  const fields = row.slice(0, tab).trim().split(/\s+/)
  const worktree = fields[1] ?? ''
  const attr = fields.slice(2).join(' ')
  if (attr.startsWith('attr/-text')) continue
  if (!attr.startsWith('attr/text=')) continue
  scanned += 1
  if (!worktree.includes('crlf') && worktree !== 'w/mixed') continue

  const target = path.join(root, name)
  const bytes = await readFile(target)
  const text = bytes.toString('utf8')
  if (!text.includes('\r\n')) continue
  const normalized = text.replace(/\r\n/g, '\n')
  changed += 1
  savedBytes += bytes.length - Buffer.byteLength(normalized, 'utf8')
  if (samples.length < 6) samples.push(name)
  if (write) await writeFile(target, normalized, 'utf8')
}

console.log(`${write ? 'rewrote' : 'would rewrite'} ${changed}/${scanned} text files to LF (${savedBytes} bytes removed)`)
if (samples.length > 0) console.log(`e.g. ${samples.join(', ')}`)
if (!write && changed > 0) console.log('re-run with --write to apply')
