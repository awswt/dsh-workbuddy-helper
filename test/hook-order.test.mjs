import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 这个文件守的是一条 React 规则，不是某个功能：
 *
 * **任何条件 return 都不能站在 hook 前面。**
 *
 * 违反它的代价在这里特别大。`conversation.input.left` 是宿主的 `kind: 'list'` 槽位，
 * `@deepseek-ai/dsh-client-ui-renderer` 的 SlotErrorBoundary 捕获到非 chain 槽位的异常后
 * 会把**整个 entry 退役**（abdicate）；而我们的 pill 与弹窗是同一个 entry。所以一次
 * "Rendered more hooks than during the previous render" 的后果不是弹窗坏掉，而是
 * 「点一次会话辅助按钮，按钮从此消失，重启 DSH 才回来」——v0.8.0 到 v0.8.4 就是这个症状。
 *
 * 静态扫描比渲染测试更稳：它不需要模拟 React 调度，也不会因为组件内部重构而假绿。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

const HOOK_PATTERN = /React\.use(State|Effect|Callback|Memo|Ref|Reducer|LayoutEffect|Context|Transition|DeferredValue|Id|ImperativeHandle|SyncExternalStore)\(/

/**
 * 把 `function Name(` 到下一个同级 `function` 之间的源码切出来。
 * 只处理本文件的实际写法（4 空格缩进的函数声明），不做通用解析。
 */
function functionBodies(source) {
  const lines = source.split('\n')
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{0,4}function ([A-Za-z0-9_]+)\s*\(/)
    if (match !== null) starts.push({ name: match[1], line: index })
  }
  const bodies = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index].line
    const to = index + 1 < starts.length ? starts[index + 1].line : lines.length
    bodies.push({ name: starts[index].name, from, lines: lines.slice(from, to) })
  }
  return bodies
}

/**
 * 找「函数体第一层」的 return 语句，以及它们之后出现的 hook 调用。
 *
 * 深度 1 = 直接写在函数体里（深度 0 是文件/模块外壳）。嵌在 if/callback 里的 return
 * 不算——那本来就是合法写法，React 也不会因为它改变 hook 数量。
 */
function auditBody(lines) {
  let depth = 0
  let earlyReturnLine = null
  const hooksAfterReturn = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    const atBodyLevel = depth === 1
    if (atBodyLevel && index > 0) {
      const isReturn = /^return\b/.test(trimmed) || /^if\s*\(.*\)\s*return\b/.test(trimmed) || /^if\s*\(.*\)\s*\{\s*return\b/.test(trimmed)
      if (isReturn && earlyReturnLine === null) earlyReturnLine = index + 1
      if (earlyReturnLine !== null && HOOK_PATTERN.test(line)) hooksAfterReturn.push(index + 1)
    }
    for (const character of line) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
    }
  }
  return { earlyReturnLine, hooksAfterReturn }
}

test('no component calls a hook after a conditional return', () => {
  const offenders = []
  for (const body of functionBodies(clientSource)) {
    const { earlyReturnLine, hooksAfterReturn } = auditBody(body.lines)
    if (hooksAfterReturn.length > 0) {
      offenders.push(`${body.name}: return at line ${earlyReturnLine + body.from}, hooks after it at ${hooksAfterReturn.map(line => line + body.from).join(', ')}`)
    }
  }
  assert.deepEqual(offenders, [], 'a conditional return sits in front of hooks; the slot entry will be abdicated instead of just the dialog:\n' + offenders.join('\n'))
})

test('PickerDialog keeps every hook ahead of its closed-state early return', () => {
  const dialog = functionBodies(clientSource).find(body => body.name === 'PickerDialog')
  assert.ok(dialog !== undefined && dialog !== null, 'PickerDialog must exist in lib/client.js')
  const { earlyReturnLine, hooksAfterReturn } = auditBody(dialog.lines)
  assert.notEqual(earlyReturnLine, null, 'PickerDialog is expected to keep a closed-state early return')
  assert.deepEqual(hooksAfterReturn, [], 'the early return must come after the last hook')
  // 账号区的两个 hook 曾经排在早退后面；钉住它们的存在，免得"删掉早退"被当成修法。
  const source = dialog.lines.join('\n')
  assert.match(source, /var loadAccounts = React\.useCallback\(/)
  assert.match(source, /if \(props\.open && tab === 'account'\) void loadAccounts\(\)/)
})

test('a crashed dialog can only take itself down, never the composer pill', () => {
  const composer = functionBodies(clientSource).find(body => body.name === 'ComposerEntry')
  assert.ok(composer !== undefined && composer !== null, 'ComposerEntry must exist in lib/client.js')
  const source = composer.lines.join('\n')
  // 弹窗必须包在自家边界里，且关闭时不挂载——两条合起来保证 pill 与弹窗的渲染互不牵连。
  assert.match(source, /h\(DialogBoundary, null, h\(PickerDialog, \{/)
  assert.match(source, /open\s*\n?\s*\?\s*h\(DialogBoundary/)
  assert.match(source, /:\s*null\)/)
  // pill 自己在边界之外渲染。
  const boundaryAt = source.indexOf('h(DialogBoundary')
  const pillAt = source.indexOf("className: 'wbh-pill'")
  assert.ok(pillAt > 0 && pillAt < boundaryAt, 'the pill must be rendered before (outside of) the dialog boundary')
})

test('the dialog boundary renders null while healthy children exist and after a failure', () => {
  const source = clientSource
  assert.match(source, /class DialogBoundary extends/)
  assert.match(source, /static getDerivedStateFromError\(\) \{\s*\n\s*return \{ failed: true \}/)
  assert.match(source, /componentDidCatch\(error\) \{/)
  assert.match(source, /if \(this\.state\.failed\) return null/)
  assert.match(source, /return this\.props\.children === undefined \? null : this\.props\.children/)
})
