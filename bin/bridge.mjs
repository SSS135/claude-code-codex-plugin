#!/usr/bin/env node
// Bridge between the codex plugin and `codex app-server`.
//
// Two roles in one file:
//   relay:  node bridge.mjs <codexPath> <sessionKey>
//           Started by the plugin with $.process.spawn. Finds (or starts) the
//           daemon for this Claude session and this build of the bridge (the
//           daemon's directory is <sessionKey>-<BUILD>, so a reload onto another
//           plugin version or path starts a new daemon instead of driving an old
//           one), then copies its event stream to stdout as NDJSON. Only while
//           the session's daemon of another build runs turns does it drive that
//           one instead, until it is idle; it then stops it and exits, so no
//           reload loses a turn. First line:
//           {"type":"ready","socket",...}. It exits when its parent goes away,
//           stdout breaks or the daemon exits; the plugin killing it on reload is
//           expected and harmless.
//   launch: node bridge.mjs --launch <codexPath> <dir>
//           Started detached by the relay; starts the daemon detached, writes
//           its pid to <dir>/pid and exits at once. The daemon is thus never a
//           descendant of the relay: the engine kills the relay's whole tree
//           when the plugin reloads, and the daemon (with codex and its
//           running turns) must outlive that.
//   daemon: node bridge.mjs --daemon <codexPath> <dir>
//           Owns one `codex app-server --listen stdio://` and serves HTTP on
//           the Unix socket <dir>/s. On Windows, where Node cannot listen on a
//           Unix socket and the plugin's fetch refuses a named pipe, it serves
//           on a loopback port instead and writes its address to <dir>/s:
//           http://127.0.0.1:<port>/<secret>, every path under the secret.
//           That address stands wherever a socket path goes below.
//             GET  /health
//             GET  /events           NDJSON stream (one subscriber, the relay)
//             POST /rpc   {method, params, timeoutMs?} -> {result} | {error}
//             POST /reply {id, result} | {id, error}   answers a server request
//             POST /wait  {threadId, msgKey?, timeoutMs} long-poll for turn end or a codex-msg message
//             POST /msg   {key, text}                  bin/codex-msg: a message from a Codex job
//           While no relay is attached it buffers events (so a plugin reload
//           loses nothing) and exits, killing codex, after GRACE_MS alone. With a
//           relay attached it exits after IDLE_MS with no turn running and no
//           request in flight; the plugin starts a new one when it next needs
//           Codex. Codex stops a thread's MCP servers (bin/codex-msg among them)
//           when it unloads the thread, and all of them when it exits. It also
//           stops daemons of bridge builds that predate this lifecycle (their
//           directory is the bare session key) once it has seen them run no
//           turn for LEGACY_IDLE_MS.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const GRACE_MS = 20_000
const IDLE_MS = 10 * 60_000
const IDLE_CHECK_MS = 60_000
/** Half the idle window, so a daemon about to idle out itself still stops an idle legacy one. */
const LEGACY_IDLE_MS = IDLE_MS / 2
const DRAIN_CHECK_MS = 5_000
const BUFFER_CAP = 5_000
const MAILBOX_CAP = 50
const MESSAGE_CAP = 20_000
/** What a codex-msg delivery hands a waiting /wait. */
const MAIL = Symbol('mail')
const SELF = fileURLToPath(import.meta.url)
/** Names this bridge build: its path and its code. */
const BUILD = createHash('sha256').update(SELF).update(fs.readFileSync(SELF)).digest('hex').slice(0, 8)
/** A daemon directory of a build before BUILD was part of it: the session key alone. */
const isLegacyDir = name => /^[A-Za-z0-9]+$/.test(name)
const IS_WINDOWS = process.platform === 'win32'

/** Where the daemon in `dir` listens: its Unix socket, or on Windows the loopback address it wrote to <dir>/s (null before it did). */
const addressOf = dir => {
  const file = path.join(dir, 's')
  if (!IS_WINDOWS) return file
  try {
    return fs.readFileSync(file, 'utf8') || null
  } catch {
    return null
  }
}

