#!/usr/bin/env node
// Bridge between the codex plugin and `codex app-server`.
//
// Two roles in one file:
//   relay:  node bridge.mjs <codexPath> <sessionKey>
//           Started by the plugin with $.process.spawn. Finds (or starts) the
//           daemon for this Claude session and this build of the bridge (the
//           daemon's directory is <sessionKey>-<BUILD>, so a reload onto another
//           plugin version or path starts a new daemon instead of driving an old
//           one; a daemon that answers late while its recorded pid lives is
//           waited for, never replaced), then copies its event stream to stdout
//           as NDJSON, naming its parent (Claude Code) to the daemon. Only while
//           the session's daemon of another build runs turns does it drive that
//           one instead, until it is idle; it then stops it and exits, so no
//           reload loses a turn. It first runs `codex --version` (a CLI that
//           does not run is a fatal line saying what to do). First line:
//           {"type":"ready","socket",...,"codexVersion"}, plus "oldBuild":{build,turns}
//           while it drives another build's daemon. It exits when its parent goes away,
//           stdout breaks or the daemon exits; the plugin killing it on reload is
//           expected and harmless.
//   launch: node bridge.mjs --launch <codexPath> <dir>
//           Started detached by the relay; starts the daemon detached, writes
//           its pid to <dir>/pid (which marks the directory as that daemon's:
//           no other daemon removes it) and exits at once. The daemon is thus never a
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
//             POST /subagents {threadId}              -> {active: {threadId: turnId}} the running turns of the sub-agents it spawned, at any depth
//             POST /msg   {key, text, to?}             bin/codex-msg: a message from a Codex job, to an agent or main
//             POST /roster {text}                      the plugin: the agent list list_agents answers
//             POST /agents {key}                       bin/codex-msg: that list, as plain text
//           While no relay is attached it buffers events (so a plugin reload
//           loses nothing) and keeps codex and its running turns while the
//           Claude Code process the last relay named lives (its parent, passed
//           as /events?claude=<pid>); once that process is gone, or none was
//           named, it exits, killing codex, after GRACE_MS alone. It exits after
//           IDLE_MS with no turn running and no request in flight; the plugin
//           starts a new one when it next needs Codex. Lifecycle events go, one
//           timestamped line each, to <dir>.log beside the directory, so the log
//           outlives the daemon that wrote it. Codex stops a thread's MCP servers (bin/codex-msg among them)
//           when it unloads the thread, and all of them when it exits; off
//           Windows the daemon then ends what is left of codex's process group. It also
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
import { serveRegistry } from './registry.mjs'

/** How long a daemon with no relay and no live Claude Code process waits for a relay before it exits. */
const GRACE_MS = Number(process.env.CODEX_BRIDGE_GRACE_MS) || 20_000
/** How often a daemon with no relay checks that the Claude Code process it was given still lives. */
const WATCH_MS = Number(process.env.CODEX_BRIDGE_WATCH_MS) || 2_000
/** A busy daemon may answer /health late: each ask waits this long, HEALTH_TRIES times, before the relay looks at its pid. */
const HEALTH_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_HEALTH_TIMEOUT_MS) || 5_000
const HEALTH_TRIES = 3
/** How long a relay waits for a daemon that does not answer but whose pid lives, before it gives up (never starting another over it). */
const LIVE_WAIT_MS = Number(process.env.CODEX_BRIDGE_LIVE_WAIT_MS) || 30_000
/** The log beside a daemon directory is cut to its last LOG_KEEP bytes once it passes LOG_CAP. */
const LOG_CAP = 1024 * 1024
const LOG_KEEP = 256 * 1024
const IDLE_MS = 10 * 60_000
const IDLE_CHECK_MS = 60_000
/** Half the idle window, so a daemon about to idle out itself still stops an idle legacy one. */
const LEGACY_IDLE_MS = IDLE_MS / 2
const DRAIN_CHECK_MS = 5_000
/** How long codex's process group has to exit on SIGTERM before SIGKILL (not on Windows). */
const GROUP_KILL_MS = 1_000
const BUFFER_CAP = 5_000
const MAILBOX_CAP = 50
const MESSAGE_CAP = 20_000
/**
 * How long a failed turn/completed is held back. Codex has reported a turn failed
 * ("Selected model is at capacity", "Error running remote compact task") and then
 * kept working on the thread; work on it within this window drops the failure.
 */
