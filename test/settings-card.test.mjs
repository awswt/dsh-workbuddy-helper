import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 设置页那一页的静态契约测试。
 *
 * 为什么不去渲染：`lib/client.js` 是浏览器半侧，渲染要宿主真 React 加 hook 调度器，
 * 那是 e2e 的活。这里要守住的是更容易回归的三件事——
 *  1. `apply()` 真的向 `settings.section` 与 `settings.section.icon` 各注册了一条；
 *  2. 两条注册的 id 相同（宿主按 id 配对图标，对不上图标永远不渲染）；
 *  3. 一个老宿主没有 settings.* 槽位时，composer 的 pill 注册不受牵连。
 *
 * 用最小 React 桩就能满足：factory 在被调用时只用到 `createElement`，
 * 没有任何 hook 在模块顶层执行。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

function fakeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(),
  })
  return {
    createElement,
    Fragment: 'Fragment',
    useState: () => {
      throw new Error('hooks must not run at module load')
    },
    useEffect: () => {
      throw new Error('hooks must not run at module load')
    },
    useCallback: () => {
      throw new Error('hooks must not run at module load')
    },
  }
}

/** 把 `lib/client.js` 的 factory body 取出来，以 `require` 注入的 React 求值。 */
async function loadClient(files = {}) {
  const source = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const marker = 'factory: function (require) {'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'client factory marker must exist')
  const bodyStart = start + marker.length
  const bodyEnd = source.lastIndexOf('\n  },\n})')
  assert.ok(bodyEnd > bodyStart, 'client factory must be closed with `  },` before `})`')
  const body = source.slice(bodyStart, bodyEnd)
  const react = fakeReact()
  const run = new Function('require', 'window', 'document', body)
  const moduleExports = run(
    name => {
      if (name === 'react') return react
      if (name === 'react-dom') return files.reactDom ?? { createPortal: node => node }
      throw new Error(`unexpected require: ${name}`)
    },
    {},
    files.document,
  )
  return { moduleExports, source }
}

/** 记录每次 inject/register 的假 ctx；`reject` 里的槽位名会在 inject 时抛错。 */
function recordingCtx(options = {}) {
  const reject = new Set(options.reject ?? [])
  const injected = []
  const registered = []
  const errors = []
  return {
    injected,
    registered,
    errors,
    ctx: {
      get() {
        return null
      },
      slots: {
        inject(name, fn) {
          injected.push(name)
          if (reject.has(name)) throw new Error(`slot ${name} is not declared by this host`)
          fn()
        },
        register(entry, component) {
          registered.push({
            name: entry.name,
            id: entry.id,
            order: entry.order,
            label: typeof entry.label === 'function' ? entry.label() : entry.label,
            component,
          })
          return () => {}
        },
      },
    },
  }
}

test('apply registers one settings page plus its nav icon under the same id', async () => {
  const { moduleExports } = await loadClient()
  const harness = recordingCtx()
  moduleExports.apply(harness.ctx)

  const section = harness.registered.find(entry => entry.name === 'settings.section')
  const icon = harness.registered.find(entry => entry.name === 'settings.section.icon')
  assert.ok(section, 'settings.section must be registered')
  assert.ok(icon, 'settings.section.icon must be registered')
  // 宿主按 id 把图标配给页；id 不同就等于没有图标，而且是静默失败。
  assert.equal(icon.id, section.id)
  assert.equal(section.id, 'workbuddy-helper-account')
  assert.equal(typeof section.component, 'function')
  assert.equal(typeof icon.component, 'function')
  assert.equal(section.label, 'WorkBuddy 登录')

  // 用的是插件自己的 id：借用官方 id 会顶掉那一页。
  const shipped = ['models', 'plugins', 'account', 'agent-presets', 'general']
  assert.equal(shipped.includes(section.id), false)
})

test('the composer pill is registered even when the host declares no settings slots', async () => {
  const { moduleExports } = await loadClient()
  // 老宿主：settings.* 一个都没有，inject 直接抛。
  const harness = recordingCtx({ reject: ['settings.section', 'settings.section.icon'] })
  // 插件对这种情况的处理是 console.error 后继续——顺手把这段噪声收下来当断言。
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args.map(String).join(' '))
  try {
    assert.doesNotThrow(() => moduleExports.apply(harness.ctx))
  } finally {
    console.error = originalError
  }

  const pill = harness.registered.find(entry => entry.name === 'conversation.input.left')
  assert.ok(pill, 'the composer pill must survive a host without settings slots')
  assert.equal(pill.id, 'workbuddy-helper-expert-picker')
  // 两个 settings 槽位都试过（而不是第一个失败就整段跳过）。
  assert.deepEqual(harness.injected, [
    'conversation.input.left',
    'settings.section',
    'settings.section.icon',
  ])
  // 失败要留痕，不能静默——但只报自己那两条。
  assert.equal(logged.length, 2)
  assert.match(logged[0], /settings section registration failed/)
  assert.match(logged[1], /settings icon registration failed/)
})

test('the settings card is exported for the panel to reuse', async () => {
  const { moduleExports } = await loadClient()
  assert.equal(typeof moduleExports.__internals.SettingsAccountCard, 'function')
  // 卡片必须走账号路由，而不是自己拼一个 URL。
  assert.equal(moduleExports.__internals.ROUTES.accounts, '/dsh-workbuddy-helper/accounts')
  assert.equal(moduleExports.__internals.ROUTES.accountsAction, '/dsh-workbuddy-helper/accounts/action')
})

test('the settings card styles are part of the single injected stylesheet', async () => {
  const { moduleExports } = await loadClient()
  const css = moduleExports.__internals.CSS
  for (const rule of ['.wbh-settings{', '.wbh-settings__hero{', '.wbh-settings__title{', '.wbh-settings__url{']) {
    assert.ok(css.includes(rule), `${rule} must be in the shared stylesheet`)
  }
})
