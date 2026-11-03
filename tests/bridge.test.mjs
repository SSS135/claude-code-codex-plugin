// Run with: node --test tests/bridge.test.mjs
// The daemon over a fake `codex app-server` that echoes the notifications a `test/emit` request carries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url))
const MSG = fileURLToPath(new URL('../bin/codex-msg', import.meta.url))
const HOLD_MS = 300
const FAKE_CODEX = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'
// Stands for an MCP server Codex started: it ignores SIGTERM, so only a SIGKILL ends it.
if (process.env.FAKE_CODEX_CHILD_PID) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  fs.writeFileSync(process.env.FAKE_CODEX_CHILD_PID, String(child.pid))
}
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'test/exit') process.exit(0)
  if (message.method === 'test/emit') message.params.messages.forEach(send)
  if (message.id !== undefined) send({ id: message.id, result: {} })
}).on('close', () => process.exit(0))
`

const call = (address, method, urlPath, body) => new Promise((resolve, reject) => {
  // http.request(url, options) takes a URL first; a Unix socket goes in the options alone.
  const req = http.request(...(address.startsWith('http') ? [new URL(address + urlPath), { method }] : [{ socketPath: address, path: urlPath, method }]), res => {
    let data = ''
    res.on('data', chunk => (data += chunk))
    res.on('end', () => resolve(JSON.parse(data)))
  })
  req.on('error', reject)
  req.end(body === undefined ? undefined : JSON.stringify(body))
})

const note = (method, params) => ({ method, params })

/** Starts the daemon over the fake Codex; resolves its address, its process and a stop that cleans up. */
async function startDaemon(env = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const dir = path.join(base, 'd-1')
  fs.mkdirSync(dir)
  const fake = path.join(base, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const daemon = spawn(process.execPath, [BRIDGE, '--daemon', fake, dir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, ...env } })
  // The daemon's stderr is its lifecycle log.
  let log = ''
  daemon.stderr.setEncoding('utf8').on('data', chunk => (log += chunk))
  const stop = async () => {
    daemon.kill()
    await new Promise(resolve => setTimeout(resolve, 300))
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  }
  const file = path.join(dir, 's')
  for (let i = 0; i < 100; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    try {
      const candidate = process.platform === 'win32' ? fs.readFileSync(file, 'utf8') : file
      if ((await call(candidate, 'GET', '/health')).ok) return { address: candidate, daemon, stop, dir, fake, log: () => log }
    } catch {}
  }
  await stop()
  assert.fail('the daemon did not start')
}
const turn = (threadId, id, status, extra = {}) => note('turn/completed', { threadId, turn: { id, status, items: [], ...extra } })

test('a failed turn end is held back and dropped when the thread works on; a real failure ends after the hold', async () => {
  const { address, stop } = await startDaemon({ CODEX_BRIDGE_FAILED_HOLD_MS: String(HOLD_MS) })
  try {
    const emit = messages => call(address, 'POST', '/rpc', { method: 'test/emit', params: { messages } })
    const wait = (threadId, timeoutMs) => call(address, 'POST', '/wait', { threadId, timeoutMs })
    const capacity = { message: 'Selected model is at capacity. Please try a different model.' }

    // Codex reports the turn failed, then works on in it: the failure never reaches a waiter.
    await emit([
      note('turn/started', { threadId: 'th-1', turn: { id: 't1' } }),
      note('error', { threadId: 'th-1', turnId: 't1', willRetry: false, error: capacity }),
      turn('th-1', 't1', 'failed', { error: capacity }),
      note('item/started', { threadId: 'th-1', turnId: 't1', item: { type: 'commandExecution', command: 'blender -b' } }),
    ])
    assert.equal((await wait('th-1', HOLD_MS * 3)).status, 'timeout')
    await emit([turn('th-1', 't1', 'completed')])
    assert.equal((await wait('th-1', 1000)).turn.status, 'completed')

    // Work after an ended turn: the thread is followed as running again.
    await emit([note('item/started', { threadId: 'th-1', turnId: 't1', item: { type: 'reasoning' } })])
    assert.deepEqual((await call(address, 'GET', '/health')).active, { 'th-1': 't1' })

    // A failure with no work after it ends the turn once the hold passes.
    const startedAt = Date.now()
    await emit([note('turn/started', { threadId: 'th-2', turn: { id: 't2' } }), turn('th-2', 't2', 'failed', { error: capacity })])
    const failed = await wait('th-2', 5000)
    assert.deepEqual([failed.status, failed.turn.status, failed.turn.error], ['completed', 'failed', capacity])
    assert.ok(Date.now() - startedAt >= HOLD_MS - 50)
  } finally {
    await stop()
  }
})

test('the processes codex started end with the daemon, and with codex when it exits on its own', { skip: process.platform === 'win32' && 'Unix process groups; Windows stops the tree with taskkill /T' }, async () => {
  const isAlive = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (const end of ['the daemon is stopped', 'codex exits']) {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-child-')), 'pid')
    const { address, daemon, stop } = await startDaemon({ FAKE_CODEX_CHILD_PID: pidFile })
    try {
      const child = Number(fs.readFileSync(pidFile, 'utf8'))
      assert.ok(isAlive(child), end)
      const exited = new Promise(resolve => daemon.on('exit', resolve))
      if (end === 'codex exits') await call(address, 'POST', '/rpc', { method: 'test/exit', timeoutMs: 1000 })
      else daemon.kill('SIGTERM')
      await exited
      for (let i = 0; i < 30 && isAlive(child); i += 1) await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(isAlive(child), false, end)
    } finally {
      await stop()
      fs.rmSync(path.dirname(pidFile), { recursive: true, force: true })
    }
  }
})

test('codex-msg: message_agent queues {text, to} for the job, list_agents reads the roster the plugin posted', async () => {
  const { address, stop } = await startDaemon()
  const server = spawn(process.execPath, [MSG, address, 'key-1'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const lines = readline.createInterface({ input: server.stdout })
  const answers = new Map()
  lines.on('line', line => {
    const message = JSON.parse(line)
    answers.get(message.id)?.(message)
  })
  let id = 0
  const request = (method, params) => new Promise(resolve => {
    id += 1
    answers.set(id, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const tool = async (name, args) => (await request('tools/call', { name, arguments: args })).result
  try {
    assert.deepEqual((await request('tools/list', {})).result.tools.map(one => one.name), ['message_agent', 'list_agents'])
    assert.equal((await tool('message_agent', { text: 'ping', to: 'peer_b' })).content[0].text, 'Sent to peer_b. A reply, if any, arrives as a new user message.')
    await tool('message_agent', { text: 'question', to: 'main' })
    const waited = await call(address, 'POST', '/wait', { threadId: 'th-x', msgKey: 'key-1', timeoutMs: 1000 })
    assert.deepEqual(waited, { status: 'message', messages: [{ text: 'ping', to: 'peer_b' }, { text: 'question' }] })
    assert.equal((await tool('message_agent', { text: '' })).isError, true)

    assert.match((await tool('list_agents', {})).content[0].text, /^No agent list yet/)
    await call(address, 'POST', '/roster', { text: '- main\n- peer_b (codex:luna, running)' })
    assert.equal((await tool('list_agents', {})).content[0].text, '- main\n- peer_b (codex:luna, running)')
  } finally {
    server.kill()
    await stop()
  }
})

test('a relay whose Codex CLI does not run says so and what to do in its first line, then exits 1', async () => {
  const relay = spawn(process.execPath, [BRIDGE, path.join(os.tmpdir(), 'no-such-codex-cli'), 'relaytest'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let stdout = ''
  relay.stdout.on('data', chunk => (stdout += chunk))
  const code = await new Promise(resolve => relay.on('exit', resolve))
  const first = JSON.parse(stdout.split('\n')[0])
  assert.equal(code, 1)
  assert.equal(first.type, 'fatal')
  assert.match(first.message, /cannot run the Codex CLI .*no-such-codex-cli/)
  assert.match(first.message, /npm i -g @openai\/codex@latest/)
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Opens the daemon's event stream as a relay would; resolves once the hello line came, with a detach that closes it. */
const attach = (address, query) => new Promise((resolve, reject) => {
  const urlPath = `/events?${query}`
  const req = http.request(...(address.startsWith('http') ? [new URL(address + urlPath), { method: 'GET' }] : [{ socketPath: address, path: urlPath, method: 'GET' }]), res => {
    res.once('data', () => resolve(() => req.destroy()))
  })
  req.on('error', reject)
  req.end()
})

test('with no relay the daemon keeps a running turn while the named Claude Code process lives, and exits after it ends', async () => {
  const claude = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const { address, daemon, stop, log } = await startDaemon({ CODEX_BRIDGE_GRACE_MS: '300', CODEX_BRIDGE_WATCH_MS: '100' })
  try {
    const exited = new Promise(resolve => daemon.on('exit', resolve))
    await call(address, 'POST', '/rpc', { method: 'test/emit', params: { messages: [note('turn/started', { threadId: 'th-1', turn: { id: 't1' } })] } })
    const detach = await attach(address, `relay=4242&claude=${claude.pid}`)
    detach()

    // Many grace periods with no relay: codex and the turn are still there.
    await sleep(1500)
    assert.equal(daemon.exitCode, null)
    assert.deepEqual((await call(address, 'GET', '/health')).active, { 'th-1': 't1' })

    claude.kill()
    const code = await Promise.race([exited, sleep(5000).then(() => 'still running')])
    assert.equal(code, 0)
    const text = log()
    assert.match(text, /relay 4242 attached/)
    assert.match(text, new RegExp(`watching Claude Code pid ${claude.pid}`))
    assert.match(text, /relay 4242 detached; codex and 1 running turn\(s\) stay/)
    assert.match(text, new RegExp(`Claude Code pid ${claude.pid} is gone`))
    assert.match(text, new RegExp(`shutting down: grace of 300 ms over: Claude Code pid ${claude.pid} is gone and no relay is attached; 1 turn\\(s\\) running`))
    assert.match(text, /^\d{4}-\d\d-\d\dT\S+ daemon \d+: /m)
  } finally {
    claude.kill()
    await stop()
  }
})

test("a daemon's cleanup removes its directory only while the recorded pid is its own", async () => {
  for (const isOwn of [true, false]) {
    const { address, daemon, stop, dir, log } = await startDaemon()
    try {
      // Another daemon a relay started in the same directory recorded its pid there.
      fs.writeFileSync(path.join(dir, 'pid'), String(isOwn ? daemon.pid : process.pid))
      const exited = new Promise(resolve => daemon.on('exit', resolve))
      await call(address, 'POST', '/rpc', { method: 'test/exit', timeoutMs: 1000 })
      await exited
      assert.equal(fs.existsSync(dir), !isOwn)
      if (!isOwn) {
        assert.equal(fs.readFileSync(path.join(dir, 'pid'), 'utf8'), String(process.pid))
        assert.match(log(), new RegExp(`left .* in place: it belongs to pid ${process.pid}`))
      }
      assert.match(log(), /codex app-server exited \(code 0/)
    } finally {
      await stop()
    }
  }
})

test('a relay waits for a slow daemon whose pid lives instead of starting another over it', async () => {
  // The relay's daemon directory: <private base>/<session key>-<BUILD>.
  const build = createHash('sha256').update(BRIDGE).update(fs.readFileSync(BRIDGE)).digest('hex').slice(0, 8)
  const base = process.platform === 'win32' ? path.join(os.tmpdir(), 'cxb') : `/tmp/cxb-${process.getuid()}`
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const key = randomBytes(8).toString('hex')
  const dir = path.join(base, `${key}-${build}`)
  fs.mkdirSync(dir, { mode: 0o700 })
  // Its daemon: alive (this process's pid is recorded), but /health hangs while `isSlow`.
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid))
  let isSlow = true
  let eventsUrl = null
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/health')) {
      if (isSlow) return
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, pid: process.pid, active: { 'th-1': 't1' } }))
    }
    if (req.url.includes('/events')) {
      eventsUrl = req.url
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      return res.write(JSON.stringify({ type: 'hello', reattached: true, active: { 'th-1': 't1' } }) + '\n')
    }
    res.writeHead(404).end()
  })
  if (process.platform === 'win32') {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    fs.writeFileSync(path.join(dir, 's'), `http://127.0.0.1:${server.address().port}/secret`)
  } else await new Promise(resolve => server.listen(path.join(dir, 's'), resolve))

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-relay-'))
  const fake = path.join(scratch, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const relay = spawn(process.execPath, [BRIDGE, fake, key], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: scratch, CODEX_BRIDGE_HEALTH_TIMEOUT_MS: '200', CODEX_BRIDGE_LIVE_WAIT_MS: '20000' },
  })
  const lines = []
  readline.createInterface({ input: relay.stdout }).on('line', line => lines.push(JSON.parse(line)))
  try {
    await sleep(2000)
    assert.equal(relay.exitCode, null)
    assert.deepEqual(lines, [])
    assert.equal(fs.readFileSync(path.join(dir, 'pid'), 'utf8'), String(process.pid))
    const waiting = fs.readFileSync(`${dir}.log`, 'utf8')
    assert.match(waiting, new RegExp(`relay ${relay.pid}: daemon ${process.pid} did not answer /health 3 times in 200 ms; its pid lives, waiting for it`))
    assert.doesNotMatch(waiting, /launching/)

    isSlow = false
    for (let i = 0; i < 50 && lines.length === 0; i += 1) await sleep(100)
    assert.equal(lines[0]?.type, 'ready')
    assert.deepEqual(lines[0].active, { 'th-1': 't1' })
    // The relay names its parent, here this process, as the Claude Code process to watch.
    assert.match(eventsUrl, new RegExp(`relay=${relay.pid}&claude=${process.pid}$`))
    assert.match(fs.readFileSync(`${dir}.log`, 'utf8'), new RegExp(`daemon ${process.pid} answered`))
  } finally {
    relay.kill()
    server.closeAllConnections()
    server.close()
    await sleep(300)
    for (const leftover of [dir, `${dir}.log`, scratch]) fs.rmSync(leftover, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("a sub-agent's note after its parent's turn ended does not revive the parent; /subagents lists running sub-agent turns at any depth (#19)", async () => {
  const { address, stop } = await startDaemon()
  try {
    const emit = messages => call(address, 'POST', '/rpc', { method: 'test/emit', params: { messages } })
    const spawned = (parent, turnId, child) => note('item/completed', { threadId: parent, turnId, item: { type: 'subAgentActivity', id: `s-${child}`, kind: 'started', agentThreadId: child, agentPath: '/root/x' } })
    await emit([
      note('turn/started', { threadId: 'lead', turn: { id: 't1' } }),
      spawned('lead', 't1', 'kid'),
      note('turn/started', { threadId: 'kid', turn: { id: 'k1' } }),
      spawned('kid', 'k1', 'grandkid'),
      note('turn/started', { threadId: 'grandkid', turn: { id: 'g1' } }),
      spawned('lead', 't1', 'done-kid'),
      note('turn/started', { threadId: 'done-kid', turn: { id: 'd1' } }),
      turn('done-kid', 'd1', 'completed'),
      turn('lead', 't1', 'interrupted'),
      // The finished sub-agent reports on the lead's thread under its ended turn; an "interacted" note names the parent.
      note('item/completed', { threadId: 'lead', turnId: 't1', item: { type: 'subAgentActivity', id: 's9', kind: 'completed', agentThreadId: 'done-kid', agentPath: '/root/x' } }),
      note('item/completed', { threadId: 'kid', turnId: 'k1', item: { type: 'subAgentActivity', id: 's8', kind: 'interacted', agentThreadId: 'lead', agentPath: '/root' } }),
    ])
    assert.equal((await call(address, 'POST', '/wait', { threadId: 'lead', timeoutMs: 1 })).status, 'idle')
    assert.deepEqual((await call(address, 'POST', '/subagents', { threadId: 'lead' })).active, { kid: 'k1', grandkid: 'g1' })
    assert.deepEqual((await call(address, 'POST', '/subagents', { threadId: 'kid' })).active, { grandkid: 'g1' })
  } finally {
    await stop()
  }
})
