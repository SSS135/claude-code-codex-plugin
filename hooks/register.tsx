// codex: OpenAI Codex agents as background workers of this Claude session.
//
//   Claude --mcp__codex__* tools--> this module --$.http.fetch(socketPath)-->
//   bin/bridge.mjs daemon --stdio JSON-RPC--> codex app-server
//   bridge relay stdout (NDJSON events) --$.process.spawn--> onEvent
//
// Every engine call lives in this file (the engine follows `$` only within
// one file); hooks/model.ts holds the pure logic it calls.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexAgent, CodexApprovals, CodexSandbox } from '../types'
import {
  aliasOf,
  afterTurn,
  approvalAnswer,
  approvalDigest,
  approvalOptions,
  approvalQuestion,
  autoReviewDigest,
  configDirs,
  type Defaults,
  effectiveDefaults,
  parseProjectConfig,
  permissionsFor,
  PROJECT_CONFIG,
  ruleLines,
  RULES_FILE,
  WakeLedger,
  withoutRule,
  type BridgeEvent,
  byThread,
  clip,
  CodexError,
  COMMAND,
  describeAgent,
  findIn,
  finalMessage,
  firstLine,
  formatTokens,
  isLive,
  type Item,
  itemCompleted,
  itemStarted,
  LineBuffer,
  modelEffortError,
  PANE,
  PREFIX,
  resolveModel,
  resultText,
  sandboxMode,
  approvalParams,
  sanitize,
  type Settings,
  sorted,
  spawnedText,
  statusColor,
  statusDot,
  textInput,
  threadResumeParams,
  timeOf,
  toolSpecs,
  trim,
  turnStartParams,
  uniqueName,
  type Verdict,
  verdictOf,
  WAKE_PATTERN,
  wakeText,
} from './model'

type Engine = EngineInterface

// ------------------------------------------------------------ state

const agentsAtom = atom({ plugin: 'codex', key: 'agents' } as const, {})
const selectedAtom = atom({ plugin: 'codex', key: 'selected' } as const, null)
const showResultAtom = atom({ plugin: 'codex', key: 'showResult' } as const, false)
const callsAtom = atom({ plugin: 'codex', key: 'calls' } as const, {})
const mainBusyAtom = atom({ plugin: 'codex', key: 'mainBusy' } as const, false)
const approvalsAtom = atom({ plugin: 'codex', key: 'approvals' } as const, [])
const bridgeKeyAtom = atom({ plugin: 'codex', key: 'bridgeKey' } as const, null)

const STORE_KEY = 'agents'
/** Under the 30 s after which $.http.fetch gives up on an answer. */
const POLL_SLICE_MS = 25_000

// Module state starts over on a reload, which is right: a reload ends every
// in-flight wait, dialog and the bridge relay along with it.
type Socket = { promise: Promise<string>; resolve: (path: string) => void; reject: (error: Error) => void }
let socket: Socket | null = null
let isBridgeRunning = false
/** Threads loaded into the running app-server (thread/start or thread/resume). */
const loadedThreads = new Set<string>()
/** Agents a codex_wait call blocks on: their completion wakes nobody. */
const waiting = new Set<string>()
/** Wake notices appended into the running main turn, settled when it ends. */
const ledger = new WakeLedger()
let pendingAppends: Promise<unknown>[] = []
let models: Map<string, string[]> | null = null
let askChain: Promise<unknown> = Promise.resolve()

// ------------------------------------------------------------ registry

async function afterWrite($: Engine, agents: Record<string, CodexAgent>): Promise<void> {
  await $.store.set(STORE_KEY, agents)
  const running = Object.values(agents).filter(isLive).length
  $.ui.status(running > 0 ? `codex: ${running} running` : undefined)
}

