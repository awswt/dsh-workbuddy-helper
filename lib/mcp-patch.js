/**
 * lib/mcp-patch.js — 读写 profile 的 cordis patch 层里由 `@deepseek-ai/dsh-mcp-client`
 * 托管的 MCP server 条目。
 *
 * 为什么要有这一层：连接器目录（catalog）里的连接器只有落到"宿主真的会去连的配置"
 * 才算进得了会话。DSH 的宿主侧 MCP 桥就是 `@deepseek-ai/dsh-mcp-client` 这个插件，
 * 它的每个 server 都是 patch 列表里的一条 `insert` 条目：
 *
 *   - insert:
 *       - id: mcp-<name>
 *         name: "@deepseek-ai/dsh-mcp-client"
 *         config:
 *           serverName: <name>
 *           transport: streamable-http | sse | stdio
 *           url: https://...
 *           headers: { Authorization: ... }
 *
 * 本文件的语义对齐 dsh-armory 2.5.9 的 `lib/mcp-config.js`（同一套 patch 约定），
 * 只保留连接器管理需要的那部分：读、增/改、禁用/启用、删除。用 YAML Document API
 * 而不是字符串拼装，保证用户文件里既有的注释与其他插件条目原样保留。
 */

import { parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from 'yaml'

/** 宿主侧 MCP 桥插件的包名，DSH profile 的 patch 层靠它识别 MCP 条目。 */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** patch 条目 config 里允许出现在受管条目上的字段。 */
export const MANAGED_CONFIG_FIELDS = Object.freeze([
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'reconnect',
])

/** serverName 会被拼成工具前缀 `mcp__<serverName>__*`，因此必须收得很窄。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nodeValue(node) {
  if (node === null || node === undefined) return undefined
  if (isMap(node) || isSeq(node)) return node.toJSON()
  if (typeof node === 'object' && 'value' in node) return node.value
  return node
}

function getNode(map, key) {
  if (!isMap(map)) return undefined
  return map.get(key, true)
}

function getValue(map, key) {
  return nodeValue(getNode(map, key))
}

/**
 * 校验一个 serverName 是否能安全地作为 patch 条目名与工具前缀。
 * @param {unknown} name
 * @returns {string}
 */
export function validateServerName(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (!SERVER_NAME_PATTERN.test(value)) {
    throw new Error(`MCP serverName 必须是 1-32 位的字母、数字、下划线或连字符：${String(name)}`)
  }
  return value
}

/**
 * 把外部传入的 spec 收敛成受管字段的白名单对象，未知字段直接丢弃。
 * @param {Record<string, unknown>} spec
 */
export function normalizeSpec(spec) {
  if (!isObject(spec)) throw new Error('MCP server spec 必须是对象')
  const name = validateServerName(spec.name ?? spec.serverName)
  const out = { name }
  for (const field of MANAGED_CONFIG_FIELDS) {
    const value = spec[field]
    if (value === undefined || value === null) continue
    if (field === 'args') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`${name}: args 必须是字符串数组`)
      }
      // 空数组在 patch 里等价于"没写"，留着只会让后续 diff 噪音变大。
      if (value.length === 0) continue
      out.args = [...value]
      continue
    }
    if (field === 'env' || field === 'headers') {
      if (!isObject(value)) throw new Error(`${name}: ${field} 必须是对象`)
      const entries = Object.entries(value)
      if (entries.length === 0) continue
      out[field] = { ...value }
      continue
    }
    out[field] = value
  }
  if (out.transport === undefined) {
    out.transport = out.url === undefined ? 'stdio' : 'streamable-http'
  }
  if (out.transport === 'stdio' && typeof out.command !== 'string') {
    throw new Error(`${name}: stdio 传输必须给出 command`)
  }
  if (out.transport !== 'stdio' && typeof out.url !== 'string') {
    throw new Error(`${name}: ${out.transport} 传输必须给出 url`)
  }
  if (spec.disabled === true) out.disabled = true
  return out
}

