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
//           reload loses a turn. It first runs `codex --version` (a CLI that
//           does not run is a fatal line saying what to do). First line:
//           {"type":"ready","socket",...,"codexVersion"}. It exits when its parent goes away,
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
//             POST /operation {id, method, params, resumeParams?} -> retained pending/completed outcome
//             POST /operation/poll {id, timeoutMs} -> same outcome (20 s maximum)
//             POST /operation/ack {id} -> acknowledges binding/consumption
//             POST /thread-state {threadId} -> lifecycle, activeTurnId, pending resume handle
//             POST /release {threadId, turnId?} -> schedules acknowledged eventual unsubscribe
//             POST /reply {id, result} | {id, error}   answers a server request
//             POST /wait  {threadId, turnId?, msgKey?, timeoutMs} long-poll for exact turn end or a codex-msg message
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
import { serveRegistry } from './registry.mjs'
import { writerStatus } from './writer-owner.mjs'

const GRACE_MS = 20_000
const IDLE_MS = Number(process.env.CODEX_BRIDGE_IDLE_MS) > 0 ? Number(process.env.CODEX_BRIDGE_IDLE_MS) : 10 * 60_000
const IDLE_CHECK_MS = Number(process.env.CODEX_BRIDGE_IDLE_CHECK_MS) > 0 ? Number(process.env.CODEX_BRIDGE_IDLE_CHECK_MS) : 60_000
/** Half the idle window, so a daemon about to idle out itself still stops an idle legacy one. */
const LEGACY_IDLE_MS = IDLE_MS / 2
const DRAIN_CHECK_MS = 5_000
const BUFFER_CAP = 5_000
const MAILBOX_CAP = 50
const MESSAGE_CAP = 20_000
/**
 * How long a failed turn/completed is held back. Codex has reported a turn failed
 * ("Selected model is at capacity", "Error running remote compact task") and then
 * kept working on the thread; work on it within this window drops the failure.
 */
