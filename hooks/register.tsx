// codex: OpenAI Codex jobs as native background subagents of this Claude session.
//
//   Agent({ subagent_type: "codex:<alias>" }) --agent.spawn--> this module starts
//   the Codex turn with the spawn's own prompt, keyed by the new agentId; the
//   subagent's loop is answered by turn.step here (no Claude model runs): it
//   calls codex_await until the turn ends, then answers the Codex final message.
//
//   this module --$.http.fetch(socketPath)--> bin/bridge.mjs daemon
//   --stdio JSON-RPC--> codex app-server; the relay's stdout (NDJSON events)
//   --$.process.spawn--> onEvent
//
// Every engine call lives in this file (the engine follows `$` only within
// one file); hooks/model.ts holds the pure logic it calls.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFailure, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { CodexAgent, CodexApprovals, CodexSandbox, OutboxItem } from '../types'
import {
  AGENT_PREFIX,
  agentSpecs,
  aliasOf,
  aliasOfType,
  afterTurnEnd,
  CAPACITY_RETRY_MS,
  approvalAnswer,
  approvalDigest,
  approvalOptions,
  approvalQuestion,
  autoReviewDigest,
  AWAIT_TOOL,
  HANDBACK_TOOL,
  configDirs,
  type Defaults,
  effectiveDefaults,
  parseHeader,
  parseProjectConfig,
  permissionsFor,
  PROJECT_CONFIG,
  type BridgeEvent,
  bridgeStopReason,
  bridgeTarget,
  byThread,
  codexVersionError,
  clip,
  CodexError,
  describeAgent,
  findIn,
  firstLine,
  fromAgent,
  handBackKey,
  isHandedBack,
  isRecent,
  noNewTurn,
  sessionJob,
  RECENT_FINISHED_MS,
  rosterText,
  isLive,
  listText,
  outputText,
  rowArgs,
  rowResult,
  runningTail,
  taskLabel,
  type ToolName,
  type Item,
  itemCompleted,
  itemStarted,
  LineBuffer,
  modelEffortError,
  nodeOptionPreloads,
  withoutPreloads,
  effortFor,
  PER_MODEL_EFFORT,
  PREFIX,
  modelFor,
  resultText,
  sandboxMode,
  approvalParams,
  sanitize,
  snapshotChanged,
  snapshotLossy,
  messagingParams,
  type MessagingParams,
  messageSummary,
  type Settings,
  sorted,
  STILL_RUNNING,
  textInput,
  threadResumeParams,
  TOOL_SPECS,
  trim,
  turnStartParams,
  uniqueName,
  type Verdict,
  verdictOf,
  wrapperAnswer,
} from './model'

type Engine = EngineInterface

// ------------------------------------------------------------ state

const agentsAtom = atom({ plugin: 'codex', key: 'agents' } as const, {})
const bridgeKeyAtom = atom({ plugin: 'codex', key: 'bridgeKey' } as const, null)

const STORE_KEY = 'agents'
/** The native transcript's row bullet and result mark. */
const DOT = '●'
const RESULT_MARK = '  ⎿  '
/** Under the 30 s after which $.http.fetch gives up on an answer. */
const POLL_SLICE_MS = 20_000
const RPC_TIMEOUT_MS = 25_000
/** TaskStop's turn/interrupt calls at most, and how long it waits after each for the turn to end. */
const INTERRUPT_ATTEMPTS = 3
const INTERRUPT_WAIT_MS = 2_000
/** How long one codex_await call blocks before the wrapper's loop calls it again. */
const AWAIT_MS = 3_600_000
/** A short wait between reads of the registry; it counts against the hook's 10 s budget. */
const SETTLE_MS = 100
/** At most this much of an await's budget goes to such short waits. */
const SETTLE_BUDGET_MS = 5_000
/** How long codex_await pauses (free of its budget) before it tries a bridge that could not be reached again. */
const BRIDGE_RETRY_MS = 10_000

// Module state starts over on a reload, which is right: a reload ends every
// in-flight wait, dialog and the bridge relay along with it.
/** A relay's start: `address` is its daemon's once `ready` was handled, null before. */
type Socket = { promise: Promise<string>; resolve: (path: string) => void; reject: (error: Error) => void; address: string | null }
let socket: Socket | null = null
/** Whether a relay of this module was ever ready: a later one that does not come up is an outage, waited out (bridgeSocket). */
let hasBeenReady = false
let registryAddress: string | null = null
let recovery: { reattached: boolean; active: Record<string, string> } | null = null
let spawnsInFlight = 0
let isBridgeRunning = false
/** Handles the running relay's `ready` again after its handling failed, on a new start; null otherwise. */
let retryReady: (() => Promise<void>) | null = null
/** The userConfig the bridge starts with; set when the module registers. */
let bridgeSettings: Settings | null = null
/** Threads this app-server connection is subscribed to (thread/start or thread/resume). */
const loadedThreads = new Set<string>()
/** Per thread, the tail of its loads, turn starts and releases, which run one at a time. */
const threadQueues = new Map<string, Promise<unknown>>()
/**
 * Per thread, the last turn this module started on it (or turn/started reported) while the bridge ran. A hook
 * may not see the $.state writes of a hook running beside it, so its record may
 * not show that turn yet.
 */
const startedTurns = new Map<string, string>()
/** Threads with a turn/start of this module in flight: their turn/started is this module's, not one Codex started itself. */
const turnStarts = new Set<string>()
/** `<threadId> <turnId>` of turns Codex ran on a stopped job that were interrupted, each once. */
const stopInterrupts = new Set<string>()
/** The node binary the bridge runs on, which Codex runs bin/codex-msg on too. */
let nodeBinary = 'node'
/** Subagents seen at turn.step that are not codex:* agents. */
const foreignAgents = new Set<string>()
let models: Map<string, string[]> | null = null
/** `codex --version` as the running bridge's relay read it; undefined from a relay that does not report it. */
let codexVersion: string | null | undefined
let askChain: Promise<unknown> = Promise.resolve()

// ------------------------------------------------------------ registry

/** Writes the agent's file; the snapshot only when recovery's view of it changed (`before` absent: a new job). */
async function afterWrite($: Engine, agents: Record<string, CodexAgent>, agent: CodexAgent, before?: CodexAgent): Promise<void> {
  await post($, '/registry/write', { agent })
  if (!before || snapshotChanged(before, agent)) await saveSnapshot($, agents)
}

/**
 * A bounded compatibility snapshot; the separate agent files are authoritative, so a failed
 * write (the store lock every session shares stayed busy past the host's short retry) is only
 * logged and the next snapshot write catches it up.
 */
async function saveSnapshot($: Engine, agents: Record<string, CodexAgent>): Promise<void> {
  try {
    await $.store.set(STORE_KEY, trim(agents))
  } catch (error) {
    $.ui.log(`codex: saving the job snapshot failed: ${errorText(error)}`, { to: 'debug' })
  }
}

/** Records a new job, its name made unique among the jobs at that moment; resolves the job as written. */
async function putAgent($: Engine, agent: CodexAgent): Promise<CodexAgent> {
  let written = agent
  const agents = await update($, agentsAtom, all => {
    written = sanitize({ ...agent, name: uniqueName(all, agent.name) })
    return { ...all, [agent.id]: written }
  })
  await afterWrite($, agents, written)
  return written
}

/** Applies `change` to the agent if it exists; resolves the agent as written. */
async function patchAgent(
  $: Engine,
  id: string,
  change: (agent: CodexAgent) => Partial<CodexAgent>,
): Promise<CodexAgent | undefined> {
  const now = await $.clock.now()
  let before: CodexAgent | undefined
  let written: CodexAgent | undefined
  const agents = await update($, agentsAtom, all => {
    const agent = all[id]
    before = agent
    if (!agent) return all
    const next = { ...agent, ...change(agent), updatedAt: Math.max(now, agent.updatedAt + 1) }
    // A job that runs again has no handed-back result: its next end is handed back.
    written = sanitize(isLive(next) ? { ...next, handedBackTurnId: null } : next)
    return { ...all, [id]: written }
  })
  if (written) await afterWrite($, agents, written, before)
  return written
}

/** Fills $.state from the store after a restart; after a reload $.state is the fresher copy. */
async function loadFromStore($: Engine): Promise<void> {
  const stored = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, CodexAgent>
  await update($, agentsAtom, live => ({ ...stored, ...live }))
}

// ------------------------------------------------------------ bridge