async function putAgent($: Engine, agent: CodexAgent): Promise<void> {
  const agents = await update($, agentsAtom, all => trim({ ...all, [agent.id]: sanitize(agent) }))
  await afterWrite($, agents)
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

/** The configured binary when it is on disk, else its bare name, which the spawn finds on PATH. */
async function resolveBinary($: Engine, configured: string, name: string): Promise<string> {
  return (await $.fs.exists(configured)) ? configured : name
}

/** Starts the relay; its events reach `onEvent` in order for the session's life. */
async function startBridge($: Engine, settings: Settings): Promise<void> {
  if (isBridgeRunning) return
  isBridgeRunning = true
  const current = newSocket()
  socket = current
  // Kept in $.state so a reload reattaches to the same daemon; a restart starts a new one.
  const fresh = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const key = (await update($, bridgeKeyAtom, held => held ?? fresh)) as string
  const node = await resolveBinary($, settings.nodePath, 'node')
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

async function post($: Engine, endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  if (!socket) throw new CodexError('the codex bridge is not running')
  const socketPath = await socket.promise
  const response = await $.http.fetch(`http://codex${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath,
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

type WaitAnswer = { status: 'completed' | 'idle'; turn: { status?: string; items?: Item[] } | null } | { status: 'timeout' }

/** Long-polls the bridge until the thread's turn ends: time inside $.http.fetch is budget-free. */
async function waitTurn($: Engine, threadId: string, timeoutMs: number): Promise<WaitAnswer> {
  // $.http.fetch gives up after 30 s and takes no timeout option: poll in slices under that.
  const deadline = (await $.clock.now()) + timeoutMs
  for (;;) {
    const left = deadline - (await $.clock.now())
    const slice = Math.max(1, Math.min(left, POLL_SLICE_MS))
    const answer = (await post($, '/wait', { threadId, timeoutMs: slice })) as unknown as WaitAnswer
    if (answer.status !== 'timeout' || left <= POLL_SLICE_MS) return answer
  }
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
    await rpc($, 'thread/resume', threadResumeParams(agent))
  } catch (error) {
    if (error instanceof CodexError && error.message.includes('active writer')) {
      throw new CodexError(
        `${agent.name}'s thread is still held by another Codex process: the previous Claude session's (it exits about 20 s after that session ends) or another live session's. Try again shortly.`,
      )
    }
    throw error
  }
  loadedThreads.add(agent.threadId)
}

type SpawnInput = {
  prompt: string
  name: string
  model: string
  effort: string
  sandbox: CodexSandbox
  approvals: CodexApprovals
  cwd: string
}

async function spawnAgent($: Engine, input: SpawnInput): Promise<CodexAgent> {
  const error = modelEffortError(await listModels($), input.model, input.effort)
  if (error) throw new CodexError(error)
  const started = await rpc<{ thread: { id: string }; model: string }>($, 'thread/start', {
    model: input.model,
    cwd: input.cwd,
    sandbox: sandboxMode(input.sandbox),
    ...approvalParams(input.approvals),
    ephemeral: false,
  })
  loadedThreads.add(started.thread.id)
  const now = await $.clock.now()
  const agent: CodexAgent = {
    id: crypto.randomUUID().slice(0, 6),
    name: input.name,
    threadId: started.thread.id,
    model: started.model,
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
    lastCommand: '',
    tokens: 0,
    error: null,
    digest: [],
    notify: true,
    startedAt: now,
    updatedAt: now,
    turnStartedAt: now,
    turnEndedAt: 0,
    sessionId: await $.session.id(),
  }
  await putAgent($, agent)
  return startTurn($, agent, input.prompt)
}

/** Starts a new turn, passing sandbox, approvals, model and effort again. */
async function startTurn($: Engine, agent: CodexAgent, text: string): Promise<CodexAgent> {
  await ensureLoaded($, agent)
  const now = await $.clock.now()
  const started = await rpc<{ turn: { id: string } }>($, 'turn/start', turnStartParams(agent, text))
  const written = await patchAgent($, agent.id, current => ({
    status: 'running',
    // turn/started may already have landed with the same id
    currentTurnId: started.turn.id,
    notify: true,
    error: null,
    activity: current.currentTurnId === started.turn.id ? current.activity : 'thinking',
    turnStartedAt: now,
  }))
  return written ?? agent
}