/** Ends a process. On Windows a killed process leaves its children running, so its whole tree goes, by force: there is no SIGTERM to catch. */
const stopTree = pid => {
  try {
    if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else process.kill(pid, 'SIGTERM')
  } catch {}
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * The file and leading arguments that run `codexPath`. On Windows a bare name
 * or npm's codex.cmd shim cannot run without a shell, so it becomes the npm
 * package's codex.js on this node, or a codex.exe, found beside the given
 * path or on PATH.
 */
const codexCommand = codexPath => {
  if (!IS_WINDOWS || /\.exe$/i.test(codexPath)) return [codexPath, []]
  if (/\.[cm]?js$/i.test(codexPath)) return [process.execPath, [codexPath]]
  const dirs = path.isAbsolute(codexPath) ? [path.dirname(codexPath)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (fs.existsSync(script)) return [process.execPath, [script]]
    const exe = path.join(dir, 'codex.exe')
    if (fs.existsSync(exe)) return [exe, []]
  }
  return [codexPath, []]
}

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
  const secret = IS_WINDOWS ? randomBytes(16).toString('hex') : null
  const [file, leading] = codexCommand(codexPath)
  const codex = spawn(file, [...leading, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
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
  const mailboxes = new Map() // codex-msg key -> texts not yet read
  const mailWaiters = new Map() // codex-msg key -> Set<(value) => void>
  const drainMail = key => {
    const messages = mailboxes.get(key) ?? []
    mailboxes.delete(key)
    return messages
  }
  let buffer = []
  let subscriber = null
  let graceTimer = null
  let everSubscribed = false
  /** Requests other than /events being served, and when the daemon was last in use. */
  let inFlight = 0
  let lastUse = Date.now()

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
      lastUse = Date.now()
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
    if (codex.exitCode === null && codex.signalCode === null) stopTree(codex.pid)
    cleanup()
    // End the relay's stream before exiting, so the relay reads an ordinary end, not a reset.
    if (subscriber) subscriber.end()
    subscriber = null
    setTimeout(() => process.exit(code), 100)
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
    return shutdown(1)
  }
  writeCodex({ method: 'initialized' })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://bridge')
      // On Windows any local process or web page reaches the port: only the secret's holders get past it.
      if (secret) {
        if (!url.pathname.startsWith(`/${secret}/`)) return sendJson(res, 403, { error: { message: 'forbidden' } })
        url.pathname = url.pathname.slice(secret.length + 1)
      }
      if (url.pathname !== '/events') {
        inFlight += 1
        lastUse = Date.now()
        res.on('close', () => {
          inFlight -= 1
          lastUse = Date.now()
        })
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, pid: process.pid, codexPid: codex.pid, build: BUILD, active: Object.fromEntries(active) })
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
        const { threadId, msgKey, timeoutMs = 600_000 } = body
        // Messages first: a job may send one and end its turn before the next poll.
        if (msgKey && mailboxes.get(msgKey)?.length) return sendJson(res, 200, { status: 'message', messages: drainMail(msgKey) })
        if (!active.has(threadId)) return sendJson(res, 200, { status: 'idle', turn: lastTurn.get(threadId) ?? null })
        const answer = await new Promise(resolve => {
          const set = waiters.get(threadId) ?? new Set()
          waiters.set(threadId, set)
          const mail = msgKey ? (mailWaiters.get(msgKey) ?? new Set()) : null
          if (mail) mailWaiters.set(msgKey, mail)
          const done = value => {
            clearTimeout(timer)
            set.delete(done)
            mail?.delete(done)
            resolve(value === MAIL ? { status: 'message', messages: drainMail(msgKey) } : value)
          }
          const timer = setTimeout(() => done({ status: 'timeout', turnId: active.get(threadId) ?? null }), timeoutMs)
          set.add(done)
          mail?.add(done)
        })
        return sendJson(res, 200, answer)
      }
      if (url.pathname === '/msg') {
        const { key, text } = body
        if (typeof key !== 'string' || key === '' || typeof text !== 'string' || text.trim() === '') {
          return sendJson(res, 400, { error: { message: 'key and text are required' } })
        }
        const box = mailboxes.get(key) ?? []
        if (box.length >= MAILBOX_CAP) return sendJson(res, 429, { error: { message: `${MAILBOX_CAP} messages are already waiting to be read` } })
        box.push(text.slice(0, MESSAGE_CAP))
        mailboxes.set(key, box)
        const set = mailWaiters.get(key)
        if (set) {
          mailWaiters.delete(key)
          for (const done of set) done(MAIL)
        }
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      return sendJson(res, 500, { error: { message: String(error?.message ?? error) } })
    }
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  if (secret) {
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(socketPath, `http://127.0.0.1:${server.address().port}/${secret}`)
      armGrace()
    })
  } else {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600)
      armGrace()
    })
  }

  // Legacy daemon directory -> since when its daemon has been seen running no turn.
  const legacyIdleSince = new Map()
  const stopIdleLegacy = async () => {
    const base = path.dirname(dir)
    const now = Date.now()
    for (const name of fs.readdirSync(base).filter(isLegacyDir)) {
      const health = await readHealth(addressOf(path.join(base, name)))
      if (!health || Object.keys(health.active ?? {}).length > 0) {
        legacyIdleSince.delete(name)
        continue
      }
      const since = legacyIdleSince.get(name) ?? now
      legacyIdleSince.set(name, since)
      if (now - since < LEGACY_IDLE_MS) continue
      legacyIdleSince.delete(name)
      if (stopDaemon(path.join(base, name), health)) process.stderr.write(`stopped idle daemon ${name} (pid ${health.pid}) of an older bridge build\n`)
    }
  }
  setInterval(() => {
    if (active.size > 0 || inFlight > 0) lastUse = Date.now()
    else if (subscriber && Date.now() - lastUse >= IDLE_MS) shutdown(0)
    stopIdleLegacy().catch(error => process.stderr.write(`legacy daemon sweep failed: ${error.message}\n`))
  }, IDLE_CHECK_MS)
}

