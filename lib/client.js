/**
 * dsh-workbuddy-helper — client half.
 *
 * Adds a compact "专家" pill to `conversation.input.left` (the composer's
 * left-side control seat) and a session-scoped picker dialog with three tabs:
 *
 *   - 专家: live WorkBuddy market + locally installed experts;
 *   - 技能: expert skills + global skills, with search;
 *   - 连接器: installed connector plugins (per-session tool gating) and the
 *     MCP connector catalog.
 *
 * All state comes from the host half's JSON routes under
 * `/dsh-workbuddy-helper/*`; the client never writes expert state itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-helper',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var createPortal = null
    try {
      var reactDom = require('react-dom')
      if (reactDom !== null && reactDom !== undefined && typeof reactDom.createPortal === 'function') {
        createPortal = reactDom.createPortal
      }
    } catch (error) {
      createPortal = null
    }

    var PACKAGE_ID = 'dsh-workbuddy-helper'
    var SLOT_NAME = 'conversation.input.left'
    var ENTRY_ID = 'workbuddy-helper-expert-picker'
    var ENTRY_ORDER = 26
    var STYLE_ID = PACKAGE_ID + '-styles'
    var ROUTES = {
      state: '/dsh-workbuddy-helper/state',
      experts: '/dsh-workbuddy-helper/experts',
      connectors: '/dsh-workbuddy-helper/connectors',
      connectorsSession: '/dsh-workbuddy-helper/connectors/session',
      select: '/dsh-workbuddy-helper/select',
      skills: '/dsh-workbuddy-helper/skills',
      off: '/dsh-workbuddy-helper/off',
    }

    var inject = ['slots']

    var CSS = [
      '.wbh-host{display:contents}',
      '.wbh-pill{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;',
      'border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;',
      'cursor:pointer;white-space:nowrap;user-select:none;max-width:240px;',
      'transition:background-color .1s ease,color .1s ease,opacity .14s ease}',
      '.wbh-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary)}',
      '.wbh-pill:active{transform:translateY(.5px)}',
      '.wbh-pill:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent);outline-offset:1px}',
      '.wbh-pill[data-active="1"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));font-weight:600}',
      '.wbh-pill__icon{width:14px;height:14px;flex:none;display:block}',
      '.wbh-pill__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;',
      'font-weight:600}',
      '@media (max-width:860px){.wbh-pill__name{display:none}.wbh-pill{padding:0 6px}}',
      '.wbh-scrim{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / 32%));',
      'backdrop-filter:var(--dsw-mask-blur,blur(6px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(6px));',
      'animation:wbh-fade .16s ease}',
      '@keyframes wbh-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes wbh-rise{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}',
      '.wbh-panel{display:flex;flex-direction:column;width:min(820px,100%);height:min(620px,calc(100vh - 48px));',
      'box-sizing:border-box;border-radius:16px;overflow:hidden;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-layer-2,#1c1d21);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));',
      'box-shadow:0 24px 64px rgb(0 0 0 / 32%);animation:wbh-rise .2s cubic-bezier(.16,1,.3,1);',
      'font-size:13px;line-height:1.5}',
      '.wbh-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px}',
      '.wbh-head__text{flex:1;min-width:0}',
      '.wbh-title{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em}',
      '.wbh-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.wbh-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'cursor:pointer;flex:none}',
      '.wbh-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'color:var(--dsw-alias-label-primary)}',
      '.wbh-tabs{display:flex;gap:4px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.wbh-tab{position:relative;height:34px;padding:0 10px;border:none;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.wbh-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.wbh-tab[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.wbh-tab[data-on="1"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;',
      'border-radius:2px;background:var(--dsw-alias-label-primary)}',
      '.wbh-tab__count{margin-left:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.wbh-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 18px}',
      '.wbh-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.wbh-search{flex:1;display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;',
      'border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));',
      'background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03))}',
      '.wbh-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.wbh-search input::placeholder{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.38))}',
      '.wbh-chips{display:flex;gap:6px;overflow-x:auto;padding:0 0 10px;scrollbar-width:thin}',
      '.wbh-chip{flex:none;height:24px;padding:0 10px;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;',
      'color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.wbh-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.wbh-chip[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600;',
      'border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.wbh-active{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:12px;border-radius:11px;',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
      '.wbh-active__text{flex:1;min-width:0}',
      '.wbh-active__name{font-weight:600}',
      '.wbh-active__meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbh-list{display:flex;flex-direction:column;gap:6px}',
      '.wbh-expert{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;',
      'border:1px solid transparent;transition:background-color .1s ease,border-color .1s ease}',
      '.wbh-expert:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      'border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.07))}',
      '.wbh-expert[data-on="1"]{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}',
      '.wbh-avatar{position:relative;width:34px;height:34px;border-radius:9px;flex:none;overflow:hidden;',
      'display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18))}',
      '.wbh-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '.wbh-expert__text{flex:1;min-width:0}',
      '.wbh-expert__name{display:flex;align-items:center;gap:6px;font-weight:600;min-width:0}',
      '.wbh-expert__name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbh-expert__desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbh-badge{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:5px;',
      'color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12))}',
      '.wbh-badge[data-kind="installed"]{color:var(--dsw-alias-state-success-primary,#2fbf71);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fbf71) 38%,transparent)}',
      '.wbh-badge[data-kind="local"]{color:var(--dsw-alias-state-warn-primary,#e0a33a);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a33a) 38%,transparent)}',
      '.wbh-badge[data-kind="connected"]{color:var(--dsw-alias-state-success-primary,#2fbf71);',
      'border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fbf71) 38%,transparent)}',
      '.wbh-badge[data-kind="tools"]{color:var(--dsw-alias-label-secondary)}',
      '.wbh-use{flex:none;height:26px;padding:0 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;',
      'border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);',
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 38%,transparent)}',
      '.wbh-use:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.wbh-use:disabled{opacity:.55;cursor:not-allowed}',
      '.wbh-more{display:flex;justify-content:center;padding:12px 0 2px}',
      '.wbh-btn{height:30px;padding:0 13px;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;',
      'color:var(--dsw-alias-label-primary)}',
      '.wbh-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      /* Monochrome primary: filled with the label colour, text in the surface
         colour, so light and dark themes both read without relying on a brand
         token that flips between black and white. */
      '.wbh-btn--primary{color:var(--dsw-alias-bg-layer-2,#fff);border-color:transparent;',
      'background:var(--dsw-alias-label-primary,#0f1115);font-weight:600}',
      '.wbh-btn--primary:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 86%,var(--dsw-alias-bg-layer-2,#fff))}',
      '.wbh-btn--primary:disabled{opacity:.45}',
      '.wbh-btn--quiet{color:var(--dsw-alias-label-secondary)}',
      '.wbh-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.wbh-section{margin-bottom:16px}',
      '.wbh-section__head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}',
      '.wbh-section__title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);',
      'letter-spacing:.02em}',
      '.wbh-skill{display:flex;align-items:flex-start;gap:9px;padding:7px 9px;border-radius:9px;cursor:pointer}',
      '.wbh-skill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.wbh-skill input{margin:3px 0 0;accent-color:var(--dsw-alias-label-primary);flex:none}',
      '.wbh-skill__name{font-weight:500}',
      '.wbh-skill__desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px}',
      '.wbh-conn{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:11px;',
      'border:1px solid transparent}',
      '.wbh-conn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
      'border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.07))}',
      '.wbh-conn__icon{width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;',
      'justify-content:center;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18))}',
      '.wbh-conn__icon svg{width:16px;height:16px;display:block}',
      '.wbh-conn__text{flex:1;min-width:0}',
      '.wbh-conn__name{display:flex;align-items:center;gap:6px;font-weight:600;min-width:0}',
      '.wbh-conn__name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbh-conn__desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.wbh-toggle{position:relative;display:inline-flex;width:36px;height:20px;flex:none;cursor:pointer}',
      '.wbh-toggle input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:inherit}',
      '.wbh-toggle i{position:absolute;inset:0;border-radius:999px;pointer-events:none;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.25));',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));transition:background-color .15s ease}',
      '.wbh-toggle i::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;',
      'border-radius:999px;background:var(--dsw-alias-label-secondary);transition:left .15s ease,background-color .15s ease}',
      '.wbh-toggle input:checked + i{background:var(--dsw-alias-label-primary);border-color:transparent}',
      '.wbh-toggle input:checked + i::after{left:18px;background:var(--dsw-alias-bg-layer-2,#fff)}',
      '.wbh-toggle input:focus-visible + i{outline:2px solid color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);outline-offset:1px}',
      '.wbh-link{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:7px;cursor:pointer;',
      'font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:transparent;flex:none}',
      '.wbh-link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.wbh-empty{padding:28px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.wbh-empty--tight{padding:10px 4px;text-align:left}',
      '.wbh-error{margin:0 0 10px;padding:8px 10px;border-radius:9px;font-size:12px;',
      'color:var(--dsw-alias-state-error-primary,#e5484d);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 10%,transparent)}',
      '.wbh-foot{display:flex;align-items:center;gap:10px;padding:11px 18px;',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}',
      '.wbh-foot__status{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbh-foot__actions{display:flex;gap:8px;flex:none}',
      '@media (max-width:640px){.wbh-scrim{padding:10px}.wbh-panel{height:calc(100vh - 20px);border-radius:12px}',
      '.wbh-expert__desc{display:none}}',
      '@media (prefers-reduced-motion:reduce){.wbh-scrim,.wbh-panel{animation:none}.wbh-pill{transition:none}}',
    ].join('')

    function installStyles() {
      try {
        if (typeof document === 'undefined') return
        var element = document.getElementById(STYLE_ID)
        if (element === null) {
          element = document.createElement('style')
          element.id = STYLE_ID
          document.head.appendChild(element)
        }
        element.textContent = CSS
      } catch (error) {
        // Styling is cosmetic; never break the composer over it.
      }
    }

    function apiUrl(path) {
      var relative = String(path).replace(/^\/+/, '')
      try {
        if (typeof document === 'undefined') return '/' + relative
        var resolved = new URL(relative, document.baseURI)
        return resolved.pathname + resolved.search
      } catch (error) {
        return '/' + relative
      }
    }

    async function requestJson(path, options) {
      var response = await fetch(apiUrl(path), options)
      var body = await response.json().catch(function () { return {} })
      if (!response.ok || body.ok === false) {
        var message = body && typeof body.error === 'string' ? body.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      return body
    }

    function getJson(path) {
      return requestJson(path, { cache: 'no-store', headers: { accept: 'application/json' } })
    }

    function postJson(path, payload) {
      return requestJson(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    function initial(value) {
      var text = typeof value === 'string' ? value.trim() : ''
      return text === '' ? '?' : text.slice(0, 1).toUpperCase()
    }

    function personIcon() {
      return h('svg', { className: 'wbh-pill__icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 8, r: 3.5 }),
        h('path', { d: 'M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5' }))
    }

    function closeIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    }

    function searchIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true', style: { opacity: 0.65, flex: 'none' } },
        h('circle', { cx: 11, cy: 11, r: 6.5 }),
        h('path', { d: 'M16 16l4 4' }))
    }

    function plugIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M9 3v5M15 3v5' }),
        h('path', { d: 'M6 8h12v3a6 6 0 0 1-12 0V8z' }),
        h('path', { d: 'M12 17v4' }))
    }

    function catalogIcon(name) {
      return h('div', { className: 'wbh-avatar' }, h('span', null, initial(name)))
    }

    function Avatar(props) {
      var bad = React.useState(false)
      var failed = bad[0]
      var setFailed = bad[1]
      return h('div', { className: 'wbh-avatar' },
        h('span', null, initial(props.name)),
        props.src && !failed
          ? h('img', { src: props.src, alt: '', loading: 'lazy', onError: function () { setFailed(true) } })
          : null)
    }

    function Badge(props) {
      return h('span', { className: 'wbh-badge', 'data-kind': props.kind }, props.children)
    }

    function Toggle(props) {
      return h('label', { className: 'wbh-toggle', 'aria-label': props.label },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          disabled: props.disabled === true,
          onChange: function (event) { props.onToggle(event.target.checked) },
        }),
        h('i', null))
    }

    /** One market row. */
    function ExpertRow(props) {
      var item = props.item
      var active = props.activeId === item.id
      return h('div', { className: 'wbh-expert', 'data-on': active ? '1' : '0' },
        h(Avatar, { name: item.displayName || item.plugin || item.id, src: item.avatar }),
        h('div', { className: 'wbh-expert__text' },
          h('div', { className: 'wbh-expert__name' },
            h('span', { title: item.displayName || item.plugin }, item.displayName || item.plugin || item.id),
            item.installed ? h(Badge, { kind: 'installed' }, '已安装') : null,
            item.source === 'local' ? h(Badge, { kind: 'local' }, '本地') : null,
            item.expertType === 'team' ? h(Badge, null, '专家团') : null),
          h('div', { className: 'wbh-expert__desc', title: item.profession || item.description },
            item.profession || item.description || '')),
        h('button', {
          type: 'button',
          className: 'wbh-use',
          disabled: props.busy === true || active,
          onClick: function () { props.onChoose(item.id) },
        }, active ? '使用中' : props.busy === true ? '处理中…' : '使用'))
    }

    function SkillRow(props) {
      var skill = props.skill
      return h('label', { className: 'wbh-skill' },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: function (event) { props.onToggle(skill.name, event.target.checked) },
        }),
        h('div', null,
          h('div', { className: 'wbh-skill__name' }, skill.name),
          skill.description ? h('div', { className: 'wbh-skill__desc' }, skill.description) : null))
    }

    function ConnectorRow(props) {
      var item = props.item
      return h('div', { className: 'wbh-conn' },
        h('div', { className: 'wbh-conn__icon' }, plugIcon()),
        h('div', { className: 'wbh-conn__text' },
          h('div', { className: 'wbh-conn__name' },
            h('span', { title: item.name }, item.name),
            item.version ? h(Badge, null, 'v' + item.version) : null,
            h(Badge, { kind: 'tools' }, item.toolCount + ' 个工具')),
          h('div', { className: 'wbh-conn__desc' },
            item.description || (item.sampleTool ? '示例工具：' + item.sampleTool.name : '未注册工具'))),
        h(Toggle, {
          checked: props.enabled,
          disabled: props.busy === true,
          label: '在本会话启用 ' + item.name,
          onToggle: function (checked) { props.onToggle(item.id, checked) },
        }))
    }

    function CatalogRow(props) {
      var item = props.item
      return h('div', { className: 'wbh-conn' },
        catalogIcon(item.name),
        h('div', { className: 'wbh-conn__text' },
          h('div', { className: 'wbh-conn__name' },
            h('span', { title: item.name }, item.name),
            item.connected ? h(Badge, { kind: 'connected' }, '已连接') : null,
            item.category ? h(Badge, null, item.category) : null,
            item.tools ? h(Badge, { kind: 'tools' }, item.tools + ' 工具') : null),
          h('div', { className: 'wbh-conn__desc', title: item.summary }, item.summary || item.vendor || '')),
        item.homepage
          ? h('a', { className: 'wbh-link', href: item.homepage, target: '_blank', rel: 'noopener noreferrer' }, '了解')
          : h('span', { className: 'wbh-badge' }, item.vendor || ''))
    }

    function PickerDialog(props) {
      var sessionId = props.sessionId
      var pair = React.useState('expert')
      var tab = pair[0]
      var setTab = pair[1]

      var statePair = React.useState(null)
      var state = statePair[0]
      var setState = statePair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]

      var loadPair = React.useState(true)
      var loading = loadPair[0]
      var setLoading = loadPair[1]

      var queryPair = React.useState('')
      var query = queryPair[0]
      var setQuery = queryPair[1]
      var debouncedPair = React.useState('')
      var debounced = debouncedPair[0]
      var setDebounced = debouncedPair[1]
      var categoryPair = React.useState(null)
      var category = categoryPair[0]
      var setCategory = categoryPair[1]
      var pagePair = React.useState(1)
      var page = pagePair[0]
      var setPage = pagePair[1]

      var itemsPair = React.useState([])
      var items = itemsPair[0]
      var setItems = itemsPair[1]
      var morePair = React.useState(false)
      var hasMore = morePair[0]
      var setHasMore = morePair[1]
      var listErrorPair = React.useState(null)
      var listError = listErrorPair[0]
      var setListError = listErrorPair[1]
      var listLoadingPair = React.useState(false)
      var listLoading = listLoadingPair[0]
      var setListLoading = listLoadingPair[1]

      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var draftPair = React.useState({ globalMode: 'all', globalNames: [], expertNames: [] })
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var dirtyPair = React.useState(false)
      var dirty = dirtyPair[0]
      var setDirty = dirtyPair[1]

      var skillQueryPair = React.useState('')
      var skillQuery = skillQueryPair[0]
      var setSkillQuery = skillQueryPair[1]
      var skillDebouncedPair = React.useState('')
      var skillDebounced = skillDebouncedPair[0]
      var setSkillDebounced = skillDebouncedPair[1]
      var smItemsPair = React.useState([])
      var smItems = smItemsPair[0]
      var setSmItems = smItemsPair[1]
      var smMorePair = React.useState(false)
      var smHasMore = smMorePair[0]
      var setSmHasMore = smMorePair[1]
      var smPagePair = React.useState(1)
      var smPage = smPagePair[0]
      var setSmPage = smPagePair[1]
      var smLoadingPair = React.useState(false)
      var smLoading = smLoadingPair[0]
      var setSmLoading = smLoadingPair[1]
      var smErrorPair = React.useState(null)
      var smError = smErrorPair[0]
      var setSmError = smErrorPair[1]
      var smAuthPair = React.useState(false)
      var smAuthRequired = smAuthPair[0]
      var setSmAuthRequired = smAuthPair[1]
      var smTotalPair = React.useState(0)
      var smTotal = smTotalPair[0]
      var setSmTotal = smTotalPair[1]

      var connPluginsPair = React.useState([])
      var connPlugins = connPluginsPair[0]
      var setConnPlugins = connPluginsPair[1]
      var connDisabledPair = React.useState(new Set())
      var connDisabled = connDisabledPair[0]
      var setConnDisabled = connDisabledPair[1]
      var connLoadingPair = React.useState(false)
      var connLoading = connLoadingPair[0]
      var setConnLoading = connLoadingPair[1]
      var connErrorPair = React.useState(null)
      var connError = connErrorPair[0]
      var setConnError = connErrorPair[1]

      var catQueryPair = React.useState('')
      var catQuery = catQueryPair[0]
      var setCatQuery = catQueryPair[1]
      var catDebouncedPair = React.useState('')
      var catDebounced = catDebouncedPair[0]
      var setCatDebounced = catDebouncedPair[1]
      var catCategoryPair = React.useState(null)
      var catCategory = catCategoryPair[0]
      var setCatCategory = catCategoryPair[1]
      var catPagePair = React.useState(1)
      var catPage = catPagePair[0]
      var setCatPage = catPagePair[1]
      var catItemsPair = React.useState([])
      var catItems = catItemsPair[0]
      var setCatItems = catItemsPair[1]
      var catMorePair = React.useState(false)
      var catHasMore = catMorePair[0]
      var setCatHasMore = catMorePair[1]
      var catLoadingPair = React.useState(false)
      var catLoading = catLoadingPair[0]
      var setCatLoading = catLoadingPair[1]
      var catErrorPair = React.useState(null)
      var catError = catErrorPair[0]
      var setCatError = catErrorPair[1]
      var catCategoriesPair = React.useState([])
      var catCategories = catCategoriesPair[0]
      var setCatCategories = catCategoriesPair[1]
      var catSourcePair = React.useState(null)
      var catSource = catSourcePair[0]
      var setCatSource = catSourcePair[1]

      var applyState = React.useCallback(function (next) {
        setState(next)
        setDraft({
          globalMode: next.skills && next.skills.globalMode === 'selected' ? 'selected' : 'all',
          globalNames: next.skills && Array.isArray(next.skills.globalNames) ? next.skills.globalNames.slice() : [],
          expertNames: next.skills && Array.isArray(next.skills.expertNames) ? next.skills.expertNames.slice() : [],
        })
        setDirty(false)
        var connectors = next && next.connectors ? next.connectors : null
        setConnDisabled(new Set(Array.isArray(connectors && connectors.disabled) ? connectors.disabled : []))
      }, [])

      var loadState = React.useCallback(async function () {
        if (sessionId === undefined || sessionId === null) return
        setLoading(true)
        setError(null)
        try {
          var body = await getJson(ROUTES.state + '?sessionId=' + encodeURIComponent(sessionId))
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [sessionId, applyState])

      React.useEffect(function () {
        if (props.open) void loadState()
      }, [props.open, loadState])

      var loadConnectors = React.useCallback(async function () {
        if (sessionId === undefined || sessionId === null) return
        setConnLoading(true)
        setConnError(null)
        try {
          var body = await getJson(ROUTES.connectors + '?view=plugins&sessionId=' + encodeURIComponent(sessionId))
          setConnPlugins(body.items)
          setConnDisabled(new Set(Array.isArray(body.disabled) ? body.disabled : []))
        } catch (failure) {
          setConnError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setConnLoading(false)
        }
      }, [sessionId])

      React.useEffect(function () {
        if (props.open && tab === 'connectors') void loadConnectors()
      }, [props.open, tab, loadConnectors])

      React.useEffect(function () {
        var timer = setTimeout(function () { setDebounced(query.trim()) }, 220)
        return function () { clearTimeout(timer) }
      }, [query])

      React.useEffect(function () {
        if (!props.open) return undefined
        var cancelled = false
        setListLoading(true)
        setListError(null)
        var params = new URLSearchParams({ page: String(page), pageSize: '24' })
        if (debounced !== '') params.set('query', debounced)
        if (category !== null) params.set('categoryId', category)
        getJson(ROUTES.experts + '?' + params.toString())
          .then(function (body) {
            if (cancelled) return
            setItems(function (previous) { return page === 1 ? body.items : previous.concat(body.items) })
            setHasMore(body.hasMore === true)
          })
          .catch(function (failure) {
            if (!cancelled) setListError(failure instanceof Error ? failure.message : String(failure))
          })
          .finally(function () {
            if (!cancelled) setListLoading(false)
          })
        return function () { cancelled = true }
      }, [props.open, debounced, category, page])

      React.useEffect(function () {
        setPage(1)
      }, [debounced, category])

      React.useEffect(function () {
        var timer = setTimeout(function () { setCatDebounced(catQuery.trim()) }, 220)
        return function () { clearTimeout(timer) }
      }, [catQuery])

      React.useEffect(function () {
        var timer = setTimeout(function () { setSkillDebounced(skillQuery.trim()) }, 220)
        return function () { clearTimeout(timer) }
      }, [skillQuery])

      React.useEffect(function () {
        setSmPage(1)
      }, [skillDebounced])

      React.useEffect(function () {
        if (!props.open || tab !== 'skills' || skillDebounced === '') return undefined
        var cancelled = false
        setSmLoading(true)
        setSmError(null)
        var params = new URLSearchParams({ query: skillDebounced, page: String(smPage), pageSize: '12' })
        getJson(ROUTES.skillMarket + '?' + params.toString())
          .then(function (body) {
            if (cancelled) return
            setSmAuthRequired(body.authRequired === true)
            setSmTotal(Number(body.total ?? 0))
            setSmHasMore(body.hasMore === true)
            setSmItems(function (previous) { return smPage === 1 ? body.items : previous.concat(body.items) })
          })
          .catch(function (failure) {
            if (!cancelled) setSmError(failure instanceof Error ? failure.message : String(failure))
          })
          .finally(function () {
            if (!cancelled) setSmLoading(false)
          })
        return function () { cancelled = true }
      }, [props.open, tab, skillDebounced, smPage])

      React.useEffect(function () {
        setCatPage(1)
      }, [catDebounced, catCategory])

      React.useEffect(function () {
        if (!props.open || tab !== 'connectors') return undefined
        var cancelled = false
        setCatLoading(true)
        setCatError(null)
        var params = new URLSearchParams({ view: 'catalog', page: String(catPage), pageSize: '24' })
        if (catDebounced !== '') params.set('query', catDebounced)
        if (catCategory !== null) params.set('category', catCategory)
        getJson(ROUTES.connectors + '?' + params.toString())
          .then(function (body) {
            if (cancelled) return
            setCatSource(body.source === 'workbuddy' ? 'workbuddy' : 'local')
            setCatItems(function (previous) { return catPage === 1 ? body.items : previous.concat(body.items) })
            setCatHasMore(body.hasMore === true)
            if (Array.isArray(body.categories) && catCategories.length === 0) setCatCategories(body.categories)
          })
          .catch(function (failure) {
            if (!cancelled) setCatError(failure instanceof Error ? failure.message : String(failure))
          })
          .finally(function () {
            if (!cancelled) setCatLoading(false)
          })
        return function () { cancelled = true }
      }, [props.open, tab, catDebounced, catCategory, catPage])

      React.useEffect(function () {
        if (!props.open) return undefined
        var onKey = function (event) {
          if (event.key === 'Escape') props.onClose()
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [props.open, props.onClose])

      if (!props.open) return null

      var choose = async function (expertId) {
        if (busy !== null) return
        setBusy(expertId)
        setError(null)
        try {
          var body = await postJson(ROUTES.select, { sessionId: sessionId, expertId: expertId })
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var remove = async function () {
        if (busy !== null) return
        setBusy('__off__')
        setError(null)
        try {
          var body = await postJson(ROUTES.off, { sessionId: sessionId })
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var toggleGlobal = function (name, checked) {
        var allNames = (state && state.globalSkills ? state.globalSkills : []).map(function (skill) { return skill.name })
        var selected = draft.globalMode === 'all' ? allNames.slice() : draft.globalNames.slice()
        var set = new Set(selected)
        if (checked) set.add(name)
        else set.delete(name)
        setDraft({ globalMode: 'selected', globalNames: Array.from(set), expertNames: draft.expertNames })
        setDirty(true)
      }

      var toggleExpert = function (name, checked) {
        var set = new Set(draft.expertNames)
        if (checked) set.add(name)
        else set.delete(name)
        setDraft({ globalMode: draft.globalMode, globalNames: draft.globalNames, expertNames: Array.from(set) })
        setDirty(true)
      }

      var setAllGlobal = function (checked) {
        setDraft({
          globalMode: checked ? 'all' : 'selected',
          globalNames: [],
          expertNames: draft.expertNames,
        })
        setDirty(true)
      }

      var saveSkills = async function () {
        if (busy !== null) return
        setBusy('__skills__')
        setError(null)
        try {
          var body = await postJson(ROUTES.skills, {
            sessionId: sessionId,
            globalMode: draft.globalMode,
            globalNames: draft.globalNames,
            expertNames: draft.expertNames,
          })
          applyState(body.state)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(null)
        }
      }

      var toggleConnector = async function (id, enabled) {
        var next = new Set(connDisabled)
        if (enabled) next.delete(id)
        else next.add(id)
        setConnDisabled(next)
        setConnError(null)
        try {
          var body = await postJson(ROUTES.connectorsSession, { sessionId: sessionId, disabled: Array.from(next) })
          applyState(body.state)
        } catch (failure) {
          setConnError(failure instanceof Error ? failure.message : String(failure))
          setConnDisabled(function (previous) {
            var rollback = new Set(previous)
            if (enabled) rollback.add(id)
            else rollback.delete(id)
            return rollback
          })
        }
      }

      var active = state && state.expert ? state.expert : null
      var globalSkills = state && Array.isArray(state.globalSkills) ? state.globalSkills : []
      var expertSkills = state && Array.isArray(state.expertSkills) ? state.expertSkills : []
      var categories = state && Array.isArray(state.categories) ? state.categories : []
      var enabledGlobal = function (name) {
        return draft.globalMode === 'all' || draft.globalNames.indexOf(name) >= 0
      }
      var enabledExpert = function (name) {
        return draft.expertNames.indexOf(name) >= 0
      }

      var skillNeedle = skillQuery.trim().toLowerCase()
      var skillMatches = function (skill) {
        if (skillNeedle === '') return true
        return [skill.name, skill.description].filter(Boolean).join(' ').toLowerCase().indexOf(skillNeedle) >= 0
      }
      var expertSkillsShown = expertSkills.filter(skillMatches)
      var globalSkillsShown = globalSkills.filter(skillMatches)

      var head = h('div', { className: 'wbh-head' },
        h('div', { className: 'wbh-head__text' },
          h('h2', { className: 'wbh-title' }, '会话辅助'),
          h('p', { className: 'wbh-sub' },
            '仅作用于当前会话',
            state && state.market && state.market.marketTotal
              ? ' · 市场 ' + Number(state.market.marketTotal).toLocaleString() + ' 位专家'
              : '',
            state && state.market && state.market.source === 'cos' ? ' · 公开快照' : '',
            state && state.connectors && state.connectors.catalogSource === 'workbuddy'
              ? ' · 连接器市场 WorkBuddy'
              : state && state.connectors && state.connectors.catalogCount
                ? ' · 连接器目录 ' + Number(state.connectors.catalogCount).toLocaleString() + ' 个'
                : '')),
        h('button', { type: 'button', className: 'wbh-iconbtn', onClick: props.onClose, 'aria-label': '关闭' }, closeIcon()))

      var connNeedle = catQuery.trim().toLowerCase()
      var connPluginsShown = connNeedle === ''
        ? connPlugins
        : connPlugins.filter(function (item) {
          return [item.id, item.name, item.packageName, item.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .indexOf(connNeedle) >= 0
        })
      var connectorCount = connPluginsShown.length
      var tabs = h('div', { className: 'wbh-tabs', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', className: 'wbh-tab', 'data-on': tab === 'expert' ? '1' : '0', onClick: function () { setTab('expert') } },
          '专家',
          active ? h('span', { className: 'wbh-tab__count' }, '1') : null),
        h('button', { type: 'button', role: 'tab', className: 'wbh-tab', 'data-on': tab === 'skills' ? '1' : '0', onClick: function () { setTab('skills') } },
          '技能',
          h('span', { className: 'wbh-tab__count' }, String(draft.expertNames.length + (draft.globalMode === 'all' ? globalSkills.length : draft.globalNames.length)))),
        h('button', { type: 'button', role: 'tab', className: 'wbh-tab', 'data-on': tab === 'connectors' ? '1' : '0', onClick: function () { setTab('connectors') } },
          '连接器',
          connectorCount > 0 ? h('span', { className: 'wbh-tab__count' }, String(connectorCount)) : null))

      var expertBody = h('div', null,
        active === null ? null : h('div', { className: 'wbh-active' },
          h(Avatar, { name: active.displayName || active.id, src: null }),
          h('div', { className: 'wbh-active__text' },
            h('div', { className: 'wbh-active__name' }, active.displayName || active.id),
            h('div', { className: 'wbh-active__meta' }, active.profession || active.plugin || '')),
          h('button', {
            type: 'button',
            className: 'wbh-btn wbh-btn--quiet',
            disabled: busy !== null,
            onClick: function () { void remove() },
          }, busy === '__off__' ? '移除中…' : '移除')),
        h('div', { className: 'wbh-toolbar' },
          h('label', { className: 'wbh-search' },
            searchIcon(),
            h('input', {
              value: query,
              placeholder: '搜索专家、职业或关键词',
              onChange: function (event) { setQuery(event.target.value) },
              'aria-label': '搜索专家',
            }))),
        categories.length === 0 ? null : h('div', { className: 'wbh-chips', role: 'tablist' },
          h('button', { type: 'button', className: 'wbh-chip', 'data-on': category === null ? '1' : '0', onClick: function () { setCategory(null) } }, '全部'),
          categories.map(function (entry) {
            return h('button', {
              key: entry.id,
              type: 'button',
              className: 'wbh-chip',
              'data-on': category === entry.id ? '1' : '0',
              onClick: function () { setCategory(category === entry.id ? null : entry.id) },
            }, entry.name || entry.id)
          })),
        listError === null ? null : h('p', { className: 'wbh-error' }, listError),
        items.length === 0 && listLoading
          ? h('div', { className: 'wbh-empty' }, '正在加载专家…')
          : items.length === 0
            ? h('div', { className: 'wbh-empty' }, '没有匹配的专家')
            : h('div', { className: 'wbh-list' },
              items.map(function (item) {
                return h(ExpertRow, {
                  key: item.id,
                  item: item,
                  activeId: active ? active.id : null,
                  busy: busy === item.id,
                  onChoose: choose,
                })
              })),
        hasMore
          ? h('div', { className: 'wbh-more' },
            h('button', { type: 'button', className: 'wbh-btn', disabled: listLoading, onClick: function () { setPage(page + 1) } },
              listLoading ? '加载中…' : '加载更多'))
          : null)

      var skillsBody = h('div', null,
        h('div', { className: 'wbh-toolbar' },
          h('label', { className: 'wbh-search' },
            searchIcon(),
            h('input', {
              value: skillQuery,
              placeholder: '搜索技能：先本机，后技能市场',
              onChange: function (event) { setSkillQuery(event.target.value) },
              'aria-label': '搜索技能',
            }))),
        skillNeedle === '' && active !== null
          ? h('div', { className: 'wbh-section' },
            h('div', { className: 'wbh-section__head' },
              h('h3', { className: 'wbh-section__title' }, '专家自带技能'),
              h('span', { className: 'wbh-sub' }, active.displayName || active.id)),
            expertSkills.length === 0
              ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '该专家没有声明技能。')
              : expertSkills.map(function (skill) {
                return h(SkillRow, {
                  key: skill.name,
                  skill: skill,
                  checked: enabledExpert(skill.name),
                  onToggle: toggleExpert,
                })
              }))
          : null,
        h('div', { className: 'wbh-section' },
          h('div', { className: 'wbh-section__head' },
            h('h3', { className: 'wbh-section__title' }, '本机技能'),
            h('button', {
              type: 'button',
              className: 'wbh-btn wbh-btn--quiet',
              onClick: function () { setAllGlobal(draft.globalMode !== 'all') },
            }, draft.globalMode === 'all' ? '全部停用' : '全部启用')),
          globalSkillsShown.length === 0
            ? h('div', { className: 'wbh-empty wbh-empty--tight' },
              skillNeedle !== '' ? '本机技能中没有匹配项。' : '当前没有可用的本机技能。')
            : globalSkillsShown.map(function (skill) {
              return h(SkillRow, {
                key: skill.name,
                skill: skill,
                checked: enabledGlobal(skill.name),
                onToggle: toggleGlobal,
              })
            })),
        skillNeedle === ''
          ? null
          : h('div', { className: 'wbh-section' },
            h('div', { className: 'wbh-section__head' },
              h('h3', { className: 'wbh-section__title' }, '技能市场'),
              h('span', { className: 'wbh-sub' },
                smAuthRequired ? '需登录 WorkBuddy 连接器' : ('共 ' + Number(smTotal).toLocaleString() + ' 条'))),
            smError === null ? null : h('p', { className: 'wbh-error' }, smError),
            smAuthRequired
              ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '未检测到 WorkBuddy 登录态：请先在连接器中登录，再搜索技能市场。')
              : smLoading && smItems.length === 0
                ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '正在搜索技能市场…')
                : smItems.length === 0
                  ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '技能市场中没有匹配项。')
                  : h('div', { className: 'wbh-list' },
                    smItems.map(function (item) {
                      return h(CatalogRow, {
                        key: item.id,
                        item: {
                          id: item.id,
                          name: item.name,
                          vendor: item.version ? 'v' + item.version : null,
                          category: '市场',
                          summary: item.description,
                          homepage: null,
                          connected: false,
                          tools: 0,
                        },
                      })
                    })),
            smHasMore
              ? h('div', { className: 'wbh-more' },
                h('button', { type: 'button', className: 'wbh-btn', disabled: smLoading, onClick: function () { setSmPage(smPage + 1) } },
                  smLoading ? '加载中…' : '加载更多'))
              : null))

      var connectorsBody = h('div', null,
        h('div', { className: 'wbh-toolbar' },
          h('label', { className: 'wbh-search' },
            searchIcon(),
            h('input', {
              value: catQuery,
              placeholder: '搜索连接器目录（名称、厂商、标签）',
              onChange: function (event) { setCatQuery(event.target.value) },
              'aria-label': '搜索连接器',
            }))),
        connError === null ? null : h('p', { className: 'wbh-error' }, connError),
        h('div', { className: 'wbh-section' },
          h('div', { className: 'wbh-section__head' },
            h('h3', { className: 'wbh-section__title' }, '本机连接器'),
            h('span', { className: 'wbh-sub' }, '开关只影响当前会话的工具')),
          connLoading && connPluginsShown.length === 0
            ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '正在扫描本机连接器…')
            : connPluginsShown.length === 0
              ? h('div', { className: 'wbh-empty wbh-empty--tight' }, connNeedle !== '' ? '本机连接器中没有匹配项。' : '本机没有安装连接器插件。')
              : h('div', { className: 'wbh-list' },
                connPluginsShown.map(function (item) {
                  return h(ConnectorRow, {
                    key: item.id,
                    item: item,
                    enabled: !connDisabled.has(item.id),
                    busy: false,
                    onToggle: function (id, enabled) { void toggleConnector(id, enabled) },
                  })
                }))),
        catError === null ? null : h('p', { className: 'wbh-error' }, catError),
        h('div', { className: 'wbh-section' },
          h('div', { className: 'wbh-section__head' },
            h('h3', { className: 'wbh-section__title' }, '连接器市场'),
            h('span', { className: 'wbh-sub' }, catSource === 'workbuddy'
              ? 'WorkBuddy 连接器市场 · 第 ' + catPage + ' 页'
              : catSource === 'local' ? '本地快照（未登录 WorkBuddy）' : '')),
          catCategories.length === 0 ? null : h('div', { className: 'wbh-chips' },
            h('button', { type: 'button', className: 'wbh-chip', 'data-on': catCategory === null ? '1' : '0', onClick: function () { setCatCategory(null) } }, '全部'),
            catCategories.map(function (entry) {
              return h('button', {
                key: entry,
                type: 'button',
                className: 'wbh-chip',
                'data-on': catCategory === entry ? '1' : '0',
                onClick: function () { setCatCategory(catCategory === entry ? null : entry) },
              }, entry)
            })),
          catItems.length === 0 && catLoading
            ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '正在加载连接器目录…')
            : catItems.length === 0
              ? h('div', { className: 'wbh-empty wbh-empty--tight' }, '目录中没有匹配的连接器。')
              : h('div', { className: 'wbh-list' },
                catItems.map(function (item) {
                  return h(CatalogRow, { key: item.id, item: item })
                })),
          catHasMore
            ? h('div', { className: 'wbh-more' },
              h('button', { type: 'button', className: 'wbh-btn', disabled: catLoading, onClick: function () { setCatPage(catPage + 1) } },
                catLoading ? '加载中…' : '加载更多'))
            : null))

      var footStatus = error !== null
        ? error
        : tab === 'expert'
          ? (active ? '当前：' + (active.displayName || active.id) + (state && state.applied ? ' · 已生效' : ' · 下一条消息生效') : '未选择专家')
          : tab === 'skills'
            ? (dirty ? '技能有未保存修改' : '技能设置已生效')
            : ('本机连接器 ' + connectorCount + ' 个' + (connDisabled.size > 0 ? ' · 本会话停用 ' + connDisabled.size + ' 个' : ''))
      var foot = h('div', { className: 'wbh-foot' },
        h('div', { className: 'wbh-foot__status' },
          error !== null && tab !== 'expert'
            ? h('span', { className: 'wbh-error', style: { margin: 0 } }, error)
            : footStatus),
        h('div', { className: 'wbh-foot__actions' },
          tab === 'skills'
            ? h('button', {
              type: 'button',
              className: 'wbh-btn wbh-btn--primary',
              disabled: !dirty || busy !== null,
              onClick: function () { void saveSkills() },
            }, busy === '__skills__' ? '保存中…' : '保存技能')
            : h('button', { type: 'button', className: 'wbh-btn wbh-btn--quiet', onClick: props.onClose }, '关闭')))

      var body = loading && state === null
        ? h('div', { className: 'wbh-body' }, h('div', { className: 'wbh-empty' }, '正在读取会话状态…'))
        : h('div', { className: 'wbh-body' }, error !== null && state === null ? h('p', { className: 'wbh-error' }, error) : null,
          tab === 'expert' ? expertBody : tab === 'skills' ? skillsBody : connectorsBody)

      var panel = h('div', {
        className: 'wbh-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '会话辅助',
        onMouseDown: function (event) { event.stopPropagation() },
      }, head, tabs, body, foot)

      var scrim = h('div', {
        className: 'wbh-scrim',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose()
        },
      }, panel)

      if (createPortal === null) return scrim
      try {
        if (typeof document === 'undefined' || document === null || !document.body) return scrim
        return createPortal(scrim, document.body)
      } catch (error) {
        return scrim
      }
    }

    function ComposerEntry(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var summaryPair = React.useState(null)
      var summary = summaryPair[0]
      var setSummary = summaryPair[1]
      var sessionId = props.sessionId

      React.useEffect(function () {
        if (sessionId === undefined || sessionId === null) return undefined
        var cancelled = false
        getJson(ROUTES.state + '?sessionId=' + encodeURIComponent(sessionId))
          .then(function (body) { if (!cancelled) setSummary(body.state) })
          .catch(function () { if (!cancelled) setSummary(null) })
        return function () { cancelled = true }
      }, [sessionId, open])

      var expert = summary && summary.expert ? summary.expert : null
      var label = expert ? expert.displayName || expert.id : '专家'

      return h('div', { className: 'wbh-host' },
        h('button', {
          type: 'button',
          className: 'wbh-pill',
          'data-active': expert ? '1' : '0',
          title: expert ? '会话辅助 · 当前专家：' + label : '会话辅助：管理本会话的专家、技能与连接器',
          onClick: function () { setOpen(true) },
        }, personIcon(), h('span', null, '会话辅助'), expert ? h('span', { className: 'wbh-pill__name' }, label) : null),
        h(PickerDialog, {
          open: open,
          sessionId: sessionId,
          onClose: function () { setOpen(false) },
        }))
    }

    function apply(ctx) {
      installStyles()
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register({
            name: SLOT_NAME,
            id: ENTRY_ID,
            order: ENTRY_ORDER,
            label: function () { return '会话辅助' },
          }, function SlotComponent(props) {
            return h(ComposerEntry, props)
          })
        })
      } catch (error) {
        try {
          console.error('[' + PACKAGE_ID + '] composer pill registration failed:', error)
        } catch (ignored) {
          // Never break the composer over a missing slot.
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = { ROUTES, CSS, PickerDialog, ComposerEntry }
    return module.exports
  },
})