/** Steers the running turn, or starts a new one when none runs. */
async function sendMessage($: Engine, agent: CodexAgent, text: string): Promise<{ kind: 'steered' | 'started'; agent: CodexAgent }> {
  if (agent.status === 'running' && agent.currentTurnId) {
    try {
      await ensureLoaded($, agent)
      await rpc($, 'turn/steer', { threadId: agent.threadId, expectedTurnId: agent.currentTurnId, input: textInput(text) })
      const written = await patchAgent($, agent.id, () => ({ notify: true }))
      return { kind: 'steered', agent: written ?? agent }
    } catch (error) {
      // The turn ended between our read and the steer: start a new one below.
      if (!(error instanceof CodexError)) throw error
    }
  }
  return { kind: 'started', agent: await startTurn($, agent, text) }
}

/** Interrupts the running turn and waits up to 15 s for it to end. */
async function stopAgent($: Engine, agent: CodexAgent): Promise<string> {
  if (agent.status !== 'running' || !agent.currentTurnId) return `${agent.name} is not running (${agent.status}).`
  await patchAgent($, agent.id, () => ({ notify: false }))
  await rpc($, 'turn/interrupt', { threadId: agent.threadId, turnId: agent.currentTurnId })
  const answer = await waitTurn($, agent.threadId, 15_000)
  if (answer.status === 'timeout') return `Interrupt sent to ${agent.name}; its turn has not ended yet.`
  return `${agent.name} stopped (${answer.turn?.status ?? 'interrupted'}). codex_send continues it with the same sandbox and approvals.`
}

/** Blocks until the running turn ends or the timeout passes. */
async function waitForAgent($: Engine, agent: CodexAgent, timeoutMs: number): Promise<'done' | 'timeout'> {
  if (agent.status !== 'running') return 'done'
  waiting.add(agent.id)
  try {
    const answer = await waitTurn($, agent.threadId, timeoutMs)
    if (answer.status === 'timeout') return 'timeout'
    const final = finalMessage(answer.turn?.items ?? [])
    await patchAgent($, agent.id, () => ({ notify: false, ...(final !== null ? { lastMessage: final } : {}) }))
    return 'done'
  } finally {
    waiting.delete(agent.id)
  }
}

// ------------------------------------------------------------ wake

async function wake($: Engine, agent: CodexAgent): Promise<void> {
  const text = wakeText(agent)
  if (await read($, mainBusyAtom)) {
    // Not awaited here: the event loop must not stall on it; turn.complete
    // waits for it before settling the ledger.
    const index = ledger.add(agent.name, text)
    pendingAppends.push(
      $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
        .then(stored => ledger.settle(index, stored.deny === undefined))
        .catch(error => {
          ledger.settle(index, false)
          $.ui.log(`codex: wake failed: ${String(error)}`)
        }),
    )
    return
  }
  void $.prompt.submit({ text }).catch(error => $.ui.log(`codex: wake failed: ${String(error)}`))
}

/** At the main turn's end: deliver what the model has not read, exactly once. */
async function flushWakes($: Engine): Promise<void> {
  await Promise.all(pendingAppends)
  pendingAppends = []
  const text = ledger.flush()
  if (text !== null) void $.prompt.submit({ text }).catch(error => $.ui.log(`codex: wake failed: ${String(error)}`))
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
      const written = await patchAgent($, agent.id, current => afterTurn(current, turn, now))
      if (!written) return
      $.ui.toast(`Codex ${written.name}: ${written.lastTurnStatus}${written.error ? ` (${clip(written.error, 80)})` : ''}`)
      if (agent.notify && !waiting.has(agent.id)) await wake($, written)
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
    await update($, approvalsAtom, list => [...list, { agentId: agent?.id ?? '', requestId: id, summary: question }])
    try {
      const reason = typeof params.reason === 'string' && params.reason ? `\nReason: ${params.reason}` : ''
      verdict = await askPerson($, `${question}${reason}\nAllow it?`, approvalOptions(method, params))
    } finally {
      await update($, approvalsAtom, list => list.filter(one => one.requestId !== id))
    }
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
        error: 'the turn was lost when the Codex process restarted; codex_send continues the thread',
        notify: false,
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

async function rulesPath($: Engine): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new CodexError('HOME is not set')
  return `${home}/${RULES_FILE}`
}

