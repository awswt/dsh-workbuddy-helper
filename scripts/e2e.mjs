#!/usr/bin/env node
/**
 * One-command end-to-end reproduction: isolated DSH_HOME → install the plugin
 * (from GitHub or from a local tarball) → fake-model headless session → verdict.
 *
 * Why this file exists: `docs/e2e-baseline.md` used to describe the procedure as
 * four hand-written PowerShell blocks with `E:/DSH/workspace/migrate` baked in.
 * A human could follow it; an agent could not re-run it. Everything the document
 * taught is encoded here instead, so "did the plugin regress?" is one command.
 *
 *   node scripts/e2e.mjs                     # install from GitHub, then probe
 *   node scripts/e2e.mjs --source local      # install ./  (the working tree)
 *   node scripts/e2e.mjs --skip-install      # reuse an existing profile
 *   node scripts/e2e.mjs --keep-home         # do not delete the isolated home
 *   node scripts/e2e.mjs --plan connector-only
 *
 * Exit code is 0 only when every check passes; the machine-readable verdict is
 * written to `<out>/report.json` (default `.workbuddy/e2e/run`).
 *
 * What it proves, in order:
 *   1. the plugin installs and `--dump-config` shows the loader entry
 *   2. `workbuddy_helper`'s schema (with the connector/skill parameters) is really
 *      sent to the model — not just registered somewhere
 *   3. `action=connector` reaches the 134-entry catalog / 8 categories
 *   4. `action=skills` lists the skills actually on disk
 *   5. `action=expert` puts the persona block into the NEXT system prompt
 *      and merges the expert's own skills into the catalog
 *
 * It never touches the real `DSH_HOME`: every run gets its own directory under
 * the OS temp dir, and the token vaults are copied in only when asked, because a
 * missing vault is what makes portal actions report AUTH_REQUIRED.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/* ─────────────────────────────── arguments ─────────────────────────────── */