function newSocket(): Socket {
  let resolve!: (path: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  promise.catch(() => undefined)
  let isSettled = false
  const current: Socket = {
    promise,
    address: null,
    resolve: path => {
      if (!isSettled) current.address = path
      isSettled = true
      resolve(path)
    },
    reject: error => {
      isSettled = true
      reject(error)
    },
  }
  return current
}

/** Whether the bridge runs and is ready, so a call on it does not wait for a start. */
const isBridgeReady = () => isBridgeRunning && socket?.address != null

/** How long one budget-free pause lasts (see pause). */
const PAUSE_MS = 2_000

/**
 * Waits about `ms` inside a `$` call, which stops the hook's budget clock while it
 * runs ($.clock.sleep would spend the budget: HookBudget). Node sleeping in a child
 * is the one such call that waits without a server to answer it.
 */
async function pause($: Engine, ms: number): Promise<void> {
  try {
    await $.process.run([nodeBinary, '-e', `setTimeout(() => {}, ${ms})`], { timeoutMs: ms + 10_000 })
  } catch {
    // No node to run: a short sleep, which the budget pays, so a caller's loop does not spin.
    await $.clock.sleep(SETTLE_MS)
  }
}

/** The relay start a hook asked for, run by superviseRelays. */
type RelayRequest = { current: Socket; argv: string[]; env: Record<string, string> | undefined }
const relayRequests: RelayRequest[] = []
/** Wakes superviseRelays for a queued request; null until session.start started it. */
let wakeSupervisor: (() => void) | null = null

/**
 * Runs every relay start from the session.start dispatch, which returned and is never
 * aborted after: a $.process.spawn child dies when the dispatch that spawned it aborts
 * (its hook overran its budget or was interrupted), so a relay restarted inside a short
 * hook such as codex_await's would die with that hook. The engine offers no spawn
 * that outlives its dispatch; a session.start loop is the one long-lived context
 * (process.spawn's own example: "a child for the session's life").
 */
async function superviseRelays($: Engine): Promise<void> {
  for (;;) {
    const request = relayRequests.shift()
    if (request) {
      runRelay($, request)
      continue
    }
    await new Promise<void>(resolve => (wakeSupervisor = resolve))
  }
}

/** The configured binary when it is on disk, else (an empty setting too) its bare name, which the spawn finds on PATH. */
async function resolveBinary($: Engine, configured: string, name: string): Promise<string> {
  return configured.trim() !== '' && (await $.fs.exists(configured)) ? configured : name
}

/** How many of the relay's last stderr lines a failed start reports. */
const STDERR_TAIL = 20

/**
 * The environment the bridge runs under: NODE_OPTIONS without preloads of files
 * no longer on disk, or node exits before the bridge runs a line. Undefined when
 * nothing needs changing.
 */
async function bridgeEnv($: Engine): Promise<Record<string, string> | undefined> {
  const options = await $.env.get('NODE_OPTIONS')
  if (!options) return undefined
  const missing = new Set<string>()
  for (const file of nodeOptionPreloads(options)) if (!(await $.fs.exists(file))) missing.add(file)
  if (missing.size === 0) return undefined
  $.ui.log(`codex bridge: NODE_OPTIONS preloads missing files, left out for the bridge: ${[...missing].join(', ')}`, { to: 'debug' })
  return { NODE_OPTIONS: withoutPreloads(options, missing) }
}

/** Starts the relay, unless it runs; its events reach `onEvent` in order until the daemon exits (the session ended, or it sat idle). */
async function startBridge($: Engine): Promise<void> {
  if (isBridgeRunning) {
    // A relay whose recovery failed still runs: retry the recovery on it, not keep its rejected start.
    const retry = retryReady
    retryReady = null
    // Not awaited: the socket swaps at once, and bridgeSocket waits for its ready free of this hook's budget.
    if (retry) void retry()
    return
  }
  const settings = bridgeSettings
  if (!settings) throw new CodexError('the codex plugin is not registered')
  isBridgeRunning = true
  const current = newSocket()
  socket = current
  // Kept in $.state so a reload reattaches to the same daemon; a restart starts a new one.
  const fresh = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const key = (await update($, bridgeKeyAtom, held => held ?? fresh)) as string
  const node = await resolveBinary($, settings.nodePath, 'node')
  nodeBinary = node
  const codex = await resolveBinary($, settings.codexPath, 'codex')
  const argv = [node, `${$.plugin.root}/bin/bridge.mjs`, codex, key]
  const env = await bridgeEnv($)
  const request = { current, argv, env }
  // Without a supervisor (session.start did not fire after a reload) the relay is this hook's child.
  if (!wakeSupervisor) {
    runRelay($, request)
    return
  }
  relayRequests.push(request)
  wakeSupervisor()
}

/** Spawns one relay, at once; its events reach `onEvent` in order until it exits. */
function runRelay($: Engine, { current: first, argv, env }: RelayRequest): void {
  /** This relay's start; a retried recovery replaces it. */
  let current = first
  /** Set once the relay exited: a recovery retry armed after that would swap in a socket of its dead daemon. */
  let isOver = false
  const handle = async (line: string): Promise<void> => {
    let event: BridgeEvent
    try {
      event = JSON.parse(line) as BridgeEvent
    } catch {
      $.ui.log(`codex bridge: unreadable line ${clip(line, 200)}`, { to: 'debug' })
      return
    }
    if (event.type === 'fatal') {
      const tail = event.logTail.trim().split('\n').slice(-6).join(' | ')
      current.reject(new CodexError(`codex bridge failed: ${event.message}${tail ? ` (${clip(tail, 1200)})` : ''}`))
    }
    try {
      await onEvent($, event)
      if (event.type === 'ready') {
        current.resolve(event.socket)
        hasBeenReady = true
      }
    } catch (error) {
      if (event.type === 'ready') {
        current.reject(new CodexError(`codex recovery failed: ${errorText(error)}`))
        if (!isOver) retryReady = () => {
          current = newSocket()
          socket = current
          return handle(line)
        }
      }
      $.ui.log(`codex: handling ${clip(line, 120)} failed: ${String(error)}`, { to: 'debug' })
    }
  }

  void (async () => {
    const lines = new LineBuffer()
    const stderr = new LineBuffer()
    const stderrTail: string[] = []
    let ended = 'it exited'
    try {
      const stream = $.process.spawn({ argv, ...(env ? { env } : {}) })
      for (;;) {
        const next = await stream.next()
        if (next.done) {
          const result = next.value
          if (result) ended = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
          break
        }
        const chunk = next.value
        if (chunk.stream === 'stderr') {
          $.ui.log(`codex bridge: ${chunk.text.trimEnd()}`, { to: 'debug' })
          stderrTail.push(...stderr.push(chunk.text))
          stderrTail.splice(0, Math.max(0, stderrTail.length - STDERR_TAIL))
          continue
        }
        for (const line of lines.push(chunk.text)) await handle(line)
      }
      for (const line of lines.rest()) await handle(line)
    } catch (error) {
      ended = `it did not run: ${errorText(error)}`
      $.ui.log(`codex bridge stopped: ${String(error)}`)
    } finally {
      isOver = true
      isBridgeRunning = false
      retryReady = null
      loadedThreads.clear()
      startedTurns.clear()
      // Settles a start still waiting for `ready` with the reason; one that was ready is unaffected.
      current.reject(new CodexError(bridgeStopReason(ended, [...stderrTail, ...stderr.rest()])))
      if (socket === current) socket = null
      registryAddress = null
      recovery = null
      codexVersion = undefined
      // The next bridge may run an updated Codex CLI with other models.
      models = null
    }
  })()
}

/** Relay starts one bridgeSocket call makes after an outage: a bridge that never came up refuses at once. */
const RELAY_STARTS = 3

/** Resolves the relay's daemon address once it is ready; rejects with why it stopped. Waits in pauses, free of the hook's budget. */
async function whenReady($: Engine, current: Socket): Promise<string> {
  while (current.address === null) await Promise.race([current.promise, pause($, PAUSE_MS)])
  return current.address
}

/**
 * The daemon's socket, starting the bridge when none runs (the daemon exits when idle).
 * After an outage (a bridge that had been ready stopped) the relay is started again
 * up to RELAY_STARTS times before the call fails.
 */
async function bridgeSocket($: Engine): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    await startBridge($)
    const current = socket
    if (!current) throw new CodexError('the codex bridge is not running')
    try {
      return await whenReady($, current)
    } catch (error) {
      // A failed recovery is retried on the running relay (retryReady), also before any relay was ready (a reload's race).
      const isRecovery = error instanceof CodexError && error.message.startsWith('codex recovery failed')
      if ((!hasBeenReady && !isRecovery) || attempt >= RELAY_STARTS) throw error
      if (isRecovery) await pause($, PAUSE_MS)
      $.ui.log(`codex: the bridge stopped before it was ready again (${errorText(error)}); starting it again`, { to: 'debug' })
    }
  }
}

/** Requests one post sends while the daemon refuses connections (it is gone and a new one starts). */
const POST_ATTEMPTS = 5

/** A connection the daemon refused: the request never reached it, so sending it again cannot repeat it. */
const isUndelivered = (error: unknown) => !(error instanceof CodexError) && /ECONNREFUSED|ENOENT/.test(errorText(error))

/** A registry read or write is safe to repeat (a write keeps the newer record), so a reset connection is retried too. */
const isRegistryRetryable = (error: unknown) => !(error instanceof CodexError) && /ECONNRESET/.test(errorText(error))

async function post($: Engine, endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  const isRegistry = endpoint.startsWith('/registry/')
  for (let attempt = 1; ; attempt += 1) {
    const address = await bridgeSocket($)
    try {
      return await postAt($, isRegistry ? registryAddress ?? address : address, endpoint, body)
    } catch (error) {
      if (attempt >= POST_ATTEMPTS || !(isUndelivered(error) || (isRegistry && isRegistryRetryable(error)))) throw error
      // The relay notices its daemon is gone and exits; the next bridgeSocket starts a new one.
      await pause($, PAUSE_MS)
    }
  }
}

async function postAt($: Engine, address: string, endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  const { url, socketPath } = bridgeTarget(address, endpoint)
  const response = await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(socketPath ? { socketPath } : {}),
  })
  const parsed = JSON.parse(response.text) as Record<string, unknown>
  const error = parsed.error as { message?: string } | undefined
  if (error) throw new CodexError(error.message ?? JSON.stringify(error))
  return parsed
}

/** One JSON-RPC call to codex app-server; resolves its `result`. */
async function rpc<T>($: Engine, method: string, params: unknown): Promise<T> {
  // The bridge answers with a timeout error before $.http.fetch's own 30 s cap.
  return (await post($, '/rpc', { method, params, timeoutMs: RPC_TIMEOUT_MS })).result as T
}

type WaitAnswer =
  | { status: 'completed' | 'idle'; turn: { id?: string; status?: string; items?: Item[] } | null }
  | { status: 'message'; messages: (OutboxItem | string)[] }
  // turnId: the turn the bridge runs on the thread, which the record may not show yet.
  | { status: 'timeout'; turnId?: string | null }

/** Long-polls until the thread's turn ends or the job (named by `msgKey`) sends a codex-msg message: time inside $.http.fetch is budget-free. */
async function waitTurn($: Engine, threadId: string, timeoutMs: number, msgKey: string): Promise<WaitAnswer> {
  // $.http.fetch gives up after 30 s and takes no timeout option: poll in slices under that.
  const deadline = (await $.clock.now()) + timeoutMs
  for (;;) {
    const left = deadline - (await $.clock.now())
    const slice = Math.max(1, Math.min(left, POLL_SLICE_MS))
    const answer = (await post($, '/wait', { threadId, msgKey, timeoutMs: slice })) as unknown as WaitAnswer
    if (answer.status !== 'timeout' || left <= POLL_SLICE_MS) return answer
  }
}

