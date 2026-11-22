import http from 'node:http'
import { spawn } from 'node:child_process'

const requests = []
const expertId = process.env.DSH_TEST_EXPERT_ID ?? 'ai-agent-engineer'
const prompt = process.env.DSH_TEST_EXPERT_PROMPT ?? `Select the ${expertId} expert.`
let afterToolBody = ''

function sse(res, events) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  res.end()
}

function textResponse(res, text) {
  sse(res, [
    ['message_start', {
      type: 'message_start',
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const messagesText = JSON.stringify(parsed.messages ?? [])
    const hasToolResult = messagesText.includes('tool_result')
    const isMainPrompt = messagesText.includes(prompt)
    requests.push({ hasToolResult, isMainPrompt, bytes: body.length })
    if (hasToolResult) {
      afterToolBody = body
      textResponse(res, 'EXPERT_TOOL_OK')
      return
    }
    if (!isMainPrompt) {
      textResponse(res, 'OK')
      return
    }
    sse(res, [
      ['message_start', {
        type: 'message_start',
        message: {
          id: 'msg_expert_1',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }],
      ['content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_expert_1', name: 'workbuddy_helper', input: {} },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ action: 'expert', expertId }) },
      }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 10 },
      }],
      ['message_stop', { type: 'message_stop' }],
    ])
  })
})
await new Promise(resolve => server.listen(9878, '127.0.0.1', resolve))

const exe = process.env.DSH_APP_EXE ?? 'D:/Program Files/deepseek harness/DeepSeek Harness.exe'
const bin = process.env.DSH_BIN ?? 'D:/Program Files/deepseek harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const child = spawn(exe, [bin, '--profile', process.env.DSH_TEST_PROFILE ?? 'workbuddy-helper-gh', prompt], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9878',
    DEEPSEEK_API_KEY: 'probe-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', chunk => { out += chunk })
child.stderr.on('data', chunk => { err += chunk })
const timer = setTimeout(() => child.kill(), 45000)
child.on('close', async code => {
  clearTimeout(timer)
  await new Promise(resolve => server.close(resolve))
  console.log('EXIT', code)
  console.log('STDOUT', out.trim())
  console.log('STDERR_HEAD', err.split('\n').slice(0, 2).join(' | '))
  console.log('REQUESTS', JSON.stringify(requests))
  console.log('AFTER_TOOL_HAS_EXPERT_BLOCK', afterToolBody.includes('<expert_selection'))
  console.log('AFTER_TOOL_HAS_EXPERT_NAME', afterToolBody.includes(expertId))
  console.log('AFTER_TOOL_HAS_DISPLAY_NAME', afterToolBody.includes('程枢'))
  console.log('AFTER_TOOL_HAS_OBJECT_NAMESTRING', afterToolBody.includes('[object Object]'))
  console.log('AFTER_TOOL_HAS_SKILL', afterToolBody.includes('agent-craft'))
  const catalogs = [...afterToolBody.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)].map(match => match[1])
  console.log('CATALOG_COUNT', catalogs.length)
  console.log('CATALOG_HAS_AGENT_CRAFT', catalogs.some(text => text.includes('agent-craft')))
  console.log('CATALOG_HAS_XLSX', catalogs.some(text => text.includes('xlsx')))
  console.log('LAST_CATALOG_HEAD', (catalogs.at(-1) ?? '').slice(0, 300))
  console.log('AFTER_TOOL_BYTES', afterToolBody.length)
  const block = /<expert_selection state=\"active\">([\s\S]*?)<\/expert_selection>/.exec(afterToolBody)
  console.log('EXPERT_BLOCK_HEAD', (block?.[1] ?? '').slice(0, 400))
  console.log('EXPERT_BLOCK_HAS_OBJECT', (block?.[1] ?? '').includes('[object Object]'))
})