const FAILED_HOLD_MS = Number(process.env.CODEX_BRIDGE_FAILED_HOLD_MS) || 30_000
const RELEASE_RETRY_MS = Number(process.env.CODEX_BRIDGE_RELEASE_RETRY_MS) || 2_000
const ABANDONED_OPERATION_MS = Number(process.env.CODEX_BRIDGE_ABANDONED_OPERATION_MS) || 120_000
const SHUTDOWN_GRACE_MS = 1_000
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
    // The CLI wrapper, native app-server, and its stdio MCP children must share
    // an owned process group independent of the daemon's own group.
    detached: !IS_WINDOWS,
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
  const failedHolds = new Map() // exact thread/turn -> held completion and timer
  const terminalTurns = new Map() // exact thread/turn -> terminal tombstone
  const supersededTurns = new Set() // an older start cannot replace a newer observed turn
  const latestTurn = new Map() // threadId -> newest observed turnId
  const waiters = new Map() // exact thread/turn -> Set<(value) => void>
  const threads = new Map() // threadId -> lifecycle state and generation
  const threadQueues = new Map()
  const releases = new Map() // threadId -> cleanup ownership, retained through rejected/late ACKs
  const interruptions = new Map() // exact stop intent survives wrapper/HTTP cancellation
  const operations = new Map() // caller operation id -> retained outcome, independent of HTTP
  let lifecycleRevision = 0
  const turnKey = (threadId, turnId) => JSON.stringify([threadId, turnId])
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
  // Foreground ownership survives HTTP cancellation and includes operations
  // queued behind cleanup. Repeated cleanup failures alone must not keep the
  // app-server and its MCP processes resident forever.
  let foregroundRuns = 0
  let lastWork = Date.now()

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
      const timer = timeoutMs === null ? null : setTimeout(() => {
        pending.delete(id)
        resolve({ error: { code: -32000, message: `${method} timed out after ${timeoutMs} ms` } })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      writeCodex(params === undefined ? { id, method } : { id, method, params })
    })

  const settleWaiters = (threadId, turnId, value) => {
    const key = turnKey(threadId, turnId)
    const set = waiters.get(key)
    if (!set) return
    waiters.delete(key)
    for (const done of set) done(value)
  }

  const onThread = (threadId, work) => {
    const run = (threadQueues.get(threadId) ?? Promise.resolve()).then(work)
    const tail = run.catch(() => {})
    threadQueues.set(threadId, tail)
    void tail.then(() => { if (threadQueues.get(threadId) === tail) threadQueues.delete(threadId) })
    return run
  }
  const threadState = threadId => {
    const owned = [...operations.values()].filter(op => op.threadId === threadId && !op.acknowledged && !op.answer?.error)
    const operation = owned.find(op => op.method === 'thread/resume')
    const admission = owned.find(op => op.method === 'turn/start')
    return { status: threads.get(threadId)?.status ?? 'unknown', activeTurnId: active.get(threadId) ?? null, ...(operation ? { operationId: operation.id } : {}), ...(admission ? { pendingOperationId: admission.id } : {}) }
  }
  const markLoaded = threadId => {
    const state = threads.get(threadId)
    threads.set(threadId, { status: 'loaded', generation: (state?.generation ?? 0) + 1, observedAt: ++lifecycleRevision })
    releases.delete(threadId)
  }
  const observeStart = (threadId, turnId) => {
    const key = turnKey(threadId, turnId)
    if (terminalTurns.has(key) || supersededTurns.has(key)) return false
    const previous = latestTurn.get(threadId)
    if (previous && previous !== turnId) supersededTurns.add(turnKey(threadId, previous))
    if (!threads.has(threadId)) markLoaded(threadId)
    const release = releases.get(threadId)
    if (release) releases.delete(threadId)
    threads.get(threadId).status = 'loaded'
    latestTurn.set(threadId, turnId)
    active.set(threadId, turnId)
    threads.get(threadId).observedAt = ++lifecycleRevision
    return true
  }
  const serverRunningTurn = thread => thread?.turns?.findLast(turn => turn.status === 'inProgress')
  const idleThread = thread => ['idle', 'systemError', 'notLoaded'].includes(thread?.status?.type ?? thread?.status) && !serverRunningTurn(thread)
  const pendingUse = threadId => [...operations.values()].some(op => op.status === 'pending' && op.params?.threadId === threadId && ['thread/resume', 'turn/start'].includes(op.method))
  const compactOperation = op => {
    delete op.params
    if (op.answer?.result) {
      const result = op.answer.result
      op.answer = { result: {
        ...(result.thread?.id ? { thread: { id: result.thread.id } } : {}),
        ...(result.turn?.id ? { turn: { id: result.turn.id, status: result.turn.status } } : {}),
        ...(typeof result.model === 'string' ? { model: result.model } : {}),
      } }
    }
  }
  const compactReleasedOperations = threadId => {
    for (const op of operations.values()) {
      if (op.status === 'completed' && ['thread/start', 'thread/resume', 'turn/start'].includes(op.method) && op.threadId === threadId) compactOperation(op)
    }
  }

  // A release is a daemon-owned intent. It survives HTTP cancellation, RPC rejection,
  // and lost notifications; a later load/start waits behind the actual unsubscribe.
  const requestRelease = (threadId, turnId) => {
    const state = threads.get(threadId)
    if (!state || ['unsubscribed', 'closed'].includes(state.status)) return threadState(threadId)
    if (pendingUse(threadId)) return threadState(threadId)
    if (active.has(threadId) || (turnId && latestTurn.get(threadId) !== turnId)) return threadState(threadId)
    if (!releases.has(threadId)) releases.set(threadId, { turnId, generation: state.generation, nextAttempt: Date.now(), running: false })
    state.status = 'releasePending'
    return threadState(threadId)
  }
  const releasePending = async (threadId, release) => {
    if (release.running || release.nextAttempt > Date.now()) return
    release.running = true
    try {
      await onThread(threadId, async () => {
        const state = threads.get(threadId)
        if (releases.get(threadId) !== release || state?.generation !== release.generation || active.has(threadId)) return
        const read = await rpc('thread/read', { threadId, includeTurns: true }, 10_000)
        if (releases.get(threadId) !== release || state.generation !== release.generation || active.has(threadId)) return
        const running = serverRunningTurn(read.result?.thread)
        if (running) { observeStart(threadId, running.id); return }
        if (read.error || !idleThread(read.result?.thread)) return
        // Admission can happen while thread/read is awaiting its response. The
        // admitted operation owns the next decision and runs after this queue item.
        if (pendingUse(threadId)) {
          releases.delete(threadId)
          state.status = 'loaded'
          return
        }
        // No timeout: a late ACK still owns this release and serializes a new load.
        const answer = await rpc('thread/unsubscribe', { threadId }, null)
        if (!answer.error && ['unsubscribed', 'notSubscribed', 'notLoaded'].includes(answer.result?.status)) {
          state.status = answer.result.status === 'notLoaded' ? 'closed' : 'unsubscribed'
          releases.delete(threadId)
          compactReleasedOperations(threadId)
          emit({ type: 'notification', method: 'thread/released', params: { threadId, status: state.status } })
        }
      })
    } finally {
      release.running = false
      release.nextAttempt = Date.now() + RELEASE_RETRY_MS
    }
  }
  const runRpc = async (method, params, timeoutMs = null, resumeParams) => {
    const foreground = !['thread/read', 'thread/unsubscribe'].includes(method)
    if (foreground) { foregroundRuns += 1; lastWork = Date.now() }
    const work = async () => {
      // Decisions in disconnected/reloaded hooks can race. Admission is the
      // daemon's responsibility too: queueing two starts must not start two turns.
      if (method === 'turn/start' && active.has(params?.threadId)) {
        return { error: { code: -32006, message: 'the thread already has an active turn; steer or reconcile it first', data: { kind: 'activeTurn' } } }
      }
      if (method === 'turn/start' && resumeParams && threads.get(params.threadId)?.status !== 'loaded') {
        const resumedAt = lifecycleRevision
        const resumed = await rpc('thread/resume', resumeParams, null)
        if (resumed.error) return resumed
        if ((threads.get(params.threadId)?.observedAt ?? 0) <= resumedAt) markLoaded(params.threadId)
      }
      if (method === 'turn/start' && active.has(params?.threadId)) {
        return { error: { code: -32006, message: 'the thread became active while resuming; steer or reconcile it first', data: { kind: 'activeTurn' } } }
      }
      const admittedAt = lifecycleRevision
      const answer = await rpc(method, params, timeoutMs)
      if (!answer.error) {
        if (['thread/start', 'thread/resume'].includes(method) && answer.result?.thread?.id && (threads.get(answer.result.thread.id)?.observedAt ?? 0) <= admittedAt) markLoaded(answer.result.thread.id)
        if (method === 'turn/start' && answer.result?.turn?.id && params?.threadId) observeStart(params.threadId, answer.result.turn.id)
      }
      return answer
    }
    try {
      return await (params?.threadId && ['thread/resume', 'turn/start', 'thread/unsubscribe'].includes(method) ? onThread(params.threadId, work) : work())
    } finally {
      if (foreground) { foregroundRuns -= 1; lastWork = Date.now() }
    }
  }
  const reconcileTerminal = async (threadId, turnId, timeoutMs) => {
    const key = turnKey(threadId, turnId)
    if (!turnId || terminalTurns.has(key) || failedHolds.has(key)) return
    const answer = await rpc('thread/read', { threadId, includeTurns: true }, Math.min(timeoutMs, 1_000))
    const observed = answer.result?.thread?.turns?.find(turn => turn.id === turnId)
    // Native Codex may project an unfinished persisted turn as interrupted.
    // Without a completion time that is not a terminal receipt. An already
    // observed non-success notification keeps ownership of its reconciliation.
    const terminalReceipt = observed && ['completed', 'failed', 'interrupted'].includes(observed.status)
      && (observed.status !== 'interrupted' || Number.isFinite(observed.completedAt))
    if (terminalReceipt && idleThread(answer.result?.thread) && !failedHolds.has(key)) {
      onCodexMessage({ method: 'turn/completed', params: { threadId, turn: observed } })
    }
  }
  const interrupt = (threadId, requestedTurnId) => {
    const admission = [...operations.values()].find(op => op.threadId === threadId && op.method === 'turn/start' && op.status === 'pending')
    const turnId = requestedTurnId ?? active.get(threadId) ?? (admission ? null : latestTurn.get(threadId)) ?? null
    const existing = interruptions.get(threadId)
    if (existing && existing.turnId === turnId && existing.pendingId === admission?.id) return existing
    const stop = { turnId, pendingId: admission?.id, running: false, attempts: 0 }
    interruptions.set(threadId, stop)
    void driveInterrupt(threadId, stop)
    return stop
  }
  const driveInterrupt = async (threadId, stop) => {
    if (stop.running || stop.attempts >= 3) return
    stop.running = true
    try {
      // An admitted start can outlive the hook. finishOperation re-enters here
      // after its exact outcome is known; do not block the admission queue.
      if (pendingUse(threadId)) return
      stop.turnId ??= active.get(threadId) ?? null
      if (!stop.turnId || terminalTurns.has(turnKey(threadId, stop.turnId))) return
      for (; stop.attempts < 3; ) {
        if (active.get(threadId) !== stop.turnId || terminalTurns.has(turnKey(threadId, stop.turnId))) return
        stop.attempts += 1
        await rpc('turn/interrupt', { threadId, turnId: stop.turnId }, 2_000)
        await reconcileTerminal(threadId, stop.turnId, 500)
        // An RPC acknowledgement is not a turn-end receipt. Only the reconciled
        // terminal notification/read may change the job to interrupted.
        if (terminalTurns.has(turnKey(threadId, stop.turnId))) return
        await new Promise(resolve => setTimeout(resolve, 250 * stop.attempts))
      }
    } finally { stop.running = false }
  }
  const operationAnswer = op => ({ operationId: op.id, status: op.status, ...(op.answer ?? {}) })
  const finishOperation = (op, answer) => {
    op.answer = answer
    op.status = 'completed'
    op.completedAt = Date.now()
    const threadId = op.params?.threadId ?? answer.result?.thread?.id
    op.threadId = threadId
    const turnId = latestTurn.get(threadId)
    // A terminal notification may precede its start/resume response. Its first
    // release was fenced by this pending operation, so reconcile after settlement,
    // including rejected admissions that left an earlier terminal turn loaded.
    if (threadId && turnId && terminalTurns.has(turnKey(threadId, turnId)) && !active.has(threadId)) requestRelease(threadId, turnId)
    for (const done of op.waiters) done(operationAnswer(op))
    op.waiters.clear()
    const stop = interruptions.get(threadId)
    if (stop) {
      if (op.method === 'turn/start') stop.turnId ??= answer.result?.turn?.id ?? null
      void driveInterrupt(threadId, stop)
    }
  }
  setInterval(() => {
    for (const [threadId, release] of releases) void releasePending(threadId, release).catch(() => {})
    for (const op of operations.values()) {
      if (op.acknowledged || op.status !== 'completed' || op.answer?.error || Date.now() - op.completedAt < ABANDONED_OPERATION_MS) continue
      if (!['thread/start', 'thread/resume'].includes(op.method)) continue
      const threadId = op.answer.result?.thread?.id ?? op.params?.threadId
      if (threadId) requestRelease(threadId)
    }
  }, Math.min(RELEASE_RETRY_MS, 1_000)).unref()

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
    const turnId = params.turn?.id ?? params.turnId
    const key = turnKey(params.threadId, turnId)
    if (method === 'turn/started' && turnId && !observeStart(params.threadId, turnId)) return
    // Items are evidence only for their exact live turn; old delayed items never
    // resurrect a terminal turn or cancel another turn's failure observation.
    if (method.startsWith('item/') && (terminalTurns.has(key) || active.get(params.threadId) !== turnId)) return
    if (method === 'thread/closed') {
      const state = threads.get(params.threadId)
      if (state?.status === 'unsubscribed' && !active.has(params.threadId)) { state.status = 'closed'; releases.delete(params.threadId); compactReleasedOperations(params.threadId) }
    }
    if (method === 'serverRequest/resolved' && params.requestId !== undefined) outstanding.delete(params.requestId)
    if (isTurnEnd && ['failed', 'interrupted'].includes(params.turn.status)) {
      if (!failedHolds.has(key) && !terminalTurns.has(key)) {
        const held = { params, timer: null }
        failedHolds.set(key, held)
        const reconcile = async () => {
          if (failedHolds.get(key) !== held) return
          if (latestTurn.get(params.threadId) !== turnId) { failedHolds.delete(key); endTurn(params); return }
          const answer = await rpc('thread/read', { threadId: params.threadId, includeTurns: true }, 10_000)
          if (failedHolds.get(key) !== held) return
          const running = serverRunningTurn(answer.result?.thread)
          if (running || answer.error || !idleThread(answer.result?.thread)) {
            if (running && running.id !== turnId) observeStart(params.threadId, running.id)
            held.timer = setTimeout(reconcile, RELEASE_RETRY_MS)
          } else { failedHolds.delete(key); endTurn(params) }
        }
        held.timer = setTimeout(reconcile, FAILED_HOLD_MS)
      }
    } else if (isTurnEnd) {
      const held = failedHolds.get(key)
      if (held) { clearTimeout(held.timer); failedHolds.delete(key) }
      endTurn(params)
    }
    else if (!isNoise(method)) emit({ type: 'notification', method, params })
  }

  const endTurn = params => {
    const key = turnKey(params.threadId, params.turn.id)
    if (terminalTurns.has(key)) return
    terminalTurns.set(key, params.turn)
    if (active.get(params.threadId) === params.turn.id) active.delete(params.threadId)
    if (!latestTurn.has(params.threadId) || latestTurn.get(params.threadId) === params.turn.id) lastTurn.set(params.threadId, params.turn)
    if (threads.has(params.threadId) && latestTurn.get(params.threadId) === params.turn.id) threads.get(params.threadId).observedAt = ++lifecycleRevision
    lastWork = Date.now()
    emit({ type: 'notification', method: 'turn/completed', params })
    settleWaiters(params.threadId, params.turn.id, { status: 'completed', turn: params.turn })
    requestRelease(params.threadId, params.turn.id)
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

  let shuttingDown = false
  const shutdown = code => {
    if (shuttingDown) return
    shuttingDown = true
    const stopGroup = signal => {
      if (IS_WINDOWS) { stopTree(codex.pid); return }
      // The group remains ours even if its leader has exited; stopping only
      // the wrapper PID leaves its native app-server/MCP descendants behind.
      try { process.kill(-codex.pid, signal) } catch {}
    }
    stopGroup('SIGTERM')
    cleanup()
    // End the relay's stream before exiting, so the relay reads an ordinary end, not a reset.
    if (subscriber) subscriber.end()
    subscriber = null
    // Escalate before this daemon exits, including after the leader exits on
    // TERM. A stubborn grandchild must not outlive the cleanup backstop.
    setTimeout(() => stopGroup('SIGKILL'), SHUTDOWN_GRACE_MS)
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS + 100)
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
    pending.clear()
    shutdown(code ?? 1)
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
      if (shuttingDown) return sendJson(res, 503, { error: { code: -32001, message: 'codex bridge is shutting down' } })
      const url = new URL(req.url ?? '/', 'http://bridge')
      // On Windows any local process or web page reaches the port: only the secret's holders get past it.
      if (secret) {
        if (!url.pathname.startsWith(`/${secret}/`)) return sendJson(res, 403, { error: { message: 'forbidden' } })
        url.pathname = url.pathname.slice(secret.length + 1)
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, pid: process.pid, codexPid: codex.pid, build: BUILD, active: Object.fromEntries(active), loaded: [...threads.values()].filter(state => state.status === 'loaded').length, releasing: releases.size, pendingOperations: [...operations.values()].filter(op => op.status === 'pending').length, pendingRequests: pending.size })
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
      if (url.pathname === '/writer-status') return sendJson(res, 200, writerStatus(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), body.threadId))
      if (url.pathname === '/interrupt') {
        if (typeof body.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.threadId) || (body.turnId != null && typeof body.turnId !== 'string')) return sendJson(res, 400, { error: { message: 'valid threadId and optional turnId required' } })
        const stop = interrupt(body.threadId, body.turnId)
        // The worker owns the stop even if this HTTP request is cancelled.
        const deadline = Date.now() + 2_000
        while (Date.now() < deadline && (!stop.turnId || !terminalTurns.has(turnKey(body.threadId, stop.turnId)))) {
          if (stop.attempts >= 3 && !stop.running) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const turn = stop.turnId && terminalTurns.get(turnKey(body.threadId, stop.turnId))
        return sendJson(res, 200, turn ? { status: 'completed', turn } : { status: 'stillRunning' })
      }
      if (url.pathname === '/thread-state') return sendJson(res, 200, threadState(body.threadId))
      if (url.pathname === '/release') return sendJson(res, 200, requestRelease(body.threadId, body.turnId))
      if (url.pathname === '/operation') {
        if (typeof body.id !== 'string' || !body.id || typeof body.method !== 'string') return sendJson(res, 400, { error: { code: -32602, message: 'operation id and method required' } })
        if (body.resumeParams !== undefined && (body.method !== 'turn/start' || !body.params?.threadId || body.resumeParams?.threadId !== body.params.threadId)) return sendJson(res, 400, { error: { code: -32602, message: 'resumeParams must belong to the turn/start thread' } })
        // JSON payload equality is deterministic for the submitting hook; object
        // key order does not change the operation's meaning.
        const canonical = value => value && typeof value === 'object' ? (Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))) : value
        const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ method: body.method, params: body.params, resumeParams: body.resumeParams }))).digest('hex')
        let op = operations.get(body.id)
        if (op && op.fingerprint !== fingerprint) return sendJson(res, 409, { error: { code: -32602, message: 'operation id already belongs to a different request' } })
        if (!op) {
          op = { id: body.id, method: body.method, params: body.params, threadId: body.params?.threadId, fingerprint, status: 'pending', acknowledged: false, waiters: new Set() }
          operations.set(op.id, op)
          void runRpc(op.method, op.params, null, body.resumeParams).then(answer => finishOperation(op, answer), () => finishOperation(op, { error: { code: -32001, message: 'bridge operation failed' } }))
        }
        return sendJson(res, 200, operationAnswer(op))
      }
      if (url.pathname === '/operation/poll' || url.pathname === '/operation/ack') {
        const op = operations.get(body.id)
        if (!op) return sendJson(res, 404, { error: { code: -32004, message: 'unknown operation' } })
        if (url.pathname === '/operation/ack') {
          if (op.status !== 'completed') return sendJson(res, 409, { error: { code: -32005, message: 'operation is still pending' } })
          op.acknowledged = true
          // The caller has durably bound/consumed this outcome. Keep the handle
          // and digest for dedupe, but stop retaining request config/prompt bodies
          // or complete thread histories for the daemon's whole lifetime.
          compactOperation(op)
          return sendJson(res, 200, { ok: true })
        }
        if (op.status === 'completed') return sendJson(res, 200, operationAnswer(op))
        const answer = await new Promise(resolve => {
          const done = value => { clearTimeout(timer); op.waiters.delete(done); resolve(value) }
          const timer = setTimeout(() => done(operationAnswer(op)), Math.max(1, Math.min(Number(body.timeoutMs) || 20_000, 20_000)))
          op.waiters.add(done)
          res.on('close', () => { clearTimeout(timer); op.waiters.delete(done) })
        })
        return sendJson(res, 200, answer)
      }
      if (url.pathname === '/rpc') {
        if (typeof body.method !== 'string') return sendJson(res, 400, { error: { message: 'method required' } })
        const answer = await runRpc(body.method, body.params, body.timeoutMs ?? 60_000)
        return sendJson(res, 200, answer)
      }
      if (url.pathname === '/reply') {
        if (!outstanding.has(body.id)) return sendJson(res, 404, { error: { message: `no open server request ${body.id}` } })
        outstanding.delete(body.id)
        lastWork = Date.now()
        writeCodex(body.error !== undefined ? { id: body.id, error: body.error } : { id: body.id, result: body.result })
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/wait') {
        const { threadId, msgKey } = body
        const turnId = body.turnId ?? active.get(threadId) ?? latestTurn.get(threadId)
        const key = turnKey(threadId, turnId)
        // The hook host aborts HTTP at 30 s. Bound even legacy callers' waits.
        const timeoutMs = Math.max(1, Math.min(Number(body.timeoutMs) || 20_000, 20_000))
        const deadline = Date.now() + timeoutMs
        // Messages first: a job may send one and end its turn before the next poll.
        if (msgKey && mailboxes.get(msgKey)?.length) return sendJson(res, 200, { status: 'message', messages: drainMail(msgKey) })
        // Notifications can be lost across a reconnect. Reconcile the requested
        // exact turn, never a thread's newest unrelated completion. The read is
        // bounded inside this poll's budget and has no mutating side effects.
        await reconcileTerminal(threadId, turnId, timeoutMs)
        if (terminalTurns.has(key)) {
          requestRelease(threadId, turnId)
          return sendJson(res, 200, { status: 'completed', turn: terminalTurns.get(key) })
        }
        if (!active.has(threadId) && !body.turnId) return sendJson(res, 200, { status: 'idle', turn: lastTurn.get(threadId) ?? null })
        const answer = await new Promise(resolve => {
          const set = waiters.get(key) ?? new Set()
          waiters.set(key, set)
          const mail = msgKey ? (mailWaiters.get(msgKey) ?? new Set()) : null
          if (mail) mailWaiters.set(msgKey, mail)
          const done = value => {
            clearTimeout(timer)
            set.delete(done)
            if (set.size === 0) waiters.delete(key)
            mail?.delete(done)
            resolve(value === MAIL ? { status: 'message', messages: drainMail(msgKey) } : value)
          }
          const timer = setTimeout(() => done({ status: 'timeout', turnId: active.get(threadId) ?? null }), Math.max(1, deadline - Date.now()))
          set.add(done)
          mail?.add(done)
          res.on('close', () => { clearTimeout(timer); set.delete(done); mail?.delete(done); if (set.size === 0) waiters.delete(key) })
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
        lastWork = Date.now()
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
    if (active.size > 0 || foregroundRuns > 0 || outstanding.size > 0) lastWork = Date.now()
    else if (subscriber && Date.now() - lastWork >= IDLE_MS) shutdown(0)
    stopIdleLegacy().catch(error => process.stderr.write(`legacy daemon sweep failed: ${error.message}\n`))
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
    throw new Error(`cannot run the Codex CLI ${codexPath} (${why}). Install or update it (npm i -g @openai/codex@latest, or update the ChatGPT app on macOS), or set the plugin's codexPath.`)
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

const isBusy = health => Object.keys(health?.active ?? {}).length > 0 || (health?.pendingRequests ?? 0) > 0 || (health?.releasing ?? 0) > 0

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
        await fail(!isRunning ? 'the daemon exited' : 'daemon did not start in 30 s', logTail)
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
      out({ type: 'ready', socket: socketPath, registry: registry.address, reattached: hello.reattached, active: hello.active, codexVersion: version })
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