/** The thread params that let a job message this session through the bridge's socket (see messagingParams). */
async function messagingFor($: Engine, msgKey: string): Promise<MessagingParams> {
  const socketPath = await bridgeSocket($)
  return messagingParams(nodeBinary, $.plugin.root, socketPath, msgKey)
}

/** Runs `work` once the thread's earlier loads, turn starts and releases have finished. */
function onThread<T>(threadId: string, work: () => Promise<T>): Promise<T> {
  const run = (threadQueues.get(threadId) ?? Promise.resolve()).then(work)
  const tail = run.catch(() => undefined)
  threadQueues.set(threadId, tail)
  void tail.then(() => {
    if (threadQueues.get(threadId) === tail) threadQueues.delete(threadId)
  })
  return run
}

/**
 * Unsubscribes from a thread whose turn ended and that runs no newer one, so
 * app-server unloads it once idle (about a minute later) and stops its MCP
 * servers: bin/codex-msg and the MCP servers of Codex's own plugins. The next
 * turn on it resumes it first (ensureLoaded).
 */
function releaseThread($: Engine, threadId: string): Promise<void> {
  return onThread(threadId, async () => {
    const agent = byThread(await read($, agentsAtom), threadId)
    if (!loadedThreads.has(threadId) || (agent && isLive(agent))) return
    loadedThreads.delete(threadId)
    await rpc($, 'thread/unsubscribe', { threadId }).catch(error =>
      $.ui.log(`codex: releasing thread ${threadId} failed: ${errorText(error)}`, { to: 'debug' }),
    )
  })
}

// ------------------------------------------------------------ operations