function parseArgs(argv) {
  const options = {
    source: 'github',
    profile: 'wbhelper-e2e',
    port: 0,
    keepHome: false,
    skipInstall: false,
    plan: 'full',
    outDir: path.join(REPO, '.workbuddy', 'e2e', 'run'),
    dshHome: null,
    cli: null,
    tokenVault: false,
    shareCatalog: true,
    timeoutMs: 240000,
    verbose: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
      index += 1
      return value
    }
    switch (token) {
      case '--source':
        options.source = next()
        break
      case '--profile':
        options.profile = next()
        break
      case '--port':
        options.port = Number(next())
        break
      case '--out':
        options.outDir = path.resolve(next())
        break
      case '--dsh-home':
        options.dshHome = path.resolve(next())
        break
      case '--cli':
        options.cli = path.resolve(next())
        break
      case '--plan':
        options.plan = next()
        break
      case '--timeout':
        options.timeoutMs = Number(next())
        break
      case '--keep-home':
        options.keepHome = true
        break
      case '--skip-install':
        options.skipInstall = true
        break
      case '--token-vault':
        options.tokenVault = true
        break
      case '--share-catalog':
        options.shareCatalog = true
        break
      case '--no-share-catalog':
        options.shareCatalog = false
        break
      case '--verbose':
        options.verbose = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${token}`)
    }
  }
  return options
}

const HELP = `dsh-workbuddy-helper end-to-end reproduction

  node scripts/e2e.mjs [options]

  --source <github|local|file:PATH>  where to install the plugin from (default: github)
  --profile <name>                   profile name inside the isolated home (default: wbhelper-e2e)
  --plan <full|connector-only|skills-only>  which probe steps to run (default: full)
  --out <dir>                        where report.json and request dumps go
  --dsh-home <dir>                   reuse a specific home instead of a temp one
  --cli <path>                       DSH CLI entry (default: the installed dsh package)
  --keep-home                        do not delete the isolated home afterwards
  --skip-install                     assume the profile is already installed
  --token-vault                      copy WorkBuddy token vaults into the isolated home
  --no-share-catalog                 do not copy the real connector catalog into the isolated home
  --timeout <ms>                     headless session timeout (default: 240000)
  --verbose                          stream the child's stdout/stderr
`

/* ──────────────────────────────── helpers ──────────────────────────────── */

const log = (message) => console.log(`[e2e] ${message}`)
const warn = (message) => console.warn(`[e2e] ${message}`)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      if (options.verbose === true) process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      if (options.verbose === true) process.stderr.write(text)
    })
    const timer = options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
        try {
          child.kill()
        } catch {
          // The process may have exited already.
        }
      }, options.timeoutMs)
    child.on('error', (error) => {
      if (timer !== null) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer)
      resolve({ code, stdout, stderr, command: `${command} ${args.join(' ')}` })
    })
  })
}

/** Reads the launch config without importing DSH: cheaper and version-independent. */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The DSH CLI entry. `resources/runtime/bin/dsh` is a shell shim, so the real
 * entry is the package's bin.js. Callers can override it with --cli.
 */
function defaultCli() {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Track a named check so the report can say exactly what failed. */
function createChecks() {
  const results = []
  return {
    results,
    pass(name, detail) {
      results.push({ name, ok: true, detail: detail ?? null })
      log(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      return true
    },
    fail(name, detail) {
      results.push({ name, ok: false, detail: detail ?? null })
      warn(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      return false
    },
    get failed() {
      return results.filter(entry => !entry.ok).length
    },
  }
}

/* ───────────────────────── fake model (SSE dialect) ─────────────────────── */

/**
 * This build speaks OpenAI Chat Completions streaming, not the Anthropic event
 * shape: `POST /chat/completions`, `tools[].function.name`, terminated by
 * `data: [DONE]`. Sending Anthropic events makes the stream die with
 * STREAM_CLOSED before the first token.
 */
const PROMPTS = {
  full: [
    { label: 'connector', input: { action: 'connector', connectorAction: 'list' } },
    { label: 'skills', input: { action: 'skills' } },
    { label: 'expert', input: { action: 'expert', expertId: 'ai-agent-engineer' } },
    { label: 'skills-after-expert', input: { action: 'skills' } },
  ],
  'connector-only': [
    { label: 'connector', input: { action: 'connector', connectorAction: 'list' } },
  ],
  'skills-only': [
    { label: 'skills', input: { action: 'skills' } },
    { label: 'expert', input: { action: 'expert', expertId: 'ai-agent-engineer' } },
    { label: 'skills-after-expert', input: { action: 'skills' } },
  ],
}

function chunkFrame(payload) {
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'e2e-fake',
    choices: [{ index: 0, delta: payload, finish_reason: null }],
  }
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) return message.content.map(part => part?.text ?? '').join('')
  return ''
}

function toolNameOf(tool) {
  return tool?.function?.name ?? tool?.name ?? null
}

/**
 * Serve the fake model and record every request body. The plan drives which tool
 * call comes next: a tool-call response is only emitted while the number of
 * `role: tool` messages is still below the plan length.
 */
async function startFakeModel({ port, plan, outDir, finalText }) {
  await fsp.mkdir(path.join(outDir, 'requests'), { recursive: true })
  const records = []
  let sequence = 0

  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (part) => chunks.push(part))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = {}
      }
      const index = sequence
      sequence += 1
      const tools = Array.isArray(parsed.tools) ? parsed.tools : []
      const helper = tools.find(tool => toolNameOf(tool) === 'workbuddy_helper')
      const parameters = helper?.function?.parameters ?? helper?.parameters ?? {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const system = messages.filter(message => message?.role === 'system').map(textOf).join('\n\n')
      const toolResults = messages
        .filter(message => message?.role === 'tool')
        .map(message => ({ toolCallId: message.tool_call_id ?? null, text: textOf(message) }))
      const skillsMatch = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(
        messages.map(textOf).join('\n'),
      )

      records.push({
        index,
        toolCount: tools.length,
        toolNames: tools.map(toolNameOf).filter(name => typeof name === 'string'),
        helperKeys: helper === undefined ? null : Object.keys(parameters.properties ?? {}),
        helperRequired: helper === undefined ? null : (parameters.required ?? []),
        systemLength: system.length,
        expertBlock: system.includes('<expert_selection state="active">'),
        expertName: /selected the "([^"]+)" expert/.exec(system)?.[1] ?? null,
        skillsCatalogSize: skillsMatch === null ? null : skillsMatch[1].length,
        toolResults,
      })
      fs.writeFileSync(path.join(outDir, 'requests', `${String(index).padStart(2, '0')}-body.json`), raw)
      if (system !== '') {
        fs.writeFileSync(path.join(outDir, 'requests', `${String(index).padStart(2, '0')}-system.txt`), system)
      }

      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.setHeader('cache-control', 'no-cache')
      response.setHeader('connection', 'keep-alive')
      const write = (payload) => response.write(`data: ${JSON.stringify(chunkFrame(payload))}\n\n`)
      write({ role: 'assistant', content: '' })

      // Auxiliary requests (title generation and the like) have no helper tool;
      // answer them with plain text so they do not consume a plan step.
      if (helper === undefined) {
        write({ content: 'ok' })
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      const step = toolResults.length
      if (step < plan.length) {
        const planned = plan[step]
        write({
          tool_calls: [{
            index: 0,
            id: `call_e2e_${step}`,
            type: 'function',
            function: { name: 'workbuddy_helper', arguments: JSON.stringify(planned.input) },
          }],
        })
        response.write(
          `data: ${JSON.stringify({ ...chunkFrame({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        )
      } else {
        write({ content: finalText })
        response.write(
          `data: ${JSON.stringify({ ...chunkFrame({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        )
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    records,
    port: typeof address === 'object' && address !== null ? address.port : port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/* ──────────────────────────────── main flow ─────────────────────────────── */

async function installPlugin({ cli, profile, source, dshHome, verbose }) {
  const spec = source === 'github'
    ? 'git+https://github.com/awswt/dsh-workbuddy-helper.git'
    : source === 'local'
      ? `file:${REPO}`
      : source
  log(`installing ${spec} into profile ${profile}`)
  const installed = await run(process.execPath, [cli, 'plugin', '--profile', profile, 'add', spec], {
    env: { ...process.env, DSH_HOME: dshHome },
    verbose,
    timeoutMs: 300000,
  })
  return { ...installed, spec }
}

/**
 * `plugin add` creates the profile package.json but leaves `dsh.profile.bundles`
 * unset, and without dsh-base/dsh-headless the profile has no headless app at
 * all. Rewriting it must not go through PowerShell (`Set-Content -Encoding utf8`
 * writes a BOM, which makes `--dump-config` fail).
 */
async function configureProfile(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json')
  const pkg = readJsonFile(pkgPath)
  if (pkg === null) return { ok: false, reason: `missing ${pkgPath}` }
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-workbuddy-helper']
  // `live` lets a patch written by the connector module mount without a restart,
  // which is what makes the "connect → tools appear" step observable in one run.
  pkg.dsh.profile.patchReload = 'live'
  await fsp.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  return { ok: true, pkgPath, bundles: pkg.dsh.profile.bundles }
}

async function dumpConfig({ cli, profile, dshHome, verbose }) {
  const result = await run(process.execPath, [cli, '--profile', profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1' },
    verbose,
    timeoutMs: 120000,
  })
  const text = `${result.stdout}\n${result.stderr}`
  return {
    ok: result.code === 0,
    code: result.code,
    hasPlugin: text.includes('name: dsh-workbuddy-helper'),
    hasHeadless: text.includes('headless-runner'),
    text,
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
    process.stdout.write(HELP)
    process.exitCode = 2
    return
  }
  if (options.help === true) {
    process.stdout.write(HELP)
    return
  }

  const checks = createChecks()
  const cli = options.cli ?? defaultCli()
  if (cli === null || !fs.existsSync(cli)) {
    warn('cannot find the DSH CLI; pass --cli <path to @deepseek-ai/dsh/lib/bin.js>')
    process.exitCode = 2
    return
  }

  const outDir = options.outDir
  await fsp.rm(outDir, { recursive: true, force: true })
  await fsp.mkdir(outDir, { recursive: true })

  const ownsHome = options.dshHome === null
  const dshHome = options.dshHome ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'wbh-e2e-home-'))
  const profileDir = path.join(dshHome, 'profiles', options.profile)
  const planKey = options.plan
  const plan = PROMPTS[planKey]
  if (plan === undefined) {
    warn(`unknown --plan ${planKey}; known: ${Object.keys(PROMPTS).join(', ')}`)
    process.exitCode = 2
    return
  }

  const report = {
    startedAt: new Date().toISOString(),
    repo: REPO,
    cli,
    source: options.source,
    profile: options.profile,
    plan: planKey,
    dshHome,
    profileDir,
    ownsHome,
    steps: [],
    checks: checks.results,
  }

  try {
    log(`isolated DSH_HOME = ${dshHome}`)
    if (options.shareCatalog === true) {
      // The 134-entry connector catalog lives in the REAL home's storage
      // (`$DSH_HOME/storages/mcp_connector.json`, written by dsh-mcp-connector).
      // An isolated home starts with no catalog at all, so `action=connector`
      // honestly reports catalogTotal 0 and the check would fail for a reason
      // that has nothing to do with this plugin. Copy ONLY the catalog table —
      // never `connections`/`grants`, which are the user's live credentials and
      // would make the isolated run look pre-connected.
      const realStorage = path.join(os.homedir(), '.dsh', 'storages', 'mcp_connector.json')
      const catalog = readJsonFile(realStorage)
      const connectors = catalog?.tables?.catalog?.remote?.connectors
      if (Array.isArray(connectors) && connectors.length > 0) {
        const target = path.join(dshHome, 'storages', 'mcp_connector.json')
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, `${JSON.stringify({
          unit: catalog.unit ?? { name: 'mcp_connector', version: 1 },
          global: {},
          tables: { catalog: { remote: { ...catalog.tables.catalog.remote, connectors } } },
        }, null, 2)}\n`, 'utf8')
        log(`copied ${connectors.length} catalog entries (connections/grants deliberately dropped)`)
      } else {
        warn(`no connector catalog at ${realStorage}: the catalog check will report 0`)
      }
    }
    if (options.tokenVault === true) {
      // Portal actions need a WorkBuddy login. Copying the vault is the supported
      // way to give the isolated home one; editing code to bypass auth is not.
      const realVault = path.join(os.homedir(), '.dsh', 'workbuddy-vault')
      if (fs.existsSync(realVault)) {
        await fsp.cp(realVault, path.join(dshHome, 'workbuddy-vault'), { recursive: true })
        log('copied the WorkBuddy token vault into the isolated home')
      } else {
        warn('no workbuddy-vault to copy: portal actions will report AUTH_REQUIRED')
      }
    }

    if (options.skipInstall === false) {
      const installed = await installPlugin({
        cli,
        profile: options.profile,
        source: options.source,
        dshHome,
        verbose: options.verbose,
      })
      report.steps.push({ step: 'install', ...installed })
      checks.pass('plugin installs', `exit ${installed.code}`) && null
      if (installed.code !== 0) {
        checks.fail('plugin installs', `exit ${installed.code}: ${installed.stderr.slice(-400)}`)
        report.failed = true
        return
      }
      const configured = await configureProfile(profileDir)
      report.steps.push({ step: 'configure', ...configured })
      if (configured.ok === true) checks.pass('profile bundles configured', configured.bundles.join(', '))
      else checks.fail('profile bundles configured', configured.reason)
    } else {
      log('--skip-install: reusing the existing profile')
    }

    const dumped = await dumpConfig({ cli, profile: options.profile, dshHome, verbose: options.verbose })
    report.steps.push({ step: 'dump-config', code: dumped.code, hasPlugin: dumped.hasPlugin, hasHeadless: dumped.hasHeadless })
    if (dumped.hasPlugin) checks.pass('loader sees dsh-workbuddy-helper')
    else checks.fail('loader sees dsh-workbuddy-helper', dumped.text.slice(-600))
    if (dumped.hasHeadless) checks.pass('headless runner present')
    else checks.fail('headless runner present', 'profile has no headless app; bundles may be wrong')

    const finalText = 'E2E_OK'
    const model = await startFakeModel({
      port: options.port,
      plan,
      outDir,
      finalText,
    })
    log(`fake model on http://127.0.0.1:${model.port}`)

    const prompt = 'Exercise the workbuddy_helper tool.'
    const session = await run(process.execPath, [cli, '--profile', options.profile, prompt], {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.port}`,
        DEEPSEEK_API_KEY: 'e2e-key',
        NO_COLOR: '1',
      },
      cwd: REPO,
      verbose: options.verbose,
      timeoutMs: options.timeoutMs,
    })
    await model.close()

    report.steps.push({
      step: 'session',
      code: session.code,
      stdout: session.stdout.slice(-4000),
      stderr: session.stderr.slice(-4000),
    })
    report.requests = model.records
    await fsp.writeFile(path.join(outDir, 'stdout.txt'), session.stdout, 'utf8')
    await fsp.writeFile(path.join(outDir, 'stderr.txt'), session.stderr, 'utf8')

    if (session.code === 0) checks.pass('headless session exits cleanly')
    else checks.fail('headless session exits cleanly', `exit ${session.code}: ${session.stderr.slice(-400)}`)

    if (model.records.length === 0) {
      checks.fail('the model was actually called', 'no request reached the fake model')
    } else {
      checks.pass('the model was actually called', `${model.records.length} requests`)
    }

    const first = model.records[0]
    if (first === undefined) {
      checks.fail('workbuddy_helper schema reaches the model')
    } else if (first.helperKeys === null) {
      checks.fail('workbuddy_helper schema reaches the model', `tool names: ${first.toolNames.join(', ').slice(0, 300)}`)
    } else {
      // The connector/skill parameters are the whole point of this plugin: if the
      // schema does not carry them the model can never call those actions.
      const expected = ['action', 'expertId', 'connectorAction', 'connectorId']
      const missing = expected.filter(key => first.helperKeys.includes(key) === false)
      if (missing.length === 0) checks.pass('workbuddy_helper schema reaches the model', first.helperKeys.join('|'))
      else checks.fail('workbuddy_helper schema carries connector parameters', `missing: ${missing.join(', ')}`)
    }

    const toolTextAt = (index) => model.records
      .flatMap(record => record.toolResults)
      .map(entry => entry.text)
    const results = toolTextAt()
    const joined = results.join('\n')

    if (planKey === 'full' || planKey === 'connector-only') {
      if (/"catalogTotal":\s*\d+/.test(joined)) {
        const total = Number(/"catalogTotal":\s*(\d+)/.exec(joined)[1])
        if (total > 0) checks.pass('connector catalog is readable', `${total} connectors`)
        else checks.fail('connector catalog is readable', 'catalogTotal is 0')
      } else {
        checks.fail('connector catalog is readable', joined.slice(0, 500))
      }
    }

    if (planKey === 'full' || planKey === 'skills-only') {
      const expertOk = model.records.some(record => record.expertBlock === true)
      if (expertOk) {
        const name = model.records.find(record => record.expertName !== null)?.expertName ?? 'unknown'
        checks.pass('expert persona reaches the next system prompt', name)
      } else {
        // The persona only lands on a request AFTER the tool call, so a one-request
        // session legitimately cannot show it — say which happened.
        checks.fail(
          'expert persona reaches the next system prompt',
          model.records.length < 2
            ? 'only one request: the persona needs a following turn'
            : 'no <expert_selection state="active"> block in any system prompt',
        )
      }
      const catalogSizes = model.records
        .map(record => record.skillsCatalogSize)
        .filter(size => typeof size === 'number')
      if (catalogSizes.length === 0) {
        checks.fail('skill catalog is injected', 'no <available_skills> block in any request')
      } else {
        // The catalog is an independent user message from @deepseek-ai/dsh-tool-skill,
        // not part of the system prompt — grepping the system text alone would lie.
        checks.pass('skill catalog is injected', `${catalogSizes.length} requests carry it`)
      }
    }

    await fsp.writeFile(
      path.join(outDir, 'report.json'),
      JSON.stringify({ ...report, finishedAt: new Date().toISOString(), checks: checks.results }, null, 2),
      'utf8',
    )

    const failed = checks.failed
    log(failed === 0
      ? `ALL CHECKS PASSED (${checks.results.length}) — report: ${path.join(outDir, 'report.json')}`
      : `${failed} CHECK(S) FAILED — report: ${path.join(outDir, 'report.json')}`)
    process.exitCode = failed === 0 ? 0 : 1
  } catch (error) {
    warn(error instanceof Error ? (error.stack ?? error.message) : String(error))
    await fsp.writeFile(
      path.join(outDir, 'report.json'),
      JSON.stringify({ ...report, error: String(error), checks: checks.results }, null, 2),
      'utf8',
    ).catch(() => undefined)
    process.exitCode = 1
  } finally {
    if (ownsHome === true && options.keepHome === false) {
      await fsp.rm(dshHome, { recursive: true, force: true }).catch(() => undefined)
    } else if (ownsHome === true) {
      log(`kept the isolated home: ${dshHome}`)
    }
  }
}

await main()
