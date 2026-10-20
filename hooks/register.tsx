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
import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { CodexAgent, CodexApprovals, CodexSandbox } from '../types'
import { LiveActivity, MAX_ASSISTANT_TEXT, assistantText, type ActivityEvent, commandPreview, redactActivity } from './activity'
import {
  agentSpecs,
  aliasOfType,
  afterTurn,
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
  isLive,
  listText,
  outputText,
  overloadRetryDelay,
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
/** Internal observation only; no transcript row is emitted for a quiet poll. */
const ACTIVITY_POLL_MS = 2_000
/** How long one codex_await call blocks before the wrapper's loop calls it again. */
const AWAIT_MS = 45_000
/** A short wait between reads of the registry; it counts against the hook's 10 s budget. */
const SETTLE_MS = 100
/** At most this much of an await's budget goes to such short waits. */
const SETTLE_BUDGET_MS = 5_000

// Module state starts over on a reload, which is right: a reload ends every
// in-flight wait, dialog and the bridge relay along with it.
type Socket = { promise: Promise<string>; resolve: (path: string) => void; reject: (error: Error) => void }
let socket: Socket | null = null
let registryAddress: string | null = null
let recovery: { reattached: boolean; active: Record<string, string> } | null = null
let spawnsInFlight = 0
let isBridgeRunning = false
/** The userConfig the bridge starts with; set when the module registers. */
let bridgeSettings: Settings | null = null
/** Threads this app-server connection is subscribed to (thread/start or thread/resume). */
const loadedThreads = new Set<string>()
/** Starts remain owned by the daemon until their job/turn binding is written. */
const unboundOperations = new Map<string, string>()
/** Per thread, the tail of its loads, turn starts and releases, which run one at a time. */
const threadQueues = new Map<string, Promise<unknown>>()
/** Notifications can beat a turn/start response; bind only its exact returned turn. */
const startingThreads = new Set<string>()
const earlyCompletions = new Map<string, Map<string, Record<string, unknown>>>()
const earlyEvents = new Map<string, { method: string; params: Record<string, unknown> }[]>()
/** The node binary the bridge runs on, which Codex runs bin/codex-msg on too. */
let nodeBinary = 'node'
/** Subagents seen at turn.step that are not codex:* agents. */
const foreignAgents = new Set<string>()
let models: Map<string, string[]> | null = null
/** `codex --version` as the running bridge's relay read it; undefined from a relay that does not report it. */
let codexVersion: string | null | undefined
let askChain: Promise<unknown> = Promise.resolve()
const liveActivity = new LiveActivity()
type Delivery = { handled: boolean; admitted: boolean; cancelled: boolean; signal: AbortSignal; agentId?: string; finished?: boolean }
// The same continuation is supplied to the engine's error handler. Retain the
// admission decision there too: a hook deadline cannot undo a submitted RPC.
const deliveries = new WeakMap<object, Delivery>()
const deliveringAgents = new Map<string, number>()
function endDelivery(delivery: Delivery): void {
  delivery.cancelled = true
  if (!delivery.agentId || delivery.finished) return
  delivery.finished = true
  const count = (deliveringAgents.get(delivery.agentId) ?? 1) - 1
  if (count) deliveringAgents.set(delivery.agentId, count)
  else deliveringAgents.delete(delivery.agentId)
}

// ------------------------------------------------------------ registry

async function afterWrite($: Engine, agents: Record<string, CodexAgent>, agent: CodexAgent): Promise<void> {
  await post($, '/registry/write', { agent })
  // A bounded compatibility snapshot; the separate agent files are authoritative.
  await $.store.set(STORE_KEY, trim(agents))
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
  let written: CodexAgent | undefined
  const agents = await update($, agentsAtom, all => {
    const agent = all[id]
    if (!agent) return all
    written = sanitize({ ...agent, ...change(agent), updatedAt: Math.max(now, agent.updatedAt + 1) })
    return { ...all, [id]: written }
  })
  if (written) await afterWrite($, agents, written)
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
  return { promise, resolve, reject }
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
  if (isBridgeRunning) return
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

  const handle = async (line: string) => {
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
      // Readiness must survive a transient registry failure during recovery.
      // Rejecting this promise would strand a healthy, already-running relay.
      if (event.type === 'ready') current.resolve(event.socket)
      await onEvent($, event)
    } catch (error) {
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
      isBridgeRunning = false
      loadedThreads.clear()
      startingThreads.clear()
      earlyCompletions.clear()
      earlyEvents.clear()
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

/** The daemon's socket, starting the bridge when none runs (the daemon exits when idle). */
async function bridgeSocket($: Engine): Promise<string> {
  await startBridge($)
  if (!socket) throw new CodexError('the codex bridge is not running')
  return socket.promise
}

async function post($: Engine, endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  const address = await bridgeSocket($)
  return postAt($, endpoint.startsWith('/registry/') ? registryAddress ?? address : address, endpoint, body)
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
  const error = parsed.error as { message?: string; code?: number; data?: unknown } | undefined
  if (error && !parsed.operationId) throw new CodexError(error.message ?? 'Codex RPC failed', error.code, error.data)
  return parsed
}

/** A timed-out HTTP poll never cancels, repeats or forgets the daemon's RPC. */
async function rpc<T>($: Engine, method: string, params: unknown, retainedId?: string, resumeParams?: unknown, delivery?: Delivery): Promise<T> {
  const id = retainedId ?? crypto.randomUUID()
  const address = await bridgeSocket($)
  let submitted = retainedId !== undefined
  for (;;) {
    let answer: Record<string, unknown>
    try {
      if (!submitted && delivery) {
        if (delivery.cancelled || delivery.signal.aborted) throw new CodexError('the message delivery was cancelled before native admission')
        delivery.admitted = true
      }
      answer = await postAt($, address, submitted ? '/operation/poll' : '/operation',
        submitted ? { id, timeoutMs: POLL_SLICE_MS } : { id, method, params, ...(resumeParams ? { resumeParams } : {}) })
      submitted = true
    } catch (error) {
      // Retry only transport delivery with this exact ID and this exact daemon.
      // Structured errors (including overload) are terminal responses, never retries.
      if (error instanceof CodexError) {
        // A structured rejection without an operation handle is an admission
        // refusal. A later poll failure cannot undo earlier submission.
        if (delivery && !submitted) delivery.admitted = false
        throw error
      }
      if (!/no complete answer within 30000ms|timeout|timed out/i.test(errorText(error))) throw error
      continue
    }
    if (answer.status === 'pending') continue
    const error = answer.error as { message?: string; code?: number; data?: unknown } | undefined
    if (error) {
      if (delivery) delivery.admitted = false // a retained, definitive native refusal
      await postAt($, address, '/operation/ack', { id }).catch(() => undefined)
      throw new CodexError(error.message ?? 'Codex RPC failed', error.code, error.data)
    }
    const result = answer.result as T
    const record = result as { thread?: { id?: string }; turn?: { id?: string } } | undefined
    const threadId = record?.thread?.id ?? (params as { threadId?: string })?.threadId
    if ((method === 'thread/start' || method === 'turn/start') && threadId) {
      unboundOperations.set(`${method}:${threadId}`, id)
    } else await postAt($, address, '/operation/ack', { id }).catch(() => undefined)
    return result
  }
}

async function acknowledgeBinding($: Engine, method: string, threadId: string): Promise<void> {
  const key = `${method}:${threadId}`
  const id = unboundOperations.get(key)
  if (!id) return
  await post($, '/operation/ack', { id })
  unboundOperations.delete(key)
}

type WaitAnswer =
  | { status: 'completed' | 'idle'; turn: { id?: string; status?: string; items?: Item[] } | null }
  | { status: 'message'; messages: string[] }
  | { status: 'timeout' }

/** Long-polls until the thread's turn ends or the job (named by `msgKey`) sends a codex-msg message: time inside $.http.fetch is budget-free. */
async function waitTurn($: Engine, threadId: string, timeoutMs: number, msgKey: string, turnId: string | null): Promise<WaitAnswer> {
  // $.http.fetch gives up after 30 s and takes no timeout option: poll in slices under that.
  const deadline = (await $.clock.now()) + timeoutMs
  for (;;) {
    const left = deadline - (await $.clock.now())
    const slice = Math.max(1, Math.min(left, POLL_SLICE_MS))
    const answer = (await post($, '/wait', { threadId, turnId, msgKey, timeoutMs: slice })) as unknown as WaitAnswer
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
function releaseThread($: Engine, threadId: string, turnId?: string): Promise<void> {
  return onThread(threadId, async () => {
    const agent = byThread(await read($, agentsAtom), threadId)
    if (agent && (isLive(agent) || (turnId && agent.lastTurnId !== turnId))) return
    // The daemon retains cleanup ownership and retries rejected/ambiguous releases.
    const ended = turnId ?? agent?.lastTurnId
    const state = await post($, '/release', { threadId, ...(ended ? { turnId: ended } : {}) })
    if (state.status === 'unsubscribed' || state.status === 'closed') loadedThreads.delete(threadId)
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
  // Cleanup also runs while hooks are disconnected. Consult the daemon, not a stale cache.
  let state = await post($, '/thread-state', { threadId: agent.threadId })
  if (typeof state.operationId === 'string') {
    await rpc($, 'thread/resume', {}, state.operationId)
    // A cancelled hook's old result may already have been released by reconciliation.
    state = await post($, '/thread-state', { threadId: agent.threadId })
  }
  if (state.status === 'loaded' && !state.operationId) return
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rpc($, 'thread/resume', threadResumeParams(agent, agent.msgKey ? await messagingFor($, agent.msgKey) : undefined))
      break
    } catch (error) {
      if (!(error instanceof CodexError) || !error.message.includes('active writer')) throw error
      const owner = await post($, '/writer-status', { threadId: agent.threadId })
      // Native locks are process-scoped. Never unlink a lock or infer ownership
      // from a saved PID, a file's age, or an old bridge error.
      if (owner.status === 'released' && attempt < 2) {
        await $.clock.sleep(100 * (attempt + 1))
        continue
      }
      throw new CodexError(owner.status === 'held'
        ? "Codex's current writer lock is held by a live process. The saved thread and permissions are unchanged; retry after its owner releases it."
        : 'Codex refused thread ownership; no live holder could be verified. The bounded resume retry ended; the saved thread and permissions are unchanged.')
    }
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
  return onThread(agent.threadId, () => startTurnOnThread($, agent, text))
}

/** Called only while holding the complete delivery/load/release queue. */
async function bindStartedTurn($: Engine, agent: CodexAgent, turnId: string, now: number): Promise<CodexAgent> {
  liveActivity.begin(agent.id, turnId)
  let written: CodexAgent | undefined
  try {
    written = await patchAgent($, agent.id, current => current.lastTurnId === turnId ? {} : ({
      status: 'running', currentTurnId: turnId, error: null, warning: null,
      activity: current.currentTurnId === turnId ? current.activity : 'thinking',
      ...(current.currentTurnId === turnId ? {} : { digest: [] }),
      turnStartedAt: now, capacityNotBefore: undefined,
    }))
  } catch {
    // patchAgent updates the local binding before persistence. The daemon keeps
    // the unacknowledged operation for recovery; this turn really did start.
    return (await read($, agentsAtom))[agent.id] ?? { ...agent, status: 'running', currentTurnId: turnId }
  }
  await acknowledgeBinding($, 'turn/start', agent.threadId).catch(() => undefined)
  await acknowledgeBinding($, 'thread/start', agent.threadId).catch(() => undefined)
  return written ?? agent
}

/** A hook can be cancelled after admission but before its durable turn binding.
 * Reattach that retained outcome instead of leaving its wrapper starting forever.
 */
async function recoverStartedTurn($: Engine, agent: CodexAgent): Promise<boolean> {
  if (startingThreads.has(agent.threadId)) return false
  return onThread(agent.threadId, async () => {
    const current = (await read($, agentsAtom))[agent.id]
    if (!current || current.status !== 'starting' || current.currentTurnId || current.capacityNotBefore !== undefined) return false
    const state = await post($, '/thread-state', { threadId: current.threadId })
    if (typeof state.pendingOperationId !== 'string') return false
    const started = await rpc<{ turn: { id: string } }>($, 'turn/start', { threadId: current.threadId }, state.pendingOperationId)
    await bindStartedTurn($, current, started.turn.id, current.turnStartedAt)
    return true
  })
}

async function startTurnOnThread($: Engine, agent: CodexAgent, text: string, retry = false, delivery?: Delivery): Promise<CodexAgent> {
  const admission = delivery ?? { handled: true, admitted: false, cancelled: false, signal: new AbortController().signal }
  await ensureLoaded($, agent)
  const now = await $.clock.now()
  if (retry && now - (agent.capacityStartedAt ?? agent.turnStartedAt) > 120_000) {
    throw new CodexError('the Codex model capacity retry budget expired while loading its thread')
  }
  const resumeParams = threadResumeParams(agent, agent.msgKey ? await messagingFor($, agent.msgKey) : undefined)
  const prepared = await patchAgent($, agent.id, current => retry && current.stopRequested ? {} : ({ status: 'starting', currentTurnId: null, capacityNotBefore: undefined,
    ...(retry ? {} : { stopRequested: false, capacityInput: text, capacityAttempts: 0, capacityStartedAt: now, capacityNotBefore: undefined, capacityWorkObserved: false }) }))
  if (retry && prepared?.stopRequested) return prepared
  startingThreads.add(agent.threadId)
  try {
    const started = await rpc<{ turn: { id: string } }>($, 'turn/start', turnStartParams(agent, text), undefined, resumeParams, admission)
    let written = await bindStartedTurn($, agent, started.turn.id, now)
    for (const event of earlyEvents.get(agent.threadId) ?? []) {
      if (event.params.turnId === started.turn.id) await onNotification($, event.method, event.params, true)
    }
    const completed = earlyCompletions.get(agent.threadId)?.get(started.turn.id)
    if (completed) {
      await finishTurn($, written, completed)
      written = (await read($, agentsAtom))[agent.id] ?? written
    }
    return written
  } catch (error) {
    if (admission.admitted) return (await read($, agentsAtom))[agent.id] ?? agent
    if (error instanceof CodexError) {
      await patchAgent($, agent.id, current => current.currentTurnId || current.status !== 'starting' ? {} : ({
        status: 'failed', capacityNotBefore: undefined, error: errorText(error), turnEndedAt: now,
      }))
    }
    throw error
  } finally {
    startingThreads.delete(agent.threadId)
    earlyCompletions.delete(agent.threadId)
    earlyEvents.delete(agent.threadId)
  }
}

/** Steers the running turn, or starts a new one when none runs. */
async function sendMessage($: Engine, agent: CodexAgent, text: string, delivery?: Delivery): Promise<'steered' | 'started'> {
  return onThread(agent.threadId, async () => {
    // The caller's snapshot may predate another queued SendMessage or completion.
    agent = (await read($, agentsAtom))[agent.id] ?? agent
    let state = await post($, '/thread-state', { threadId: agent.threadId })
    if (typeof state.pendingOperationId === 'string') {
      const started = await rpc<{ turn: { id: string } }>($, 'turn/start', { threadId: agent.threadId }, state.pendingOperationId)
      agent = await bindStartedTurn($, agent, started.turn.id, await $.clock.now())
      state = await post($, '/thread-state', { threadId: agent.threadId })
    }
    if (state.activeTurnId === null && agent.currentTurnId && isLive(agent)) {
      const observed = await post($, '/wait', { threadId: agent.threadId, turnId: agent.currentTurnId, timeoutMs: 1 }) as unknown as WaitAnswer
      if (observed.status !== 'completed' || observed.turn?.id !== agent.currentTurnId) {
        throw new CodexError('the previous Codex turn is still running or its end is unconfirmed; no new turn was started')
      }
      await settleTurn($, agent, observed)
      agent = (await read($, agentsAtom))[agent.id] ?? agent
    }
    const turnId = typeof state.activeTurnId === 'string' ? state.activeTurnId : state.activeTurnId === null ? null : agent.currentTurnId
    if (turnId) {
      await ensureLoaded($, agent)
      // Any refusal, including activeTurnNotSteerable, leaves this delivery refused.
      // A fresh delivery can observe authoritative idle state; this payload is never repeated.
      await rpc($, 'turn/steer', { threadId: agent.threadId, expectedTurnId: turnId, input: textInput(text) }, undefined, undefined, delivery)
      return 'steered'
    } else if (agent.status === 'starting' && agent.capacityNotBefore === undefined) {
      throw new CodexError('the original turn is still starting; its outcome is pending')
    }
    await startTurnOnThread($, agent, text, false, delivery)
    return 'started'
  })
}

// ------------------------------------------------------------ native agents

/** Whether a subagent no record names yet is a codex:* agent (its spawn hook is still starting the turn). */
async function isCodexType($: Engine, agentId: string): Promise<boolean> {
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  return info !== undefined && aliasOfType(info.type) !== undefined
}

/** The Codex job a SendMessage recipient names: an agentId, or the name the Agent call gave. */
async function recipient($: Engine, to: string): Promise<CodexAgent | undefined> {
  const native = await $.agent.list()
  const info = native.find(agent => agent.id === to) ?? native.find(agent => agent.name === to)
  if (info && aliasOfType(info.type) === undefined) return undefined
  const known = findIn(await read($, agentsAtom), to) || (info && aliasOfType(info.type) !== undefined)
  try { await reconcileAgents($, undefined, to) } catch (error) {
    if (known) throw error
    return undefined
  }
  const agents = await read($, agentsAtom)
  if (info) return agents[info.id]
  if (agents[to]) return agents[to]
  const named = Object.values(agents).filter(agent => agent.name === to)
  if (named.length > 1) throw new CodexError('More than one saved Codex job has this name; use its agent ID. No native input was admitted.')
  return named[0]
}

/** Current engines supply { agentId }; tolerate the old string form too. */
function resumeAgentId(resume: unknown): string | undefined {
  if (typeof resume === 'string') return resume
  if (resume && typeof resume === 'object' && 'agentId' in resume && typeof resume.agentId === 'string') return resume.agentId
  return undefined
}

async function recordDeliveryRefusal($: Engine, id: string, error: unknown): Promise<void> {
  const now = await $.clock.now()
  await patchAgent($, id, current => ({
    ...(isLive(current) ? {} : { status: 'failed' as const, currentTurnId: null, turnEndedAt: now }),
    error: `the Codex message did not start or resume a turn: ${errorText(error)}`,
  })).catch(() => undefined)
}

const missingThread = (id: string) => `No saved Codex thread for agent ${id}. Its job record is missing; start a new codex:* agent. Do not retry codex_await.`

/** Native IDs remain authoritative when Claude restores agents under a different session ID. */
async function reconcileAgents($: Engine, address?: string, ref?: string): Promise<void> {
  const sessionId = await $.session.id()
  const native = (await $.agent.list()).filter(agent => aliasOfType(agent.type) !== undefined)
  const bridge = address ?? await bridgeSocket($)
  const target = registryAddress ?? bridge
  const disk = (await postAt($, target, '/registry/read', { sessionId, ids: native.map(agent => agent.id), ref })).agents as Record<string, CodexAgent>
  const now = await $.clock.now()
  const missing: Record<string, CodexAgent> = {}
  const held = await read($, agentsAtom)
  for (const info of native) {
    if (held[info.id] || disk[info.id] || spawnsInFlight > 0) continue
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
      if (!all[id]?.threadId || agent.updatedAt > (all[id]?.updatedAt ?? -1)) all[id] = agent
    }
    for (const id of nativeIds) {
      const agent = all[id]
      if (agent && agent.sessionId !== sessionId) {
        all[id] = { ...agent, sessionId, updatedAt: Math.max(now, agent.updatedAt + 1) }
        if (isLive(agent) && recovery && !recovery.reattached && !recovery.active[agent.threadId]) {
          all[id] = { ...all[id]!, warning: 'bridge reconnected; still running until the saved turn is confirmed ended' }
        }
        changed.push(id)
      }
    }
    return all
  })
  for (const id of changed) await postAt($, target, '/registry/write', { agent: agents[id] })
  if (changed.length) await $.store.set(STORE_KEY, trim(agents))
}

/** Settle only the exact bound turn; failed capacity turns can schedule a bounded retry. */
async function finishTurn($: Engine, agent: CodexAgent, turn: Record<string, unknown>): Promise<void> {
  const now = await $.clock.now()
  await patchAgent($, agent.id, current => {
    if (current.currentTurnId !== turn.id) return {}
    const ended = afterTurn(current, turn, now)
    const delay = current.status === 'running' && !current.stopRequested ? overloadRetryDelay(current, turn, now) : null
    if (delay === null) return { ...ended, capacityNotBefore: undefined, warning: null }
    return { ...ended, status: 'starting', capacityAttempts: (current.capacityAttempts ?? 0) + 1,
      capacityNotBefore: now + delay, activity: 'waiting to retry model capacity',
      warning: 'Codex model is at capacity; a bounded retry on the same model is pending' }
  })
  void releaseThread($, agent.threadId, String(turn.id)).catch(() => undefined)
}

/** Records how the exact turn the bridge reported ended, if the registry has not yet. */
async function settleTurn($: Engine, agent: CodexAgent, answer: WaitAnswer): Promise<void> {
  if (answer.status === 'timeout' || answer.status === 'message') return
  const turn = answer.turn
  if (turn && turn.id === agent.currentTurnId) {
    await finishTurn($, agent, turn)
    return
  }
  if (turn || answer.status !== 'idle') return
  const now = await $.clock.now()
  await patchAgent($, agent.id, current => !isLive(current) || current.currentTurnId !== agent.currentTurnId ? {} : ({
    status: 'failed', currentTurnId: null, lastTurnId: current.currentTurnId,
    lastTurnStatus: 'failed', error: 'the Codex turn was lost', turnEndedAt: now,
  }))
  void releaseThread($, agent.threadId, agent.currentTurnId ?? undefined).catch(() => undefined)
}

/** The durable retry reservation is claimed inside the same thread queue as SendMessage. */
async function retryCapacity($: Engine, agent: CodexAgent): Promise<void> {
  await onThread(agent.threadId, async () => {
    const current = (await read($, agentsAtom))[agent.id]
    if (!current || current.stopRequested || current.status !== 'starting' || current.currentTurnId ||
      current.lastTurnId !== agent.lastTurnId || current.capacityNotBefore !== agent.capacityNotBefore ||
      current.capacityNotBefore === undefined || current.capacityNotBefore > await $.clock.now()) return
    const now = await $.clock.now()
    if (now - (current.capacityStartedAt ?? current.turnStartedAt) > 120_000) {
      await patchAgent($, current.id, () => ({ status: 'failed', capacityNotBefore: undefined,
        error: 'the Codex model capacity retry budget expired', turnEndedAt: now }))
      await post($, '/release', { threadId: current.threadId, turnId: current.lastTurnId }).catch(() => undefined)
      return
    }
    const state = await post($, '/thread-state', { threadId: current.threadId })
    if (state.activeTurnId || state.pendingOperationId) {
      await patchAgent($, current.id, () => ({ status: 'failed', capacityNotBefore: undefined,
        error: 'the Codex capacity retry was withheld because thread activity is still pending' }))
      return
    }
    try {
      await startTurnOnThread($, current, current.capacityInput ?? '', true)
    } catch (error) {
      const now = await $.clock.now()
      await patchAgent($, current.id, latest => latest.currentTurnId ? {} : ({
        status: 'failed', capacityNotBefore: undefined, error: `the Codex capacity retry did not start: ${errorText(error)}`, turnEndedAt: now,
      }))
      void releaseThread($, current.threadId, current.lastTurnId ?? undefined).catch(() => undefined)
    }
  })
}

/**
 * SendMessage calls this module made for a wrapper. Its tool.check hook allows
 * them: no model request made the step, so auto mode's classifier, which
 * judges a model's actions with its request, has no verdict to give.
 */
const relayCalls = new Set<string>()

// These are receipts for work Codex already did, never instructions to Bash.
// Bind every receipt to the exact wrapper and sanitized command. Unknown/stale
// replay IDs refuse locally, including after a reload, and can never execute.
const REPLAY_PREFIX = 'toolu_codex_replay_'
const replayCalls = new Map<string, { agentId: string; command: string; result: string }>()

async function* replayStep(e: { turnId: string; index: number; agentId: string }, events: ActivityEvent[]): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  let index = 0
  const answers: string[] = []
  const toolUses: { name: string; input: Record<string, unknown> }[] = []
  for (const event of events) {
    if (event.kind === 'text') {
      yield { kind: 'text', index: index++, text: event.text }
      answers.push(event.text)
    } else {
      const id = `${REPLAY_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`
      replayCalls.set(id, { agentId: e.agentId, command: event.command, result: event.result })
      if (replayCalls.size > 512) replayCalls.delete(replayCalls.keys().next().value!)
      const input = { command: event.command }
      yield { kind: 'tool', index, id, name: 'Bash' }
      yield { kind: 'input', index: index++, json: JSON.stringify(input) }
      toolUses.push({ name: 'Bash', input })
    }
  }
  // A text-only end_turn would finish the wrapper. Keep the same await loop,
  // including after the last replay batch and during terminal reconciliation.
  const id = `toolu_codex_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
  yield { kind: 'tool', index, id, name: AWAIT_TOOL }
  yield { kind: 'input', index, json: '{}' }
  toolUses.push({ name: AWAIT_TOOL, input: {} })
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: answers.join('\n\n'), toolUses, stopReason: 'tool_use', usage: null }
}

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

/** Holds codex-msg messages until the wrapper's loop passes them on with SendMessage. */
async function queueMessages($: Engine, agentId: string, messages: readonly string[]): Promise<void> {
  if (messages.length === 0) return
  await patchAgent($, agentId, current => ({
    outbox: [...current.outbox, ...messages],
    digest: [...current.digest, ...messages.map(text => `message to Claude: ${clip(firstLine(text), 200)}`)],
  }))
}

const messagesText = (count: number) => `Codex sent ${count === 1 ? 'a message' : `${count} messages`} for the main session.`

/**
 * codex_await: blocks until the wrapper's Codex turn ends, or the job sends a
 * codex-msg message, and answers which; a quiet AWAIT_MS window returns empty.
 * The wrapper's loop (turn.step) then passes a message on, or calls
 * it again, or ends with the result.
 */
async function awaitJob($: Engine, agentId: string | undefined, signal: AbortSignal): Promise<string> {
  if (agentId === undefined) throw new CodexError('codex_await serves codex:* agents only')
  if (!(await read($, agentsAtom))[agentId] && !(await isCodexType($, agentId))) throw new CodexError('codex_await serves codex:* agents only')
  for (let attempt = 0; ; attempt += 1) {
    try { await reconcileAgents($); break } catch {
      if (signal.aborted) throw new CodexError('Codex await was aborted')
      if (attempt === 2) return `${STILL_RUNNING}: registry unavailable; waiting to reconnect without changing the native turn.`
      await $.clock.sleep(100 * (attempt + 1))
    }
  }
  const startedAt = await $.clock.now()
  const deadline = startedAt + AWAIT_MS
  let settling = 0
  for (;;) {
    if (signal.aborted) throw new CodexError('Codex await was aborted')
    const agent = (await read($, agentsAtom))[agentId]
    if (deliveringAgents.has(agentId)) {
      await $.clock.sleep(SETTLE_MS)
      return `${STILL_RUNNING}: a message delivery is awaiting native admission.`
    }
    if (agent && liveActivity.has(agent.id, agent.currentTurnId ?? agent.lastTurnId ?? '')) return ''
    if (agent && !isLive(agent)) {
      liveActivity.forget(agent.id)
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
    if (agent?.status === 'starting' && agent.capacityNotBefore !== undefined) {
      const delay = agent.capacityNotBefore - await $.clock.now()
      if (delay > 0) {
        await $.clock.sleep(Math.min(delay, SETTLE_BUDGET_MS))
        return `${STILL_RUNNING}: waiting to retry Codex model capacity on the same thread and model.`
      }
      await retryCapacity($, agent)
      continue
    }
    if (!agent || agent.status === 'starting') {
      if (agent && await recoverStartedTurn($, agent)) continue
      // The spawn hook is between the subagent's start and the Codex turn's.
      if (settling >= SETTLE_BUDGET_MS) {
        if (agent) return `${STILL_RUNNING}: its turn is still starting.`
        throw new CodexError('codex_await serves codex:* agents only, and no Codex job runs under this agent')
      }
      await $.clock.sleep(SETTLE_MS)
      settling += SETTLE_MS
      continue
    }
    const left = deadline - (await $.clock.now())
    if (left <= 0) return ''
    let answer: WaitAnswer | undefined
    try {
      answer = await waitTurn($, agent.threadId, Math.min(left, ACTIVITY_POLL_MS), agent.msgKey, agent.currentTurnId)
    } catch (error) {
      if (signal.aborted) throw error
      // A host HTTP timeout alone does not mean the Codex process died.
      if (/no complete answer within 30000ms/.test(errorText(error))) continue
      // Transport loss cannot settle a native turn. Bound retries within this
      // await call; the wrapper issues another await instead of ending or spinning.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await $.clock.sleep(100 * (attempt + 1))
        try {
          answer = await waitTurn($, agent.threadId, ACTIVITY_POLL_MS, agent.msgKey, agent.currentTurnId)
          break
        } catch (retryError) {
          if (signal.aborted) throw retryError
        }
      }
      if (!answer) return `${STILL_RUNNING}: bridge unavailable; the turn has not been confirmed ended. Waiting to reconnect.`
    }
    if (answer.status === 'message') {
      await queueMessages($, agentId, answer.messages)
      return messagesText(answer.messages.length)
    }
    await settleTurn($, agent, answer)
  }
}

/** Request a native stop without treating the wrapper's abort as a receipt. */
async function stopJob($: Engine, id: string): Promise<void> {
  const agent = (await read($, agentsAtom))[id]
  if (!agent?.threadId || !isLive(agent)) return
  await patchAgent($, id, () => ({ stopRequested: true })).catch(() => undefined)
  if (agent.status === 'starting' && agent.capacityNotBefore !== undefined) {
    const now = await $.clock.now()
    const cancelled = await patchAgent($, id, current => current.capacityNotBefore === undefined ? {} : ({
      status: 'interrupted', capacityNotBefore: undefined, currentTurnId: null,
      lastTurnStatus: 'interrupted', error: null, turnEndedAt: now,
    }))
    if (cancelled && !isLive(cancelled)) {
      await releaseThread($, agent.threadId, agent.lastTurnId ?? undefined)
      return
    }
    // A retry may already have admitted a native start; stop that retained
    // admission instead of treating a failed cancellation as a terminal receipt.
  }
  try {
    const answer = await post($, '/interrupt', { threadId: agent.threadId, turnId: agent.currentTurnId })
    if (answer.status === 'completed' && answer.turn) {
      await settleTurn($, agent, answer as unknown as WaitAnswer)
      return
    }
  } catch {
    // A failed request is not evidence that the native turn stopped.
  }
  await patchAgent($, id, current => !isLive(current) || (agent.currentTurnId && current.currentTurnId !== agent.currentTurnId) ? {} : ({
    warning: 'Stop requested; Codex is still running until its exact turn is confirmed ended.',
  })).catch(() => undefined)
}

// ------------------------------------------------------------ events

/** Project before buffering: never retain output, patches, config, or raw reasoning text. */
function projectEarlyEvent(method: string, params: Record<string, unknown>): Record<string, unknown> | null {
  const base = { threadId: params.threadId, turnId: params.turnId }
  if (method === 'turn/plan/updated') {
    const plan = Array.isArray(params.plan) ? params.plan : []
    const total = plan.reduce((size, raw) => size + (typeof raw?.step === 'string' ? raw.step.length : 0) + 10, 0)
    if (total > MAX_ASSISTANT_TEXT) return { ...base, plan: [{ step: '[Codex plan omitted: exceeds the transcript safety limit.]', status: 'pending' }] }
    return { ...base, plan: plan.map(raw => {
      const step = raw as { step?: unknown; status?: unknown }
      return { step: assistantText(typeof step?.step === 'string' ? step.step : ''),
        status: ['pending', 'inProgress', 'completed'].includes(String(step?.status)) ? step.status : 'pending' }
    }) }
  }
  if (method !== 'item/started' && method !== 'item/completed') return null
  const raw = params.item as Record<string, unknown> | undefined
  if (!raw || typeof raw.type !== 'string') return null
  const item: Record<string, unknown> = { type: raw.type.slice(0, 80), id: typeof raw.id === 'string' ? raw.id.slice(0, 128) : undefined }
  const fields = raw.type === 'commandExecution' ? ['command'] : ['agentMessage', 'plan'].includes(raw.type) ? ['text'] : raw.type === 'mcpToolCall' ? ['server', 'tool'] : []
  for (const field of fields) if (typeof raw[field] === 'string') item[field] = field === 'command' ? commandPreview(raw[field] as string, 1000) : assistantText(raw[field] as string)
  if (raw.type === 'reasoning' && Array.isArray(raw.summary)) item.summary = [assistantText(raw.summary.filter(part => typeof part === 'string').join('\n\n'))]
  if (typeof raw.durationMs === 'number') item.durationMs = raw.durationMs
  if (typeof raw.exitCode === 'number') item.exitCode = raw.exitCode
  if (raw.phase === 'final_answer' || raw.phase === 'commentary') item.phase = raw.phase
  if (typeof raw.status === 'string') item.status = raw.status.slice(0, 40)
  if (raw.type === 'fileChange' && Array.isArray(raw.changes)) item.changes = raw.changes.slice(0, 8).map(rawChange => {
    const change = rawChange as { path?: unknown; kind?: unknown }
    return { path: redactActivity(typeof change.path === 'string' ? change.path : '', 120),
      kind: typeof change.kind === 'string' ? change.kind.slice(0, 40) : 'edit' }
  })
  return { ...base, item }
}

async function onNotification($: Engine, method: string, params: Record<string, unknown>, fromStartBuffer = false): Promise<void> {
  if (typeof params.threadId !== 'string') return
  const agent = byThread(await read($, agentsAtom), params.threadId)
  if (!agent) return
  const turn = params.turn as Record<string, unknown> | undefined
  if (method === 'thread/released' || method === 'thread/closed') loadedThreads.delete(params.threadId)
  // Keep item/plan events behind earlier pre-admission events until the
  // returned turn is bound and its buffer drains. Registry I/O during binding
  // must not let a later live message overtake an earlier buffered command.
  const bufferDuringStart = !fromStartBuffer && startingThreads.has(params.threadId)
    && ['item/started', 'item/completed', 'turn/plan/updated'].includes(method)
  if (typeof params.turnId === 'string' && (params.turnId !== agent.currentTurnId || bufferDuringStart)) {
    if (!fromStartBuffer && startingThreads.has(params.threadId)) {
      let events = earlyEvents.get(params.threadId)
      if (!events) earlyEvents.set(params.threadId, events = [])
      const projected = projectEarlyEvent(method, params)
      if (projected && events.length < 128) events.push({ method, params: projected })
      else if (projected) await patchAgent($, agent.id, () => ({ capacityWorkObserved: true }))
    }
    return
  }
  if (typeof params.turnId === 'string' && params.turnId === agent.currentTurnId) {
    liveActivity.begin(agent.id, params.turnId)
    liveActivity.record(agent.id, params.turnId, method, params)
  }
  switch (method) {
    case 'turn/started': {
      if (!turn?.id || turn.id !== agent.currentTurnId) return
      liveActivity.begin(agent.id, String(turn.id))
      const now = await $.clock.now()
      await patchAgent($, agent.id, current => current.currentTurnId !== turn.id ? {} : ({
        status: 'running',
        currentTurnId: String(turn.id),
        digest: [],
        turnStartedAt: current.currentTurnId === turn?.id ? current.turnStartedAt : now,
      }))
      return
    }
    case 'item/started': {
      const change = itemStarted(params.item as Item)
      await patchAgent($, agent.id, current => params.turnId !== current.currentTurnId ? {} : ({ ...change, capacityWorkObserved: current.capacityWorkObserved || (params.item as Item).type !== 'userMessage' }))
      return
    }
    case 'item/completed':
      await patchAgent($, agent.id, current => params.turnId !== current.currentTurnId ? {} : ({ ...itemCompleted(current, params.item as Item), capacityWorkObserved: current.capacityWorkObserved || (params.item as Item).type !== 'userMessage' }))
      return
    case 'item/autoApprovalReview/completed': {
      if (typeof params.turnId !== 'string') return
      const line = autoReviewDigest(params)
      await patchAgent($, agent.id, current => params.turnId !== current.currentTurnId ? {} : ({ digest: [...current.digest, line] }))
      return
    }
    case 'thread/tokenUsage/updated': {
      const usage = params.tokenUsage as { total?: { totalTokens?: number } } | undefined
      await patchAgent($, agent.id, current => ({ tokens: usage?.total?.totalTokens ?? current.tokens }))
      return
    }
    case 'error': {
      if (typeof params.turnId !== 'string') return
      // Never terminal: only turn/completed ends a turn (Codex retries, or works on after a failed compaction).
      const message = (params.error as { message?: string } | undefined)?.message ?? 'error'
      const warning = params.willRetry === true ? `${message} (retrying)` : message
      await patchAgent($, agent.id, current => params.turnId !== current.currentTurnId ? {} : ({ warning, digest: [...current.digest, `warning: ${clip(firstLine(warning), 200)}`] }))
      return
    }
    case 'turn/completed': {
      if (!turn || typeof turn.id !== 'string') return
      if (startingThreads.has(params.threadId)) {
        let completed = earlyCompletions.get(params.threadId)
        if (!completed) earlyCompletions.set(params.threadId, completed = new Map())
        // Bounded while a single start is pending; unrelated old completions cannot bind.
        if (completed.size < 16) completed.set(turn.id, turn)
        // Apply terminal state after earlier buffered display events. Otherwise
        // binding persistence can settle the turn before its transcript drains.
        return
      }
      await finishTurn($, agent, turn)
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
      ...agent, warning: 'bridge reconnected; still running until the saved turn is confirmed ended', updatedAt: Math.max(now, agent.updatedAt + 1),
    }]
  })))
  for (const agent of Object.values(agents)) {
    if (agent.sessionId === sessionId) await postAt($, registryAddress ?? address, '/registry/write', { agent })
  }
  await $.store.set(STORE_KEY, trim(agents))
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

const TOOL_NAMES: readonly ToolName[] = ['codex_list', 'codex_result', 'codex_await']

/** Serves codex_list (this session's jobs) and codex_result (any job); a CodexError becomes the call's error text. */
async function runTool($: Engine, name: 'codex_list' | 'codex_result', e: unknown): Promise<string> {
  const args = e as Record<string, unknown>
  await reconcileAgents($, undefined, textArg(args.id))
  // Saved jobs stay readable on an outdated CLI; the warning says new ones will be refused.
  const outdated = codexVersionError(codexVersion)
  const warning = outdated ? `\n\nWarning: ${outdated} New codex:* agents are refused until then.` : ''
  if (name === 'codex_list') return listText(sorted(await read($, agentsAtom)), await $.session.id(), await $.clock.now(), args.all === true) + warning
  const ref = textArg(args.id)
  if (!ref) throw new CodexError('id is required')
  const agent = findIn(await read($, agentsAtom), ref)
  if (!agent) throw new CodexError(`No Codex agent "${ref}". codex_list shows them.`)
  return resultText(agent, args.full === true, await $.clock.now()) + warning
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
    await startBridge($)
    return started
  })

  // ---------------------------------------------------------- native agents

  // A codex:* spawn: the Codex thread starts before the subagent, so a bad model,
  // effort or header refuses the Agent call itself; its turn starts with the
  // prompt as given, header lines stripped, once the subagent's id is known.
  on('agent.spawn', async ($, e, next) => {
    const alias = aliasOfType(e.subagentType)
    if (alias === undefined) return next(e)
    if (e.resume !== undefined) {
      const id = resumeAgentId(e.resume)
      if (!id) return { deny: missingThread(e.name || 'unknown') }
      await reconcileAgents($, undefined, id)
      const saved = (await read($, agentsAtom))[id]
      if (!saved?.threadId) return { deny: missingThread(id) }
      return next(e)
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
        // Made unique as the job is recorded (putAgent), so two spawns at once never share one.
        name: taskLabel(e) || alias,
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
    spawnsInFlight += 1
    try {
      let spawned
      try { spawned = await next({ ...e, background: true }) } catch (error) {
        void releaseThread($, threadId).catch(() => undefined)
        throw error
      }
      if (spawned.agentId === undefined) {
        void releaseThread($, threadId).catch(() => undefined)
        return spawned
      }
      let agent: CodexAgent
      try {
        agent = await putAgent($, await newAgent($, spawned.agentId, threadId, input))
      } catch (error) {
        const now = await $.clock.now()
        await patchAgent($, spawned.agentId, () => ({ status: 'failed', turnEndedAt: now, error: `the Codex job could not be saved: ${errorText(error)}` })).catch(() => undefined)
        void releaseThread($, threadId).catch(() => undefined)
        return spawned
      }
      try {
        await startTurn($, agent, body)
      } catch (error) {
        // The subagent runs: it ends at once with this reason as its answer.
        const now = await $.clock.now()
        await patchAgent($, agent.id, () => ({ status: 'failed', error: `the Codex turn did not start: ${errorText(error)}`, turnEndedAt: now }))
        void releaseThread($, threadId).catch(() => undefined)
      }
      return spawned
    } finally {
      spawnsInFlight -= 1
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'codex: the Codex job did not start (the hook failed or ran out of time)' }))

  // The codex:* subagent's loop: every model request is answered here and no
  // Claude model runs. While the Codex turn runs, the answer is a codex_await
  // call; a codex-msg message is passed on as a SendMessage to main; once the
  // turn ended, the answer is the Codex final message, verbatim.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined || foreignAgents.has(e.agentId)) return yield* next(e)
    let agent = (await read($, agentsAtom))[e.agentId]
    if (!agent && !(await isCodexType($, e.agentId))) {
      foreignAgents.add(e.agentId)
      return yield* next(e)
    }
    await reconcileAgents($)
    agent = (await read($, agentsAtom))[e.agentId]
    if (deliveringAgents.has(e.agentId)) return yield* toolStep(e, AWAIT_TOOL, {})
    const message = agent?.outbox[0]
    if (agent && message !== undefined) {
      // A codex-msg message goes to the main session as this agent's own SendMessage, verbatim.
      await patchAgent($, agent.id, current => ({ outbox: current.outbox.slice(1) }))
      return yield* toolStep(e, 'SendMessage', { to: 'main', summary: messageSummary(message), message })
    }
    if (agent) {
      const events = liveActivity.take(agent.id, agent.currentTurnId ?? agent.lastTurnId ?? '')
      if (events.length) return yield* replayStep({ ...e, agentId: e.agentId }, events)
    }
    if (agent && !isLive(agent)) {
      const text = wrapperAnswer(agent)
      // Where the engine requires it (auto mode), the report goes back through SubagentHandback;
      // where that tool is not offered, its call fails and the final text is the report.
      if (!(await isHandbackRefused($, e.agentId))) return yield* toolStep(e, HANDBACK_TOOL, { message: text })
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }
    return yield* toolStep(e, AWAIT_TOOL, {})
  }).catch(async function* ($, e, next) {
    if (e.agentId === undefined || foreignAgents.has(e.agentId)) return yield* next(e)
    // A catch must answer locally (no Claude request), but cannot claim the
    // backend ended. All recovery I/O and bounded retries belong in codex_await.
    return yield* toolStep(e, AWAIT_TOOL, {})
  })

  // Ask the engine to accept delivery/resume before admitting native work. Its
  // wrapper waits through this handoff rather than returning the previous answer.
  on('session.send', async ($, e, next) => {
    const delivery: Delivery = { handled: false, admitted: false, cancelled: false, signal: next.signal }
    deliveries.set(next, delivery)
    let agent: CodexAgent | undefined
    try { agent = await recipient($, e.to) } catch (error) {
      return { isDelivered: false as const, reason: `Codex did not take the message: ${errorText(error)}` }
    }
    if (!agent) return next(e)
    delivery.handled = true
    if (!agent.threadId) return { isDelivered: false as const, reason: missingThread(agent.id) }
    // Verify the saved native binding before waking an idle wrapper. Resuming
    // a thread loads history/MCP only; input is admitted after engine acceptance.
    try { await onThread(agent.threadId, () => ensureLoaded($, agent)) } catch (error) {
      await recordDeliveryRefusal($, agent.id, error)
      return { isDelivered: false as const, reason: `Codex did not take the message: ${errorText(error)}` }
    }
    deliveringAgents.set(agent.id, (deliveringAgents.get(agent.id) ?? 0) + 1)
    delivery.agentId = agent.id
    try {
      const accepted = await next(e)
      if (!accepted.isDelivered) return accepted
      await sendMessage($, agent, e.text, delivery)
      return { isDelivered: true as const }
    } catch (error) {
      // After submission, a lost response is pending, never proof of refusal.
      // The retained operation owns the outcome; never repeat this payload.
      if (delivery.admitted) return { isDelivered: true as const }
      await recordDeliveryRefusal($, agent.id, error)
      return { isDelivered: false as const, reason: `Codex did not take the message: ${errorText(error)}` }
    } finally {
      endDelivery(delivery)
    }
  }).catch(($, e, next) => {
    const delivery = deliveries.get(next)
    if (delivery) endDelivery(delivery)
    if (delivery?.admitted) return { isDelivered: true as const }
    if (!delivery?.handled && next.called) return next(e)
    return { isDelivered: false as const, reason: 'codex: the message did not reach Codex; no native input was admitted' }
  })

  // The wrapper's SendMessage relays of Codex messages: the plugin made the call, so it allows it.
  // (SubagentHandback is left to the engine: only auto mode's classifier may allow it.)
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.tool_use_id === undefined || !relayCalls.delete(e.tool_use_id)) return next(e)
    return { decision: 'allow' as const, reason: "codex: relays a Codex job's message to the main session, verbatim" }
  })

  // Interruption belongs to the daemon, so it survives the wrapper's abort,
  // a cancelled HTTP call and an admission whose response has not arrived yet.

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const id = (e as unknown as { task_id?: string; shell_id?: string }).task_id ?? (e as unknown as { shell_id?: string }).shell_id
    const done = await next(e)
    if (done.deny !== undefined || done.isError || !id) return done
    const agent = await recipient($, id)
    if (!agent) return done
    await stopJob($, id)
    const current = id ? (await read($, agentsAtom))[id] : undefined
    return current && isLive(current)
      ? { ...done, result: { ...done.result as object, message: 'The Claude wrapper was stopped. Codex is still running; its exact turn has not been confirmed ended. Check codex_list for the native outcome.' } }
      : done
  }).catch(async ($, e, next) => {
    const done = await next(e)
    if (done.deny !== undefined || done.isError) return done
    return { ...done, result: { ...done.result as object, message: 'The wrapper stop was accepted; the native Codex outcome is unconfirmed. Check codex_list before retrying.' } }
  })

  // Also covers the task-list stop and an aborted wrapper outside TaskStop.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      for (const [id, receipt] of replayCalls) if (receipt.agentId === e.agentId) replayCalls.delete(id)
      if (e.reason === 'aborted' || e.isAborted) await stopJob($, e.agentId)
    }
    return next(e)
  })

  // ---------------------------------------------------------- tools

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!e.tool_use_id?.startsWith(REPLAY_PREFIX)) return next(e)
    const receipt = replayCalls.get(e.tool_use_id)
    replayCalls.delete(e.tool_use_id)
    if (!receipt || receipt.agentId !== e.agentId || receipt.command !== e.command) {
      return { deny: 'Codex command replay receipt unavailable; no command was executed.' }
    }
    return { result: { stdout: receipt.result, stderr: '', interrupted: false } }
  }).catch(($, e, next) => e.tool_use_id?.startsWith(REPLAY_PREFIX)
    ? { deny: 'Codex command replay failed; no command was executed.' }
    : next(e))

  // A pattern: the tools table a type-check reads lists the MCP tools of the last reload alone.
  on('tool.call', { tool: new RegExp(`^${AWAIT_TOOL}$`) }, async ($, e, next) => {
    try {
      return { result: await awaitJob($, e.agentId, next.signal) }
    } catch (error) {
      const agent = e.agentId ? (await read($, agentsAtom))[e.agentId] : undefined
      if (agent && isLive(agent)) return { result: `${STILL_RUNNING}: native outcome unconfirmed; waiting to reconnect.` }
      return { deny: errorText(error) }
    }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    const agent = e.agentId ? (await read($, agentsAtom))[e.agentId] : undefined
    return agent && isLive(agent)
      ? { result: `${STILL_RUNNING}: native outcome unconfirmed; waiting to reconnect.` }
      : { deny: 'codex: codex_await did not finish (its hook failed or ran out of time)' }
  })

  // One hook for both: a matcher over a union of names does not type-check.
  const toolPattern = new RegExp(`^${PREFIX}(codex_list|codex_result)$`)
  on('tool.call', { tool: toolPattern }, async ($, e) => {
    try {
      return { result: await runTool($, e.tool.slice(PREFIX.length) as 'codex_list' | 'codex_result', e) }
    } catch (error) {
      return { deny: errorText(error) }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `codex: ${e.tool.slice(PREFIX.length)} did not finish (its hook failed or ran out of time)` }))

  // List codex_list and codex_result up front rather than behind ToolSearch; codex_await stays behind it.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    return e.tool.startsWith(PREFIX) && e.tool !== AWAIT_TOOL ? { ...described, isDeferred: false } : described
  })

  // ---------------------------------------------------------- drawing

  // Await is transport only, including terminal/relay outcomes. Assistant text
  // and Bash receipts are ordinary engine blocks with no custom rendering.
  for (const tool of TOOL_NAMES) {
    on('ui.render', { component: 'ToolUse', props: { tool: `${PREFIX}${tool}` } }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      const { isRunning, isErrored, isInterrupted } = e.props
      const text = outputText(e.props.output)
      if (tool === 'codex_await') return <Box />
      const result = isRunning || isInterrupted || isErrored ? null : rowResult(tool, text)
      const dot = isErrored || isInterrupted ? 'error' : isRunning ? 'inactive' : 'success'
      return (
        <Box flexDirection="column">
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

    // List/result keep their compact summary; awaits never add transcript chrome.
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
