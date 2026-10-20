// Opt-in native Codex/MCP integration with a LOCAL mock Responses provider.
// No credentials, user CODEX_HOME, installed daemon, or real provider is used.
// Run in the host heavy slot:
// CODEX_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 tests/native-lifecycle.test.mjs
// CODEX_NATIVE_CLI optionally names an absolute installed CLI. No CLI is run
// unless the opt-in is present. The native unload delay is explicitly 1 second;
// this proves real cleanup, not the installed default's 60-second timing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url))
const MCP = fileURLToPath(new URL('./fixtures/native-mcp.mjs', import.meta.url))
const enabled = process.env.CODEX_NATIVE_LIFECYCLE === '1'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (work, check, message, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await work()
    if (check(value)) return value
    await sleep(50)
  }
  throw new Error(message)
}
const executable = () => {
  const requested = process.env.CODEX_NATIVE_CLI
  if (requested) {
    if (!path.isAbsolute(requested)) throw new Error('CODEX_NATIVE_CLI must be absolute')
    fs.accessSync(requested, fs.constants.X_OK)
    return requested
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'codex')
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch {}
  }
  throw new Error('the native lifecycle gate requires an installed Codex CLI')
}
const alive = ({ pid, started }) => {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[0] !== 'Z' && fields[19] === started
  } catch (error) {
    if (process.platform === 'linux' && error.code === 'ENOENT') return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
}
const request = (socketPath, endpoint, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: endpoint, method: body === undefined ? 'GET' : 'POST' }, res => {
    let text = ''
    res.on('data', chunk => { text += chunk })
    res.on('end', () => {
      try { resolve(JSON.parse(text)) } catch { reject(new Error('invalid native fixture bridge response')) }
    })
  })
  req.setTimeout(25_000, () => req.destroy(new Error('native fixture bridge request exceeded its deadline')))
  req.on('error', () => reject(new Error('native fixture bridge transport failed')))
  req.end(body === undefined ? undefined : JSON.stringify(body))
})

