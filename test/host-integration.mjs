import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { apply } from '../lib/index.js'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oh-host-'))
const sections = []
const providers = []
const commands = []
const listeners = new Map()
let fiberDisposed = 0

function makeScopedContext() {
  return {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    skills: {
      registerProvider(create) {
        const control = { invalidate() {} }
        providers.push(create(control))
        return () => {
          providers.pop()
        }
      },
    },
  }
}

const globalSkills = [
  { name: 'xlsx', description: 'Spreadsheet work', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'filesystem' },
  { name: 'docx', description: 'Document work', invocation: { modelInvocable: true, userInvocable: true }, source: 'user-dsh', provider: 'filesystem' },
]

const agent = {
  id: 'sess-integration',
  session: { header: { cwd: process.cwd() } },
  ctx: {
    async plugin(plugin, config) {
      const scoped = makeScopedContext()
      plugin(scoped, config)
      return {
        async dispose() {
          fiberDisposed += 1
          sections.splice(0, sections.length)
          providers.splice(0, providers.length)
        },
      }
    },
  },
}

const ctx = {
  tools: {
    register(definition) {
      ctx.registeredTool = definition
    },
  },
  agents: {
    get(id) {
      return id === agent.id ? agent : undefined
    },
    list() {
      return [agent]
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  skills: {
    async list() {
      return globalSkills
    },
    async snapshot() {
      return { skills: globalSkills, complete: true }
    },
    async get(name) {
      return globalSkills.find(skill => skill.name === name)
    },
    registerProvider(create) {
      const control = { invalidate() {} }
      providers.push(create(control))
      return () => {}
    },
  },
  get(name) {
    if (name === 'commands') {
      return {
        register(definition) {
          commands.push(definition)
        },
      }
    }
    return undefined
  },
  on(event, listener) {
    listeners.set(event, listener)
  },
  effect(callback) {
    callback()
  },
  logger: {
    warn() {},
    info() {},
  },
}

apply(ctx, {
  dataDir,
  authMode: 'none',
  localRoots: [path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins')],
  marketBaseUrl: 'https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace',
})

assert.equal(typeof ctx.registeredTool?.execute, 'function', 'tool must be registered')
assert.equal(commands.length, 1, 'command must be registered')
assert.equal(commands[0].name, 'workbuddy-helper')

const connector = JSON.parse(await ctx.registeredTool.execute({ action: 'connector' }, { agent }))
assert.equal(connector.connector, 'dsh-connect-workbuddy')
assert.equal(typeof connector.accountCount, 'number')
assert.equal(JSON.stringify(connector).includes('accessToken'), false)

const selected = JSON.parse(await ctx.registeredTool.execute({ action: 'expert', expertId: 'ai-agent-engineer' }, { agent }))
assert.equal(selected.applied, true)
assert.equal(selected.expert.id, 'ai-agent-engineer')
assert.equal(typeof selected.expert.displayName, 'string')
assert.equal(selected.expert.displayName, '程枢')
assert.equal(sections.some(section => section.name.startsWith('workbuddy-helper:expert:')), true)
assert.equal(providers.some(provider => provider.name.startsWith('workbuddy-helper-expert-')), true)

const skills = JSON.parse(await ctx.registeredTool.execute({ action: 'skills' }, { agent }))
assert.equal(skills.global.length, 2)
assert.equal(skills.expert.some(skill => skill.name === 'agent-craft'), true)

const marketView = JSON.parse(await ctx.registeredTool.execute({ action: 'market', query: '逆向' }, { agent }))
assert.equal(marketView.publicTotal, 429)
assert.equal(marketView.items.some(item => item.id === 'rea-reverse-engineer' && item.source === 'local'), true)

const reverse = JSON.parse(await ctx.registeredTool.execute({ action: 'expert', expertId: 'rea-reverse-engineer' }, { agent }))
assert.equal(reverse.applied, true)
assert.equal(reverse.expert.id, 'rea-reverse-engineer')
assert.equal(reverse.expert.displayName, 'REA 逆向功能分析专家')
assert.equal(reverse.skills.expertNames.includes('rea-analysis'), true)

const cleared = JSON.parse(await ctx.registeredTool.execute({ action: 'off' }, { agent }))
assert.equal(cleared.applied, false)
assert.equal(cleared.expert, null)
assert.equal(fiberDisposed >= 1, true)
assert.equal(sections.length, 0)
assert.equal(providers.length, 0)

console.log(JSON.stringify({
  ok: true,
  tool: ctx.registeredTool.name,
  command: commands[0].name,
  connector: {
    installed: connector.installed,
    accounts: connector.accountCount,
    usable: connector.usableAccountCount,
  },
  selectedExpert: selected.expert.id,
  selectedSkills: skills.expert.map(skill => skill.name),
  market: {
    publicTotal: marketView.publicTotal,
    localTotal: marketView.localTotal,
    reverseFound: marketView.items.some(item => item.id === 'rea-reverse-engineer' && item.source === 'local'),
  },
  reverseExpert: reverse.expert.displayName,
  cleared: cleared.applied === false,
  fiberDisposed,
}, null, 2))