const FAILED_HOLD_MS = Number(process.env.CODEX_BRIDGE_FAILED_HOLD_MS) || 30_000
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

/**
 * Ends codex with the processes it started (its MCP servers). Off Windows codex
 * leads its own process group: the group gets SIGTERM, then SIGKILL after
 * GROUP_KILL_MS if any of it is left, which also ends the MCP servers of a codex
 * that already exited. On Windows only a running codex is stopped: the pid of an
 * exited one may be reused.
 */
const stopCodex = async codex => {
  if (IS_WINDOWS) {
    if (codex.exitCode === null && codex.signalCode === null) stopTree(codex.pid)
    return
  }
  const signalGroup = signal => {
    try {
      process.kill(-codex.pid, signal)
      return true
    } catch {
      return false
    }
  }
  if (!signalGroup('SIGTERM')) return
  for (const deadline = Date.now() + GROUP_KILL_MS; Date.now() < deadline; ) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (!signalGroup(0)) return
  }
  signalGroup('SIGKILL')
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The lifecycle log of the daemon in `dir`: beside the directory, which a daemon's cleanup removes. */
const logPathOf = dir => `${dir}.log`

const stamp = text => `${new Date().toISOString()} ${text}\n`

/** Appends a timestamped line to the log of the daemon in `dir` (the relay's side; the daemon writes its stderr there). */
const note = (dir, text) => {
  try {
    fs.appendFileSync(logPathOf(dir), stamp(text), { mode: 0o600 })
  } catch {}
}

/** The pid the launcher recorded for the daemon in `dir`, or null. */
const recordedPid = dir => {
  try {
    return Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()) || null
  } catch {
    return null
  }
}

/**
 * The codex.exe of the Codex desktop app (Store package OpenAI.Codex), or null.
 * Its folder name carries the app version and WindowsApps cannot be listed, so
 * Windows is asked where the package lives.
 */
const codexAppExe = () => {
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  const dir = (ran.stdout ?? '').trim().split(/\r?\n/)[0]
  const exe = dir ? path.join(dir, 'app', 'resources', 'codex.exe') : null
  return exe && fs.existsSync(exe) ? exe : null
}