async function listModels($: Engine): Promise<Map<string, string[]>> {
  if (models) return models
  const found = new Map<string, string[]>()
  let cursor: string | null = null
  do {
    const page: { data: { id: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[]; nextCursor: string | null } =
      await rpc($, 'model/list', { includeHidden: true, cursor })
    for (const model of page.data) found.set(model.id, model.supportedReasoningEfforts.map(one => one.reasoningEffort))
    cursor = page.nextCursor
  } while (cursor)
  models = found
  return found
}

/** Loads the agent's thread into this app-server (after a Claude restart). */
async function ensureLoaded($: Engine, agent: CodexAgent): Promise<void> {
  if (loadedThreads.has(agent.threadId)) return
  try {
    await rpc($, 'thread/resume', threadResumeParams(agent, agent.msgKey ? await messagingFor($, agent.msgKey) : undefined))
  } catch (error) {
    if (error instanceof CodexError && error.message.includes('active writer')) {
      throw new CodexError(
        `${agent.name}'s thread is still held by another Codex process: a previous bridge's (it exits about 20 s after its Claude session ends, and after a reload onto another plugin version once it runs no turn) or another live session's. Try again shortly.`,
      )
    }
    throw error
  }
  loadedThreads.add(agent.threadId)
}

type JobInput = {
  description: string
  name: string
  model: string
  effort: string
  sandbox: CodexSandbox
  approvals: CodexApprovals
  cwd: string
  msgKey: string
}

/** Starts and names the Codex thread; the turn starts once the subagent's id is known. */
async function startThread($: Engine, input: JobInput): Promise<{ threadId: string; model: string }> {
  const started = await rpc<{ thread: { id: string }; model: string }>($, 'thread/start', {
    model: input.model,
    cwd: input.cwd,
    sandbox: sandboxMode(input.sandbox),
    ...approvalParams(input.approvals),
    ephemeral: false,
    ...(await messagingFor($, input.msgKey)),
  })
  loadedThreads.add(started.thread.id)
  // Names the session in the Codex app, `codex resume` and `codex agents`; the agent runs either way.
  await rpc($, 'thread/name/set', { threadId: started.thread.id, name: input.name }).catch(error =>
    $.ui.log(`codex: naming thread ${started.thread.id} failed: ${String(error)}`, { to: 'debug' }),
  )
  return { threadId: started.thread.id, model: started.model }
}

async function newAgent($: Engine, id: string, threadId: string, input: JobInput): Promise<CodexAgent> {
  const now = await $.clock.now()
  return {
    id,
    name: input.name,
    description: input.description,
    threadId,
    model: input.model,
    effort: input.effort,
    sandbox: input.sandbox,
    approvals: input.approvals,
    cwd: input.cwd,
    status: 'starting',
    currentTurnId: null,
    lastTurnId: null,
    lastTurnStatus: null,
    lastMessage: '',
    activity: 'starting',
    tokens: 0,
    error: null,
    msgKey: input.msgKey,
    outbox: [],
    digest: [],
    startedAt: now,
    updatedAt: now,
    turnStartedAt: now,
    turnEndedAt: 0,
    sessionId: await $.session.id(),
  }
}

/** Starts a new turn, passing sandbox, approvals, model and effort again. */
function startTurn($: Engine, agent: CodexAgent, text: string): Promise<CodexAgent> {
  return onThread(agent.threadId, () => startTurnOnQueue($, agent, text))
}

/** startTurn's work, for a caller already running on the thread's queue; `capacityRetries` is set only by a capacity retry. */
async function startTurnOnQueue($: Engine, agent: CodexAgent, text: string, capacityRetries = 0): Promise<CodexAgent> {
  await ensureLoaded($, agent)
  const now = await $.clock.now()
  let started: { turn: { id: string } }
  turnStarts.add(agent.threadId)
  try {
    started = await rpc<{ turn: { id: string } }>($, 'turn/start', turnStartParams(agent, text))
    startedTurns.set(agent.threadId, started.turn.id)
  } finally {
    turnStarts.delete(agent.threadId)
  }
  const written = await patchAgent($, agent.id, current => ({
    status: 'running',
    // turn/started may already have landed with the same id
    currentTurnId: started.turn.id,
    error: null,
    warning: null,
    activity: current.currentTurnId === started.turn.id ? current.activity : 'thinking',
    turnStartedAt: now,
    // A new turn replaces a pending capacity retry; one other than such a retry starts its count over.
    capacityRetryAt: null,
    capacityRetries,
  }))
  return written ?? agent
}

/**
 * A retry of a turn that failed at capacity: "continue" on the same thread, never the original
 * prompt. A start that throws counts as a retry: the next is scheduled, or after the last the job fails.
 */
function retryWithContinue($: Engine, agent: CodexAgent): Promise<void> {
  return onThread(agent.threadId, async () => {
    // A stop (TaskStop, codex_stop) queued ahead of this retry cancels it.
    const current = (await read($, agentsAtom))[agent.id]
    if (!current || current.stoppedAt || current.status !== 'starting') return
    const retries = (agent.capacityRetries ?? 0) + 1
    // A turn started since (a message's) replaces the retry: the job follows it, if its record does not yet.
    const started = startedTurns.get(agent.threadId)
    if (started !== undefined && started !== agent.lastTurnId) {
      await patchAgent($, agent.id, current => (current.status === 'starting' && current.capacityRetryAt ? { status: 'running', currentTurnId: started, capacityRetryAt: null } : {}))
      return
    }
    try {
      await startTurnOnQueue($, agent, 'continue', retries)
      await patchAgent($, agent.id, () => ({ warning: `capacity: retried with continue (${retries} of ${CAPACITY_RETRY_MS.length})` }))
    } catch (error) {
      const now = await $.clock.now()
      const wait = CAPACITY_RETRY_MS[retries]
      // A stop (TaskStop) since leaves the job alone.
      await patchAgent($, agent.id, current => current.status !== 'starting' ? {} : wait !== undefined ? {
        capacityRetries: retries,
        capacityRetryAt: now + wait,
        warning: `capacity: the retry did not start (${errorText(error)}); retrying in ${wait / 1000} s`,
      } : {
        status: 'failed',
        capacityRetries: retries,
        capacityRetryAt: null,
        lastTurnStatus: 'failed',
        error: `the model was at capacity and the last retry did not start: ${errorText(error)}`,
        activity: 'failed',
        turnEndedAt: now,
      })
      // Queued behind this work, not awaited in it.
      if (wait === undefined) void releaseThread($, agent.threadId)
    }
  })
}

/**
 * Steers the running turn, or starts a new one when none runs. Decided on the
 * thread's queue, so two messages to an idle job start one turn, not two.
 */
function sendMessage($: Engine, agent: CodexAgent, text: string): Promise<'steered' | 'started'> {
  return onThread(agent.threadId, async () => {
    // A turn an earlier message on the queue started, unless the record saw it end.
    const started = startedTurns.get(agent.threadId)
    const turnId = started !== undefined && started !== agent.lastTurnId ? started : agent.status === 'running' ? agent.currentTurnId : null
    if (turnId) {
      try {
        await ensureLoaded($, agent)
        await rpc($, 'turn/steer', { threadId: agent.threadId, expectedTurnId: turnId, input: textInput(text) })
        return 'steered'
      } catch (error) {
        // Only Codex's refusal ("no active turn to steer", "expected active turn id ... but found ...") means the turn
        // ended: start a new one below. After any other error, a timeout above all, Codex may hold the steer already.
        if (!(error instanceof CodexError) || !/no active turn|expected active turn id/.test(error.message)) throw error
      }
    }
    await startTurnOnQueue($, agent, text)
    return 'started'
  })
}

/**
 * Jobs whose latest SendMessage session.send already put to Codex (a steer or a
 * new turn): the engine's resume that delivers it starts no turn of its own. Not
 * startedTurns against lastTurnId: an interrupted job's lost turn never becomes
 * its lastTurnId, so that check would hold its next message back.
 */
const sentToCodex = new Set<string>()

/** Per job, the Codex job whose wrapper sent its latest SendMessage, read when that message resumes the job's wrapper (#18). */
const resumers = new Map<string, string>()

/**
 * A resumed job's message as a new turn, unless session.send put it to Codex or a
 * turn runs: decided on the thread's queue, behind sendMessage's own work.
 */
function resumeTurn($: Engine, agent: CodexAgent, text: string): Promise<void> {
  const isSent = sentToCodex.delete(agent.id)
  return onThread(agent.threadId, async () => {
    const current = (await read($, agentsAtom))[agent.id] ?? agent
    if (isSent || text.trim() === '' || current.status === 'running') return
    await startTurnOnQueue($, current, text)
  })
}

/** A spawned job until its first turn started: what its record and that turn are made from. */
type FirstTurn = { threadId: string; input: JobInput; body: string; isStarting: boolean; since: number; tries: number; isStopped?: boolean }

/**
 * Spawned jobs whose first turn has not started, by subagent id. The spawn hook starts it
 * once the hook returned, free of its budget (a hook that overran it was cut between the
 * subagent's start and the turn's, and the job stayed `starting`); codex_await starts it
 * again when that start failed, or hangs past FIRST_TURN_GRACE_MS. A reload loses them.
 */
const firstTurns = new Map<string, FirstTurn>()
/** How long a first turn's start may run, past the bridge's 25 s rpc timeout and the host's 30 s fetch cap, before codex_await takes it over. */
const FIRST_TURN_GRACE_MS = 60_000

/** Writes the spawned job's record and starts its first turn; a refused turn ends the job failed with why. */
async function startFirstTurn($: Engine, id: string, job: FirstTurn): Promise<void> {
  job.isStarting = true
  job.tries += 1
  try {
    job.since = await $.clock.now()
    const agent = (await read($, agentsAtom))[id] ?? (await putAgent($, await newAgent($, id, job.threadId, job.input)))
    const started = job.tries > 1 ? startedTurns.get(job.threadId) : undefined
    const wasStopped = job.isStopped === true
    if (wasStopped) {
      // The user stopped the job (TaskStop, codex_stop) before its first turn started: it never starts.
      await patchAgent($, id, () => stoppedBeforeTurn(job.since))
      void releaseThread($, job.threadId)
    } else if (started !== undefined) {
      // An earlier try's turn/start went through and only its record write was lost.
      await patchAgent($, id, current => (current.status === 'starting' ? { status: 'running', currentTurnId: started } : {}))
    } else {
      try {
        await startTurn($, agent, job.body)
      } catch (error) {
        // The subagent runs: it ends at once with this reason as its answer.
        const now = await $.clock.now()
        await patchAgent($, id, () => ({ status: 'failed', error: `the Codex turn did not start: ${errorText(error)}`, turnEndedAt: now }))
        void releaseThread($, job.threadId)
      }
    }
    // A stop that came while the turn started interrupts it.
    if (!wasStopped && job.isStopped) await interruptTurn($, agent)
    if (firstTurns.get(id) === job) firstTurns.delete(id)
    await pushRoster($)
  } finally {
    job.isStarting = false
  }
}

/** A job the user stopped before its turn ran (its first turn, or a capacity retry, pending): it ends interrupted. */
const stoppedBeforeTurn = (now: number): Partial<CodexAgent> => ({
  status: 'interrupted', currentTurnId: null, capacityRetryAt: null, lastTurnStatus: 'interrupted',
  activity: 'stopped by the user', error: null, turnEndedAt: now, stoppedAt: now,
})

/**
 * Interrupts the turn the bridge runs on the job's thread. The bridge names it: the record
 * may hold an older turn or none (a turn a hook beside this one started, #16). An interrupt
 * can be missed: it is sent again while the bridge still reports the turn, INTERRUPT_ATTEMPTS
 * times at most. Resolves whether one was sent.
 */
async function interruptTurn($: Engine, agent: CodexAgent): Promise<boolean> {
  if (!agent.threadId) return false
  return (await interruptThread($, agent.name, agent.threadId, agent.status === 'running' ? agent.currentTurnId : null)).isSent
}

/** interruptTurn on one thread: whether an interrupt was sent, and whether the bridge still runs a turn there after the last. */
async function interruptThread($: Engine, name: string, threadId: string, turnId: string | null): Promise<{ isSent: boolean; isRunning: boolean }> {
  let isSent = false
  // One more wait than interrupts: it reads whether the last one took.
  for (let attempt = 0; attempt <= INTERRUPT_ATTEMPTS; attempt += 1) {
    const answer = (await post($, '/wait', { threadId, timeoutMs: attempt === 0 ? 1 : INTERRUPT_WAIT_MS }).catch(() => null)) as WaitAnswer | null
    // The turn ended. A bridge that does not answer leaves the record's turn to interrupt, once.
    if (answer ? answer.status !== 'timeout' : attempt > 0) return { isSent, isRunning: false }
    if (answer?.status === 'timeout') turnId = answer.turnId ?? turnId
    if (!turnId || attempt === INTERRUPT_ATTEMPTS) return { isSent, isRunning: answer !== null }
    await rpc($, 'turn/interrupt', { threadId, turnId }).catch(error =>
      $.ui.log(`codex: interrupting ${name} failed: ${errorText(error)}`),
    )
    isSent = true
  }
  return { isSent, isRunning: false }
}

/**
 * Interrupts the running turns of the sub-agents the job's thread spawned with Codex's own
 * spawn_agent, at any depth: turn/interrupt on the job's thread leaves them running (#19).
 * Resolves how many were interrupted and the threads of those still running.
 */
async function stopSubAgents($: Engine, agent: CodexAgent): Promise<{ stopped: number; running: string[] }> {
  // A daemon of an older bridge build has no /subagents: it tracks no sub-agents to stop.
  const answer = await post($, '/subagents', { threadId: agent.threadId }).catch(() => null)
  const turns = Object.entries((answer?.active ?? {}) as Record<string, string>)
  const results = await Promise.all(turns.map(([threadId, turnId]) => interruptThread($, `${agent.name}'s sub-agent ${threadId}`, threadId, turnId)))
  return {
    stopped: results.filter(result => result.isSent && !result.isRunning).length,
    running: turns.filter((_, index) => results[index]!.isRunning).map(([threadId]) => threadId),
  }
}

/**
 * Stops a job for the user (TaskStop, codex_stop), its wrapper alive or not: a pending first
 * turn or capacity retry never starts, the running Codex turn is interrupted, and other agents'
 * messages are refused until main's SendMessage resumes it. Resolves what it did, undefined
 * when no Codex job has that id.
 */
async function stopJob($: Engine, id: string): Promise<string | undefined> {
  await reconcileAgents($, undefined, id)
  const job = firstTurns.get(id)
  if (job) job.isStopped = true
  const now = await $.clock.now()
  let wasStarting = false
  const agent = await patchAgent($, id, current => {
    wasStarting = current.status === 'starting'
    return wasStarting ? stoppedBeforeTurn(now) : { stoppedAt: now, capacityRetryAt: null }
  })
  if (!agent) return job ? `Stopped ${id}: its first turn will not start.` : undefined
  if (wasStarting) void releaseThread($, agent.threadId)
  const own = agent.threadId ? await interruptThread($, agent.name, agent.threadId, agent.status === 'running' ? agent.currentTurnId : null) : { isSent: false, isRunning: false }
  const subAgents = agent.threadId ? await stopSubAgents($, agent) : { stopped: 0, running: [] }
  const stillRunning = [...(own.isRunning ? ['its own turn'] : []), ...(subAgents.running.length ? [`its sub-agent thread(s) ${subAgents.running.join(', ')}`] : [])]
  if (stillRunning.length) {
    return `${agent.name} is not stopped: Codex still runs ${stillRunning.join(' and ')} after ${INTERRUPT_ATTEMPTS} interrupts. It is marked stopped (other agents' messages do not start it); codex_stop again, or check codex_list.`
  }
  const spawned = subAgents.stopped ? `, and ${subAgents.stopped} sub-agent(s) it spawned` : ''
  if (own.isSent) return `Stopped ${agent.name}: its Codex turn was interrupted${spawned}.`
  if (subAgents.stopped) return `Stopped ${agent.name}: its own turn had ended; ${subAgents.stopped} sub-agent(s) it spawned were interrupted.`
  if (wasStarting) return `Stopped ${agent.name}: its turn will not start.`
  return `${agent.name} was not running. It is marked stopped: other agents' messages do not start it; a SendMessage from the main session does.`
}

/** Interrupts, once, a turn Codex runs on a job the user stopped; not awaited, so the event loop is never held on it. */
function interruptStopped($: Engine, agent: CodexAgent, turnId: string): void {
  const key = `${agent.threadId} ${turnId}`
  if (stopInterrupts.has(key)) return
  stopInterrupts.add(key)
  void rpc($, 'turn/interrupt', { threadId: agent.threadId, turnId }).catch(error =>
    $.ui.log(`codex: interrupting ${agent.name}'s turn after its stop failed: ${errorText(error)}`),
  )
}

// ------------------------------------------------------------ native agents

/** Whether a subagent no record names yet is a codex:* agent (its spawn hook is still starting the turn). */
async function isCodexType($: Engine, agentId: string): Promise<boolean> {
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  return info !== undefined && aliasOfType(info.type) !== undefined
}

/**
 * The Codex job a SendMessage recipient names: an agentId, or the name the Agent
 * call gave. Matched over the plugin's records too, so a job the engine no longer
 * lists (finished, or its wrapper ended) gets its turn before the engine resumes it.
 */
async function recipient($: Engine, to: string): Promise<CodexAgent | undefined> {
  const info = (await $.agent.list()).find(agent => agent.id === to || agent.name === to)
  // A listed agent of another type holds the name.
  if (info && aliasOfType(info.type) === undefined) return undefined
  const sessionId = await $.session.id()
  const match = (agents: Record<string, CodexAgent>) => (info ? agents[info.id] : undefined) ?? sessionJob(agents, sessionId, to)
  if (!info && !match(await read($, agentsAtom))) return undefined
  await reconcileAgents($, undefined, to)
  return match(await read($, agentsAtom))
}

const missingThread = (id: string) => `No saved Codex thread for agent ${id}. Its job record is missing; start a new codex:* agent. Do not retry codex_await.`

/** Native IDs remain authoritative when Claude restores agents under a different session ID. */
async function reconcileAgents($: Engine, address?: string, ref?: string): Promise<void> {
  const sessionId = await $.session.id()
  const native = (await $.agent.list()).filter(agent => aliasOfType(agent.type) !== undefined)
  // Without an address, post re-resolves the registry on each try: during a reload handover
  // the previous relay's registry refuses the first connection.
  const registry = (endpoint: string, body: unknown) =>
    address === undefined ? post($, endpoint, body) : postAt($, registryAddress ?? address, endpoint, body)
  const disk = (await registry('/registry/read', { sessionId, ids: native.map(agent => agent.id), ref })).agents as Record<string, CodexAgent>
  const now = await $.clock.now()
  const missing: Record<string, CodexAgent> = {}
  const held = await read($, agentsAtom)
  for (const info of native) {
    if (held[info.id] || disk[info.id] || spawnsInFlight > 0 || firstTurns.has(info.id)) continue
    const alias = aliasOfType(info.type) as string
    missing[info.id] = {
      ...(await newAgent($, info.id, '', {
        name: info.description || info.name || info.id, description: info.description,
        model: modelFor(new Map(), alias), effort: 'unknown', sandbox: 'read-only', approvals: 'never',
        cwd: await $.session.cwd(), msgKey: '',
      })),
      status: 'failed', error: missingThread(info.id), activity: 'missing job record', lastTurnStatus: 'failed', turnEndedAt: now,
    }
  }
  const nativeIds = new Set(native.map(agent => agent.id))
  let changed: string[] = []
  const agents = await update($, agentsAtom, live => {
    changed = Object.keys(missing)
    const all = { ...missing, ...live }
    for (const [id, agent] of Object.entries(disk)) {
      // The same write on disk wins too: the store snapshot's copy has its final message clipped (trim).
      if (!all[id]?.threadId || agent.updatedAt >= (all[id]?.updatedAt ?? -1)) all[id] = agent
      // A newer copy may be the snapshot's, its busy fields blank: those come from disk, so no write blanks them there.
      else all[id] = { ...all[id]!, ...snapshotLossy(agent) }
    }
    for (const id of nativeIds) {
      const agent = all[id]
      if (agent && agent.sessionId !== sessionId) {
        all[id] = { ...agent, sessionId, updatedAt: Math.max(now, agent.updatedAt + 1) }
        if (isLive(agent) && recovery && !recovery.reattached && !recovery.active[agent.threadId]) {
          all[id] = { ...all[id]!, status: 'interrupted', currentTurnId: null, lastTurnStatus: 'interrupted', turnEndedAt: now,
            error: 'the turn was lost when the Codex process restarted; a SendMessage to its agent starts a new turn on the thread' }
        }
        changed.push(id)
      }
    }
    return all
  })
  for (const id of changed) await registry('/registry/write', { agent: agents[id] })
  if (changed.length) await saveSnapshot($, agents)
}

/** Records how the turn the bridge reported ended, if the registry has not yet. */
async function settleTurn($: Engine, agent: CodexAgent, answer: WaitAnswer): Promise<void> {
  if (answer.status === 'timeout' || answer.status === 'message') return
  const now = await $.clock.now()
  const turn = answer.turn
  await patchAgent($, agent.id, current => {
    if (!isLive(current)) return {}
    if (turn && (current.currentTurnId === null || turn.id === current.currentTurnId)) return afterTurnEnd(current, turn, now)
    // The bridge runs no turn on the thread and its last one is not ours.
    return { status: 'failed', currentTurnId: null, lastTurnStatus: 'failed', error: 'the Codex turn was lost', turnEndedAt: now }
  })
}

/**
 * SendMessage calls this module made for a wrapper. Its tool.check hook allows
 * them: no model request made the step, so auto mode's classifier, which
 * judges a model's actions with its request, has no verdict to give.
 */
const relayCalls = new Set<string>()

/** A wrapper step that is one tool call the plugin makes. */
async function* toolStep(e: { turnId: string; index: number }, name: string, input: Record<string, unknown>): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const id = `toolu_codex_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
  if (name === 'SendMessage') relayCalls.add(id)
  yield { kind: 'tool', index: 0, id, name }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
}

/** Whether the wrapper's last step was a SubagentHandback call that failed: the engine does not offer that tool here. */
async function isHandbackRefused($: Engine, agentId: string): Promise<boolean> {
  const messages = await $.session.messages({ agentId })
  if (!Array.isArray(messages)) throw new CodexError(`reading the agent's messages failed: ${messages.deny}`)
  const last = messages.filter(message => message.role === 'assistant').at(-1)
  return last?.toolUses.some(use => use.tool === HANDBACK_TOOL && use.isError === true) ?? false
}

