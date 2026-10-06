#!/usr/bin/env node
// Bridge between the codex plugin and `codex app-server`.
//
// Two roles in one file:
//   relay:  node bridge.mjs <codexPath> <sessionKey>
//           Started by the plugin with $.process.spawn. Finds (or starts) the
//           daemon for this Claude session, then copies its event stream to
//           stdout as NDJSON. First line: {"type":"ready","socket",...}.
//           It exits when its parent goes away or stdout breaks; the plugin
//           killing it on reload is expected and harmless.
//   launch: node bridge.mjs --launch <codexPath> <dir>
//           Started detached by the relay; starts the daemon detached, writes
//           its pid to <dir>/pid and exits at once. The daemon is thus never a
//           descendant of the relay: the engine kills the relay's whole tree
//           when the plugin reloads, and the daemon (with codex and its
//           running turns) must outlive that.
//   daemon: node bridge.mjs --daemon <codexPath> <dir>
//           Owns one `codex app-server --listen stdio://` and serves HTTP on
//           the Unix socket <dir>/s:
//             GET  /health
//             GET  /events           NDJSON stream (one subscriber, the relay)
//             POST /rpc   {method, params, timeoutMs?} -> {result} | {error}
//             POST /reply {id, result} | {id, error}   answers a server request
//             POST /wait  {threadId, timeoutMs}        long-poll for turn end
//           While no relay is attached it buffers events (so a plugin reload
//           loses nothing) and exits, killing codex, after GRACE_MS alone.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const GRACE_MS = 20_000
const BUFFER_CAP = 5_000
const SELF = fileURLToPath(import.meta.url)

// Notifications the plugin never reads: streaming deltas and chatter.
const NOISE = new Set([
  'account/rateLimits/updated',
  'mcpServer/startupStatus/updated',
  'warning',
  'configWarning',
  'deprecationNotice',
  'guardianWarning',
  'skills/changed',
  'fs/changed',
  'turn/diff/updated',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/patchUpdated',
  'thread/settings/updated',
])
const isNoise = method =>
  NOISE.has(method) || /[dD]elta$/.test(method) || method.startsWith('rawResponse')

const readBody = req =>
  new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : JSON.parse(data))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

// ---------------------------------------------------------------- daemon

async function daemon(codexPath, dir) {
  const socketPath = path.join(dir, 's')
  const codex = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // A codex that cannot start: say why in daemon.log (the relay reports its tail).
  codex.on('error', error => {
    process.stderr.write(`cannot start ${codexPath}: ${error.message}\n`)
    process.exit(1)
  })
  const stderrTail = []
  readline.createInterface({ input: codex.stderr }).on('line', line => {
    stderrTail.push(line)
    if (stderrTail.length > 40) stderrTail.shift()
  })

  let nextId = 1
  const pending = new Map() // our request id -> {resolve, timer}
  const outstanding = new Map() // server request id -> event
  const active = new Map() // threadId -> running turnId
  const lastTurn = new Map() // threadId -> last completed turn
  const waiters = new Map() // threadId -> Set<(value) => void>
  let buffer = []
  let subscriber = null
  let graceTimer = null
  let everSubscribed = false

  const emit = event => {
    if (subscriber) subscriber.write(JSON.stringify(event) + '\n')
    else if (event.type !== 'request') {
      buffer.push(event)
      if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP)
    }
  }

  const writeCodex = message => codex.stdin.write(JSON.stringify(message) + '\n')

  const rpc = (method, params, timeoutMs = 60_000) =>
    new Promise(resolve => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: { code: -32000, message: `${method} timed out after ${timeoutMs} ms` } })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      writeCodex(params === undefined ? { id, method } : { id, method, params })
    })

  const settleWaiters = (threadId, value) => {
    const set = waiters.get(threadId)
    if (!set) return
    waiters.delete(threadId)
    for (const done of set) done(value)
  }

  const onCodexMessage = message => {
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message.error ? { error: message.error } : { result: message.result })
      return
    }
    if (message.id !== undefined) {
      const event = { type: 'request', id: message.id, method: message.method, params: message.params ?? {} }
      outstanding.set(message.id, event)
      emit(event)
      return
    }
    const { method, params = {} } = message
    if (method === 'turn/started' && params.turn?.id) active.set(params.threadId, params.turn.id)
    if (method === 'turn/completed' && params.turn) {
      active.delete(params.threadId)
      lastTurn.set(params.threadId, params.turn)
    }
    if (method === 'serverRequest/resolved' && params.requestId !== undefined) outstanding.delete(params.requestId)
    if (!isNoise(method)) emit({ type: 'notification', method, params })
    if (method === 'turn/completed' && params.turn) settleWaiters(params.threadId, { status: 'completed', turn: params.turn })
  }

  readline.createInterface({ input: codex.stdout }).on('line', line => {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    onCodexMessage(message)
  })

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  const shutdown = code => {
    if (codex.exitCode === null && codex.signalCode === null) codex.kill('SIGTERM')
    cleanup()
    process.exit(code)
  }

  const armGrace = () => {
    clearTimeout(graceTimer)
    graceTimer = setTimeout(() => shutdown(0), GRACE_MS)
  }

  codex.on('exit', (code, signal) => {
    emit({ type: 'exit', code, signal, stderrTail })
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer)
      resolve({ error: { code: -32001, message: 'codex app-server exited' } })
    }
    if (subscriber) subscriber.end()
    cleanup()
    setTimeout(() => process.exit(code ?? 1), 100)
  })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0))

  const init = await rpc('initialize', { clientInfo: { name: 'claude-code-codex-plugin', version: '0.1.0' } }, 30_000)
  if (init.error) {
    process.stderr.write(`initialize failed: ${JSON.stringify(init.error)}\n`)
    shutdown(1)
  }
  writeCodex({ method: 'initialized' })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://bridge')
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, pid: process.pid, codexPid: codex.pid, active: Object.fromEntries(active) })
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        if (subscriber) subscriber.end()
        clearTimeout(graceTimer)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ type: 'hello', reattached: everSubscribed, active: Object.fromEntries(active) }) + '\n')
        for (const event of outstanding.values()) res.write(JSON.stringify(event) + '\n')
        for (const event of buffer) res.write(JSON.stringify(event) + '\n')
        buffer = []
        subscriber = res
        everSubscribed = true
        res.on('close', () => {
          if (subscriber === res) {
            subscriber = null
            armGrace()
          }
        })
        return
      }
      if (req.method !== 'POST') return sendJson(res, 404, { error: { message: 'not found' } })
      const body = await readBody(req)
      if (url.pathname === '/rpc') {
        if (typeof body.method !== 'string') return sendJson(res, 400, { error: { message: 'method required' } })
        const answer = await rpc(body.method, body.params, body.timeoutMs ?? 60_000)
        if (body.method === 'turn/start' && answer.result?.turn?.id && body.params?.threadId) {
          active.set(body.params.threadId, answer.result.turn.id)
        }
        return sendJson(res, 200, answer)
      }
      if (url.pathname === '/reply') {
        if (!outstanding.has(body.id)) return sendJson(res, 404, { error: { message: `no open server request ${body.id}` } })
        outstanding.delete(body.id)
        writeCodex(body.error !== undefined ? { id: body.id, error: body.error } : { id: body.id, result: body.result })
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/wait') {
        const { threadId, timeoutMs = 600_000 } = body
        if (!active.has(threadId)) return sendJson(res, 200, { status: 'idle', turn: lastTurn.get(threadId) ?? null })
        const answer = await new Promise(resolve => {
          const set = waiters.get(threadId) ?? new Set()
          waiters.set(threadId, set)
          const done = value => {
            clearTimeout(timer)
            set.delete(done)
            resolve(value)
          }
          const timer = setTimeout(() => done({ status: 'timeout', turnId: active.get(threadId) ?? null }), timeoutMs)
          set.add(done)
        })
        return sendJson(res, 200, answer)
      }
      return sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      return sendJson(res, 500, { error: { message: String(error?.message ?? error) } })
    }
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  try {
    fs.unlinkSync(socketPath)
  } catch {}
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600)
    armGrace()
  })
}