/**
 * The file and leading arguments that run `codexPath`. On Windows a bare name
 * or npm's codex.cmd shim cannot run without a shell, so it becomes the npm
 * package's codex.js on this node, or a codex.exe, found beside the given
 * path or on PATH, else the Codex desktop app's codex.exe.
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
  const appExe = path.isAbsolute(codexPath) ? null : codexAppExe()
  return appExe ? [appExe, []] : [codexPath, []]
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
  // stderr is the log beside the directory (launch opens it).
  const log = text => process.stderr.write(stamp(`daemon ${process.pid}: ${text}`))
  const [file, leading] = codexCommand(codexPath)
  const codex = spawn(file, [...leading, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Off Windows codex leads its own process group, so stopCodex reaches its MCP servers too
    // (on Windows detached would give it a console of its own; taskkill /T reaches the tree there).
    detached: !IS_WINDOWS,
    windowsHide: true,
  })
  log(`started in ${dir}; codex app-server pid ${codex.pid ?? 'none'}: ${[file, ...leading].join(' ')}`)
  // A codex that cannot start: say why in the log (the relay reports its tail).
  codex.on('error', error => {
    const hint = error.code === 'ENOENT' ? ' (not found: install the Codex app, or `npm install -g @openai/codex` for the node on PATH, or set the codexPath plugin option)' : ''
    log(`cannot start ${codexPath}: ${error.message}${hint}`)
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
  const subAgents = new Map() // threadId -> Set of the sub-agent threads it spawned (Codex's spawn_agent)
  const failedHolds = new Map() // threadId -> timer of a failed turn/completed held back
  const waiters = new Map() // threadId -> Set<(value) => void>
  const mailboxes = new Map() // codex-msg key -> {text, to?} not yet read
  let roster = 'No agent list yet: the Claude session has not sent one.'
  const mailWaiters = new Map() // codex-msg key -> Set<(value) => void>
  const drainMail = key => {
    const messages = mailboxes.get(key) ?? []
    mailboxes.delete(key)
    return messages
  }
  let buffer = []
  let subscriber = null
  /** The pid of the attached relay, for the log. */
  let relayPid = null
  /** The Claude Code process the last relay named: while it lives, codex runs on with no relay attached. */
  let claudePid = null
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
    const isTurnEnd = method === 'turn/completed' && params.turn
    // A sub-agent's activity note lands on its parent's thread, tagged with the parent's last turn even after that
    // turn ended: it is the sub-agent's work, not the parent's (#19).
    const isSubAgentNote = method.startsWith('item/') && params.item?.type === 'subAgentActivity'
    if (isSubAgentNote && params.item.kind === 'started' && typeof params.item.agentThreadId === 'string') {
      subAgents.set(params.threadId, (subAgents.get(params.threadId) ?? new Set()).add(params.item.agentThreadId))
    }
    const isWork = isTurnEnd || method === 'turn/started' || (method.startsWith('item/') && !isSubAgentNote)
    if (isWork && failedHolds.has(params.threadId)) {
      clearTimeout(failedHolds.get(params.threadId))
      failedHolds.delete(params.threadId)
    }
    if (method === 'turn/started' && params.turn?.id) active.set(params.threadId, params.turn.id)
    // Work after the thread's turn ended: follow it as a running turn again.
    if (method.startsWith('item/') && !isSubAgentNote && typeof params.turnId === 'string' && !active.has(params.threadId)) active.set(params.threadId, params.turnId)
    if (method === 'serverRequest/resolved' && params.requestId !== undefined) outstanding.delete(params.requestId)
    if (isTurnEnd && params.turn.status === 'failed') {
      failedHolds.set(params.threadId, setTimeout(() => {
        failedHolds.delete(params.threadId)
        endTurn(params)
      }, FAILED_HOLD_MS))
    } else if (isTurnEnd) endTurn(params)
    else if (!isNoise(method)) emit({ type: 'notification', method, params })
  }

  const endTurn = params => {
    active.delete(params.threadId)
    lastTurn.set(params.threadId, params.turn)
    lastUse = Date.now()
    emit({ type: 'notification', method: 'turn/completed', params })
    settleWaiters(params.threadId, { status: 'completed', turn: params.turn })
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

  let isCleanedUp = false
  const cleanup = () => {
    // Shutdown and codex's exit both get here.
    if (isCleanedUp) return
    isCleanedUp = true
    // A relay that took this daemon for gone may have started another in the directory: that one owns it now.
    const owner = recordedPid(dir)
    if (owner !== process.pid) return log(`left ${dir} in place: it belongs to pid ${owner ?? 'none'}`)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  const shutdown = async (code, reason) => {
    log(`shutting down: ${reason}; ${active.size} turn(s) running`)
    const stopping = stopCodex(codex)
    cleanup()
    // End the relay's stream before exiting, so the relay reads an ordinary end, not a reset.
    if (subscriber) subscriber.end()
    subscriber = null
    await stopping
    setTimeout(() => process.exit(code), 100)
  }

  const armGrace = reason => {
    clearTimeout(graceTimer)
    log(`${reason}; exiting in ${GRACE_MS} ms unless a relay attaches`)
    graceTimer = setTimeout(() => shutdown(0, `grace of ${GRACE_MS} ms over: ${reason}`), GRACE_MS)
  }

  const disarmGrace = () => {
    clearTimeout(graceTimer)
    graceTimer = null
  }

  // With no relay attached, codex and its turns stay while Claude Code runs; its exit starts the grace.
  setInterval(() => {
    if (subscriber || graceTimer || claudePid === null || isAlive(claudePid)) return
    armGrace(`Claude Code pid ${claudePid} is gone and no relay is attached`)
  }, WATCH_MS)

  codex.on('exit', async (code, signal) => {
    log(`codex app-server exited (code ${code}, signal ${signal})${stderrTail.length ? `; stderr: ${stderrTail.slice(-3).join(' | ').slice(-500)}` : ''}`)
    emit({ type: 'exit', code, signal, stderrTail })
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer)
      resolve({ error: { code: -32001, message: 'codex app-server exited' } })
    }
    if (subscriber) subscriber.end()
    cleanup()
    // Its MCP servers may outlive it: end what is left of its process group.
    await stopCodex(codex)
    setTimeout(() => process.exit(code ?? 1), 100)
  })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0, `${signal} received`))

  const init = await rpc('initialize', { clientInfo: { name: 'claude-code-codex-plugin', version: '0.1.0' } }, 30_000)
  if (init.error) return shutdown(1, `initialize failed: ${JSON.stringify(init.error)}`)
  writeCodex({ method: 'initialized' })
  log(`codex initialized${init.result?.userAgent ? ` (${init.result.userAgent})` : ''}`)

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
        const attaching = Number(url.searchParams.get('relay')) || null
        log(`relay ${attaching ?? '?'} attached${subscriber ? `, replacing relay ${relayPid ?? '?'}` : ''}`)
        if (subscriber) subscriber.end()
        disarmGrace()
        relayPid = attaching
        const named = Number(url.searchParams.get('claude')) || null
        if (named !== null && named !== claudePid) {
          claudePid = named
          log(`watching Claude Code pid ${claudePid}`)
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ type: 'hello', reattached: everSubscribed, active: Object.fromEntries(active) }) + '\n')
        for (const event of outstanding.values()) res.write(JSON.stringify(event) + '\n')
        for (const event of buffer) res.write(JSON.stringify(event) + '\n')
        buffer = []
        subscriber = res
        everSubscribed = true
        res.on('close', () => {
          if (subscriber !== res) return
          subscriber = null
          if (claudePid !== null && isAlive(claudePid)) log(`relay ${attaching ?? '?'} detached; codex and ${active.size} running turn(s) stay while Claude Code pid ${claudePid} lives`)
          else armGrace(`relay ${attaching ?? '?'} detached and ${claudePid === null ? 'no Claude Code pid was given' : `Claude Code pid ${claudePid} is gone`}`)
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
        const { threadId, msgKey } = body
        // The hook host aborts HTTP at 30 s. Bound even legacy callers' waits.
        const timeoutMs = Math.max(1, Math.min(Number(body.timeoutMs) || 20_000, 20_000))
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
      if (url.pathname === '/subagents') {
        // Turn/interrupt ends a thread's turn alone: its sub-agents, and theirs, run on.
        const running = {}
        const seen = new Set([body.threadId])
        for (const queue = [body.threadId]; queue.length > 0; ) {
          for (const child of subAgents.get(queue.shift()) ?? []) {
            if (seen.has(child)) continue
            seen.add(child)
            queue.push(child)
            if (active.has(child)) running[child] = active.get(child)
          }
        }
        return sendJson(res, 200, { active: running })
      }
      if (url.pathname === '/msg') {
        const { key, text, to } = body
        if (typeof key !== 'string' || key === '' || typeof text !== 'string' || text.trim() === '') {
          return sendJson(res, 400, { error: { message: 'key and text are required' } })
        }
        if (to !== undefined && (typeof to !== 'string' || to.trim() === '')) return sendJson(res, 400, { error: { message: 'to, when given, names an agent' } })
        const box = mailboxes.get(key) ?? []
        if (box.length >= MAILBOX_CAP) return sendJson(res, 429, { error: { message: `${MAILBOX_CAP} messages are already waiting to be read` } })
        box.push(to === undefined ? { text: text.slice(0, MESSAGE_CAP) } : { text: text.slice(0, MESSAGE_CAP), to })
        mailboxes.set(key, box)
        const set = mailWaiters.get(key)
        if (set) {
          mailWaiters.delete(key)
          for (const done of set) done(MAIL)
        }
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/roster') {
        if (typeof body.text !== 'string') return sendJson(res, 400, { error: { message: 'text is required' } })
        roster = body.text
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/agents') {
        if (typeof body.key !== 'string' || body.key === '') return sendJson(res, 400, { error: { message: 'key is required' } })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(roster)
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
      armGrace('no relay attached yet')
    })
  } else {
    try {
      fs.unlinkSync(socketPath)
    } catch {}
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600)
      armGrace('no relay attached yet')
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
      if (stopDaemon(path.join(base, name), health)) log(`stopped idle daemon ${name} (pid ${health.pid}) of an older bridge build`)
    }
  }
  setInterval(() => {
    if (active.size > 0 || inFlight > 0) lastUse = Date.now()
    else if (Date.now() - lastUse >= IDLE_MS) shutdown(0, `idle: no turn ran and no request came for ${IDLE_MS / 60_000} min`)
    stopIdleLegacy().catch(error => log(`legacy daemon sweep failed: ${error.message}`))
  }, IDLE_CHECK_MS)
}

