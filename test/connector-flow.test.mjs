import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONNECT_ACTIONS,
  connectorUiHint,
  connectorUiUrl,
  createOperationRegistry,
  describeConnectorError,
  normalizeConnectResult,
  oauthHandoffAction,
  tokenConfigAction,
} from '../lib/connector-flow.js'

test('operation registry grants one in-flight operation per connector', () => {
  const registry = createOperationRegistry()
  const first = registry.claim('amap', { action: 'connect', requestId: 'req-1' })
  assert.equal(first.granted, true)
  assert.match(first.opId, /^amap#\d+$/)
  assert.equal(first.requestId, 'req-1')
  assert.equal(registry.isCurrent('amap', first.opId), true)
  assert.deepEqual(registry.pending(), ['amap'])

  // 重复点击不排队、不并发：第二次直接告诉调用方"已经在连了"。
  const second = registry.claim('amap', { action: 'connect', requestId: 'req-2' })
  assert.equal(second.granted, false)
  assert.equal(second.current, first.opId)
  assert.equal(second.requestId, 'req-1')

  assert.equal(registry.claim('bocha', { action: 'connect' }).granted, true)
  assert.deepEqual(registry.pending().sort(), ['amap', 'bocha'])
  assert.equal(registry.size, 2)
})

test('a stale operation stops being current once cancelled', () => {
  const registry = createOperationRegistry()
  const op = registry.claim('amap', { action: 'repairConnect' })
  assert.equal(registry.isCurrent('amap', op.opId), true)
  assert.equal(registry.cancel('amap').opId, op.opId)
  assert.equal(registry.cancel('amap'), undefined)

  // 取消后重新连接会拿到新的 opId，旧的回调必须被判为过期。
  const next = registry.claim('amap', { action: 'connect' })
  assert.notEqual(next.opId, op.opId)
  assert.equal(registry.isCurrent('amap', op.opId), false)
  assert.equal(registry.isCurrent('amap', next.opId), true)

  // release 只释放自己持有的 opId。
  assert.equal(registry.release('amap', op.opId), false)
  assert.equal(registry.release('amap', next.opId), true)
  assert.equal(registry.isCurrent('amap', next.opId), false)
  assert.deepEqual(registry.pending(), [])
})

test('connect actions mirror the WorkBuddy façade', () => {
  assert.deepEqual([...CONNECT_ACTIONS], ['connect', 'repairConnect', 'reauthorize'])
  const registry = createOperationRegistry()
  assert.equal(registry.claim('x', { action: 'nonsense' }).granted, true)
  assert.equal(registry.size, 1)
})

test('normalizeConnectResult collapses the WorkBuddy outcomes', () => {
  assert.equal(normalizeConnectResult({ success: true }).status, 'connected')
  assert.equal(normalizeConnectResult({ success: true, viaForm: true }).viaForm, true)
  assert.equal(normalizeConnectResult({ cancelled: true }).status, 'cancelled')

  const form = normalizeConnectResult({ needsTokenConfig: true, form: { kind: 'form', fields: [] } })
  assert.equal(form.status, 'action-required')
  assert.equal(form.action.kind, 'form')

  const auth = normalizeConnectResult({ needsAuth: true, authStart: { authorizeUrl: 'https://x', nextAction: 'redirect' } })
  assert.equal(auth.status, 'action-required')
  assert.equal(auth.action.kind, 'open_url')
  assert.equal(auth.action.url, 'https://x')

  const connecting = normalizeConnectResult({ connecting: true })
  assert.equal(connecting.status, 'connecting')
  assert.equal(connecting.connecting, true)

  const failed = normalizeConnectResult({ success: false, error: new Error('boom') })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.message, 'boom')
  assert.equal(failed.error.kind, 'retry')
})

test('describeConnectorError maps codes to the actionable display kinds', () => {
  assert.equal(describeConnectorError(Object.assign(new Error('unauthorized'), { code: 'unauthorized' })).kind, 'authorize')
  assert.equal(describeConnectorError(Object.assign(new Error('missing token'), { code: 'needs-token-config' })).kind, 'configure')
  assert.equal(describeConnectorError(Object.assign(new Error('old version'), { code: 'incompatible' })).kind, 'upgrade')
  assert.equal(describeConnectorError(Object.assign(new Error('no permission'), { code: 'forbidden' })).kind, 'contact-admin')
  const described = describeConnectorError(new Error('socket hang up'))
  assert.equal(described.kind, 'retry')
  assert.equal(described.message, 'socket hang up')
})

test('token and OAuth actions carry what the UI needs to finish the connect', () => {
  const form = tokenConfigAction(
    { id: 'bocha-search', name: '博查搜索', auth: { mode: 'api-key', apiKeyHeader: 'Authorization' } },
    { existing: {} },
  )
  assert.equal(form.kind, 'form')
  assert.equal(form.configId, 'bocha-search')
  assert.deepEqual(form.fields.map(field => field.name), ['token', 'header'])
  assert.equal(form.fields[0].required, true)
  assert.equal(form.fields[1].value, 'Authorization')

  // 已有凭据时不预填真实值，只标记 present。
  const prefilled = tokenConfigAction(
    { id: 'x', name: 'X', auth: { mode: 'bearer' } },
    { existing: { token: 'secret-value' } },
  )
  assert.equal(prefilled.fields[0].value, '')
  assert.equal(prefilled.fields[0].present, true)

  const handoff = oauthHandoffAction({ id: 'canva', name: 'Canva' }, { url: 'https://mcp-connector/ui', expireAt: 1795355999999 })
  assert.equal(handoff.kind, 'open_url')
  assert.equal(handoff.url, 'https://mcp-connector/ui')
  assert.equal(handoff.nextAction, 'redirect')
  assert.equal(handoff.expireAt, 1795355999999)
})

test('connectorUiUrl writes the connector identity and never fakes a deep link', () => {
  const url = connectorUiUrl({ serverName: 'amap', configId: 'amap' })
  // 管理页只认 uiLocale/locale，所以这里只保证"我们带了可观测的标识"，不假装能定位。
  assert.equal(url, '/mcp-connector/ui?serverName=amap&connector=amap&from=dsh-workbuddy-helper')
  assert.equal(
    connectorUiUrl({}),
    '/mcp-connector/ui?from=dsh-workbuddy-helper',
    'empty values must not add blank query parameters',
  )
  assert.equal(
    connectorUiUrl({ base: '/mcp-connector/ui', serverName: 'amap', from: 'panel' }),
    '/mcp-connector/ui?serverName=amap&from=panel',
  )
})

test('connectorUiHint names the connector and its server so the user can search it', () => {
  assert.equal(
    connectorUiHint({ id: 'amap', name: '高德地图' }, { external: { serverName: 'amap' } }),
    '在管理页搜索「高德地图」（server: amap）完成授权或断开',
  )
  assert.equal(
    connectorUiHint({ id: 'amap', name: '高德地图' }, null),
    '在管理页搜索「高德地图」完成授权或断开',
    'a catalog-only config has no serverName yet',
  )
  assert.equal(connectorUiHint({}, null), '在管理页搜索「」完成授权或断开')
})
