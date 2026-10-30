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

import type { CodexAgent, CodexApprovals, CodexSandbox, OutboxItem } from '../types'
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
  fromAgent,
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
/** How long one codex_await call blocks before the wrapper's loop calls it again. */
const AWAIT_MS = 3_600_000
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
/** Per thread, the tail of its loads, turn starts and releases, which run one at a time. */
const threadQueues = new Map<string, Promise<unknown>>()
/** The node binary the bridge runs on, which Codex runs bin/codex-msg on too. */
let nodeBinary = 'node'
/** Subagents seen at turn.step that are not codex:* agents. */
const foreignAgents = new Set<string>()
let models: Map<string, string[]> | null = null
/** `codex --version` as the running bridge's relay read it; undefined from a relay that does not report it. */
let codexVersion: string | null | undefined
let askChain: Promise<unknown> = Promise.resolve()

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
      await onEvent($, event)
      if (event.type === 'ready') current.resolve(event.socket)
    } catch (error) {
      if (event.type === 'ready') current.reject(new CodexError(`codex recovery failed: ${errorText(error)}`))
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
  | { status: 'timeout' }

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
  return onThread(agent.threadId, async () => {
    await ensureLoaded($, agent)
    const now = await $.clock.now()
    const started = await rpc<{ turn: { id: string } }>($, 'turn/start', turnStartParams(agent, text))
    const written = await patchAgent($, agent.id, current => ({
      status: 'running',
      // turn/started may already have landed with the same id
      currentTurnId: started.turn.id,
      error: null,
      warning: null,
      activity: current.currentTurnId === started.turn.id ? current.activity : 'thinking',
      turnStartedAt: now,
    }))
    return written ?? agent
  })
}

/** Steers the running turn, or starts a new one when none runs. */
async function sendMessage($: Engine, agent: CodexAgent, text: string): Promise<'steered' | 'started'> {
  if (agent.status === 'running' && agent.currentTurnId) {
    try {
      await ensureLoaded($, agent)
      await rpc($, 'turn/steer', { threadId: agent.threadId, expectedTurnId: agent.currentTurnId, input: textInput(text) })
      return 'steered'
    } catch (error) {
      // The turn ended between our read and the steer: start a new one below.
      if (!(error instanceof CodexError)) throw error
    }
  }
  await startTurn($, agent, text)
  return 'started'
}

// ------------------------------------------------------------ native agents

/** Whether a subagent no record names yet is a codex:* agent (its spawn hook is still starting the turn). */
async function isCodexType($: Engine, agentId: string): Promise<boolean> {
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  return info !== undefined && aliasOfType(info.type) !== undefined
}

/** The Codex job a SendMessage recipient names: an agentId, or the name the Agent call gave. */
async function recipient($: Engine, to: string): Promise<CodexAgent | undefined> {
  const info = (await $.agent.list()).find(agent => agent.id === to || agent.name === to)
  if (!(await read($, agentsAtom))[to] && (!info || aliasOfType(info.type) === undefined)) return undefined
  await reconcileAgents($)
  const agents = await read($, agentsAtom)
  if (agents[to]) return agents[to]
  return info ? agents[info.id] : undefined
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
          all[id] = { ...all[id]!, status: 'interrupted', currentTurnId: null, lastTurnStatus: 'interrupted', turnEndedAt: now,
            error: 'the turn was lost when the Codex process restarted; a SendMessage to its agent starts a new turn on the thread' }
        }
        changed.push(id)
      }
    }
    return all
  })
  for (const id of changed) await postAt($, target, '/registry/write', { agent: agents[id] })
  if (changed.length) await $.store.set(STORE_KEY, trim(agents))
}

