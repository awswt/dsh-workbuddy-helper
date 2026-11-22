import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MANAGED_CONFIG_FIELDS,
  MCP_PLUGIN_NAME,
  normalizeSpec,
  readMcpServers,
  removeMcpServer,
  setMcpDisabled,
  upsertMcpServers,
  validateServerName,
} from '../lib/mcp-patch.js'

test('mcp patch keeps the armory plugin contract', () => {
  assert.equal(MCP_PLUGIN_NAME, '@deepseek-ai/dsh-mcp-client')
  assert.deepEqual(MANAGED_CONFIG_FIELDS, [
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
})

test('validateServerName rejects names the host cannot mount', () => {
  assert.equal(validateServerName('bocha-search'), 'bocha-search')
  assert.equal(validateServerName('Amap_2'), 'Amap_2')
  for (const bad of ['', 'has space', 'a'.repeat(33), 'has.dot']) {
    assert.throws(() => validateServerName(bad), /MCP serverName/)
  }
})

test('normalizeSpec keeps only managed fields and fills the transport', () => {
  const spec = normalizeSpec({
    serverName: 'demo',
    url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer t' },
    ignored: 'nope',
    args: [],
    env: {},
  })
  assert.equal(spec.name, 'demo')
  assert.equal(spec.transport, 'streamable-http')
  assert.equal(spec.url, 'https://example.test/mcp')
  assert.deepEqual(spec.headers, { Authorization: 'Bearer t' })
  assert.equal('ignored' in spec, false)
  assert.equal('args' in spec, false)
  assert.equal('env' in spec, false)
  assert.throws(() => normalizeSpec({ name: 'stdio-needs-command', transport: 'stdio' }), /stdio/)
  assert.throws(() => normalizeSpec({ name: 'http-needs-url', transport: 'sse' }), /url/)
})

test('upsert appends a new insert block and updates the same name in place', () => {
  const original = [
    '- id: ui-settings-general',
    '  disabled: false',
    '',
  ].join('\n')

  const first = upsertMcpServers(original, [{ name: 'amap', transport: 'http', url: 'https://a.test/mcp' }])
  assert.deepEqual(first.added, ['amap'])
  assert.deepEqual(first.updated, [])
  assert.match(first.content, /- insert:/)
  assert.match(first.content, /id: mcp-amap/)
  assert.match(first.content, /name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?/)
  assert.match(first.content, /serverName: amap/)
  assert.match(first.content, /- id: ui-settings-general/)

  const parsed = readMcpServers(first.content)
  assert.deepEqual(parsed.servers.map(server => server.name), ['amap'])
  assert.equal(parsed.entryIds.amap, 'mcp-amap')

  const second = upsertMcpServers(first.content, [{ name: 'amap', transport: 'http', url: 'https://b.test/mcp' }])
  assert.deepEqual(second.added, [])
  assert.deepEqual(second.updated, ['amap'])
  assert.equal(second.content.match(/serverName: amap/g).length, 1)
  assert.match(second.content, /https:\/\/b\.test\/mcp/)
  assert.doesNotMatch(second.content, /https:\/\/a\.test\/mcp/)
})

test('setMcpDisabled toggles the entry without touching other entries', () => {
  const base = upsertMcpServers('', [{ name: 'amap', transport: 'http', url: 'https://a.test/mcp' }]).content
  const disabled = setMcpDisabled(base, 'amap', true)
  assert.equal(readMcpServers(disabled).servers[0].disabled, true)
  const enabled = setMcpDisabled(disabled, 'amap', false)
  assert.equal(readMcpServers(enabled).servers[0].disabled, undefined)
  assert.throws(() => setMcpDisabled(enabled, 'missing', true), /没有可管理的 MCP/)
})

test('remove deletes exactly one managed entry and reports the miss otherwise', () => {
  const base = upsertMcpServers('', [
    { name: 'amap', transport: 'http', url: 'https://a.test/mcp' },
    { name: 'bocha', transport: 'http', url: 'https://b.test/mcp' },
  ]).content
  const removed = removeMcpServer(base, 'amap')
  assert.equal(removed.removed, true)
  assert.deepEqual(readMcpServers(removed.content).servers.map(server => server.name), ['bocha'])
  assert.equal(removeMcpServer(removed.content, 'amap').removed, false)
})

test('upsert with removeNames prunes stale entries in the same write', () => {
  const base = upsertMcpServers('', [
    { name: 'amap', transport: 'http', url: 'https://a.test/mcp' },
    { name: 'bocha', transport: 'http', url: 'https://b.test/mcp' },
  ]).content
  const result = upsertMcpServers(base, [{ name: 'bocha', transport: 'http', url: 'https://b2.test/mcp' }], {
    removeNames: ['amap'],
  })
  assert.deepEqual(result.removed, ['amap'])
  assert.deepEqual(readMcpServers(result.content).servers.map(server => server.name), ['bocha'])
})

test('duplicate serverName in one patch is reported instead of silently merged', () => {
  const once = upsertMcpServers('', [{ name: 'dup', transport: 'http', url: 'https://a.test/mcp' }]).content
  const twice = `${once}\n${once.trim().split('\n').map(line => line.replace(/^  /, '  ')).join('\n')}\n`
  assert.throws(() => readMcpServers(twice), /重复 serverName/)
})

test('an empty patch gains a block-style insert block, not a flow one', () => {
  // 空 profile 的 cordis.patch.yml 是 `[]`，写回时必须保持可 review 的 block 风格。
  const written = upsertMcpServers('[]', [
    { serverName: 'amap', transport: 'stdio', command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'], env: { K: 'v' } },
  ]).content
  assert.match(written, /^- insert:/m)
  assert.doesNotMatch(written, /\{\s*insert:/)
  assert.match(written, /^ {4}- id: mcp-amap$/m)
  const parsed = readMcpServers(written)
  assert.equal(parsed.servers.length, 1)
  assert.equal(parsed.servers[0].env.K, 'v')
  assert.deepEqual(parsed.servers[0].args, ['-y', '@amap/amap-maps-mcp-server'])
})