/** Per wrapper, the report its last SubagentHandback call carried: where the engine refuses that call, the same text follows as the final answer. */
const handBackTexts = new Map<string, string>()

/** Whether `to` names a Codex job of this session that runs or finished recently, its wrapper ended or not: a peer's message reaches it. */
async function isReachableJob($: Engine, to: string): Promise<boolean> {
  const job = sessionJob(await read($, agentsAtom), await $.session.id(), to)
  return job !== undefined && job.threadId !== '' && isRecent(job, await $.clock.now())
}

/** A bridge or record from before 1.0 holds bare texts, all for main. */
const outboxItem = (item: OutboxItem | string): OutboxItem => (typeof item === 'string' ? { text: item } : item)

/** Holds codex-msg messages until the wrapper's loop passes them on with SendMessage. */
async function queueMessages($: Engine, agentId: string, messages: readonly (OutboxItem | string)[]): Promise<void> {
  if (messages.length === 0) return
  const items = messages.map(outboxItem)
  await patchAgent($, agentId, current => ({
    outbox: [...current.outbox, ...items],
    digest: [...current.digest, ...items.map(item => `message to ${item.to ?? 'main'}: ${clip(firstLine(item.text), 200)}`)],
  }))
}

/** codex_await's answer for codex-msg messages: each one's recipient and whole text, so even the wrapper's model relays the real text. */
const messagesText = (messages: readonly (OutboxItem | string)[]) =>
  messages
    .map(outboxItem)
    .map((item, index) => `Codex sent ${messages.length === 1 ? 'a message' : `message ${index + 1} of ${messages.length}`} for ${item.to ?? 'main'}:\n\n${item.text}`)
    .join('\n\n')

/** When each subagent's last turn ended, as turn.complete saw it: list_agents hides one finished longer ago than RECENT_FINISHED_MS. */
const agentEndedAt = new Map<string, number>()

/** codex:* jobs and Claude subagents of this session that run or finished within RECENT_FINISHED_MS. */
async function recentAgents($: Engine): Promise<{ name: string; type: string; status: string; description: string }[]> {
  const now = await $.clock.now()
  const jobs = await read($, agentsAtom)
  const listed = await $.agent.list()
  const jobStatus = (job: CodexAgent) => (isLive(job) ? 'running' : (job.lastTurnStatus ?? job.status))
  const agents = listed.flatMap(info => {
    const job = jobs[info.id]
    const live = job ? isLive(job) : ['pending', 'running', 'waiting', 'idle'].includes(info.status)
    const endedAt = job ? job.turnEndedAt : (agentEndedAt.get(info.id) ?? 0)
    if (!live && endedAt < now - RECENT_FINISHED_MS) return []
    const status = job ? jobStatus(job) : info.status
    return [{ name: info.name ?? info.id, type: info.type, status, description: info.description }]
  })
  // This session's jobs the engine no longer lists (their wrapper ended), while they run or finished recently.
  const sessionId = await $.session.id()
  const listedIds = new Set(listed.map(info => info.id))
  const orphans = Object.values(jobs).filter(job => job.sessionId === sessionId && job.threadId && !listedIds.has(job.id) && isRecent(job, now))
  return [...agents, ...orphans.map(job => ({ name: job.name, type: `${AGENT_PREFIX}${aliasOf(job.model)}`, status: jobStatus(job), description: job.description }))]
}

/** Sends a running bridge the agents list_agents shows; a failure only leaves the previous list standing. */
async function pushRoster($: Engine): Promise<void> {
  if (!isBridgeRunning) return
  try {
    await post($, '/roster', { text: rosterText(await recentAgents($)) })
  } catch (error) {
    $.ui.log(`codex: sending the agent list to the bridge failed: ${errorText(error)}`, { to: 'debug' })
  }
}

/**
 * codex_await: blocks until the wrapper's Codex turn ends, or the job sends a
 * codex-msg message, and answers which; after AWAIT_MS it answers that the job
 * still runs. The wrapper's loop (turn.step) then passes a message on, or calls
 * it again, or ends with the result.
 */