/** Records how the turn the bridge reported ended, if the registry has not yet. */
async function settleTurn($: Engine, agent: CodexAgent, answer: WaitAnswer): Promise<void> {
  if (answer.status === 'timeout' || answer.status === 'message') return
  const now = await $.clock.now()
  const turn = answer.turn
  await patchAgent($, agent.id, current => {
    if (!isLive(current)) return {}
    if (turn && (current.currentTurnId === null || turn.id === current.currentTurnId)) return afterTurn(current, turn, now)
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

const messagesText = (messages: readonly (OutboxItem | string)[]) => {
  const to = [...new Set(messages.map(item => outboxItem(item).to ?? 'main'))]
  return `Codex sent ${messages.length === 1 ? 'a message' : `${messages.length} messages`} for ${to.join(', ')}.`
}

/** When each subagent's last turn ended, as turn.complete saw it: list_agents hides one finished longer ago than RECENT_FINISHED_MS. */
const agentEndedAt = new Map<string, number>()

/** codex:* jobs and Claude subagents of this session that run or finished within RECENT_FINISHED_MS. */
async function recentAgents($: Engine): Promise<{ name: string; type: string; status: string; description: string }[]> {
  const now = await $.clock.now()
  const jobs = await read($, agentsAtom)
  return (await $.agent.list()).flatMap(info => {
    const job = jobs[info.id]
    const live = job ? isLive(job) : ['pending', 'running', 'waiting', 'idle'].includes(info.status)
    const endedAt = job ? job.turnEndedAt : (agentEndedAt.get(info.id) ?? 0)
    if (!live && endedAt < now - RECENT_FINISHED_MS) return []
    const status = job ? (isLive(job) ? 'running' : (job.lastTurnStatus ?? job.status)) : info.status
    return [{ name: info.name ?? info.id, type: info.type, status, description: info.description }]
  })
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
  await reconcileAgents($)
  const startedAt = await $.clock.now()
  const deadline = startedAt + AWAIT_MS
  let settling = 0
  for (;;) {
    const agent = (await read($, agentsAtom))[agentId]
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
    if (left <= 0) return `${STILL_RUNNING}: ${describeAgent(agent, await $.clock.now())}`
    // Each poll refreshes the list a running job's list_agents reads.
    await pushRoster($)
    let answer: WaitAnswer
    try {
      answer = await waitTurn($, agent.threadId, Math.min(left, POLL_SLICE_MS), agent.msgKey)
    } catch (error) {
      if (signal.aborted) throw error
      // A host HTTP timeout alone does not mean the Codex process died.
      if (/no complete answer within 30000ms/.test(errorText(error))) continue
      // The bridge is gone (its daemon stopped or reset the wait): the turn cannot be followed, so the job
      // ends interrupted with the reason; its thread is intact, and a SendMessage starts a new turn on it.
      const now = await $.clock.now()
      await patchAgent($, agentId, () => ({
        status: 'interrupted',
        currentTurnId: null,
        lastTurnStatus: 'interrupted',
        error: `the Codex bridge was lost (${errorText(error)}); a SendMessage to its agent starts a new turn on the thread`,
        turnEndedAt: now,
      }))
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
  if (method.startsWith('item/') && typeof params.turnId === 'string' && !isLive(agent)) {
    // The thread still works after its job was settled: the job runs again.
    const turnId = params.turnId
    await patchAgent($, agent.id, current => isLive(current) ? {} : {
      status: 'running', currentTurnId: turnId,
      warning: `Codex kept working after its turn was reported ${current.lastTurnStatus ?? current.status}${current.error ? `: ${current.error}` : ''}`,
      error: null,
    })
  }
  switch (method) {
    case 'turn/started': {
      const now = await $.clock.now()
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
        current.currentTurnId === null || current.currentTurnId === turn.id ? afterTurn(current, turn, now) : {},
      )
      // Never hold the event loop on the release. A failed turn's thread stays subscribed: Codex may work on.
      if (turn.status !== 'failed') void releaseThread($, params.threadId)
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
    if (alias === undefined) {
      const spawned = await next(e)
      await pushRoster($)
      return spawned
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
    spawnsInFlight += 1
    try {
      const spawned = await next({ ...e, background: true })
      if (spawned.agentId === undefined) {
        void releaseThread($, threadId)
        return spawned
      }
      const agent = await putAgent($, await newAgent($, spawned.agentId, threadId, input))
      try {
        await startTurn($, agent, body)
      } catch (error) {
        // The subagent runs: it ends at once with this reason as its answer.
        const now = await $.clock.now()
        await patchAgent($, agent.id, () => ({ status: 'failed', error: `the Codex turn did not start: ${errorText(error)}`, turnEndedAt: now }))
        void releaseThread($, threadId)
      }
      await pushRoster($)
      return spawned
    } finally {
      spawnsInFlight -= 1
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'codex: the Codex job did not start (the hook failed or ran out of time)' }))

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
    await reconcileAgents($)
    agent = (await read($, agentsAtom))[e.agentId]
    while (agent && agent.outbox.length > 0) {
      // A codex-msg message goes out as this agent's own SendMessage, verbatim.
      const { text, to = 'main' } = outboxItem(agent.outbox[0] as OutboxItem | string)
      agent = (await patchAgent($, agent.id, current => ({ outbox: current.outbox.slice(1) }))) ?? agent
      if (to === 'main' || (await $.agent.list()).some(info => info.id === to || info.name === to)) {
        return yield* toolStep(e, 'SendMessage', { to, summary: messageSummary(text), message: text })
      }
      // The engine would refuse it after the call, out of Codex's sight: Codex hears it instead.
      await sendMessage($, agent, `Message to ${to} not delivered: no agent of this session has that name. list_agents shows the agents you can message.`).catch(error =>
        $.ui.log(`codex: telling ${agent?.name} its message to ${to} was not delivered failed: ${errorText(error)}`),
      )
      agent = (await read($, agentsAtom))[e.agentId]
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
  })

  // SendMessage to a codex:* agent goes to Codex first: a steer while its turn
  // runs, a new turn on the thread once it ended (the delivery then resumes the
  // subagent, whose loop waits for that turn). Refused when Codex refuses it.
  on('session.send', async ($, e, next) => {
    const agent = await recipient($, e.to)
    if (!agent) return next(e)
    if (!agent.threadId) return { isDelivered: false as const, reason: missingThread(agent.id) }
    // From another agent, Codex is told whom to answer; main's messages arrive as they are.
    const sender = e.agentId === undefined ? undefined : (await $.agent.list()).find(info => info.id === e.agentId)
    const text = e.agentId === undefined ? e.text : fromAgent(sender?.name ?? e.agentId, e.text)
    try {
      await sendMessage($, agent, text)
    } catch (error) {
      const now = await $.clock.now()
      await patchAgent($, agent.id, () => ({
        ...(agent.status === 'running' ? {} : { status: 'failed' as const, currentTurnId: null, turnEndedAt: now }),
        error: `the Codex message did not start or resume a turn: ${errorText(error)}`,
      }))
      return { isDelivered: false as const, reason: `Codex did not take the message: ${errorText(error)}` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { isDelivered: false as const, reason: 'codex: the message did not reach Codex' }))

  // The wrapper's SendMessage relays of Codex messages: the plugin made the call, so it allows it.
  // (SubagentHandback is left to the engine: only auto mode's classifier may allow it.)
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.tool_use_id === undefined || !relayCalls.delete(e.tool_use_id)) return next(e)
    return { decision: 'allow' as const, reason: "codex: relays a Codex job's message, verbatim" }
  })

  // TaskStop, or the task list's stop, kills the subagent mid codex_await: its
  // turn ends aborted, and the Codex turn under it is interrupted.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) agentEndedAt.set(e.agentId, await $.clock.now())
    if (e.agentId === undefined || e.reason !== 'aborted') return done
    const agent = (await read($, agentsAtom))[e.agentId]
    if (agent?.status === 'running' && agent.currentTurnId) {
      await rpc($, 'turn/interrupt', { threadId: agent.threadId, turnId: agent.currentTurnId }).catch(error =>
        $.ui.log(`codex: interrupting ${agent.name} failed: ${errorText(error)}`),
      )
    }
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
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'codex: codex_await did not finish (its hook failed or ran out of time)' }))

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
