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
  bridgeTarget,
  byThread,
  clip,
  CodexError,
  describeAgent,
  findIn,
  firstLine,
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
  effortFor,
  PER_MODEL_EFFORT,
  PREFIX,
  fallbackWarning,
  MODEL_ALIASES,
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
const POLL_SLICE_MS = 25_000
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
/** Whether this load already warned that the Codex CLI is too old for an alias's model. */
let hasWarnedOldCli = false
let askChain: Promise<unknown> = Promise.resolve()

// ------------------------------------------------------------ registry

async function afterWrite($: Engine, agents: Record<string, CodexAgent>): Promise<void> {
  await $.store.set(STORE_KEY, agents)
}

/** Records a new job, its name made unique among the jobs at that moment; resolves the job as written. */
async function putAgent($: Engine, agent: CodexAgent): Promise<CodexAgent> {
  let written = agent
  const agents = await update($, agentsAtom, all => {
    written = sanitize({ ...agent, name: uniqueName(all, agent.name) })
    return trim({ ...all, [agent.id]: written })
  })
  await afterWrite($, agents)
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
    written = sanitize({ ...agent, ...change(agent), updatedAt: now })
    return { ...all, [id]: written }
  })
  if (written) await afterWrite($, agents)
  return written
}

/** Fills $.state from the store after a restart; after a reload $.state is the fresher copy. */
async function loadFromStore($: Engine): Promise<void> {
  const stored = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, CodexAgent>
  const agents = await update($, agentsAtom, live => ({ ...stored, ...live }))
  await afterWrite($, agents)
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

  const handle = async (line: string) => {
    let event: BridgeEvent
    try {
      event = JSON.parse(line) as BridgeEvent
    } catch {
      $.ui.log(`codex bridge: unreadable line ${clip(line, 200)}`, { to: 'debug' })
      return
    }
    if (event.type === 'ready') current.resolve(event.socket)
    if (event.type === 'fatal') current.reject(new CodexError(`codex bridge failed: ${event.message}`))
    try {
      await onEvent($, event)
    } catch (error) {
      $.ui.log(`codex: handling ${clip(line, 120)} failed: ${String(error)}`, { to: 'debug' })
    }
  }

  void (async () => {
    const lines = new LineBuffer()
    try {
      for await (const chunk of $.process.spawn({ argv })) {
        if (chunk.stream === 'stderr') {
          $.ui.log(`codex bridge: ${chunk.text.trimEnd()}`, { to: 'debug' })
          continue
        }
        for (const line of lines.push(chunk.text)) await handle(line)
      }
      for (const line of lines.rest()) await handle(line)
    } catch (error) {
      $.ui.log(`codex bridge stopped: ${String(error)}`)
    } finally {
      isBridgeRunning = false
      loadedThreads.clear()
      current.reject(new CodexError('the codex bridge stopped'))
      if (socket === current) socket = null
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
  const { url, socketPath } = bridgeTarget(await bridgeSocket($), endpoint)
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
  return (await post($, '/rpc', { method, params, timeoutMs: POLL_SLICE_MS })).result as T
}

type WaitAnswer =
  | { status: 'completed' | 'idle'; turn: { id?: string; status?: string; items?: Item[] } | null }
  | { status: 'message'; messages: string[] }
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
  const agents = await read($, agentsAtom)
  if (agents[to]) return agents[to]
  const info = (await $.agent.list()).find(agent => agent.name === to)
  return info ? agents[info.id] : undefined
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
 * codex-msg message, and answers which; after AWAIT_MS it answers that the job
 * still runs. The wrapper's loop (turn.step) then passes a message on, or calls
 * it again, or ends with the result.
 */
async function awaitJob($: Engine, agentId: string | undefined, signal: AbortSignal): Promise<string> {
  if (agentId === undefined) throw new CodexError('codex_await serves codex:* agents only')
  const startedAt = await $.clock.now()
  const deadline = startedAt + AWAIT_MS
  let settling = 0
  for (;;) {
    const agent = (await read($, agentsAtom))[agentId]
    if (agent && !isLive(agent)) {
      // A message sent just before the turn ended still goes out, ahead of the result;
      // with the bridge gone there is none to read, and the result goes alone.
      try {
        const last = (await post($, '/wait', { threadId: agent.threadId, msgKey: agent.msgKey, timeoutMs: 1 })) as unknown as WaitAnswer
        if (last.status === 'message') await queueMessages($, agentId, last.messages)
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
    let answer: WaitAnswer
    try {
      answer = await waitTurn($, agent.threadId, Math.min(left, POLL_SLICE_MS), agent.msgKey)
    } catch (error) {
      if (signal.aborted) throw error
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
      return messagesText(answer.messages.length)
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
      const error = params.error as { message?: string } | undefined
      if (params.willRetry !== true) await patchAgent($, agent.id, () => ({ error: error?.message ?? 'error' }))
      return
    }
    case 'turn/completed': {
      if (!turn) return
      const now = await $.clock.now()
      // A late end of an earlier turn leaves a newer running one alone.
      await patchAgent($, agent.id, current =>
        current.currentTurnId === null || current.currentTurnId === turn.id ? afterTurn(current, turn, now) : {},
      )
      // Never hold the event loop on the release.
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
async function onReady($: Engine, reattached: boolean, active: Record<string, string>): Promise<void> {
  for (const agent of Object.values(await read($, agentsAtom))) {
    if (!isLive(agent)) continue
    const turnId = active[agent.threadId]
    if (turnId) {
      loadedThreads.add(agent.threadId)
      await patchAgent($, agent.id, () => ({ status: 'running', currentTurnId: turnId }))
    } else if (!reattached) {
      // A reattached daemon replays the turn's end from its buffer; a new one never saw it.
      await patchAgent($, agent.id, () => ({
        status: 'interrupted',
        currentTurnId: null,
        lastTurnStatus: 'interrupted',
        error: 'the turn was lost when the Codex process restarted; a SendMessage to its agent starts a new turn on the thread',
      }))
    }
  }
}

async function onEvent($: Engine, event: BridgeEvent): Promise<void> {
  switch (event.type) {
    case 'ready':
      await onReady($, event.reattached, event.active)
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
      for (const agent of Object.values(await read($, agentsAtom))) {
        if (isLive(agent)) {
          await patchAgent($, agent.id, () => ({ status: 'failed', currentTurnId: null, error: 'codex app-server exited' }))
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
  if (name === 'codex_list') return listText(sorted(await read($, agentsAtom)), await $.session.id(), await $.clock.now())
  const ref = textArg(args.id)
  if (!ref) throw new CodexError('id is required')
  const agent = findIn(await read($, agentsAtom), ref)
  if (!agent) throw new CodexError(`No Codex agent "${ref}". codex_list shows them.`)
  return resultText(agent, args.full === true, await $.clock.now())
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
    let input: JobInput
    let body: string
    let threadId: string
    try {
      const header = parseHeader(e.prompt)
      body = header.body
      if (body.trim() === '') return { deny: 'codex: the prompt is empty once its header lines are taken off' }
      const defaults = effectiveDefaults(settings, await projectConfig($))
      const listed = await listModels($)
      const model = modelFor(listed, alias)
      const effort = header.effort ?? effortFor(defaults, alias)
      const { sandbox, approvals } = permissionsFor(header, defaults)
      const error = modelEffortError(listed, model, effort)
      if (error) return { deny: `codex: ${error}` }
      if (model !== MODEL_ALIASES[alias] && !hasWarnedOldCli) {
        hasWarnedOldCli = true
        $.ui.log(fallbackWarning(alias, model))
        $.ui.toast(fallbackWarning(alias, model), { timeoutMs: 10_000 })
      }
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
      await patchAgent($, agent.id, () => ({ status: 'failed', error: `the Codex turn did not start: ${errorText(error)}` }))
      void releaseThread($, threadId)
    }
    return spawned
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'codex: the Codex job did not start (the hook failed or ran out of time)' }))

  // The codex:* subagent's loop: every model request is answered here and no
  // Claude model runs. While the Codex turn runs, the answer is a codex_await
  // call; a codex-msg message is passed on as a SendMessage to main; once the
  // turn ended, the answer is the Codex final message, verbatim.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined || foreignAgents.has(e.agentId)) return yield* next(e)
    const agent = (await read($, agentsAtom))[e.agentId]
    if (!agent && !(await isCodexType($, e.agentId))) {
      foreignAgents.add(e.agentId)
      return yield* next(e)
    }
    const message = agent?.outbox[0]
    if (agent && message !== undefined) {
      // A codex-msg message goes to the main session as this agent's own SendMessage, verbatim.
      await patchAgent($, agent.id, current => ({ outbox: current.outbox.slice(1) }))
      return yield* toolStep(e, 'SendMessage', { to: 'main', summary: messageSummary(message), message })
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
    try {
      await sendMessage($, agent, e.text)
    } catch (error) {
      return { isDelivered: false as const, reason: `Codex did not take the message: ${errorText(error)}` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { isDelivered: false as const, reason: 'codex: the message did not reach Codex' }))

  // The wrapper's SendMessage relays of Codex messages: the plugin made the call, so it allows it.
  // (SubagentHandback is left to the engine: only auto mode's classifier may allow it.)
  on('tool.check', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.tool_use_id === undefined || !relayCalls.delete(e.tool_use_id)) return next(e)
    return { decision: 'allow' as const, reason: "codex: relays a Codex job's message to the main session, verbatim" }
  })

  // TaskStop, or the task list's stop, kills the subagent mid codex_await: its
  // turn ends aborted, and the Codex turn under it is interrupted.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
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
    const tail = runningTail(Object.values(await read($, agentsAtom)))
    if (!tail) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })
}