async function awaitJob($: Engine, agentId: string | undefined, signal: AbortSignal): Promise<string> {
  if (agentId === undefined) throw new CodexError('codex_await serves codex:* agents only')
  if (!(await read($, agentsAtom))[agentId] && !(await isCodexType($, agentId))) throw new CodexError('codex_await serves codex:* agents only')
  const startedAt = await $.clock.now()
  const deadline = startedAt + AWAIT_MS
  // A bridge outage is waited out, never answered: the job may run on in the daemon.
  for (;;) {
    try {
      await reconcileAgents($)
      break
    } catch (error) {
      if (signal.aborted) throw error
      if ((await $.clock.now()) >= deadline) return `${STILL_RUNNING}: the Codex bridge is not reachable (${errorText(error)}).`
      $.ui.log(`codex: ${agentId} waits for the Codex bridge: ${errorText(error)}`, { to: 'debug' })
      await pause($, BRIDGE_RETRY_MS)
    }
  }
  let settling = 0
  for (;;) {
    let agent = (await read($, agentsAtom))[agentId]
    // The wrapper's polls drive a due capacity retry, so a stopped job gets none and a reloaded plugin loses none.
    if (agent?.status === 'starting' && agent.capacityRetryAt && (await $.clock.now()) >= agent.capacityRetryAt) {
      await retryWithContinue($, agent)
      agent = (await read($, agentsAtom))[agentId]
    }
    // A resumed wrapper whose message ran no new turn (one it started shows as running): never the old result again.
    if (agent && isHandedBack(agent)) return noNewTurn(agent)
    if (agent && !isLive(agent)) {
      // A message sent just before the turn ended still goes out, ahead of the result;
      // with the bridge gone there is none to read, and the result goes alone.
      try {
        const last = agent.threadId ? (await post($, '/wait', { threadId: agent.threadId, msgKey: agent.msgKey, timeoutMs: 1 })) as unknown as WaitAnswer : null
        if (last?.status === 'message') await queueMessages($, agentId, last.messages)
      } catch (error) {
        $.ui.log(`codex: reading ${agent.name}'s last messages failed: ${errorText(error)}`, { to: 'debug' })
      }
      return wrapperAnswer(agent)
    }
    if (!agent || agent.status === 'starting') {
      const now = await $.clock.now()
      const job = firstTurns.get(agentId)
      // The spawn's start of the first turn failed, or hangs: this wrapper starts it.
      if (job && (!job.isStarting || now - job.since >= FIRST_TURN_GRACE_MS)) {
        // A hung start holds the thread's queue: the turn starts on a new one.
        if (job.isStarting) threadQueues.delete(job.threadId)
        await startFirstTurn($, agentId, job)
        continue
      }
      // No start of this module will run its first turn (the plugin reloaded since its spawn): it ends failed, with why.
      if (agent && !job && !agent.currentTurnId && !agent.capacityRetryAt && now - agent.updatedAt >= FIRST_TURN_GRACE_MS) {
        await patchAgent($, agentId, () => ({
          status: 'failed', lastTurnStatus: 'failed', activity: 'failed', turnEndedAt: now,
          error: 'the Codex turn never started: its start was lost before Codex took the prompt (the plugin reloaded); start the job again',
        }))
        continue
      }
      // The spawn is between the subagent's start and the Codex turn's.
      if (settling >= SETTLE_BUDGET_MS) {
        if (agent) return `${STILL_RUNNING}: its turn is still starting.`
        throw new CodexError('codex_await serves codex:* agents only, and no Codex job runs under this agent')
      }
      await $.clock.sleep(SETTLE_MS)
      settling += SETTLE_MS
      continue
    }
    const left = deadline - (await $.clock.now())
    if (left <= 0) return `${STILL_RUNNING}: ${describeAgent(agent, await $.clock.now())}`
    // A relay that stopped starts again here; until it is back the job is not judged lost.
    try {
      await bridgeSocket($)
    } catch (error) {
      if (signal.aborted) throw error
      $.ui.log(`codex: ${agent.name} waits for the Codex bridge: ${errorText(error)}`, { to: 'debug' })
      await pause($, BRIDGE_RETRY_MS)
      continue
    }
    // Each poll refreshes the list a running job's list_agents reads.
    await pushRoster($)
    let answer: WaitAnswer
    try {
      answer = await waitTurn($, agent.threadId, Math.min(left, POLL_SLICE_MS), agent.msgKey)
    } catch (error) {
      if (signal.aborted) throw error
      // A host HTTP timeout alone does not mean the Codex process died.
      if (/no complete answer within 30000ms/.test(errorText(error))) continue
      // Nor does a failed wait (a reload, or a relay or its recovery restarting): the daemon and its turn likely run on.
      // A turn that really died is settled by the next relay's ready (a new daemon, not reattached, marks it interrupted).
      $.ui.log(`codex: ${agent.name} waits for the Codex bridge: ${errorText(error)}`, { to: 'debug' })
      await pause($, BRIDGE_RETRY_MS)
      continue
    }
    if (answer.status === 'message') {
      await queueMessages($, agentId, answer.messages)
      return messagesText(answer.messages)
    }
    await settleTurn($, agent, answer)
  }
}

// ------------------------------------------------------------ events

async function onNotification($: Engine, method: string, params: Record<string, unknown>): Promise<void> {
  if (typeof params.threadId !== 'string') return
  const agent = byThread(await read($, agentsAtom), params.threadId)
  if (!agent) return
  const turn = params.turn as Record<string, unknown> | undefined
  // A sub-agent's activity note (Codex's spawn_agent) lands on this thread tagged with its last turn, also after that
  // turn ended: it is the sub-agent's work, not this job's (#19).
  const isSubAgentNote = (params.item as Item | undefined)?.type === 'subAgentActivity'
  if (method.startsWith('item/') && !isSubAgentNote && typeof params.turnId === 'string' && agent.stoppedAt && !isLive(agent)) {
    // Work on a job the user stopped is interrupted, not followed: a turn that really runs ends interrupted again.
    interruptStopped($, agent, params.turnId)
  } else if (method.startsWith('item/') && !isSubAgentNote && typeof params.turnId === 'string' && (!isLive(agent) || agent.capacityRetryAt)) {
    // The thread still works after its job was settled, or while it waits for a capacity retry: the job runs again.
    const turnId = params.turnId
    await patchAgent($, agent.id, current => isLive(current) && !current.capacityRetryAt ? {} : {
      status: 'running', currentTurnId: turnId, capacityRetryAt: null,
      warning: `Codex kept working after its turn was reported ${current.lastTurnStatus ?? current.status}${current.error ? `: ${current.error}` : ''}`,
      error: null,
    })
  }
  switch (method) {
    case 'turn/started': {
      const now = await $.clock.now()
      // A turn Codex started itself on a job the user stopped is interrupted at once: only main's SendMessage resumes it.
      const isOwn = turnStarts.has(params.threadId) || startedTurns.get(params.threadId) === turn?.id
      if (agent.stoppedAt && !isOwn && turn?.id) interruptStopped($, agent, String(turn.id))
      // A turn Codex started itself counts too, so an older one this module started holds no capacity retry back.
      if (turn?.id) startedTurns.set(params.threadId, String(turn.id))
      await patchAgent($, agent.id, current => ({
        status: 'running',
        currentTurnId: String(turn?.id),
        digest: [],
        turnStartedAt: current.currentTurnId === turn?.id ? current.turnStartedAt : now,
      }))
      return
    }
    case 'item/started': {
      const change = itemStarted(params.item as Item)
      if (change) await patchAgent($, agent.id, () => change)
      return
    }
    case 'item/completed':
      await patchAgent($, agent.id, current => itemCompleted(current, params.item as Item))
      return
    case 'item/autoApprovalReview/completed': {
      const line = autoReviewDigest(params)
      await patchAgent($, agent.id, current => ({ digest: [...current.digest, line] }))
      return
    }
    case 'thread/tokenUsage/updated': {
      const usage = params.tokenUsage as { total?: { totalTokens?: number } } | undefined
      await patchAgent($, agent.id, current => ({ tokens: usage?.total?.totalTokens ?? current.tokens }))
      return
    }
    case 'error': {
      // Never terminal: only turn/completed ends a turn (Codex retries, or works on after a failed compaction).
      const message = (params.error as { message?: string } | undefined)?.message ?? 'error'
      const warning = params.willRetry === true ? `${message} (retrying)` : message
      await patchAgent($, agent.id, current => ({ warning, digest: [...current.digest, `warning: ${clip(firstLine(warning), 200)}`] }))
      return
    }
    case 'turn/completed': {
      if (!turn) return
      const now = await $.clock.now()
      // A late end of an earlier turn leaves a newer running one alone.
      await patchAgent($, agent.id, current =>
        current.currentTurnId === null || current.currentTurnId === turn.id ? afterTurnEnd(current, turn, now) : {},
      )
      // Never hold the event loop on the release. A failed end is final too: the bridge drops one the thread works on after.
      void releaseThread($, params.threadId)
      return
    }
  }
}

/** Asks the person, one dialog at a time; a dismissed dialog (or -p) is a deny. */
function askPerson($: Engine, question: string, options: string[]): Promise<Verdict> {
  const asked = askChain.then(async (): Promise<Verdict> => {
    try {
      return verdictOf(await $.ui.ask(question, { options, header: 'Codex' }))
    } catch {
      return { kind: 'deny' }
    }
  })
  askChain = asked
  return asked
}

async function onRequest($: Engine, id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
  const agent = typeof params.threadId === 'string' ? byThread(await read($, agentsAtom), params.threadId) : undefined
  const question = approvalQuestion(method, params, agent ? `Codex ${agent.name} (${agent.model})` : 'A Codex agent')
  let verdict: Verdict | null = null
  if (question !== null) {
    const reason = typeof params.reason === 'string' && params.reason ? `\nReason: ${params.reason}` : ''
    verdict = await askPerson($, `${question}${reason}\nAllow it?`, approvalOptions(method, params))
  }
  await post($, '/reply', { id, ...approvalAnswer(method, params, verdict) })
  if (agent) {
    const line = approvalDigest(method, params, verdict)
    await patchAgent($, agent.id, current => ({ digest: [...current.digest, line] }))
  }
  // Text typed under "Other": decline, and tell the agent what the person said.
  if (verdict?.kind === 'other' && agent) {
    const fresh = findIn(await read($, agentsAtom), agent.id)
    if (fresh) await sendMessage($, fresh, `The user declined that request and said: ${verdict.text}`)
  }
}

/** After the bridge (re)starts: settle agents whose turn did not survive. */
async function onReady($: Engine, address: string, reattached: boolean, active: Record<string, string>): Promise<void> {
  // A hot reload or an in-process session switch need not fire session.start.
  await loadFromStore($)
  await reconcileAgents($, address)
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const agents = await update($, agentsAtom, all => Object.fromEntries(Object.entries(all).map(([id, agent]) => {
    if (agent.sessionId !== sessionId || !isLive(agent)) return [id, agent]
    const turnId = active[agent.threadId]
    if (turnId) {
      loadedThreads.add(agent.threadId)
      return [id, { ...agent, status: 'running', currentTurnId: turnId, updatedAt: Math.max(now, agent.updatedAt + 1) }]
    }
    // A reattached daemon replays the turn's end from its buffer; a new one never saw it.
    return [id, reattached ? agent : {
      ...agent, status: 'interrupted', currentTurnId: null, lastTurnStatus: 'interrupted', turnEndedAt: now, updatedAt: Math.max(now, agent.updatedAt + 1),
      error: 'the turn was lost when the Codex process restarted; a SendMessage to its agent starts a new turn on the thread',
    }]
  })))
  for (const agent of Object.values(agents)) {
    if (agent.sessionId !== sessionId) continue
    // A reset or refused write is repeated (it keeps the newer record) rather than failing the whole recovery.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await postAt($, registryAddress ?? address, '/registry/write', { agent })
        break
      } catch (error) {
        if (attempt >= POST_ATTEMPTS || !(isUndelivered(error) || isRegistryRetryable(error))) throw error
        await pause($, PAUSE_MS)
      }
    }
  }
  await saveSnapshot($, agents)
}

