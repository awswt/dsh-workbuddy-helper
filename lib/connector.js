import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isExpired, mask, resolveDshHome } from './util.js'

const REGION_ORDER = ['cn', 'global']

/**
 * Read-only view of the WorkBuddy connector's account vault.
 *
 * `dsh-connect-workbuddy` stores one JSON file per account under
 * `$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`. This adapter never
 * writes that directory, never refreshes tokens, and never returns a token
 * from `status()`. `resolveToken()` is the only method that reads the secret,
 * and its result is intended to be used immediately as a request header.
 */
export class WorkBuddyConnector {
  constructor(options = {}) {
    this.dshHome = options.dshHome ?? resolveDshHome()
    this.vaultDir = options.vaultDir ?? path.join(this.dshHome, 'workbuddy-vault')
    this.explicitVault = options.vaultDir !== undefined
  }

  async detectInstalled() {
    const profilesDir = path.join(this.dshHome, 'profiles')
    let entries = []
    try {
      entries = await fs.readdir(profilesDir, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(profilesDir, entry.name, 'node_modules', 'dsh-connect-workbuddy', 'package.json')
      try {
        const pkg = JSON.parse(await fs.readFile(candidate, 'utf8'))
        return { profile: entry.name, version: pkg.version, packageJson: candidate }
      } catch {
        continue
      }
    }
    return undefined
  }

  async listAccountFiles() {
    const files = []
    for (const region of REGION_ORDER) {
      const dir = path.join(this.vaultDir, region)
      let entries = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        files.push({ region, file: path.join(dir, entry.name) })
      }
    }
    if (files.length === 0) {
      let entries = []
      try {
        entries = await fs.readdir(this.vaultDir, { withFileTypes: true })
      } catch {
        return files
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        files.push({ region: 'legacy', file: path.join(this.vaultDir, entry.name) })
      }
    }
    return files
  }

  async listAccounts() {
    const files = await this.listAccountFiles()
    const accounts = []
    for (const { region, file } of files) {
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'))
        const auth = record.auth ?? {}
        const account = record.account ?? {}
        const rawExpires = Number(auth.expiresAt ?? 0)
        const expiresAt = Number.isFinite(rawExpires) && rawExpires > 0 && rawExpires < 1e12 ? rawExpires * 1000 : rawExpires
        accounts.push({
          region,
          accountId: String(record.accountId ?? path.basename(file, '.json')),
          nickname: String(account.nickname ?? ''),
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
          expired: isExpired(expiresAt),
          hasToken: typeof auth.accessToken === 'string' && auth.accessToken.length > 0,
          file,
        })
      } catch {
        continue
      }
    }
    const order = item => {
      const index = REGION_ORDER.indexOf(item.region)
      return index === -1 ? REGION_ORDER.length : index
    }
    accounts.sort((a, b) => order(a) - order(b) || b.expiresAt - a.expiresAt)
    return accounts
  }

  async resolveToken(options = {}) {
    const accounts = await this.listAccounts()
    const preferred = options.region
    const eligible = accounts.filter(item => {
      if (!item.hasToken || item.expired) return false
      return preferred === undefined || item.region === preferred
    })
    const chosen = eligible[0] ?? accounts.find(item => !preferred && item.hasToken && !item.expired)
    if (chosen === undefined) return undefined
    try {
      const record = JSON.parse(await fs.readFile(chosen.file, 'utf8'))
      const token = record.auth?.accessToken
      if (typeof token !== 'string' || token.length === 0) return undefined
      return {
        token,
        accountId: chosen.accountId,
        region: chosen.region,
        domain: typeof record.auth?.domain === 'string' ? record.auth.domain : undefined,
        expiresAt: chosen.expiresAt,
      }
    } catch {
      return undefined
    }
  }

  async status() {
    const installed = await this.detectInstalled()
    const accounts = await this.listAccounts()
    const usable = accounts.filter(item => item.hasToken && !item.expired)
    return {
      connector: 'dsh-connect-workbuddy',
      installed: installed !== undefined,
      profile: installed?.profile ?? null,
      version: installed?.version ?? null,
      vaultPresent: accounts.length > 0,
      vaultDir: mask(this.vaultDir, 12),
      accountCount: accounts.length,
      usableAccountCount: usable.length,
      tokenAvailable: usable.length > 0,
      regions: [...new Set(accounts.map(item => item.region))],
      accounts: accounts.map(item => ({
        accountId: mask(item.accountId, 4),
        nickname: mask(item.nickname, 2),
        region: item.region,
        expiresAt: item.expiresAt > 0 ? new Date(item.expiresAt).toISOString() : null,
        expired: item.expired,
        hasToken: item.hasToken,
      })),
    }
  }
}
