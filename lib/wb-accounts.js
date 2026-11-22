/**
 * 账号服务：把「扫码登录 → 存进本插件自己的库 → 刷新/删除/迁移」拼成一组动作。
 *
 * 存在的理由是把状态机放在一处：
 *   - `wb-login.js` 只管三个上游端点与会话表；
 *   - `wb-vault.js` 只管落盘、锁、脱敏视图；
 *   - 这里负责"轮询成功后必须立刻落盘"、"region 必须与申请时一致"、"刷新只对自有
 *     账号生效"这类跨模块规则。写进 index.js 会让它继续膨胀，写在 webui 里则工具
 *     调用拿不到同一份逻辑。
 *
 * 本模块没有 DSH import，可离线单测（fetch 可注入）。
 */
import { createLoginStore } from './wb-login.js'
import { importFromVault } from './wb-vault.js'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{
 *   connector: { saveAccount: Function, ownAccounts: Function, accounts: Function,
 *                status: Function, store: object, refreshAccount?: Function },
 *   loginStore?: object,
 *   fetchImpl?: Function,
 *   now?: Function,
 *   vaultDir?: string,
 * }} options
 */
export function createAccountService(options) {
  const connector = options.connector
  if (connector === undefined) throw new Error('createAccountService requires a connector')
  const now = options.now ?? (() => Date.now())
  const login = options.loginStore ?? createLoginStore({})
  // 登录这一步用调用方的 fetch（测试可注入），刷新走 connector 自己的那份。
  const fetchImpl = options.fetchImpl

  return {
    /** 申请一次登录；返回给人打开的 URL 和一个 loginId。 */
    async start(region) {
      const wanted = region === 'global' ? 'global' : 'cn'
      return login.start(wanted, { fetchImpl, now: now() })
    },

    /**
     * 轮询一次。成功后**立刻落盘**——把落盘放在这里而不是让调用方自己存，
     * 是为了避免"面板拿到 account 却忘了存"这种只在生产出现的漏。
     */
    async poll(loginId, options_ = {}) {
      const outcome = await login.poll(loginId, {
        fetchImpl,
        now: now(),
        ...options_.region === undefined ? {} : { region: options_.region },
      })
      if (outcome.done !== true || outcome.account === undefined) return outcome
      try {
        const saved = await connector.saveAccount(outcome.account)
        return { done: true, account: saved }
      } catch (error) {
        return { done: true, error: `signed in, but the account could not be stored: ${messageOf(error)}` }
      }
    },

    cancel(loginId) {
      return login.cancel(loginId)
    },

    /** 未完成的登录（面板显示"等待扫码"用），不含 state。 */
    pending() {
      return login.list(now())
    },

    /** 账号总览：自有库 + 兼容层。 */
    async list() {
      const [own, merged, status] = await Promise.all([
        connector.ownAccounts(),
        connector.accounts(),
        connector.status(),
      ])
      return {
        own,
        all: merged,
        summary: {
          count: merged.length,
          usableCount: merged.filter(item => item.hasToken && (!item.expired || item.refreshExpiresAt === 0 || item.refreshExpiresAt > now())).length,
          ownCount: own.length,
          vaultCount: merged.length - own.length,
          // 面板要告诉用户"账号存在哪里"，所以这里给真实路径。
          // status.own.dir 是脱敏的（那是给模型看的一行摘要），别拿它当路径用。
          dir: typeof connector.store?.root === 'string' ? connector.store.root : null,
          source: status.source,
        },
        pending: login.list(now()),
      }
    },

    /**
     * 强制刷新一条自有账号。
     *
     * 只允许自有账号：兼容层的文件归 `dsh-connect-workbuddy` 写，我们改它会让那个
     * 插件的 `refreshedAtMs` 与现实不符。要给那条刷新，就在那边点刷新。
     */
    async refresh(accountId) {
      const id = String(accountId ?? '').trim()
      if (id === '') throw new Error('accountId is required to refresh an account')
      const raw = await connector.store.raw(id)
      if (raw === undefined) throw new Error(`account not found in this plugin's own store: ${id}`)
      return connector.refreshAccount(id)
    },

    async remove(accountId) {
      const id = String(accountId ?? '').trim()
      if (id === '') throw new Error('accountId is required to remove an account')
      const removed = await connector.store.remove(id)
      return { removed, accountId: id }
    },

    /**
     * 把 `dsh-connect-workbuddy` 的 vault 一次性搬进来。
     *
     * 单向：读那边、写我们这边。不删也不改对方目录，所以随时可以反悔。
     */
    async importLegacy(importOptions = {}) {
      const vaultDir = importOptions.vaultDir ?? options.vaultDir
      if (typeof vaultDir !== 'string' || vaultDir === '') {
        throw new Error('no dsh-connect-workbuddy vault directory is configured')
      }
      const outcome = await importFromVault({
        vaultDir,
        store: connector.store,
        ...importOptions.regions === undefined ? {} : { regions: importOptions.regions },
      })
      return {
        imported: outcome.imported.length,
        skipped: outcome.skipped,
        errors: outcome.errors,
        accounts: outcome.imported,
      }
    },
  }
}