/** /codex rules [rm <n>]: Codex's own allow rules, which "Allow always" adds. */
async function rulesCommand($: Engine, rest: string[]): Promise<string> {
  const path = await rulesPath($)
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  if (rest[0] === 'rm') {
    const n = Number(rest[1])
    const edited = Number.isInteger(n) ? withoutRule(text, n) : null
    if (!edited) return `No rule ${rest[1] ?? ''} in ${path}. /codex rules lists them.`
    await $.fs.write(path, edited.text)
    return `Removed ${edited.removed}\nCodex reads its rules when it starts: agents already running keep the rule until this session restarts.`
  }
  const rules = ruleLines(text)
  if (rules.length === 0) return `No Codex allow rules in ${path}. "Allow always" in an approval dialog adds one.`
  return [`Codex allow rules (${path}):`, ...rules.map((entry, i) => `${i + 1}. ${entry.rule}`), 'Remove one with /codex rules rm <n>.'].join('\n')
}

const argsOf = (e: unknown) => e as Record<string, unknown>
const textArg = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const TOOL_NAMES = ['codex_spawn', 'codex_send', 'codex_stop', 'codex_list', 'codex_result', 'codex_wait'] as const
type ToolName = (typeof TOOL_NAMES)[number]

async function agentFor($: Engine, e: unknown): Promise<CodexAgent> {
  const ref = textArg(argsOf(e).id)
  if (!ref) throw new CodexError('id is required')
  const agent = findIn(await read($, agentsAtom), ref)
  if (!agent) throw new CodexError(`No Codex agent "${ref}". codex_list shows them.`)
  return agent
}

async function rememberCall($: Engine, toolUseId: string, agentId: string): Promise<void> {
  await update($, callsAtom, calls => Object.fromEntries(Object.entries({ ...calls, [toolUseId]: agentId }).slice(-200)))
}