async function onEvent($: Engine, event: BridgeEvent): Promise<void> {
  switch (event.type) {
    case 'ready':
      codexVersion = event.codexVersion
      registryAddress = event.registry ?? event.socket
      recovery = { reattached: event.reattached, active: event.active }
      await onReady($, event.socket, event.reattached, event.active)
      return
    case 'notification':
      await onNotification($, event.method, event.params)
      return
    case 'request':
      // Never hold the event loop on a dialog.
      void onRequest($, event.id, event.method, event.params).catch(error =>
        $.ui.log(`codex: answering ${event.method} failed: ${String(error)}`),
      )
      return
    case 'exit':
      $.ui.log(`codex app-server exited (${event.code ?? event.signal}). ${event.stderrTail.slice(-3).join(' | ')}`)
      const sessionId = await $.session.id()
      const now = await $.clock.now()
      for (const agent of Object.values(await read($, agentsAtom))) {
        if (agent.sessionId === sessionId && isLive(agent)) {
          await patchAgent($, agent.id, () => ({ status: 'failed', currentTurnId: null, error: 'codex app-server exited', turnEndedAt: now }))
        }
      }
      return
    case 'fatal':
      $.ui.log(`codex bridge failed: ${event.message}\n${event.logTail}`)
      return
  }
}

// ------------------------------------------------------------ the module

/** The nearest .claude/codex.json from the session's cwd up to the project root. */
async function projectConfig($: Engine): Promise<Partial<Defaults>> {
  for (const dir of configDirs(await $.session.cwd(), await $.session.root())) {
    const path = `${dir === '/' ? '' : dir}/${PROJECT_CONFIG}`
    if (await $.fs.exists(path)) return parseProjectConfig(await $.fs.read(path), path)
  }
  return {}
}

const textArg = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const TOOL_NAMES: readonly ToolName[] = ['codex_list', 'codex_result', 'codex_stop', 'codex_await']