function parsePatch(content) {
  const doc = parseDocument(content || '')
  if (doc.errors.length) {
    throw new Error(`profile patch YAML 无法解析：${doc.errors[0].message}`)
  }
  // 空文件、只有注释的文件解析出来 contents 为 null 且 errors 为 0——合法空 patch。
  if (doc.contents === null) doc.contents = new YAMLSeq()
  if (!isSeq(doc.contents)) throw new Error('profile patch 必须是 YAML 列表')
  // `[]` 解析出来是 flow 风格的序列，往里塞条目会写成 `{ insert: [...] }`。
  // 空的 patch 是我们自己的产物，转成 block 风格，便于用户 review diff。
  if (doc.contents.items.length === 0 && doc.contents.flow === true) doc.contents.flow = false
  return doc
}

function findInsertSeq(item) {
  const insert = getNode(item, 'insert')
  return isSeq(insert) ? insert : null
}

function entrySpec(entry) {
  if (!isMap(entry)) return null
  if (getValue(entry, 'name') !== MCP_PLUGIN_NAME) return null
  const config = getNode(entry, 'config')
  if (!isMap(config)) return null
  const name = getValue(config, 'serverName')
  if (typeof name !== 'string') return null
  const spec = { name, transport: getValue(config, 'transport') }
  for (const field of MANAGED_CONFIG_FIELDS) {
    const value = getValue(config, field)
    if (value !== undefined) spec[field] = value
  }
  if (getValue(entry, 'disabled') === true) spec.disabled = true
  const id = getValue(entry, 'id')
  if (typeof id === 'string') spec.id = id
  return spec
}

/**
 * 读出 patch 里所有由 MCP 桥托管的 server。
 * @param {string} content
 * @returns {{servers: Array<Record<string, unknown>>, entryIds: Record<string, string>}}
 */
export function readMcpServers(content) {
  const doc = parsePatch(content)
  const servers = []
  const entryIds = {}
  const seen = new Set()
  for (const item of doc.contents.items) {
    const insert = findInsertSeq(item)
    if (!insert) continue
    for (const entry of insert.items) {
      const spec = entrySpec(entry)
      if (!spec) continue
      if (seen.has(spec.name)) throw new Error(`当前 profile 中存在重复 serverName：${spec.name}`)
      seen.add(spec.name)
      servers.push(spec)
      if (spec.id !== undefined) entryIds[spec.name] = spec.id
    }
  }
  return { servers, entryIds }
}

function collectIds(node, ids = new Set()) {
  if (isMap(node)) {
    const id = getValue(node, 'id')
    if (typeof id === 'string') ids.add(id)
    for (const pair of node.items) collectIds(pair.value, ids)
  } else if (isSeq(node)) {
    for (const item of node.items) collectIds(item, ids)
  }
  return ids
}

function nextEntryId(name, ids) {
  const base = `mcp-${name}`
  let id = base
  let suffix = 2
  while (ids.has(id)) id = `${base}-${suffix++}`
  ids.add(id)
  return id
}

function makeScalarOrNode(value) {
  if (Array.isArray(value)) {
    const seq = new YAMLSeq()
    for (const item of value) seq.items.push(makeScalarOrNode(item))
    return seq
  }
  if (isObject(value)) {
    const map = new YAMLMap()
    for (const [key, item] of Object.entries(value)) map.set(key, makeScalarOrNode(item))
    return map
  }
  return value
}

function makeEntry(spec, id) {
  const entry = new YAMLMap()
  entry.set('id', id)
  entry.set('name', MCP_PLUGIN_NAME)
  if (spec.disabled === true) entry.set('disabled', true)
  const config = new YAMLMap()
  config.set('serverName', spec.name)
  for (const field of MANAGED_CONFIG_FIELDS) {
    if (spec[field] === undefined) continue
    config.set(field, makeScalarOrNode(spec[field]))
  }
  entry.set('config', config)
  return entry
}