// ---------------------------------------------------------------- relay

/** `socketPath` is a daemon's address (addressOf): a Unix socket, or a loopback URL. */
const request = (socketPath, method, urlPath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [url, via] = /^https?:/.test(socketPath) ? [`${socketPath}${urlPath}`, {}] : [`http://bridge${urlPath}`, { socketPath }]
    const req = http.request(url, { ...via, method, timeout: timeoutMs }, resolve)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** A daemon's /health answer, or null when none answers on the socket. */
const readHealth = async socketPath => {
  if (!socketPath) return null
  try {
    const res = await request(socketPath, 'GET', '/health', 1000)
    res.setEncoding('utf8')
    let text = ''
    for await (const chunk of res) text += chunk
    return res.statusCode === 200 ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const isHealthy = async socketPath => (await readHealth(socketPath)) !== null

const isBusy = health => Object.keys(health?.active ?? {}).length > 0

/** Stops the daemon in `dir` that answered `health`, when the pid it reports is the one its launcher recorded; whether it did. */
const stopDaemon = (dir, health) => {
  let recorded = null
  try {
    recorded = fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()
  } catch {}
  if (recorded !== String(health.pid)) return false
  stopTree(health.pid)
  // A daemon stopped by force (Windows) cleans up nothing itself.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  return true
}

/** This session's live daemon of another bridge build (a plugin reload onto another version or path, or a legacy one): `{dir, health}`, or null. */
const otherDaemon = async (base, key) => {
  for (const name of fs.readdirSync(base)) {
    if ((name !== key && !name.startsWith(`${key}-`)) || name === `${key}-${BUILD}`) continue
    const health = await readHealth(addressOf(path.join(base, name)))
    if (health) return { dir: path.join(base, name), health }
  }
  return null
}

const privateBase = () => {
  // Windows has no uid or Unix modes: the per-user temp directory is private to this user already.
  if (IS_WINDOWS) {
    const base = path.join(os.tmpdir(), 'cxb')
    fs.mkdirSync(base, { recursive: true })
    return base
  }
  const base = `/tmp/cxb-${process.getuid()}`
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(base)
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`${base} is not a directory this user owns`)
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(base, 0o700)
  return base
}

/**
 * Drives another build's daemon until it has run no turn for two checks in a
 * row, then stops it and exits: the plugin's next request starts this build's
 * daemon, which resumes the threads.
 */
const drain = other => {
  let quiet = 0
  setInterval(async () => {
    const health = await readHealth(addressOf(other.dir))
    quiet = isBusy(health) ? 0 : quiet + 1
    if (health && quiet < 2) return
    if (health) stopDaemon(other.dir, health)
    process.exit(0)
  }, DRAIN_CHECK_MS)
}

async function relay(codexPath, sessionKey) {
  const out = line => process.stdout.write(JSON.stringify(line) + '\n')
  process.stdout.on('error', () => process.exit(0))
  const parent = process.ppid
  // Windows never reparents an orphan: there the parent's pid stops answering instead.
  setInterval(() => {
    if (process.ppid !== parent || !isAlive(parent)) process.exit(0)
  }, 1000).unref()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))

  const key = sessionKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'default'
  const base = privateBase()
  const dir = path.join(base, `${key}-${BUILD}`)

  const other = (await isHealthy(addressOf(dir))) ? null : await otherDaemon(base, key)
  // A reload onto another build while turns run on the old build's daemon: drive that one, so no turn is lost.
  const target = isBusy(other?.health) ? other.dir : dir
  if (target !== dir) drain(other)
  else if (!(await isHealthy(addressOf(dir)))) {
    // An idle one would only hold threads this build's daemon must resume.
    if (other) stopDaemon(other.dir, other.health)
    // Retries: on Windows an exiting daemon may still hold its log open for a moment.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    fs.mkdirSync(dir, { mode: 0o700 })
    const launcher = spawn(process.execPath, [SELF, '--launch', codexPath, dir], { detached: true, stdio: 'ignore', windowsHide: true })
    await new Promise(resolve => launcher.on('exit', resolve))
    const daemonPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))
    const deadline = Date.now() + 30_000
    while (!(await isHealthy(addressOf(dir)))) {
      const isRunning = isAlive(daemonPid)
      if (!isRunning || Date.now() > deadline) {
        let logTail = ''
        try {
          logTail = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8').slice(-2000)
        } catch {}
        out({ type: 'fatal', message: !isRunning ? 'the daemon exited' : 'daemon did not start in 30 s', logTail })
        process.exit(1)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const socketPath = addressOf(target)
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
  const daemonChild = spawn(process.execPath, [SELF, '--daemon', codexPath, dir], { detached: true, stdio: ['ignore', log, log], windowsHide: true })
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