// ---------------------------------------------------------------- relay

const request = (socketPath, method, urlPath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath, timeout: timeoutMs }, resolve)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

const isHealthy = async socketPath => {
  try {
    const res = await request(socketPath, 'GET', '/health', 1000)
    res.resume()
    return res.statusCode === 200
  } catch {
    return false
  }
}

const privateBase = () => {
  const base = `/tmp/cxb-${process.getuid()}`
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(base)
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`${base} is not a directory this user owns`)
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(base, 0o700)
  return base
}

async function relay(codexPath, sessionKey) {
  const out = line => process.stdout.write(JSON.stringify(line) + '\n')
  process.stdout.on('error', () => process.exit(0))
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, 1000).unref()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))

  const key = sessionKey.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) || 'default'
  const dir = path.join(privateBase(), key)
  const socketPath = path.join(dir, 's')

  if (!(await isHealthy(socketPath))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { mode: 0o700 })
    const launcher = spawn(process.execPath, [SELF, '--launch', codexPath, dir], { detached: true, stdio: 'ignore' })
    await new Promise(resolve => launcher.on('exit', resolve))
    const daemonPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))
    const deadline = Date.now() + 30_000
    while (!(await isHealthy(socketPath))) {
      const isAlive = (() => {
        try {
          process.kill(daemonPid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (!isAlive || Date.now() > deadline) {
        let logTail = ''
        try {
          logTail = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8').slice(-2000)
        } catch {}
        out({ type: 'fatal', message: !isAlive ? 'the daemon exited' : 'daemon did not start in 30 s', logTail })
        process.exit(1)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const res = await request(socketPath, 'GET', '/events', 0)
  res.setEncoding('utf8')
  const lines = readline.createInterface({ input: res })
  let first = true
  for await (const line of lines) {
    if (first) {
      first = false
      const hello = JSON.parse(line)
      out({ type: 'ready', socket: socketPath, reattached: hello.reattached, active: hello.active })
      continue
    }
    process.stdout.write(line + '\n')
  }
  process.exit(0)
}

function launch(codexPath, dir) {
  const log = fs.openSync(path.join(dir, 'daemon.log'), 'a', 0o600)
  const daemonChild = spawn(process.execPath, [SELF, '--daemon', codexPath, dir], { detached: true, stdio: ['ignore', log, log] })
  fs.writeFileSync(path.join(dir, 'pid'), String(daemonChild.pid), { mode: 0o600 })
  daemonChild.unref()
  process.exit(0)
}

const [, , first, ...rest] = process.argv
if (first === '--launch') {
  const [codexPath, dir] = rest
  launch(codexPath, dir)
} else if (first === '--daemon') {
  const [codexPath, dir] = rest
  daemon(codexPath, dir)
} else if (first && rest[0]) {
  relay(first, rest[0])
} else {
  process.stderr.write('usage: bridge.mjs <codexPath> <sessionKey>\n')
  process.exit(2)
}
