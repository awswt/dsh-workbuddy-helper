import http from 'node:http'
import { spawn } from 'node:child_process'

const requests = []
let toolResultText = ''

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

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const messagesText = JSON.stringify(parsed.messages ?? [])
    const hasToolResult = messagesText.includes('tool_result')
    const isMainPrompt = messagesText.includes('Call the workbuddy_helper tool')
    requests.push({ url: req.url, hasToolResult, isMainPrompt, bytes: body.length })
    if (hasToolResult) {
      const match = /"type":"tool_result"[\s\S]{0,4000}/.exec(messagesText)
      if (match) toolResultText = match[0].slice(0, 2000)
    }
    if (isMainPrompt && !hasToolResult) {
      sse(res, [
        ['message_start', {
          type: 'message_start',
          message: {
            id: 'msg_probe_1',
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
          content_block: { type: 'tool_use', id: 'toolu_probe_1', name: 'workbuddy_helper', input: {} },
        }],
        ['content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"action":"connector"}' },
        }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 10 },
        }],
        ['message_stop', { type: 'message_stop' }],
      ])
      return
    }
    if (!hasToolResult) {
      sse(res, [
        ['message_start', {
          type: 'message_start',
          message: {
            id: 'msg_probe_plain',
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
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ])
      return
    }
    sse(res, [
      ['message_start', {
        type: 'message_start',
        message: {
          id: 'msg_probe_2',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      }],
      ['content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'CONNECTOR_TOOL_OK' },
      }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      }],
      ['message_stop', { type: 'message_stop' }],
    ])
  })
})
await new Promise(resolve => server.listen(9877, '127.0.0.1', resolve))

const exe = process.env.DSH_APP_EXE ?? 'D:/Program Files/deepseek harness/DeepSeek Harness.exe'
const bin = process.env.DSH_BIN ?? 'D:/Program Files/deepseek harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const child = spawn(exe, [bin, '--profile', process.env.DSH_TEST_PROFILE ?? 'workbuddy-helper-gh', 'Call the workbuddy_helper tool with action=connector.'], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9877',
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
  console.log('STDOUT_START')
  console.log(out.slice(0, 4000))
  console.log('STDOUT_END')
  console.log('STDERR_START')
  console.log(err.slice(0, 2000))
  console.log('STDERR_END')
  console.log('REQUESTS', JSON.stringify(requests))
  console.log('TOOL_RESULT_START')
  console.log(toolResultText)
  console.log('TOOL_RESULT_END')
})