function updateEntry(entry, spec) {
  if (spec.disabled === true) entry.set('disabled', true)
  else if (spec.disabled === false) entry.delete('disabled')
  const config = getNode(entry, 'config')
  config.set('serverName', spec.name)
  for (const field of MANAGED_CONFIG_FIELDS) {
    if (spec[field] === undefined) {
      if (field !== 'serverName') config.delete(field)
    } else {
      config.set(field, makeScalarOrNode(spec[field]))
    }
  }
}

/**
 * 幂等地写入/更新 MCP server 条目；返回新的 patch 文本。
 * 已存在同名条目时原地更新（保留 id 与位置），不存在时追加到一个新的 `insert` 段。
 * @param {string} content 现有 patch 文本
 * @param {Array<Record<string, unknown>>} specs 待写入的 spec（name 必填）
 * @param {{removeNames?: string[]}} [options]
 * @returns {{content: string, added: string[], updated: string[], removed: string[]}}
 */
export function upsertMcpServers(content, specs, options = {}) {
  const normalized = (specs ?? []).map(normalizeSpec)
  const removeNames = new Set((options.removeNames ?? []).map(name => validateServerName(name)))
  const doc = parsePatch(content)
  const wanted = new Map(normalized.map(spec => [spec.name, spec]))
  const added = []
  const updated = []
  const removed = []
  const touched = new Set()

  for (let index = doc.contents.items.length - 1; index >= 0; index -= 1) {
    const item = doc.contents.items[index]
    const insert = findInsertSeq(item)
    if (!insert) continue
    insert.items = insert.items.filter(entry => {
      const spec = entrySpec(entry)
      if (!spec) return true
      if (removeNames.has(spec.name)) {
        removed.push(spec.name)
        return false
      }
      const next = wanted.get(spec.name)
      if (next === undefined || touched.has(spec.name)) return true
      updateEntry(entry, next)
      updated.push(spec.name)
      touched.add(spec.name)
      return true
    })
    if (insert.items.length === 0 && isMap(item) && item.items.length === 1) {
      doc.contents.items.splice(index, 1)
    }
  }

  const additions = normalized.filter(spec => !touched.has(spec.name))
  if (additions.length > 0) {
    const ids = collectIds(doc.contents, new Set())
    const patch = new YAMLMap()
    const insert = new YAMLSeq()
    for (const spec of additions) {
      insert.items.push(makeEntry(spec, nextEntryId(spec.name, ids)))
      added.push(spec.name)
    }
    patch.set('insert', insert)
    doc.contents.items.push(patch)
  }

  return { content: String(doc), added, updated, removed }
}

/**
 * 启用/禁用一个已存在的 MCP server 条目（`disabled: true` 的增删）。
 * @param {string} content
 * @param {string} name
 * @param {boolean} disabled
 * @returns {string}
 */
export function setMcpDisabled(content, name, disabled) {
  const target = validateServerName(name)
  const doc = parsePatch(content)
  for (const item of doc.contents.items) {
    const insert = findInsertSeq(item)
    if (!insert) continue
    for (const entry of insert.items) {
      const spec = entrySpec(entry)
      if (spec?.name !== target) continue
      if (disabled) entry.set('disabled', true)
      else entry.delete('disabled')
      return String(doc)
    }
  }
  throw new Error(`当前 profile patch 里没有可管理的 MCP：${target}`)
}

/**
 * 删除一个 MCP server 条目；不存在时返回原文本（幂等）。
 * @param {string} content
 * @param {string} name
 * @returns {{content: string, removed: boolean}}
 */
export function removeMcpServer(content, name) {
  const target = validateServerName(name)
  const doc = parsePatch(content)
  let removed = false
  for (let index = doc.contents.items.length - 1; index >= 0; index -= 1) {
    const item = doc.contents.items[index]
    const insert = findInsertSeq(item)
    if (!insert) continue
    const before = insert.items.length
    insert.items = insert.items.filter(entry => {
      const spec = entrySpec(entry)
      if (spec?.name !== target) return true
      removed = true
      return false
    })
    if (removed && insert.items.length !== before && insert.items.length === 0 && isMap(item) && item.items.length === 1) {
      doc.contents.items.splice(index, 1)
    }
  }
  return { content: removed ? String(doc) : content, removed }
}