/** Serves codex_list (this session's jobs), codex_result and codex_stop (any job); a CodexError becomes the call's error text. */
async function runTool($: Engine, name: 'codex_list' | 'codex_result' | 'codex_stop', e: unknown): Promise<string> {
  const args = e as Record<string, unknown>
  await reconcileAgents($, undefined, textArg(args.id))
  // Saved jobs stay readable on an outdated CLI; the warning says new ones will be refused.
  const outdated = codexVersionError(codexVersion)
  const warning = outdated ? `\n\nWarning: ${outdated} New codex:* agents are refused until then.` : ''
  if (name === 'codex_list') return listText(sorted(await read($, agentsAtom)), await $.session.id(), await $.clock.now(), args.all === true) + warning
  const ref = textArg(args.id)
  if (!ref) throw new CodexError('id is required')
  const agent = findIn(await read($, agentsAtom), ref)
  // A job whose first turn is pending has no record yet.
  const stopped = name === 'codex_stop' && (agent || firstTurns.has(ref)) ? await stopJob($, agent?.id ?? ref) : undefined
  if (stopped !== undefined) return stopped
  if (!agent || name === 'codex_stop') throw new CodexError(`No Codex agent "${ref}". codex_list shows them.`)
  return resultText(agent, args.full === true, await $.clock.now()) + warning
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Why a hook failed, as its `.catch` reads it on next.error: the kind (throw, timeout, re-entry) and the message. */
const failureText = (failure: HookFailure) => (failure.message ? `${failure.kind}: ${failure.message}` : failure.kind)

export const register: Register = (on, options) => {
  const settings: Settings = {
    codexPath: String(options.codexPath),
    nodePath: String(options.nodePath),
    defaultEffort: options.defaultEffort === PER_MODEL_EFFORT ? undefined : String(options.defaultEffort),
    defaultSandbox: String(options.defaultSandbox) as CodexSandbox,
    defaultApprovals: String(options.defaultApprovals) as CodexApprovals,
  }
  bridgeSettings = settings

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let project: Partial<Defaults> = {}
    try {
      project = await projectConfig($)
    } catch (error) {
      $.ui.log(`codex: ${errorText(error)}`)
    }
    for (const tool of TOOL_SPECS) await $.tool.register(tool)
    for (const spec of agentSpecs(effectiveDefaults(settings, project))) await $.agent.register(spec)
    await loadFromStore($)
    if (!wakeSupervisor) void superviseRelays($)
    await startBridge($)
    return started
  })

  // ---------------------------------------------------------- native agents

  // A codex:* spawn: the Codex thread starts before the subagent, so a bad model,
  // effort or header refuses the Agent call itself; its turn starts with the
  // prompt as given, header lines stripped, once the subagent's id is known.
  on('agent.spawn', async ($, e, next) => {
    const alias = aliasOfType(e.subagentType)
    if (alias === undefined) {
      const spawned = await next(e)
      await pushRoster($)
      return spawned
    }
    // A resume (SendMessage to a finished job) keeps the job and its thread: session.send
    // started the turn on it, or, where its hook did not match the job, the message starts
    // it here; the resumed subagent's loop awaits that turn.
    const resume = (e as { resume?: { agentId?: string } }).resume
    if (resume) {
      const id = String(resume.agentId)
      // The saved record, also when this hook does not hold it yet.
      await reconcileAgents($, undefined, id)
      const agent = (await read($, agentsAtom))[id]
      if (!agent?.threadId) return { deny: `codex: no saved Codex thread for agent ${id}; start a new codex:* agent` }
      try {
        await resumeTurn($, agent, e.prompt)
      } catch (error) {
        return { deny: `codex: Codex did not take the message: ${errorText(error)}` }
      }
      // The engine makes the sender of the resuming message the wrapper's caller.
      const resumedBy = resumers.get(id) ?? null
      resumers.delete(id)
      if ((agent.resumedBy ?? null) !== resumedBy) {
        await patchAgent($, id, () => ({ resumedBy })).catch(error => $.ui.log(`codex: recording who resumed ${agent.name} failed: ${errorText(error)}`, { to: 'debug' }))
      }
      return next(e)
    }
    // Agents address each other by name: a job needs one, and one name means one recent agent.
    const name = e.name?.trim()
    if (!name) return { deny: 'codex: give the agent a `name` (the Agent call\'s name parameter); other agents message it by that name' }
    if (name === 'main' || (await recentAgents($)).some(agent => agent.name === name)) {
      return { deny: `codex: the name ${name} is taken by a running or recently finished agent; pick another` }
    }
    let input: JobInput
    let body: string
    let threadId: string
    try {
      const header = parseHeader(e.prompt)
      body = header.body
      if (body.trim() === '') return { deny: 'codex: the prompt is empty once its header lines are taken off' }
      const defaults = effectiveDefaults(settings, await projectConfig($))
      // A bridge that is down starts here again, or the refusal says why it did not; its relay has read `codex --version`.
      await bridgeSocket($)
      const outdated = codexVersionError(codexVersion)
      if (outdated) return { deny: `codex: ${outdated}` }
      const listed = await listModels($)
      const model = modelFor(listed, alias)
      const effort = header.effort ?? effortFor(defaults, alias)
      const { sandbox, approvals } = permissionsFor(header, defaults)
      const error = modelEffortError(listed, model, effort)
      if (error) return { deny: `codex: ${error}` }
      input = {
        description: taskLabel(e),
        // The Agent call's name, which SendMessage and message_agent address; putAgent suffixes it
        // in the record only when an older job holds it.
        name,
        model,
        effort,
        sandbox,
        approvals,
        cwd: e.cwd ?? (await $.session.cwd()),
        msgKey: crypto.randomUUID().replaceAll('-', ''),
      }
      const thread = await startThread($, input)
      threadId = thread.threadId
      input = { ...input, model: thread.model }
    } catch (error) {
      return { deny: `codex: ${errorText(error)}` }
    }
    const job: FirstTurn = { threadId, input, body, isStarting: true, since: await $.clock.now(), tries: 0 }
    spawnsInFlight += 1
    let spawned: Awaited<ReturnType<typeof next>>
    try {
      spawned = await next({ ...e, background: true })
      if (spawned.agentId !== undefined) firstTurns.set(spawned.agentId, job)
    } catch (error) {
      // No subagent will run on the thread.
      void releaseThread($, threadId)
      throw error
    } finally {
      spawnsInFlight -= 1
    }
    if (spawned.agentId === undefined) {
      void releaseThread($, threadId)
      return spawned
    }
    // The record and the turn are written once this hook returned: no budget cuts them off
    // with the subagent already running (codex_await finishes a start that failed or hangs).
    void startFirstTurn($, spawned.agentId, job).catch(error =>
      $.ui.log(`codex: starting ${input.name}'s first turn failed: ${errorText(error)}; codex_await starts it again`, { to: 'debug' }),
    )
    return spawned
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `codex: the Codex job did not start (its hook failed: ${failureText(next.error)})` }))

  // The codex:* subagent's loop: every model request is answered here and no
  // Claude model runs. While the Codex turn runs, the answer is a codex_await
  // call; a codex-msg message is passed on as a SendMessage to the agent it
  // names, or main; once the turn ended, the answer is the Codex final message, verbatim.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined || foreignAgents.has(e.agentId)) return yield* next(e)
    let agent = (await read($, agentsAtom))[e.agentId]
    if (!agent && !(await isCodexType($, e.agentId))) {
      foreignAgents.add(e.agentId)
      return yield* next(e)
    }
    // While the bridge (re)starts the job cannot be read: codex_await waits for it, free of a hook's budget.
    if (!isBridgeReady()) return yield* toolStep(e, AWAIT_TOOL, {})
    await reconcileAgents($)
    agent = (await read($, agentsAtom))[e.agentId]
    while (agent && agent.outbox.length > 0) {
      // A codex-msg message goes out as this agent's own SendMessage, verbatim.
      const { text, to = 'main' } = outboxItem(agent.outbox[0] as OutboxItem | string)
      agent = (await patchAgent($, agent.id, current => ({ outbox: current.outbox.slice(1) }))) ?? agent
      const listed = (await $.agent.list()).find(info => info.id === to || info.name === to)
      const jobs = await read($, agentsAtom)
      const target = (listed ? jobs[listed.id] : undefined) ?? sessionJob(jobs, await $.session.id(), to)
      // A job the user stopped takes main's messages only (#16).
      const refusal = to !== 'main' && target?.stoppedAt ? `${to} was stopped by the user`
        : to === 'main' || listed || (await isReachableJob($, to)) ? null
        : 'no agent of this session has that name. list_agents shows the agents you can message.'
      if (refusal === null) return yield* toolStep(e, 'SendMessage', { to, summary: messageSummary(text), message: text })
      // The engine would refuse it after the call, out of Codex's sight: Codex hears it instead.
      await sendMessage($, agent, `Message to ${to} not delivered: ${refusal}`).catch(error =>
        $.ui.log(`codex: telling ${agent?.name} its message to ${to} was not delivered failed: ${errorText(error)}`),
      )
      agent = (await read($, agentsAtom))[e.agentId]
    }
    if (agent && !isLive(agent)) {
      // A peer job's message resumed this wrapper: its hand-back and task notification go to that job's
      // wrapper, which never reads them (#18), so main gets the result first, as this agent's message.
      if (agent.resumedBy && !isHandedBack(agent)) {
        const peer = agent.resumedBy
        await patchAgent($, agent.id, () => ({ resumedBy: null }))
        const message = `${agent.name}'s Codex turn ended. ${peer}'s message resumed ${agent.name}, so Claude Code hands its result and task notification to ${peer}, not to you. Its result:\n\n${wrapperAnswer(agent)}`
        return yield* toolStep(e, 'SendMessage', { to: 'main', summary: `${agent.name} finished`, message })
      }
      const isRefused = await isHandbackRefused($, e.agentId)
      // Where the engine requires it (auto mode), the report goes back through SubagentHandback;
      // where that tool is not offered, its call fails and the final text is the report.
      if (!isRefused) {
        // Never the same turn's result twice: a resume whose message started a turn finds the job running
        // (the resume hook started it before the wrapper's loop), so one that finds it handed back ran none.
        const report = isHandedBack(agent) ? noNewTurn(agent) : wrapperAnswer(agent)
        handBackTexts.set(e.agentId, report)
        const key = handBackKey(agent)
        await patchAgent($, agent.id, () => ({ handedBackTurnId: key }))
        return yield* toolStep(e, HANDBACK_TOOL, { message: report })
      }
      const text = handBackTexts.get(e.agentId) ?? wrapperAnswer(agent)
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }
    return yield* toolStep(e, AWAIT_TOOL, {})
  }).catch(async function* ($, e, next) {
    // A step the hook had passed on (another subagent's) is answered beneath, as it was.
    if (next.called || e.agentId === undefined || foreignAgents.has(e.agentId)) return yield* next(e)
    const isCodex = (await read($, agentsAtom))[e.agentId] !== undefined || (await isCodexType($, e.agentId).catch(() => false))
    if (!isCodex) return yield* next(e)
    // A codex:* wrapper whose step failed never falls to its Claude model, which would hand back while
    // the job runs: it waits on codex_await again, which reads the job afresh.
    $.ui.log(`codex: ${e.agentId}'s step failed (${failureText(next.error)}); it calls codex_await again`, { to: 'debug' })
    return yield* toolStep(e, AWAIT_TOOL, {})
  })

  // SendMessage to a codex:* agent goes to Codex first: a steer while its turn
  // runs, a new turn on the thread once it ended (the delivery then resumes the
  // subagent, whose loop waits for that turn). Refused when Codex refuses it.
  on('session.send', async ($, e, next) => {
    let agent: CodexAgent | undefined
    try {
      agent = await recipient($, e.to)
    } catch (error) {
      return { isDelivered: false as const, reason: `codex: could not read whether ${e.to} is a Codex job (${errorText(error)}); send it again` }
    }
    if (!agent) return next(e)
    if (!agent.threadId) return { isDelivered: false as const, reason: missingThread(agent.id) }
    // A job the user stopped is resumed by main's messages alone (#16).
    if (agent.stoppedAt && e.agentId !== undefined) {
      return { isDelivered: false as const, reason: `${agent.name} was stopped by the user; only the main session can resume it` }
    }
    // From another agent, Codex is told whom to answer; main's messages arrive as they are.
    const sender = e.agentId === undefined ? undefined : (await $.agent.list()).find(info => info.id === e.agentId)
    const text = e.agentId === undefined ? e.text : fromAgent(sender?.name ?? e.agentId, e.text)
    let sent: 'steered' | 'started'
    try {
      sent = await sendMessage($, agent, text)
      sentToCodex.add(agent.id)
      const senderJob = e.agentId === undefined ? undefined : (await read($, agentsAtom))[e.agentId]
      if (senderJob) resumers.set(agent.id, senderJob.name)
      else resumers.delete(agent.id)
    } catch (error) {
      const now = await $.clock.now()
      const isRunning = agent.status === 'running'
      // The refusal states why either way; a record that cannot be written now only loses the error line.
      await patchAgent($, agent.id, () => ({
        ...(isRunning ? {} : { status: 'failed' as const, currentTurnId: null, turnEndedAt: now }),
        error: `the Codex message did not start or resume a turn: ${errorText(error)}`,
      })).catch(failure => $.ui.log(`codex: recording the refused message to ${e.to} failed: ${errorText(failure)}`, { to: 'debug' }))
      return { isDelivered: false as const, reason: `Codex did not take the message: ${errorText(error)}` }
    }
    const delivered = await next(e)
    if (delivered.isDelivered) {
      // Delivered already: a failed write must not reach the .catch below, which would deliver it again.
      if (agent.stoppedAt) await patchAgent($, agent.id, () => ({ stoppedAt: null })).catch(error => $.ui.log(`codex: clearing ${agent?.name}'s stop failed: ${errorText(error)}`, { to: 'debug' }))
    } else if (sent === 'started') {
      // No wrapper resumes to wait on the turn or stop it: it does not run on unseen.
      sentToCodex.delete(agent.id)
      await interruptTurn($, agent)
    }
    return delivered
  }).catch(($, e, next) => (next.called ? next(e) : { isDelivered: false as const, reason: `codex: the message did not reach Codex (its hook failed: ${failureText(next.error)})` }))

  // The wrapper's SendMessage relays of Codex messages: the plugin made the call, so it allows it.
  // (SubagentHandback is left to the engine: only auto mode's classifier may allow it.)
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.tool_use_id === undefined || !relayCalls.delete(e.tool_use_id)) return next(e)
    return { decision: 'allow' as const, reason: "codex: relays a Codex job's message, verbatim" }
  })

  // TaskStop, or the task list's stop, kills the subagent mid codex_await: its
  // turn ends aborted, and the job under it is stopped (stopJob).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) agentEndedAt.set(e.agentId, await $.clock.now())
    if (e.agentId === undefined || e.reason !== 'aborted' || foreignAgents.has(e.agentId)) return done
    const id = e.agentId
    const isCodex = (await read($, agentsAtom))[id] !== undefined || firstTurns.has(id) || (await isCodexType($, id).catch(() => false))
    if (isCodex) await stopJob($, id).catch(error => $.ui.log(`codex: stopping ${id} failed: ${errorText(error)}`))
    return done
  })

  // ---------------------------------------------------------- tools

  // A pattern: the tools table a type-check reads lists the MCP tools of the last reload alone.
  on('tool.call', { tool: new RegExp(`^${AWAIT_TOOL}$`) }, async ($, e, next) => {
    try {
      return { result: await awaitJob($, e.agentId, next.signal) }
    } catch (error) {
      return { deny: errorText(error) }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `codex: codex_await did not finish (its hook failed: ${failureText(next.error)}); call codex_await again` }))

  // One hook for all three: a matcher over a union of names does not type-check.
  const toolPattern = new RegExp(`^${PREFIX}(codex_list|codex_result|codex_stop)$`)
  on('tool.call', { tool: toolPattern }, async ($, e) => {
    try {
      return { result: await runTool($, e.tool.slice(PREFIX.length) as 'codex_list' | 'codex_result' | 'codex_stop', e) }
    } catch (error) {
      return { deny: errorText(error) }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `codex: ${e.tool.slice(PREFIX.length)} did not finish (its hook failed: ${failureText(next.error)})` }))

  // List codex_list and codex_result up front rather than behind ToolSearch; codex_await stays behind it.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    return e.tool.startsWith(PREFIX) && e.tool !== AWAIT_TOOL ? { ...described, isDeferred: false } : described
  })

  // ---------------------------------------------------------- drawing

  // Every codex_* call draws like a native Agent row: one header line and one result line, each
  // cut to the width, never wrapped. They read only the call's own props.
  for (const tool of TOOL_NAMES) {
    on('ui.render', { component: 'ToolUse', props: { tool: `${PREFIX}${tool}` } }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      const { isRunning, isErrored, isInterrupted } = e.props
      const text = outputText(e.props.output)
      const result = isRunning || isInterrupted || isErrored ? null : rowResult(tool, text)
      const dot = isErrored || isInterrupted ? 'error' : isRunning ? 'inactive' : 'success'
      return (
        // The blank line above it that native tool rows draw.
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={dot}>{DOT} </Text>
            <Text bold>Codex</Text>({rowArgs(tool, (e.props.input ?? {}) as Record<string, unknown>)})
          </Text>
          {!isRunning && (
            <Text wrap="truncate-end">
              <Text dimColor>{RESULT_MARK}</Text>
              {isInterrupted ? (
                <Text dimColor>Interrupted</Text>
              ) : isErrored ? (
                <Text color="error">failed: {firstLine(text)}</Text>
              ) : (
                result?.main
              )}
              {result?.dim && <Text dimColor>{result.dim}</Text>}
            </Text>
          )}
        </Box>
      )
    })

    // The text under the row is the model's; the row above already says what it came to.
    on('ui.render', { component: 'ToolResult', props: { tool: `${PREFIX}${tool}` } }, async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }

  // Running agents ride at the end of the hint line under the prompt, where native background
  // tasks show; nothing is added while none runs.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const sessionId = await $.session.id()
    const tail = runningTail(Object.values(await read($, agentsAtom)).filter(agent => agent.sessionId === sessionId))
    if (!tail) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })
}