// ---------------------------------------------------------------- relay

/**
 * `codex --version`'s output, which the plugin checks against the oldest CLI it
 * runs on; null when it printed nothing. Throws, saying what to do, when the
 * CLI does not run at all.
 */
const codexVersion = codexPath => {
  const [file, leading] = codexCommand(codexPath)
  const ran = spawnSync(file, [...leading, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
  if (ran.error || ran.status !== 0) {
    const why = ran.error?.message ?? `exit code ${ran.status ?? ran.signal}: ${(ran.stderr || ran.stdout || '').trim().split('\n').slice(-3).join(' | ')}`
    throw new Error(`cannot run the Codex CLI ${codexPath} (${why}). Install or update it (npm i -g @openai/codex@latest, or update the ChatGPT app on macOS or the Codex app on Windows), or set the plugin's codexPath.`)
  }
  return ran.stdout.trim() || null
}

/** `socketPath` is a daemon's address (addressOf): a Unix socket, or a loopback URL. */
const request = (socketPath, method, urlPath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [url, via] = /^https?:/.test(socketPath) ? [`${socketPath}${urlPath}`, {}] : [`http://bridge${urlPath}`, { socketPath }]
    const req = http.request(url, { ...via, method, timeout: timeoutMs }, resolve)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** A daemon's /health answer; throws when none comes (`code` ECONNREFUSED: nothing listens there). */
const askHealth = async socketPath => {
  const res = await request(socketPath, 'GET', '/health', HEALTH_TIMEOUT_MS)
  res.setEncoding('utf8')
  let text = ''
  for await (const chunk of res) text += chunk
  if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`)
  return JSON.parse(text)
}

/** A daemon's /health answer, or null when none answers on the socket. */
const readHealth = async socketPath => {
  if (!socketPath) return null
  try {
    return await askHealth(socketPath)
  } catch {
    return null
  }
}

/**
 * Whether the daemon in `dir` answers, asked up to `tries` times: `up`;
 * `refused` when nothing listens at its address (it is gone, even if its pid
 * was reused); `silent` when it has no address yet or did not answer in time.
 */
const probe = async (dir, tries) => {
  for (let i = 0; i < tries; i += 1) {
    const address = addressOf(dir)
    try {
      if (address) {
        await askHealth(address)
        return 'up'
      }
    } catch (error) {
      if (error.code === 'ECONNREFUSED') return 'refused'
    }
  }
  return 'silent'
}

/** Waits up to `ms` for the daemon in `dir` (pid `pid`) to answer: `up`, `gone` (it exited or stopped listening) or `timeout`. */
const untilUp = async (dir, pid, ms) => {
  for (const deadline = Date.now() + ms; ; await new Promise(resolve => setTimeout(resolve, 100))) {
    const state = await probe(dir, 1)
    if (state === 'up') return 'up'
    if (state === 'refused' || !isAlive(pid)) return 'gone'
    if (Date.now() > deadline) return 'timeout'
  }
}

const isBusy = health => Object.keys(health?.active ?? {}).length > 0

/** Stops the daemon in `dir` that answered `health`, when the pid it reports is the one its launcher recorded; whether it did. */
const stopDaemon = (dir, health) => {
  let recorded = null
  try {
    recorded = fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()
  } catch {}
  if (recorded !== String(health.pid)) return false
  note(dir, `pid ${process.pid} (build ${BUILD}) stopped daemon ${health.pid} of another bridge build`)
  stopTree(health.pid)
  // A daemon stopped by force (Windows) cleans up nothing itself.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  return true
}

/** This session's live daemon of another bridge build (a plugin reload onto another version or path, or a legacy one): `{dir, health}`, or null. */
const otherDaemon = async (base, key) => {
  for (const name of fs.readdirSync(base)) {
    if ((name !== key && !name.startsWith(`${key}-`)) || name === `${key}-${BUILD}` || name.endsWith('.log')) continue
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
  // Exits once the line is written: a pipe's write may still be pending (macOS), and the plugin shows this reason.
  const fail = (message, logTail) => new Promise(() => process.stdout.write(JSON.stringify({ type: 'fatal', message, logTail }) + '\n', () => process.exit(1)))
  process.stdout.on('error', () => process.exit(0))
  const parent = process.ppid
  // Windows never reparents an orphan: there the parent's pid stops answering instead.
  setInterval(() => {
    if (process.ppid !== parent || !isAlive(parent)) process.exit(0)
  }, 1000).unref()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))
  let version
  try {
    version = codexVersion(codexPath)
  } catch (error) {
    await fail(error.message, '')
  }
  const registry = await serveRegistry()

  const key = sessionKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'default'
  const base = privateBase()
  const dir = path.join(base, `${key}-${BUILD}`)

  const logTail = () => {
    try {
      return fs.readFileSync(logPathOf(dir), 'utf8').slice(-2000)
    } catch {
      return ''
    }
  }
  const me = `relay ${process.pid}`

  let state = await probe(dir, HEALTH_TRIES)
  const other = state === 'up' ? null : await otherDaemon(base, key)
  // A reload onto another build while turns run on the old build's daemon: drive that one, so no turn is lost.
  const target = isBusy(other?.health) ? other.dir : dir
  if (target !== dir) drain(other)
  else if (state !== 'up') {
    // A daemon whose pid lives but that does not answer is busy, not gone: starting another over it would lose its turns.
    const owner = recordedPid(dir)
    if (state === 'silent' && owner !== null && isAlive(owner)) {
      note(dir, `${me}: daemon ${owner} did not answer /health ${HEALTH_TRIES} times in ${HEALTH_TIMEOUT_MS} ms; its pid lives, waiting for it`)
      state = await untilUp(dir, owner, LIVE_WAIT_MS)
      note(dir, `${me}: daemon ${owner} ${state === 'up' ? 'answered' : state === 'gone' ? 'is gone' : `still has not answered after ${LIVE_WAIT_MS} ms; not starting another over it`}`)
      if (state === 'timeout') await fail(`the daemon (pid ${owner}) runs but has not answered for ${(HEALTH_TRIES * HEALTH_TIMEOUT_MS + LIVE_WAIT_MS) / 1000} s; the next codex call tries again. If it stays stuck, end that process.`, logTail())
    }
    if (state !== 'up') {
      note(dir, `${me}: ${owner === null ? 'no daemon' : `daemon ${owner} is gone (${state})`}; launching one for Codex ${version ?? '(unknown version)'}`)
      // An idle one would only hold threads this build's daemon must resume.
      if (other) stopDaemon(other.dir, other.health)
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
      fs.mkdirSync(dir, { mode: 0o700 })
      const launcher = spawn(process.execPath, [SELF, '--launch', codexPath, dir], { detached: true, stdio: 'ignore', windowsHide: true })
      await new Promise(resolve => launcher.on('exit', resolve))
      const daemonPid = recordedPid(dir)
      const started = daemonPid === null ? 'gone' : await untilUp(dir, daemonPid, 30_000)
      if (started !== 'up') {
        note(dir, `${me}: daemon ${daemonPid} ${started === 'gone' ? 'exited' : 'did not start in 30 s'}`)
        await fail(started === 'gone' ? 'the daemon exited' : 'daemon did not start in 30 s', logTail())
      }
    }
  }

  const socketPath = addressOf(target)
  // The relay's parent is Claude Code itself: the daemon keeps codex while that process lives, relay or not.
  const res = await request(socketPath, 'GET', `/events?relay=${process.pid}&claude=${parent}`, 0)
  res.setEncoding('utf8')
  const lines = readline.createInterface({ input: res })
  let first = true
  for await (const line of lines) {
    if (first) {
      first = false
      const hello = JSON.parse(line)
      // oldBuild: this relay drives another build's daemon, so the plugin's update applies once its turns end.
      out({ type: 'ready', socket: socketPath, registry: registry.address, reattached: hello.reattached, active: hello.active, codexVersion: version, ...(target !== dir && { oldBuild: { build: other.health.build ?? null, turns: Object.keys(hello.active ?? {}).length } }) })
      continue
    }
    process.stdout.write(line + '\n')
  }
  process.exit(0)
}

function launch(codexPath, dir) {
  try {
    const size = fs.statSync(logPathOf(dir)).size
    if (size > LOG_CAP) {
      const kept = Buffer.alloc(LOG_KEEP)
      const fd = fs.openSync(logPathOf(dir), 'r')
      fs.readSync(fd, kept, 0, LOG_KEEP, size - LOG_KEEP)
      fs.closeSync(fd)
      fs.writeFileSync(logPathOf(dir), kept)
    }
  } catch {}
  const log = fs.openSync(logPathOf(dir), 'a', 0o600)
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