/** Serves one of our tools; a CodexError becomes the call's error text. */
async function runTool($: Engine, name: ToolName, e: unknown, settings: Settings): Promise<string> {
  await startBridge($, settings)
  const args = argsOf(e)
  switch (name) {
    case 'codex_spawn': {
      const prompt = textArg(args.prompt)
      if (!prompt) throw new CodexError('prompt is required')
      const defaults = effectiveDefaults(settings, await projectConfig($))
      const model = resolveModel(textArg(args.model) ?? defaults.model)
      const { sandbox, approvals } = permissionsFor({ sandbox: textArg(args.sandbox), approvals: textArg(args.approvals) }, defaults)
      const agent = await spawnAgent($, {
        prompt,
        model,
        effort: textArg(args.effort) ?? defaults.effort,
        sandbox,
        approvals,
        name: uniqueName(await read($, agentsAtom), textArg(args.name) ?? aliasOf(model)),
        cwd: textArg(args.cwd) ?? (await $.session.cwd()),
      })
      await rememberCall($, String(args.tool_use_id), agent.id)
      void $.ui.open({ id: PANE, title: 'Codex agents' })
      return spawnedText(agent)
    }
    case 'codex_send': {
      const message = textArg(args.message)
      if (!message) throw new CodexError('message is required')
      const outcome = await sendMessage($, await agentFor($, e), message)
      await rememberCall($, String(args.tool_use_id), outcome.agent.id)
      return outcome.kind === 'steered'
        ? `Steered into ${outcome.agent.name}'s running turn. You will be notified when it finishes.`
        : `Started a new turn for ${outcome.agent.name} (sandbox ${outcome.agent.sandbox}, approvals ${outcome.agent.approvals}). You will be notified when it finishes.`
    }
    case 'codex_stop':
      return stopAgent($, await agentFor($, e))
    case 'codex_list': {
      const agents = sorted(await read($, agentsAtom))
      if (agents.length === 0) return 'No Codex agents yet. codex_spawn starts one.'
      const now = await $.clock.now()
      return agents.map(agent => describeAgent(agent, now)).join('\n')
    }
    case 'codex_result':
      return resultText(await agentFor($, e), args.full === true, await $.clock.now())
    case 'codex_wait': {
      const agent = await agentFor($, e)
      const seconds = Math.min(3600, Math.max(1, Number(args.timeoutSec ?? 600)))
      const outcome = await waitForAgent($, agent, seconds * 1000)
      const fresh = findIn(await read($, agentsAtom), agent.id) ?? agent
      const now = await $.clock.now()
      if (outcome === 'timeout') return `Still running after ${seconds}s.\n${describeAgent(fresh, now)}`
      return resultText(fresh, false, now)
    }
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    codexPath: String(options.codexPath),
    nodePath: String(options.nodePath),
    defaultModel: String(options.defaultModel),
    defaultEffort: String(options.defaultEffort),
    defaultSandbox: String(options.defaultSandbox) as CodexSandbox,
    defaultApprovals: String(options.defaultApprovals) as CodexApprovals,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let project: Partial<Defaults> = {}
    try {
      project = await projectConfig($)
    } catch (error) {
      $.ui.log(`codex: ${String(error instanceof Error ? error.message : error)}`)
    }
    for (const tool of toolSpecs(effectiveDefaults(settings, project))) await $.tool.register(tool)
    await $.command.register(COMMAND)
    await loadFromStore($)
    await startBridge($, settings)
    if (Object.keys(await read($, agentsAtom)).length > 0) void $.ui.open({ id: PANE, title: 'Codex agents' })
    return started
  })

  on('turn.start', async ($, e, next) => {
    ledger.reset()
    pendingAppends = []
    await update($, mainBusyAtom, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await update($, mainBusyAtom, () => false)
      await flushWakes($)
    }
    return done
  })

  // A main-loop model request is starting: every wake notice stored so far is in it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) ledger.step()
    return yield* next(e)
  })

  // ---------------------------------------------------------- tools

  // One hook for all six tools: a matcher over a union of names does not type-check.
  const toolPattern = new RegExp(`^${PREFIX}(${TOOL_NAMES.join('|')})$`)
  const toolName = (tool: string) => tool.slice(PREFIX.length) as ToolName
  on('tool.call', { tool: toolPattern }, async ($, e) => {
    try {
      return { result: await runTool($, toolName(e.tool), e, settings) }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }).catch(($, e) => ({ deny: `codex: ${toolName(e.tool)} did not finish (its hook failed or ran out of time)` }))

  // List the tools up front rather than behind ToolSearch.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    return e.tool.startsWith(PREFIX) ? { ...described, isDeferred: false } : described
  })

  // ---------------------------------------------------------- command

  on('command.run', { command: 'codex' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'stop') {
      const agent = findIn(await read($, agentsAtom), rest.join(' '))
      if (!agent) return { text: `No Codex agent "${rest.join(' ')}".` }
      return { text: await stopAgent($, agent) }
    }
    if (verb === 'models') {
      const found = await listModels($)
      const lines = [...found.entries()].map(([id, efforts]) => `${id}: ${efforts.join(', ')}`)
      const defaults = effectiveDefaults(settings, await projectConfig($))
      return {
        text: `${lines.join('\n')}\nDefaults: ${defaults.model}, effort ${defaults.effort}, sandbox ${defaults.sandbox}, approvals ${defaults.approvals}.`,
      }
    }
    if (verb === 'rules') return { text: await rulesCommand($, rest) }
    await $.ui.open({ id: PANE, title: 'Codex agents' })
    const now = await $.clock.now()
    const agents = sorted(await read($, agentsAtom))
    return { text: agents.length ? agents.map(agent => describeAgent(agent, now)).join('\n') : 'No Codex agents yet.' }
  })

  // ---------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const agents = sorted(await read($, agentsAtom))
    const selected = await read($, selectedAtom)
    const showResult = await read($, showResultAtom)
    const approvals = await read($, approvalsAtom)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns - 2)
    if (agents.length === 0) return <Text dimColor>No Codex agents yet. The model starts them with codex_spawn.</Text>
    const current = agents.find(agent => agent.id === selected) ?? agents[0]
    return (
      <Box flexDirection="column">
        {approvals.map(approval => (
          <Text color="permission" wrap="truncate-end">
            ? {approval.summary}
          </Text>
        ))}
        {agents.map(agent => (
          <Box key={`row-${agent.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={statusColor(agent)}>{statusDot(agent)}</Text>
              <Button
                key={`pick-${agent.id}`}
                plain
                label={agent.name}
                onPress={() => update($, selectedAtom, () => agent.id)}
              />
              <Text color="suggestion">
                {agent.model}/{agent.effort}
              </Text>
              <Text dimColor>
                {agent.status} {timeOf(agent, now)} {formatTokens(agent.tokens)}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {clip(firstLine(agent.status === 'running' ? agent.activity : agent.lastMessage || agent.activity), width)}
            </Text>
          </Box>
        ))}
        {current && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              {current.name} ({current.id}) {current.sandbox}, approvals {current.approvals}
            </Text>
            <Box flexDirection="row" gap={1}>
              {current.status === 'running' && <Button key="stop" label="Stop" onPress={() => stopAgent($, current)} />}
              <Button
                key="result"
                label={showResult ? 'Hide result' : 'Result'}
                onPress={() => update($, showResultAtom, value => !value)}
              />
            </Box>
            {current.error && <Text color="error">{current.error}</Text>}
            {showResult && (
              <Box flexDirection="column">
                {current.digest.slice(-12).map(line => (
                  <Text dimColor wrap="truncate-end">
                    {line}
                  </Text>
                ))}
                <Text>{current.lastMessage || 'No final message yet.'}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })

  // codex_spawn / codex_send rows drawn like native Agent rows: a description and a live status line.
  for (const tool of ['codex_spawn', 'codex_send']) {
    on('ui.render', { component: 'ToolUse', props: { tool: `${PREFIX}${tool}` } }, async ($, e, next) => {
      const agentId = (await read($, callsAtom))[e.props.tool_use_id]
      const agent = agentId ? (await read($, agentsAtom))[agentId] : undefined
      if (!agent || e.props.isErrored) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const input = (e.props.input ?? {}) as Record<string, unknown>
      const said = String(input.prompt ?? input.message ?? '')
      const now = await $.clock.now()
      const line = isLive(agent)
        ? `${agent.activity} (${timeOf(agent, now)}, ${formatTokens(agent.tokens)})`
        : `${agent.lastTurnStatus ?? agent.status} in ${timeOf(agent, now)}, ${formatTokens(agent.tokens)}`
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{tool === 'codex_spawn' ? 'Codex' : 'Codex message'}</Text>
            <Text>
              ({agent.name} {agent.model}/{agent.effort})
            </Text>
            <Text dimColor wrap="truncate-end">
              {clip(firstLine(said), 80)}
            </Text>
          </Box>
          <Text color={statusColor(agent)} wrap="truncate-end">
            {'  '}L {clip(firstLine(line), 140)}
          </Text>
        </Box>
      )
    })
  }

  // The wake row: one compact line, like a native task notification (ctrl+o shows it whole).
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, async ($, e, next) => {
    const origin = e.props.origin
    if (e.props.isExpanded || origin.kind !== 'plugin' || origin.name !== 'codex') return next(e)
    const match = WAKE_PATTERN.exec(e.props.text)
    if (!match) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor>
        Codex agent {match[1]} ({match[2]}) finished: {match[3]}
      </Text>
    )
  })
}