test('native Codex returns isolated MCP processes to baseline after completed, failed and interrupted turns', {
  skip: !enabled || process.platform === 'win32', timeout: 180_000,
}, async t => {
  const cli = executable()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-lifecycle-'))
  const home = path.join(base, 'home')
  const codexHome = path.join(home, '.codex')
  const cwd = path.join(base, 'workspace')
  const dir = path.join(base, 'daemon')
  for (const target of [home, codexHome, cwd, dir]) fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  const ledger = path.join(base, 'mcp-processes.jsonl')
  const socketPath = path.join(dir, 's')
  let daemon
  let events
  let stopping = false
  let streamError = null
  let passed = false
  let mode = 'completed'
  let providerCalls = 0
  const providerBodies = []
  let rejectedNetwork = 0
  const rejectedRequests = []
  const heldResponses = new Set()
  const responseGates = []
  const provider = http.createServer((req, res) => {
    // Proxies are deliberately pointed here too. Never forward any URL/CONNECT;
    // an unexpected request fails the test instead of reaching a real service.
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      rejectedNetwork += 1
      rejectedRequests.push({ method: req.method, url: req.url })
      req.resume()
      res.writeHead(403); res.end(); return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => providerBodies.push(body))
    providerCalls += 1
    const responseMode = mode
    const id = 'fixture-response-' + providerCalls
    // Do not finish any turn until the test has measured its live MCP child.
    responseGates.push(() => {
      if (responseMode === 'failed') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'isolated terminal fixture failure', type: 'invalid_request_error', code: 'fixture_terminal_failure' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const event = value => res.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n')
      event({ type: 'response.created', response: { id } })
      if (responseMode === 'interrupted') {
        heldResponses.add(res)
        res.on('close', () => heldResponses.delete(res))
        return
      }
      event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'fixture-message', content: [{ type: 'output_text', text: 'fixture complete' }] } })
      event({ type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: null, output_tokens_details: null } } })
      res.end()
    })
  })
  provider.on('connect', (req, socket) => { rejectedNetwork += 1; rejectedRequests.push({ method: 'CONNECT', url: req.url }); socket.destroy() })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  const endpoint = 'http://127.0.0.1:' + provider.address().port
  const processRecords = () => {
    try { return fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
  }
  const ownedPids = () => [...new Map(processRecords().map(record => [record.pid + ':' + record.started, record])).values()]
  const processCount = () => ownedPids().filter(alive).length
  const stop = async () => {
    stopping = true
    events?.destroy()
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM')
      await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), sleep(5000)])
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
    }
    for (const res of heldResponses) res.destroy()
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    // Only fixture-owned ledger PIDs may be cleaned up. No host-wide process
    // searches, user MCPs, installed bridge, or unrelated process are touched.
    for (const child of ownedPids()) if (alive(child)) { try { process.kill(child.pid, 'SIGKILL') } catch {} }
    if (passed) fs.rmSync(base, { recursive: true, force: true })
    else {
      fs.writeFileSync(path.join(base, 'rejected-requests.json'), JSON.stringify(rejectedRequests, null, 2) + '\n', { mode: 0o600 })
      t.diagnostic('Private native fixture failure diagnostics retained at ' + base)
    }
  }
  t.after(stop)
  const toml = value => JSON.stringify(value)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `
model = "mock-model"
model_provider = "isolated_fixture"
approval_policy = "never"
sandbox_mode = "read-only"
thread_unload_delay_secs = 1
check_for_update_on_startup = false

[features]
# Disable Codex's default curated plugin-catalog Git/API synchronization in this
# temporary home. The explicitly configured harmless MCP remains enabled.
plugins = false
[analytics]
enabled = false
[feedback]
enabled = false
[model_providers.isolated_fixture]
name = "Local lifecycle fixture"
base_url = ${toml(endpoint + '/v1')}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.lifecycle_fixture]
command = ${toml(process.execPath)}
args = [${toml(MCP)}, ${toml(ledger)}]
startup_timeout_sec = 10
`, { mode: 0o600 })
  const log = fs.openSync(path.join(base, 'daemon.log'), 'a', 0o600)
  try {
    // Allowlist environment: do not pass auth, user configuration, inherited
    // MCP credentials, or provider-routing environment variables to Codex.
    daemon = spawn(process.execPath, [BRIDGE, '--daemon', cli, dir], {
      cwd, stdio: ['ignore', log, log],
      env: {
        PATH: [path.dirname(process.execPath), path.dirname(cli), '/usr/bin', '/bin'].join(path.delimiter),
        HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(home, '.config'), TMPDIR: base,
        LANG: 'C.UTF-8', TERM: 'dumb', HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
        http_proxy: endpoint, https_proxy: endpoint, all_proxy: endpoint, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
        CODEX_BRIDGE_FAILED_HOLD_MS: '100', CODEX_BRIDGE_RELEASE_RETRY_MS: '100',
      },
    })
  } finally { fs.closeSync(log) }
  await until(async () => { try { return await request(socketPath, '/health') } catch { return null } }, value => value?.ok, 'native fixture daemon failed to initialize')
  const notes = []
  const observed = new Promise((resolve, reject) => {
    const onStreamError = error => {
      // Destroying our own open event subscription during teardown can reset
      // its HTTP response. Earlier failures still invalidate this fixture.
      if (stopping && error.code === 'ECONNRESET') return
      streamError = error
      reject(new Error('native fixture event stream failed'))
    }
    events = http.get({ socketPath, path: '/events' }, res => {
      res.on('error', onStreamError)
      readline.createInterface({ input: res }).on('error', onStreamError).on('line', line => {
        const event = JSON.parse(line)
        notes.push(event)
        if (event.type === 'hello') resolve()
      })
    })
    events.on('error', onStreamError)
  })
  await observed
  const rpc = async (method, params) => {
    const answer = await request(socketPath, '/rpc', { method, params, timeoutMs: 15_000 })
    if (answer.error) throw new Error('native fixture RPC failed: ' + method + ' (code ' + answer.error.code + ')')
    return answer.result
  }
  const baseline = processCount()
  assert.equal(baseline, 0, 'no fixture MCP should exist before loading a thread')
  let originalThread
  for (const status of ['completed', 'failed', 'interrupted', 'completed', 'failed', 'interrupted']) {
    mode = status
    const before = providerCalls
    const noteOffset = notes.length
    const initializedBefore = processRecords().filter(record => record.event === 'initialized').length
    const followup = status === 'completed' && originalThread
    const started = followup
      ? await rpc('thread/resume', { threadId: originalThread, model: 'mock-model', cwd, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true })
      : await rpc('thread/start', { model: 'mock-model', modelProvider: 'isolated_fixture', cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
    if (followup) assert.equal(started.thread.id, originalThread, 'follow-ups must bind the same durable thread')
    if (status === 'completed' && !originalThread) originalThread = started.thread.id
    const threadId = started.thread.id
    const turn = await rpc('turn/start', { threadId, model: 'mock-model', input: [{ type: 'text', text: followup ? 'Follow up using the original fixture context.' : 'Return the fixed fixture response.', text_elements: [] }] })
    await until(async () => processRecords().filter(record => record.event === 'initialized').length, count => count > initializedBefore, 'native Codex did not initialize the harmless MCP')
    assert.equal(processCount(), baseline + 1, 'the native failure/success case must have a real loaded MCP process')
    await until(async () => providerCalls, count => count > before, 'native turn never reached the local mock provider')
    responseGates.shift()()
    if (status === 'interrupted') await request(socketPath, '/interrupt', { threadId, turnId: turn.turn.id })
    const completed = await request(socketPath, '/wait', { threadId, turnId: turn.turn.id, timeoutMs: 20_000 })
    assert.equal(completed.status, 'completed', 'native turn did not produce a terminal outcome')
    assert.equal(completed.turn.status, status, 'native terminal status did not match its fixture case')
    if (followup) {
      const requestBody = JSON.parse(providerBodies.at(-1))
      const input = JSON.stringify(requestBody.input)
      assert.ok(input.includes('Return the fixed fixture response.'), 'resume must send the original user prompt to the provider')
      assert.ok(input.includes('fixture complete'), 'resume must send the original assistant history to the provider')
      assert.ok(input.includes('Follow up using the original fixture context.'), 'resume must append the new input')
      t.diagnostic('native follow-up: same thread after unload; original user and assistant history present in provider request')
    }
    await until(async () => notes.slice(noteOffset).some(event => event.method === 'thread/released' && event.params?.threadId === threadId), Boolean, 'native unsubscribe was not acknowledged')
    await until(async () => notes.slice(noteOffset).some(event => event.method === 'thread/closed' && event.params?.threadId === threadId), Boolean, 'native thread never closed after release')
    await until(async () => processCount(), count => count === baseline, 'native MCP process count did not return to baseline')
    t.diagnostic('native ' + status + ': initialized MCP=1; terminal observed; unsubscribe acknowledged; thread closed; MCP baseline=0')
  }
  assert.equal(providerCalls, 6, 'the native fixture should perform exactly one local request per cycle')
  assert.equal(rejectedNetwork, 0, 'unexpected network requests were refused by the local proxy')
  assert.equal(streamError, null, 'native event stream failed before teardown')
  assert.equal(fs.existsSync(path.join(codexHome, 'auth.json')), false, 'the isolated native fixture must not acquire authentication')
  t.diagnostic('Native unload delay explicitly overridden to 1 second; six local mock provider requests; no real provider calls.')
  passed = true
})
