import type { On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { agentDescription, agentSpecs, aliasOf, approvalAnswer, approvalOptions, bridgeTarget, codexVersionError, configDirs, describeAgent, effectiveDefaults, effortFor, listText, MIN_CODEX_VERSION, modelEffortError, modelFor, nodeOptionPreloads, parseHeader, permissionsFor, resultText, shortCommand, TOOL_SPECS, UPDATE_HINT, withoutPreloads, wrapperAnswer } from '../hooks/model'
import type { CodexAgent } from '../types'

// A fake bridge: the relay's stdout is a queue the test pushes NDJSON into,
// and its HTTP endpoints are answered by an `http.fetch` hook. Beneath the
// plugin, the test stands for the engine: the Agent tool's spawn, the agent
// list, SendMessage's delivery and a Claude model's turn.step.

type Rpc = { method: string; params: Record<string, unknown> }

type Fake = {
  argv: readonly string[]
  /** The environment each bridge spawn set over the host's, in order. */
  spawnEnvs: (Record<string, string> | undefined)[]
  /** What the relay writes: stdout text, or a stderr piece. */
  queue: (string | { stderr: string })[]
  closed: boolean
  /** How the relay ends once closed. */
  exitCode: number
  /** The host's environment, as $.env.get reads it. */
  env: Record<string, string>
  wake: () => void
  rpcs: Rpc[]
  /** Methods whose next call the fake app-server answers with this error. */
  rpcErrors: Record<string, string | { message: string; code: number; data?: unknown }>
  loaded: Set<string>
  active: Record<string, string>
  operations: Map<string, Record<string, unknown>>
  acknowledged: Set<string>
  rpcHook?: (rpc: Rpc) => void
  registryError?: string
  registryWriteError?: string
  writerStatus?: string
  interruptAnswer?: Record<string, unknown>
  deliveryRefusal?: string
  deliveryHook?: () => Promise<void>
  storeDelayMs?: number
  stopRefusal?: string
  spawnRefusal?: string
  stopError?: boolean
  stopCalls?: number
  ackError?: string
  submitError?: string
  operationRefusal?: string
  sessionDelayMs?: number
  /** Simulated short polls before the retained response is delivered. */
  pendingPolls: Record<string, number>
  operationPolls: number
  loseSubmit: string | null
  replies: Record<string, unknown>[]
  waits: Record<string, unknown>[]
  /** What the engine's spawn received, and the agentIds it hands out in turn. */
  spawned: Record<string, unknown>[]
  agentIds: string[]
  /** What the engine's agent list answers. */
  agentList: { id: string; type: string; name?: string }[]
  /** SendMessage deliveries that reached the engine beneath the plugin. */
  delivered: { to: string; text: string }[]
  /** What the engine's session.messages answers per agent. */
  messages: Record<string, SessionMessage[]>
  /** Model requests that reached a Claude model beneath the plugin. */
  modelSteps: number
  asked: string[]
  /** The option labels each dialog offered. */
  askedOptions: string[][]
  /** Files the fake fs holds, by absolute path. */
  files: Record<string, string>
  /** What the AskUserQuestion dialog answers; null dismisses it. */
  askAnswer: string | null
  waitAnswer: Record<string, unknown>
  /** Answers for the next /wait polls, before waitAnswer. */
  waitQueue: Record<string, unknown>[]
  /** Fails every /wait with this message. */
  waitError: string | null
  waitHook?: (body: Record<string, unknown>) => Promise<void>
  turnCount: number
  registeredAgents: Record<string, unknown>[]
  store: Record<string, unknown>
  disk: Record<string, CodexAgent>
  /** Where each bridge fetch went: `<socketPath> <url>`. */
  targets: string[]
  /** Transcript lines and toasts the person saw. */
  shown: string[]
  /** What model/list answers: [id, efforts], in any order. */
  models: [string, string[]][]
  clock: MockClock
}

/** The engine resolves a path on the host's root: on Windows '/work/x' arrives as 'C:\work\x'. */
const posixPath = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function fakeBridge(on: On, stored: Record<string, unknown> = {}, files: Record<string, string> = {}, disk: Record<string, CodexAgent> = {}, now = 1_000_000): Fake {
  const fake: Fake = {
    argv: [],
    spawnEnvs: [],
    queue: [],
    closed: false,
    exitCode: 0,
    env: {},
    wake: () => undefined,
    rpcs: [],
    rpcErrors: {},
    loaded: new Set(),
    active: {},
    operations: new Map(),
    acknowledged: new Set(),
    pendingPolls: {},
    operationPolls: 0,
    loseSubmit: null,
    replies: [],
    waits: [],
    spawned: [],
    agentIds: ['a1', 'a2', 'a3'],
    agentList: [],
    delivered: [],
    messages: {},
    modelSteps: 0,
    asked: [],
    askedOptions: [],
    files: { ...files },
    askAnswer: 'Allow once',
    waitAnswer: { status: 'timeout' },
    turnCount: 0,
    waitQueue: [],
    waitError: null,
    registeredAgents: [],
    store: { ...stored },
    disk: JSON.parse(JSON.stringify(disk)),
    targets: [],
    shown: [],
    models: [
      ['gpt-6-luna', EFFORTS],
      ['gpt-6.1-sol', [...EFFORTS, 'ultra']],
    ],
    clock: mock.clock(on, { now }),
  }
  // The engine beneath the plugin.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codex__${e.name}` } }))
  on('agent.register', (_$, e) => {
    fake.registeredAgents.push(JSON.parse(JSON.stringify(e)))
    return { value: { agent: `codex:${e.name}` } }
  })
  on('agent.spawn', (_$, e) => {
    if (fake.spawnRefusal) return { deny: fake.spawnRefusal }
    fake.spawned.push(JSON.parse(JSON.stringify(e)))
    const agentId = (typeof e.resume === 'object' ? e.resume.agentId : e.resume) ?? fake.agentIds.shift() as string
    fake.agentList.push({ id: agentId, type: e.subagentType, ...(e.name ? { name: e.name } : {}) })
    return { model: 'claude-haiku-4-5', agentId }
  })
  on('agent.list', () => ({
    value: fake.agentList.map(agent => ({ ...agent, description: '', status: 'running' as const })),
  }))
  on('session.messages', (_$, e) => ({ value: fake.messages[(e as { agentId?: string }).agentId ?? ''] ?? [] }))
  on('tool.check', () => ({ decision: 'ask' as const, reason: 'beneath' }))
  on('session.send', async ($, e) => {
    if (fake.deliveryRefusal) return { isDelivered: false as const, reason: fake.deliveryRefusal }
    await fake.deliveryHook?.()
    fake.delivered.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  on('turn.step', async function* (_$, e) {
    fake.modelSteps += 1
    yield { kind: 'text' as const, index: 0, text: 'from Claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('session.id', () => fake.sessionDelayMs ? new Promise<{ value: string }>(resolve => setTimeout(() => resolve({ value: 'session-1' }), fake.sessionDelayMs)) : ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work' }))
  on('fs.exists', (_$, e) => ({ value: posixPath(e.path) in fake.files }))
  on('fs.read', (_$, e) => (posixPath(e.path) in fake.files ? { value: fake.files[posixPath(e.path)] as string } : { deny: `no file ${e.path}` }))
  on('ui.log', (_$, e) => {
    if (e.to === 'transcript') fake.shown.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    fake.shown.push(`toast: ${e.text}`)
    return { value: undefined }
  })

  // The store, answered here so the test can read what the plugin mirrors into it.
  on('store.get', (_$, e) => ({ value: fake.store[e.key] }))
  on('store.set', async (_$, e) => {
    if (fake.storeDelayMs) await new Promise(resolve => setTimeout(resolve, fake.storeDelayMs))
    fake.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })

  on('env.get', (_$, e) => ({ value: fake.env[e.name] }))
  on('process.spawn', async function* (_$, e) {
    fake.argv = e.argv
    fake.spawnEnvs.push(e.env ? { ...e.env } : undefined)
    for (;;) {
      const text = fake.queue.shift()
      if (typeof text === 'object') {
        yield { stream: 'stderr' as const, text: text.stderr }
        continue
      }
      if (text !== undefined) {
        yield { stream: 'stdout' as const, text }
        continue
      }
      if (fake.closed) return { value: { code: fake.exitCode, signal: null } }
      await new Promise<void>(resolve => (fake.wake = resolve))
    }
  })

  const answer = (rpc: Rpc): unknown => {
    switch (rpc.method) {
      case 'model/list':
        return {
          data: fake.models.map(([id, efforts]) => ({ id, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })),
          nextCursor: null,
        }
      case 'thread/start': {
        const id = `th-${fake.rpcs.filter(one => one.method === 'thread/start').length}`
        fake.loaded.add(id)
        return { thread: { id }, model: rpc.params.model }
      }
      case 'thread/resume':
        fake.loaded.add(String(rpc.params.threadId))
        return {}
      case 'turn/start':
        fake.turnCount += 1
        fake.active[String(rpc.params.threadId)] = `turn-${fake.turnCount}`
        return { turn: { id: `turn-${fake.turnCount}` } }
      default:
        return {}
    }
  }

  on('http.fetch', async (_$, e) => {
    fake.targets.push(`${e.init?.socketPath ?? ''} ${e.url}`)
    // A Windows bridge's paths sit under its secret (see the Windows test).
    const path = new URL(e.url).pathname.replace(/^\/s3cret(?=\/)/, '')
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    let reply: unknown = { ok: true }
    if (path === '/registry/read') {
      if (fake.registryError) return { deny: fake.registryError }
      const ids = (body.ids ?? []) as string[]
      reply = { agents: Object.fromEntries(Object.values(fake.disk).filter(agent => agent.sessionId === body.sessionId || ids.includes(agent.id) || agent.id === body.ref || agent.name === body.ref).map(agent => [agent.id, agent])) }
    }
    if (path === '/registry/write') {
      if (fake.registryWriteError) return { deny: fake.registryWriteError }
      const agent = body.agent as CodexAgent
      if (!fake.disk[agent.id] || fake.disk[agent.id]!.updatedAt <= agent.updatedAt) fake.disk[agent.id] = JSON.parse(JSON.stringify(agent))
    }
    if (path === '/writer-status') reply = { status: fake.writerStatus ?? 'unknown' }
    if (path === '/interrupt') {
      fake.rpcs.push({ method: 'turn/interrupt', params: { threadId: body.threadId, turnId: body.turnId ?? fake.active[String(body.threadId)] } })
      reply = fake.interruptAnswer ?? { status: 'stillRunning' }
    }
    if (path === '/thread-state') {
      const pending = [...fake.operations.entries()].find(([id, op]) => !fake.acknowledged.has(id) && op.method === 'turn/start' && (op.params as Rpc['params'])?.threadId === body.threadId)
      reply = { status: fake.loaded.has(String(body.threadId)) ? 'loaded' : 'unsubscribed', activeTurnId: fake.active[String(body.threadId)] ?? null,
        ...(pending ? { pendingOperationId: pending[0] } : {}) }
    }
    if (path === '/operation/ack') {
      if (fake.ackError) return { deny: fake.ackError }
      fake.acknowledged.add(String(body.id))
    }
    if (path === '/release') {
      const id = String(body.threadId)
      if (!fake.active[id] && fake.loaded.has(id)) {
        fake.rpcs.push({ method: 'thread/unsubscribe', params: { threadId: id } })
        fake.loaded.delete(id)
      }
      reply = { status: fake.loaded.has(id) ? 'loaded' : 'unsubscribed' }
    }
    if (path === '/operation') {
      if (fake.operationRefusal && ['turn/start', 'turn/steer'].includes(String(body.method))) {
        reply = { error: { code: -32602, message: fake.operationRefusal } }
        return { value: { status: 400, ok: false, headers: {}, text: JSON.stringify(reply) } }
      }
      const id = String(body.id)
      if (fake.operations.has(id)) reply = fake.operations.get(id)
      else {
      const rpc = { method: String(body.method), params: (body.params ?? {}) as Record<string, unknown> }
      fake.rpcs.push(rpc)
      const error = fake.rpcErrors[rpc.method]
      if (error !== undefined) {
        delete fake.rpcErrors[rpc.method]
        reply = { operationId: id, status: 'completed', error: typeof error === 'string' ? { message: error } : error }
      } else reply = { operationId: id, status: 'completed', result: answer(rpc) }
      fake.rpcHook?.(rpc)
      fake.operations.set(id, { ...(reply as Record<string, unknown>), method: rpc.method, params: rpc.params, resumeParams: body.resumeParams })
      if (fake.submitError && ['turn/start', 'turn/steer'].includes(rpc.method)) return { deny: fake.submitError }
      if (fake.pendingPolls[rpc.method]) reply = { operationId: id, status: 'pending' }
      if (fake.loseSubmit === rpc.method) {
        fake.loseSubmit = null
        return { deny: 'no complete answer within 30000ms' }
      }
      }
    }
    if (path === '/operation/poll') {
      fake.operationPolls += 1
      const op = fake.operations.get(String(body.id))!
      const method = String(op.method)
      if ((fake.pendingPolls[method] ?? 0) > 0) {
        fake.pendingPolls[method]! -= 1
        reply = { operationId: body.id, status: 'pending' }
      } else reply = op
    }
    if (path === '/reply') fake.replies.push(body)
    if (path === '/wait') {
      fake.waits.push(body)
      await fake.waitHook?.(body)
      if (fake.waitError !== null) reply = { error: { message: fake.waitError } }
      else {
        reply = fake.waitQueue.shift() ?? fake.waitAnswer
        const turn = (reply as { turn?: { id: string } }).turn
        if (turn && fake.active[String(body.threadId)] === turn.id) delete fake.active[String(body.threadId)]
      }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })

  // Claude Code 2.1.304's TaskStop outputSchema: all three strings required,
  // command optional. A string mock concealed the live output-shape bug.
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    fake.stopCalls = (fake.stopCalls ?? 0) + 1
    if (fake.stopRefusal) return { deny: fake.stopRefusal }
    return { result: { message: 'wrapper stopped', task_id: e.task_id ?? e.shell_id, task_type: 'local_agent', command: 'fixture task' }, ...(fake.stopError ? { isError: true } : {}) }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = String((e as unknown as { questions: { question: string }[] }).questions[0]?.question)
    fake.asked.push(question)
    const options = (e as unknown as { questions: { options: { label: string }[] }[] }).questions[0]?.options ?? []
    fake.askedOptions.push(options.map(option => option.label))
    if (fake.askAnswer === null) return { deny: 'dismissed' }
    return { result: { questions: (e as unknown as { questions: never[] }).questions, answers: { [question]: fake.askAnswer } } }
  })

  return fake
}

const push = (fake: Fake, event: unknown) => {
  const note = event as { method?: string; params?: { threadId: string; turn?: { id: string } } }
  if (note.method === 'turn/completed' && fake.active[note.params!.threadId] === note.params?.turn?.id) delete fake.active[note.params!.threadId]
  fake.queue.push(`${JSON.stringify(event)}\n`)
  fake.wake()
}

const note = (method: string, params: Record<string, unknown>) => ({ type: 'notification', method, params })

const done = (fake: Fake) => {
  fake.closed = true
  fake.wake()
}

/** Polls `check`, letting the event loop settle between polls. */
async function until(fake: Fake, check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return
    await fake.clock.settle()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const agentsOf = async (fake: Fake) => (fake.store.agents ?? {}) as Record<string, Record<string, unknown>>

async function start($: Engine, fake: Fake, ready: Record<string, unknown> = {}) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // Split across pieces: the plugin must buffer until the newline.
  const line = JSON.stringify({ type: 'ready', socket: '/tmp/cxb-test/s', reattached: false, active: {}, ...ready })
  fake.queue.push(line.slice(0, 10), `${line.slice(10)}\n`)
  fake.wake()
}

/** What the Agent tool hands `agent.spawn` for a call. */
const spawnInput = (prompt: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: 'toolu_test',
  prompt,
  description: 'Sleep a while',
  subagentType: 'codex:luna',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...extra,
})

/** SendMessage from the main loop's model. */
const send = ($: Engine, to: string, text: string) => $.session.send({ to, text, origin: { kind: 'model' } })

/** The Agent tool starting a codex:luna agent, as the engine raises it. */
async function spawn($: Engine, fake: Fake, prompt = 'sleep 20', extra: Record<string, unknown> = {}) {
  const spawned = await $.agent.spawn(spawnInput(prompt, extra))
  expect(spawned.deny).toBeUndefined()
  return (await agentsOf(fake))[spawned.agentId as string] as Record<string, unknown>
}

/** One model request of a loop: the chunks it yielded and its result. */
async function step($: Engine, agentId: string, index = 0): Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult }> {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-haiku-4-5', messageCount: 1, agentId })
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}

const awaitCall = ($: Engine, agentId: string) => $.tool.call({ tool: 'mcp__codex__codex_await', agentId } as never)

/** The JSON arguments a tool step streamed. */
const inputOf = (chunks: TurnStepChunk[]) =>
  JSON.parse(chunks.filter(chunk => chunk.kind === 'input').map(chunk => (chunk as { json: string }).json).join('')) as Record<string, unknown>

/** Drive bounded retry sleeps without replacing the real engine's hook budget. */
async function withRetryClock<T>(fake: Fake, work: () => Promise<T>): Promise<T> {
  let settled = false
  const result = work().finally(() => { settled = true })
  for (let i = 0; i < 20 && !settled; i += 1) await fake.clock.advance(1000)
  expect(settled).toBe(true)
  return result
}

/** The report a wrapper's final step hands back. */
async function finalOf($: Engine, agentId: string, index = 0): Promise<unknown> {
  let { chunks } = await step($, agentId, index)
  // Replay queued native text/tools before the final handback.
  for (let n = 0; n < 20 && (chunks[0] as { name?: string })?.name !== 'SubagentHandback'; n += 1) {
    for (const chunk of chunks) if (chunk.kind === 'tool' && chunk.name === 'Bash') {
      const input = JSON.parse(chunks.filter(c => c.kind === 'input' && c.index === chunk.index).map(c => (c as { json: string }).json).join(''))
      await $.tool.call({ tool: 'Bash', tool_use_id: chunk.id, agentId, ...input } as never)
    }
    chunks = (await step($, agentId, ++index)).chunks
  }
  expect(chunks[0]).toMatchObject({ kind: 'tool', name: 'SubagentHandback' })
  return inputOf(chunks).message
}

const completed = (id: string, text: string) => ({ status: 'completed', turn: { id, status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] } })

const CODEX_DEFAULT = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
const NODE_DEFAULT = '/opt/homebrew/bin/node'

test('configured binaries missing from disk fall back to node and codex on PATH', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(fake.argv[0]).toBe('node')
  expect(fake.argv[2]).toBe('codex')
  done(fake)
})

test('registers one native agent type per model alias, run on haiku with codex_await and SendMessage', async ($, on) => {
  const fake = fakeBridge(on, {}, { '/work/.claude/codex.json': JSON.stringify({ effort: 'medium' }) })
  await start($, fake)
  expect(fake.registeredAgents.map(spec => spec.name)).toEqual(['luna', 'sol', 'astra', 'terra'])
  for (const spec of fake.registeredAgents) {
    expect(spec).toMatchObject({ tools: ['mcp__codex__codex_await', 'SendMessage', 'SubagentHandback'], model: 'haiku', background: true, omitClaudeMd: true })
  }
  const luna = String(fake.registeredAgents[0]?.description)
  expect(luna).toContain('the newest Luna model, effort medium.')
  expect(luna).toContain('effort: low|medium|high|xhigh|max"')
  expect(String(fake.registeredAgents[1]?.description)).toContain('|ultra')
  done(fake)
})

test('a codex:* spawn starts the Codex turn with the exact prompt, keyed by the agentId', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, { [CODEX_DEFAULT]: '', [NODE_DEFAULT]: '' })
  await start($, fake)
  expect(fake.argv[0]).toBe(NODE_DEFAULT)
  expect(fake.argv[1]).toMatch(/bin\/bridge\.mjs$/)
  expect(fake.argv[2]).toBe(CODEX_DEFAULT)

  const prompt = 'Write unit tests for calc.js\n\n  keep the indentation\n'
  const agent = await spawn($, fake, prompt, { description: 'Write calc tests' })
  expect(fake.spawned[0]).toMatchObject({ subagentType: 'codex:luna', prompt, background: true })
  expect(agent).toMatchObject({ id: 'a1', name: 'Write calc tests', description: 'Write calc tests', model: 'gpt-6-luna', effort: 'max', status: 'running', currentTurnId: 'turn-1', cwd: '/work/app' })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['model/list', 'thread/start', 'thread/name/set', 'turn/start'])
  expect(fake.rpcs[1]?.params).toMatchObject({ model: 'gpt-6-luna', cwd: '/work/app', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', ephemeral: false })
  // The job can message the session: bin/codex-msg as an MCP server, named with the bridge's socket and the job's key.
  const msgKey = String(agent.msgKey)
  expect(msgKey).toMatch(/^[0-9a-f]{32}$/)
  const started = fake.rpcs[1]?.params as { config: { mcp_servers: Record<string, { command: string; args: string[] }> }; developerInstructions: string }
  expect(started.config.mcp_servers.claude_session?.command).toBe(NODE_DEFAULT)
  expect(started.config.mcp_servers.claude_session?.args).toEqual([expect.stringMatching(/\/bin\/codex-msg$/), '/tmp/cxb-test/s', msgKey])
  expect(started.developerInstructions).toContain('call the message_claude tool of the claude_session MCP server')
  expect(fake.rpcs[2]?.params).toEqual({ threadId: 'th-1', name: 'Write calc tests' })
  expect(fake.rpcs[3]?.params).toMatchObject({ threadId: 'th-1', effort: 'max', input: [{ type: 'text', text: prompt, text_elements: [] }] })
  expect([...fake.operations.values()].find(op => op.method === 'turn/start')?.resumeParams).toMatchObject({ threadId: 'th-1', model: 'gpt-6-luna' })

  // The cwd the Agent call set wins, and a second luna gets its own name.
  await spawn($, fake, 'x', { cwd: '/elsewhere' })
  expect((await agentsOf(fake)).a2).toMatchObject({ name: 'Sleep a while', cwd: '/elsewhere' })
  // The same description again: a numbered name.
  await spawn($, fake, 'z')
  expect((await agentsOf(fake)).a3?.name).toBe('Sleep a while (2)')

  push(fake, note('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } }))
  push(fake, note('item/started', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: "/bin/zsh -lc 'sleep 20'" } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.activity === '$ sleep 20', 'activity')
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: "/bin/zsh -lc 'sleep 20'", exitCode: 0, status: 'completed' } }))
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'DONE', phase: 'final_answer' } }))
  push(fake, note('thread/tokenUsage/updated', { threadId: 'th-1', tokenUsage: { total: { totalTokens: 1234 } } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.tokens === 1234, 'tokens')
  expect((await agentsOf(fake)).a1?.digest).toEqual(['$ sleep 20 -> exit 0', 'answer: DONE'])
  done(fake)
})

test('header lines set effort, sandbox and approvals and are stripped; a bad one refuses the spawn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'effort: low\nSandbox: read-only\napprovals: ask\n\nDo X\nthen Y')
  expect(fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/start')?.params).toMatchObject({ effort: 'low', sandboxPolicy: { type: 'readOnly' }, input: [{ text: 'Do X\nthen Y' }] })

  // yolo only when the prompt says so: no sandbox and no approvals.
  fake.rpcs = []
  await spawn($, fake, 'approvals: yolo\nx')
  expect(fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/start')?.params).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' })

  // Refused before any subagent starts.
  const before = fake.spawned.length
  for (const [prompt, reason] of [
    ['effort: ultra\nx', 'does not take effort "ultra"'],
    ['approvals: yolo\nsandbox: read-only\nx', 'contradicts'],
    ['sandbox: everything\nx', 'sandbox must be one of'],
    ['effort: low\neffort: high\nx', 'sets effort twice'],
    ['effort: low\n\n', 'prompt is empty'],
  ] as const) {
    const refused = await $.agent.spawn(spawnInput(prompt))
    expect(refused.deny).toContain(reason)
  }
  expect(fake.spawned).toHaveLength(before)

  // Any other agent type passes untouched.
  const other = await $.agent.spawn(spawnInput('effort: low\nhi', { subagentType: 'general-purpose' }))
  expect(other.agentId).toBeDefined()
  expect(fake.spawned.at(-1)).toMatchObject({ subagentType: 'general-purpose', prompt: 'effort: low\nhi' })
  done(fake)
})

test('parseHeader reads only the leading key lines and keeps the rest as given', () => {
  expect(parseHeader('plain\neffort: low')).toEqual({ body: 'plain\neffort: low' })
  expect(parseHeader('  effort:  HIGH \n\n\n  indented body\n')).toEqual({ effort: 'high', body: '  indented body\n' })
  expect(parseHeader('approvals: never\nsandbox: workspace-write\nbody')).toEqual({ approvals: 'never', sandbox: 'workspace-write', body: 'body' })
  expect(() => parseHeader('sandbox: a\nsandbox: b\nx')).toThrow('twice')
})

test('the wrapper loop: codex_await while Codex runs, then the Codex final message verbatim, with no Claude model', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)

  const first = await step($, 'a1')
  expect(first.chunks.map(chunk => chunk.kind)).toEqual(['tool', 'input', 'stop'])
  expect(first.chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect(first.result).toMatchObject({ toolUses: [{ name: 'mcp__codex__codex_await', input: {} }], stopReason: 'tool_use' })

  const final = 'Line one\n\n  exact *markdown*, kept as is\n'
  fake.waitQueue = [{ status: 'timeout' }, { status: 'timeout' }, completed('turn-1', final)]
  const awaited = await awaitCall($, 'a1')
  expect(awaited.result).toBe(final)
  // Three slices, then the read of any message sent as the turn ended.
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([2_000, 2_000, 2_000, 1])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', lastMessage: final })

  // The report goes back through SubagentHandback, verbatim.
  const last = await step($, 'a1', 1)
  expect(last.chunks[0]).toMatchObject({ kind: 'tool', name: 'SubagentHandback' })
  expect(inputOf(last.chunks)).toEqual({ message: final })
  expect(last.result).toMatchObject({ toolUses: [{ name: 'SubagentHandback', input: { message: final } }], stopReason: 'tool_use' })
  // Where the engine offers no SubagentHandback, the failed call is followed by the final text.
  fake.messages.a1 = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: 'SubagentHandback', input: {}, isError: true }] }]
  const plain = await step($, 'a1', 2)
  expect(plain.chunks.filter(chunk => chunk.kind === 'text').map(chunk => (chunk as { text: string }).text).join('')).toBe(final)
  expect(plain.result).toMatchObject({ answer: final, toolUses: [], stopReason: 'end_turn' })
  expect(fake.modelSteps).toBe(0)

  // Another subagent's requests go to its model.
  fake.agentList.push({ id: 'other', type: 'general-purpose' })
  const foreign = await step($, 'other')
  expect(foreign.result.answer).toBe('from Claude')
  expect(fake.modelSteps).toBe(1)
  done(fake)
})

test('bridge loss keeps the wrapper awaiting with bounded retries; a rejected start ends it', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitError = 'ECONNRESET'
  const response = await withRetryClock(fake, () => awaitCall($, 'a1'))
  expect(String(response.result)).toContain('Codex is still running')
  expect(fake.waits).toHaveLength(4)
  expect((await step($, 'a1')).chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-1' })
  fake.waitError = null
  fake.waitQueue = [completed('turn-1', 'reconnected final')]
  await awaitCall($, 'a1')
  expect(await finalOf($, 'a1', 1)).toBe('reconnected final')
  expect(fake.modelSteps).toBe(0)

  // A turn that did not start: the wrapper still runs, and ends with why.
  fake.waitError = null
  fake.rpcErrors['turn/start'] = 'thread busy'
  await spawn($, fake, 'y')
  expect(await finalOf($, 'a2')).toBe('Codex failed: the Codex turn did not start: thread busy')

  // codex_await serves codex:* agents alone.
  expect((await $.tool.call({ tool: 'mcp__codex__codex_await' } as never)).deny).toContain('codex:* agents only')
  expect(wrapperAnswer({ status: 'interrupted', error: null } as unknown as CodexAgent)).toBe('Codex turn interrupted.')
  expect(wrapperAnswer({ status: 'idle', lastMessage: '' } as unknown as CodexAgent)).toBe('(Codex finished without a final message.)')
  done(fake)
})

test('a codex-msg message returns codex_await early and goes to main as the agent\'s own SendMessage, verbatim', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const agent = await spawn($, fake)
  const question = 'Which DB should I use?\n\n  keep *this* exactly '
  fake.waitQueue = [{ status: 'timeout' }, { status: 'message', messages: [question] }]
  expect((await awaitCall($, 'a1')).result).toBe('Codex sent a message for the main session.')
  expect(fake.waits.map(wait => wait.msgKey)).toEqual([agent.msgKey, agent.msgKey])

  const relay = await step($, 'a1', 1)
  expect(relay.chunks[0]).toMatchObject({ kind: 'tool', name: 'SendMessage' })
  const input = JSON.parse(relay.chunks.filter(chunk => chunk.kind === 'input').map(chunk => (chunk as { json: string }).json).join(''))
  expect(input).toEqual({ to: 'main', summary: 'Codex: Which DB should I use?', message: question })
  expect(relay.result).toMatchObject({ toolUses: [{ name: 'SendMessage', input }], stopReason: 'tool_use' })
  // The plugin allows its own relay call once (auto mode has no classifier verdict for a step no model made); nothing else.
  const relayId = (relay.chunks[0] as { id: string }).id
  const check = (tool_use_id: string) => $.tool.check({ tool: 'SendMessage', input, tool_use_id, agentId: 'a1' } as never)
  expect(await check(relayId)).toMatchObject({ decision: 'allow' })
  expect(await check(relayId)).toMatchObject({ decision: 'ask' })
  expect(await check('toolu_other')).toMatchObject({ decision: 'ask' })
  expect((await agentsOf(fake)).a1?.outbox).toEqual([])
  expect((await agentsOf(fake)).a1?.digest).toEqual(['message to Claude: Which DB should I use?'])

  // Back to waiting; a message sent just before the turn ended goes out ahead of the result.
  expect((await step($, 'a1', 2)).result.toolUses[0]?.name).toBe('mcp__codex__codex_await')
  fake.waitQueue = [completed('turn-1', 'RESULT'), { status: 'message', messages: ['late note'] }]
  expect((await awaitCall($, 'a1')).result).toBe('RESULT')
  expect(fake.waits.at(-1)).toMatchObject({ threadId: 'th-1', msgKey: agent.msgKey, timeoutMs: 1 })
  const late = await step($, 'a1', 3)
  expect(JSON.parse((late.chunks.find(chunk => chunk.kind === 'input') as { json: string }).json).message).toBe('late note')
  expect(await finalOf($, 'a1', 4)).toBe('RESULT')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('a reply to a Codex question reaches the running Codex turn as a steer', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [{ status: 'message', messages: ['What is the secret word?'] }]
  await awaitCall($, 'a1')
  await step($, 'a1', 1)
  expect(await send($, 'a1', 'The secret word is MANGO.')).toEqual({ isDelivered: true })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer').map(rpc => rpc.params)).toEqual([
    { threadId: 'th-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'The secret word is MANGO.', text_elements: [] }] },
  ])
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  done(fake)
})


test('SendMessage steers a running Codex turn and starts a new one once it ended, then delivers', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'task', { name: 'helper' })

  expect(await send($, 'a1', 'also say BANANA')).toEqual({ isDelivered: true })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/steer')?.params).toMatchObject({ threadId: 'th-1', expectedTurnId: 'turn-1', input: [{ text: 'also say BANANA' }] })
  expect(fake.delivered).toEqual([{ to: 'a1', text: 'also say BANANA' }])

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')

  // By the name the Agent call gave: engine acceptance, then a new turn on the same thread.
  await send($, 'helper', 'next task')
  const starts = fake.rpcs.filter(rpc => rpc.method === 'turn/start')
  expect(starts).toHaveLength(2)
  expect(starts[1]?.params).toMatchObject({ threadId: 'th-1', input: [{ text: 'next task' }], sandboxPolicy: { type: 'workspaceWrite' } })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })
  expect((await step($, 'a1', 0)).result.stopReason).toBe('tool_use')

  // Refused when Codex refuses it; anyone else's messages pass untouched.
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle again')
  fake.rpcErrors['turn/start'] = 'no such thread'
  const refused = await send($, 'a1', 'again')
  expect(refused).toMatchObject({ isDelivered: false, reason: 'Codex did not take the message: no such thread' })
  const rpcs = fake.rpcs.length
  await send($, 'someone-else', 'hi')
  expect(fake.rpcs).toHaveLength(rpcs)
  // The engine accepts the wrapper handoff before native admission, even if
  // Codex subsequently refuses the input. No extra native turn was started.
  expect(fake.delivered.map(one => one.to)).toEqual(['a1', 'helper', 'a1', 'someone-else'])
  done(fake)
})

const releases = (fake: Fake) => fake.rpcs.filter(rpc => rpc.method === 'thread/unsubscribe').map(rpc => rpc.params)

test('an ended turn releases its thread, so Codex unloads it and stops its MCP servers; the next turn resumes it first', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const agent = await spawn($, fake)
  expect(releases(fake)).toEqual([])
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'the release')
  expect(releases(fake)).toEqual([{ threadId: 'th-1' }])

  // SendMessage after the release: the thread is resumed, codex-msg included, before the new turn.
  const before = fake.rpcs.length
  expect(await send($, 'a1', 'next task')).toEqual({ isDelivered: true })
  expect(fake.rpcs.slice(before).map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  const resumed = fake.rpcs[before]?.params as { threadId: string; config: { mcp_servers: { claude_session: { args: string[] } } } }
  expect(resumed.threadId).toBe('th-1')
  expect(resumed.config.mcp_servers.claude_session.args.slice(1)).toEqual(['/tmp/cxb-test/s', agent.msgKey])

  // That turn's end releases it again; a repeated end does not.
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  await until(fake, async () => releases(fake).length === 2, 'the second release')
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect(releases(fake)).toHaveLength(2)
  done(fake)
})

test('a late end of an earlier turn neither ends nor releases the turn started after it', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  // The wrapper learns of the end from /wait before the notification lands, and a new turn starts.
  fake.waitQueue = [completed('turn-1', 'R')]
  expect((await awaitCall($, 'a1')).result).toBe('R')
  await send($, 'a1', 'more')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })
  expect(releases(fake)).toEqual([{ threadId: 'th-1' }])

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  await until(fake, async () => releases(fake).length === 2, 'the release')
  done(fake)
})

test('two simultaneous idle messages decide inside one queue: one start then one steer', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [completed('turn-1', 'done')]
  await awaitCall($, 'a1')
  await Promise.all([send($, 'a1', 'first'), send($, 'a1', 'second')])
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(2)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer').map(rpc => rpc.params.expectedTurnId)).toEqual(['turn-2'])
  done(fake)
})

test('structured steer refusal never starts a replacement and old items never revive a settled turn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  for (const error of [
    { code: -32000, message: 'timed out', data: { outcome: 'unknown' } },
    { code: -32001, message: 'overloaded', data: { retryAfterMs: 1000 } },
    { code: -32600, message: 'invalid request' },
  ]) {
    fake.rpcErrors['turn/steer'] = error
    expect(await send($, 'a1', 'do more')).toMatchObject({ isDelivered: false })
    expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
    expect((await agentsOf(fake)).a1?.currentTurnId).toBe('turn-1')
  }
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'settled')
  push(fake, note('item/started', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'old' } }))
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect((await agentsOf(fake)).a1?.status).toBe('idle')
  done(fake)
})

test('a fabricated idle error cannot repeat a delivery; a fresh idle delivery can start', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.rpcHook = rpc => {
    if (rpc.method === 'turn/steer') delete fake.active['th-1']
  }
  fake.rpcErrors['turn/steer'] = { code: -32600, message: 'the expected turn ended', data: { kind: 'noActiveTurn' } }
  expect(await send($, 'a1', 'first')).toMatchObject({ isDelivered: false })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  fake.waitQueue = [completed('turn-1', 'authoritative completion')]
  expect(await send($, 'a1', 'next')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(2)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })
  done(fake)
})

test('late started and error events cannot revive old turns or overwrite a newer turn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [completed('turn-1', 'done')]
  await awaitCall($, 'a1')
  await send($, 'a1', 'next')
  fake.waitQueue = [completed('turn-2', 'done again')]
  await awaitCall($, 'a1')
  push(fake, note('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } }))
  push(fake, note('error', { threadId: 'th-1', turnId: 'turn-1', error: { message: 'old error' } }))
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', lastTurnId: 'turn-2', error: null })
  done(fake)
})

test('a retained start binding is adopted before a new delivery decides whether to steer', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.acknowledged.clear()
  expect(await send($, 'a1', 'more')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer')).toHaveLength(1)
  expect(fake.acknowledged.size).toBeGreaterThan(0)
  done(fake)
})

test('a terminal response received before a later start reply settles its exact turn', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [completed('turn-1', 'done')]
  await awaitCall($, 'a1')
  fake.pendingPolls['turn/start'] = 2
  fake.rpcHook = rpc => {
    if (rpc.method === 'turn/start') push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  }
  await send($, 'a1', 'next')
  await until(fake, async () => (await agentsOf(fake)).a1?.lastTurnId === 'turn-2', 'exact early completion')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', currentTurnId: null, lastTurnId: 'turn-2' })
  done(fake)
})

test('incremental events before a start reply are replayed only for its exact turn with sanitized output', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [completed('turn-1', 'done')]
  await awaitCall($, 'a1')
  const earlyText = `## Early message\n\n${'Full paragraph. '.repeat(300)}\n\n- **kept**`
  fake.pendingPolls['turn/start'] = 3
  fake.rpcHook = rpc => {
    if (rpc.method !== 'turn/start') return
    push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: 'old', type: 'agentMessage', text: 'OLD TURN HIDDEN' } }))
    push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-2', item: { id: 'command', type: 'commandExecution', command: '/bin/bash -lc \"TOKEN=fixture-secret python3 - <<EOF\nHEREDOC BODY HIDDEN\nEOF\"', exitCode: 0, durationMs: 1200, aggregatedOutput: 'RAW OUTPUT HIDDEN' } }))
    push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-2', item: { id: 'early-summary', type: 'reasoning', summary: ['Checking early work.'], content: ['RAW REASONING HIDDEN'] } }))
    push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-2', item: { id: 'early-message', type: 'agentMessage', text: earlyText } }))
    push(fake, note('turn/plan/updated', { threadId: 'th-1', turnId: 'turn-2', plan: [{ step: earlyText, status: 'inProgress' }] }))
  }
  await send($, 'a1', 'next')
  expect((await awaitCall($, 'a1')).result).toBe('')
  const replay = await step($, 'a1', 1)
  expect(replay.result.toolUses[0]).toEqual({ name: 'Bash', input: { command: '… python3 - …' } })
  expect(replay.result.answer).toContain(`Plan: 0/1 done\n\n- [ ] ${earlyText}`)
  expect(replay.chunks).toContainEqual({ kind: 'text', index: 2, text: earlyText })
  expect(replay.result.answer).toContain('Checking early work.')
  const output = JSON.stringify(replay)
  for (const hidden of ['fixture-secret', 'RAW OUTPUT HIDDEN', 'OLD TURN HIDDEN', 'HEREDOC BODY HIDDEN', 'RAW REASONING HIDDEN']) expect(output).not.toContain(hidden)
  done(fake)
})

test('cold resume polls a retained outcome without issuing a second resume', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'release')
  fake.pendingPolls['thread/resume'] = 5
  expect(await send($, 'a1', 'continue')).toMatchObject({ isDelivered: true })
  expect(fake.operationPolls).toBe(6)
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/resume')).toHaveLength(1)
  done(fake)
})

test('a lost submit response retries the same operation and binds one late start to one job', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  fake.loseSubmit = 'thread/start'
  const agent = await spawn($, fake)
  expect(agent.threadId).toBe('th-1')
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(1)
  expect(fake.spawned).toHaveLength(1)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  done(fake)
})

test('TaskStop: an aborted wrapper turn interrupts the Codex turn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/interrupt').map(rpc => rpc.params)).toEqual([{ threadId: 'th-1', turnId: 'turn-1' }])
  // The interrupted turn's end releases the thread.
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'the release')
  // A turn that ended normally, or the main loop's, interrupts nothing.
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 't-a1', agentId: 'a1', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'main', reason: 'aborted' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/interrupt')).toHaveLength(1)
  done(fake)
})

test('an approval asks the person and posts the reply; a dismissed dialog declines', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)

  push(fake, { type: 'request', id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', command: "/bin/zsh -lc 'touch /x'" } })
  await until(fake, async () => fake.replies.length === 1, 'first reply')
  expect(fake.asked[0]).toContain('Codex Sleep a while (gpt-6-luna) wants to run: touch /x')
  expect(fake.replies[0]).toEqual({ id: 7, result: { decision: 'accept' } })

  fake.askAnswer = null
  push(fake, { type: 'request', id: 8, method: 'item/fileChange/requestApproval', params: { threadId: 'th-1' } })
  await until(fake, async () => fake.replies.length === 2, 'second reply')
  expect(fake.replies[1]).toEqual({ id: 8, result: { decision: 'decline' } })

  fake.askAnswer = 'Allow for session'
  push(fake, { type: 'request', id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', command: 'ls' } })
  await until(fake, async () => fake.replies.length === 3, 'third reply')
  expect(fake.replies[2]).toEqual({ id: 9, result: { decision: 'acceptForSession' } })
  // No rule proposed: no "Allow always".
  expect(fake.askedOptions[0]).toEqual(['Allow once', 'Allow for session', 'Deny'])

  // A proposed rule: "Allow always" answers with it, so Codex persists it.
  fake.askAnswer = 'Allow always'
  const rule = ['touch', '/x']
  push(fake, { type: 'request', id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', command: 'touch /x', proposedExecpolicyAmendment: rule } })
  await until(fake, async () => fake.replies.length === 4, 'fourth reply')
  expect(fake.askedOptions[3]).toEqual(['Allow once', 'Allow for session', 'Allow always', 'Deny'])
  expect(fake.replies[3]).toEqual({ id: 10, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rule } } } })

  // Codex's reviewer (approvals: auto) is recorded too.
  push(fake, note('item/autoApprovalReview/completed', { threadId: 'th-1', turnId: 'turn-1', review: { status: 'approved', riskLevel: 'low', rationale: 'benign' }, action: { type: 'command', command: "/bin/zsh -lc 'echo hi > ~/x'" } }))
  await until(fake, async () => ((await agentsOf(fake)).a1?.digest as string[]).length === 5, 'review digest')
  expect((await agentsOf(fake)).a1?.digest).toEqual([
    'approval: $ touch /x -> approved by user (once)',
    'approval: file change -> declined by user',
    'approval: $ ls -> approved by user (session)',
    'approval: $ touch /x -> approved by user (always: rule touch /x)',
    'approval: $ echo hi > ~/x -> auto-reviewer approved, low risk: benign',
  ])
  done(fake)
})

test('permissions: auto by default, yolo forces full access and refuses a contradicting sandbox', () => {
  const settings = { codexPath: 'c', nodePath: 'n', defaultEffort: 'high', defaultSandbox: 'workspace-write' as const, defaultApprovals: 'auto' as const }
  const defaults = effectiveDefaults(settings, {})
  expect(defaults).toEqual({ effort: 'high', sandbox: 'workspace-write', approvals: 'auto' })
  expect(permissionsFor({}, defaults)).toEqual({ sandbox: 'workspace-write', approvals: 'auto' })
  expect(permissionsFor({ approvals: 'yolo' }, defaults)).toEqual({ sandbox: 'full-access', approvals: 'yolo' })
  expect(() => permissionsFor({ approvals: 'yolo', sandbox: 'read-only' }, defaults)).toThrow('contradicts')
  expect(permissionsFor({ sandbox: 'read-only' }, effectiveDefaults(settings, { approvals: 'yolo' }))).toEqual({ sandbox: 'read-only', approvals: 'never' })
  expect(permissionsFor({}, effectiveDefaults(settings, { approvals: 'yolo' }))).toEqual({ sandbox: 'full-access', approvals: 'yolo' })
  expect(() => permissionsFor({ approvals: 'sometimes' }, defaults)).toThrow('approvals must be one of')
  expect(configDirs('/work/app/src', '/work')).toEqual(['/work/app/src', '/work/app', '/work'])
  expect(configDirs('/elsewhere', '/work')).toEqual(['/elsewhere', '/'])
  expect(approvalOptions('item/fileChange/requestApproval', { proposedExecpolicyAmendment: ['x'] })).not.toContain('Allow always')
  expect(approvalAnswer('item/fileChange/requestApproval', {}, { kind: 'always' })).toEqual({ result: { decision: 'acceptForSession' } })
  expect(agentSpecs(defaults).map(spec => spec.name)).toEqual(['luna', 'sol', 'astra', 'terra'])
})

test('Windows paths: config dirs split at \\ and end at the drive; commands drop the PowerShell wrapper', () => {
  expect(configDirs('X:\\src\\app\\lib\\', 'X:\\src')).toEqual(['X:\\src\\app\\lib', 'X:\\src\\app', 'X:\\src'])
  expect(configDirs('X:\\elsewhere', 'X:\\src\\')).toEqual(['X:\\elsewhere', 'X:'])
  expect(configDirs('X:\\', 'Y:\\')).toEqual(['X:'])
  expect(configDirs('/', '/')).toEqual(['/'])
  // As Codex 0.153 on Windows reports them.
  const pwsh = '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -NoProfile -Command'
  expect(shortCommand(`${pwsh} Get-Location`)).toBe('Get-Location')
  expect(shortCommand(`${pwsh} 'Get-ChildItem -Name -Filter "*.mjs"'`)).toBe('Get-ChildItem -Name -Filter "*.mjs"')
  expect(shortCommand(`${pwsh} "Write-Output 'it''s a \\"test\\"'"`)).toBe(`Write-Output 'it''s a "test"'`)
  // As Codex 0.161 on Windows reports them, verbatim: the script quoted POSIX-style, '…' and "…" by turns.
  const pwsh161 = String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command`
  expect(shortCommand(String.raw`${pwsh161} '$files = Get-ChildItem -Name -Filter '"'*.mjs'; \"count: "'$($files.Count)"'`)).toBe(
    `$files = Get-ChildItem -Name -Filter '*.mjs'; "count: $($files.Count)"`,
  )
  expect(shortCommand(String.raw`${pwsh161} '$env:PYTHONIOENCODING='"'utf-8'; Write-Output "'$env:PYTHONIOENCODING'`)).toBe(
    `$env:PYTHONIOENCODING='utf-8'; Write-Output $env:PYTHONIOENCODING`,
  )
  expect(shortCommand(String.raw`${pwsh161} "Write-Output 'it''s'"`)).toBe("Write-Output 'it''s'")
  expect(shortCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
  expect(shortCommand("echo 'unclosed")).toBe("echo 'unclosed")
  expect(shortCommand('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-Date')).toBe('Get-Date')
  expect(shortCommand("/bin/bash -lc 'ls -la'")).toBe('ls -la')
  expect(shortCommand('git log --grep pwsh -Command x')).toBe('git log --grep pwsh -Command x')
  expect(bridgeTarget('/tmp/cxb-501/k/s', '/rpc')).toEqual({ url: 'http://codex/rpc', socketPath: '/tmp/cxb-501/k/s' })
  expect(bridgeTarget('http://127.0.0.1:5000/s3cret', '/rpc')).toEqual({ url: 'http://127.0.0.1:5000/s3cret/rpc' })
})

test("Windows bridge: requests go to the daemon's loopback URL under its secret, and codex-msg gets that URL", { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  push(fake, { type: 'ready', socket: 'http://127.0.0.1:5000/s3cret', reattached: false, active: {} })
  const agent = await spawn($, fake, 'x')
  expect(fake.targets.length).toBeGreaterThan(0)
  for (const target of fake.targets) expect(target).toMatch(/^ http:\/\/127\.0\.0\.1:5000\/s3cret\/(operation(?:\/poll|\/ack)?|thread-state|release|wait|registry\/(read|write))$/)
  const started = fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { args: string[] }> } }
  expect(started.config.mcp_servers.claude_session?.args.slice(1)).toEqual(['http://127.0.0.1:5000/s3cret', String(agent.msgKey)])
  done(fake)
})

test('the agent listing: sol is the default, luna for searches and easy work, astra and terra only when asked', () => {
  const defaults = effectiveDefaults({ codexPath: 'c', nodePath: 'n', defaultEffort: undefined, defaultSandbox: 'workspace-write', defaultApprovals: 'auto' }, {})
  expect(agentDescription('sol', defaults)).toContain('Default')
  expect(agentDescription('sol', defaults)).toContain('the newest Sol model, effort high.')
  expect(agentDescription('luna', defaults)).toContain('searches')
  for (const alias of ['astra', 'terra']) expect(agentDescription(alias, defaults)).toContain('ONLY when the user explicitly asks')
  for (const alias of ['luna', 'sol', 'astra', 'terra']) {
    const description = agentDescription(alias, defaults)
    expect(description).toContain(`the newest ${alias[0]?.toUpperCase()}${alias.slice(1)} model`)
    expect(description).not.toMatch(/gpt-|\b\d+(?:\.\d+)*\b/)
  }
})

test('each alias selects the newest numeric version of its family in any list order; with none the error says to update', () => {
  const old = new Map(['gpt-5.5-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => [id, EFFORTS]))
  expect(['luna', 'sol', 'astra', 'terra'].map(alias => modelFor(old, alias))).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra'])
  for (const ids of [
    ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol'],
    ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-sol'],
  ]) expect(modelFor(new Map(ids.map(id => [id, EFFORTS])), 'sol')).toBe('gpt-6.1-sol')
  for (const alias of ['luna', 'sol', 'astra', 'terra']) {
    for (const versions of [['6.1', '7', '5.6', '6'], ['7', '6', '6.1', '5.6'], ['5.6', '6', '7', '6.1']]) {
      const models = new Map(versions.map(version => [`gpt-${version}-${alias}`, EFFORTS]))
      models.set('gpt-99-other', EFFORTS)
      models.set(`gpt-99-${alias}-preview`, EFFORTS)
      expect(modelFor(models, alias)).toBe(`gpt-7-${alias}`)
    }
  }
  // Numeric components, not lexical order or a decimal number.
  expect(modelFor(new Map(['gpt-9-sol', 'gpt-10-sol'].map(id => [id, EFFORTS])), 'sol')).toBe('gpt-10-sol')
  expect(modelFor(new Map(['gpt-6.9-sol', 'gpt-6.10-sol'].map(id => [id, EFFORTS])), 'sol')).toBe('gpt-6.10-sol')
  expect(modelFor(new Map(['gpt-6.1-sol', 'gpt-6.1.2-sol'].map(id => [id, EFFORTS])), 'sol')).toBe('gpt-6.1.2-sol')
  // No family at all: the fallback id, which modelEffortError refuses with the update advice.
  const none = new Map([['gpt-5.5', EFFORTS]])
  expect(modelFor(none, 'luna')).toBe('gpt-6-luna')
  expect(modelFor(new Map(), 'sol')).toBe('gpt-6.1-sol')
  expect(modelEffortError(none, 'gpt-6-luna', 'max')).toContain(UPDATE_HINT)
  expect(modelEffortError(none, 'some-model', 'max')).not.toContain(UPDATE_HINT)
  expect(aliasOf('gpt-5.6-luna')).toBe('luna')
  expect(aliasOf('gpt-6.1-sol')).toBe('sol')
  expect(aliasOf('gpt-7-sol')).toBe('sol')
  expect(aliasOf('o3')).toBe('o3')
})

test('a spawn runs the newest listed family model without a pinned-model warning and shows its real id', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  fake.models = [
    ['gpt-6-luna', EFFORTS], ['gpt-5.6-luna', EFFORTS], ['gpt-7-luna', EFFORTS],
    ['gpt-6.1-sol', [...EFFORTS, 'ultra']], ['gpt-7-sol', [...EFFORTS, 'ultra']], ['gpt-6-sol', EFFORTS],
  ]
  await start($, fake)
  const first = await spawn($, fake, 'x')
  await spawn($, fake, 'y', { subagentType: 'codex:sol' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start').map(rpc => rpc.params.model)).toEqual(['gpt-7-luna', 'gpt-7-sol'])
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params.model)).toEqual(['gpt-7-luna', 'gpt-7-sol'])
  expect(first.model).toBe('gpt-7-luna')
  const warnings = fake.shown.filter(line => line.includes(UPDATE_HINT))
  expect(warnings).toEqual([])
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toContain('[gpt-7-luna/max,')
  expect(String(fake.registeredAgents[1]?.description)).toContain('the newest Sol model')
  done(fake)
})

test('a spawn runs the newest available model even when only older family versions are listed, without a warning', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  fake.models = [['gpt-5.5-luna', EFFORTS], ['gpt-5.6-luna', EFFORTS]]
  await start($, fake)
  const agent = await spawn($, fake, 'x')
  expect(agent.model).toBe('gpt-5.6-luna')
  expect(fake.shown.filter(line => line.includes(UPDATE_HINT))).toEqual([])
  done(fake)
})

test('a spawn whose alias has no model of its family on this Codex CLI is refused with the update advice', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  fake.models = [['gpt-5.5', EFFORTS]]
  await start($, fake)
  const refused = await $.agent.spawn(spawnInput('x'))
  expect(refused.deny).toContain('Unknown Codex model "gpt-6-luna"')
  expect(refused.deny).toContain(UPDATE_HINT)
  expect(fake.spawned).toEqual([])
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toEqual([])
  done(fake)
})

test('project config: header lines > .claude/codex.json (nearest up to the root) > userConfig', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, { '/work/.claude/codex.json': JSON.stringify({ effort: 'medium', approvals: 'yolo' }) })
  await start($, fake)
  // Project defaults apply: medium, yolo (so full access).
  await spawn($, fake, 'x')
  expect(fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params).toMatchObject({ model: 'gpt-6-luna', sandbox: 'danger-full-access', approvalPolicy: 'never' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/start')?.params).toMatchObject({ effort: 'medium' })
  // Header lines win over the project.
  await spawn($, fake, 'effort: low\napprovals: ask\nsandbox: read-only\ny')
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')[1]?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')[1]?.params).toMatchObject({ effort: 'low' })
  // A broken config is reported, not ignored.
  fake.files['/work/.claude/codex.json'] = '{"sandbox": "everything"}'
  const refused = await $.agent.spawn(spawnInput('z', { subagentType: 'codex:sol' }))
  expect(refused.deny).toContain('sandbox must be one of')
  done(fake)
})

test('effort: per-model built-ins (luna max, others high) under header > project > userConfig', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  fake.agentIds.push('a4')
  await start($, fake)
  const descriptions = fake.registeredAgents.map(spec => String(spec.description))
  expect(descriptions[0]).toMatch(/^For simple mechanical work and searches/)
  expect(descriptions[0]).toContain('the newest Luna model, effort max.')
  expect(descriptions[1]).toMatch(/^Default Codex agent for normal tasks/)
  expect(descriptions[1]).toContain('the newest Sol model, effort high.')
  expect(descriptions[2]).toMatch(/^Use ONLY when the user explicitly asks for astra/)
  expect(descriptions[3]).toMatch(/^Use ONLY when the user explicitly asks for terra/)
  // No effort set anywhere: each model's own.
  await spawn($, fake, 'x')
  await spawn($, fake, 'y', { subagentType: 'codex:sol' })
  const turns = () => fake.rpcs.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params.effort)
  expect(turns()).toEqual(['max', 'high'])
  // A project effort applies to every model; the header still wins.
  fake.files['/work/.claude/codex.json'] = JSON.stringify({ effort: 'low' })
  await spawn($, fake, 'z')
  await spawn($, fake, 'effort: xhigh\nw')
  expect(turns().slice(2)).toEqual(['low', 'xhigh'])
  done(fake)
})

test('effort: a userConfig defaultEffort replaces the per-model built-ins, below the project', { options: { defaultEffort: 'medium' }, timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(String(fake.registeredAgents[0]?.description)).toContain('the newest Luna model, effort medium.')
  await spawn($, fake, 'x')
  fake.files['/work/.claude/codex.json'] = JSON.stringify({ effort: 'low' })
  await spawn($, fake, 'y')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params.effort)).toEqual(['medium', 'low'])
  const settings = { codexPath: 'c', nodePath: 'n', defaultEffort: undefined, defaultSandbox: 'workspace-write' as const, defaultApprovals: 'auto' as const }
  const builtIn = effectiveDefaults(settings, {})
  expect(['luna', 'sol', 'astra', 'terra'].map(alias => effortFor(builtIn, alias))).toEqual(['max', 'high', 'high', 'high'])
  expect(agentDescription('terra', builtIn)).toContain('the newest Terra model, effort high.')
  done(fake)
})

test('after a reload the registry comes back from the store and live turns reattach', async ($, on) => {
  const base = {
    threadId: 'th-old', model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write', approvals: 'ask', cwd: '/work',
    currentTurnId: 'turn-9', lastTurnId: null, lastTurnStatus: null, lastMessage: '', activity: 'x', lastCommand: '',
    tokens: 0, error: null, digest: [], startedAt: 1, updatedAt: 1, turnStartedAt: 1, turnEndedAt: 0, sessionId: 'session-1',
  }
  const fake = fakeBridge(on, {
    agents: {
      aaa111: { ...base, id: 'aaa111', name: 'alive', status: 'running' },
      bbb222: { ...base, id: 'bbb222', name: 'lost', threadId: 'th-lost', status: 'running' },
    },
  })
  await start($, fake, { reattached: false, active: { 'th-old': 'turn-9' } })
  await until(fake, async () => !!(await agentsOf(fake)).bbb222?.warning, 'reconnection warning')
  const agents = await agentsOf(fake)
  expect(agents.aaa111).toMatchObject({ status: 'running', currentTurnId: 'turn-9' })
  expect(agents.bbb222).toMatchObject({ status: 'running', currentTurnId: 'turn-9' })

  // A message must first confirm the old turn ended, then resume its saved thread.
  fake.waitQueue = [completed('turn-9', 'saved completion')]
  await send($, 'bbb222', 'continue')
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  expect(fake.rpcs[0]?.params).toMatchObject({ threadId: 'th-lost', sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  done(fake)
})

const savedAgent = (id: string, extra: Partial<CodexAgent> = {}): CodexAgent => ({
  id, name: `Saved ${id}`, description: 'saved work', threadId: `th-${id}`, model: 'gpt-6.1-sol',
  effort: 'high', sandbox: 'full-access', approvals: 'ask', cwd: '/work', status: 'running',
  currentTurnId: 'old-turn', lastTurnId: null, lastTurnStatus: null, lastMessage: 'previous result',
  activity: 'working', msgKey: `key-${id}`, outbox: [], tokens: 123, error: null, digest: [],
  startedAt: 1, updatedAt: 2, turnStartedAt: 1, turnEndedAt: 0, sessionId: 'old-session', ...extra,
})

test('a reattached wrapper binds a completed retained start without another message or turn', async ($, on) => {
  const original = savedAgent('a1', { status: 'starting', currentTurnId: null, sessionId: 'session-1' })
  const fake = fakeBridge(on, { agents: { a1: original } }, {}, { a1: original })
  fake.agentList.push({ id: 'a1', type: 'codex:sol' })
  fake.operations.set('lost-binding', { operationId: 'lost-binding', status: 'completed', method: 'turn/start',
    params: { threadId: 'th-a1' }, result: { turn: { id: 'retained-turn', status: 'completed' } } })
  await start($, fake, { reattached: true })
  fake.waitQueue = [completed('retained-turn', 'RECOVERED RESULT')]
  expect((await awaitCall($, 'a1')).result).toBe('RECOVERED RESULT')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', currentTurnId: null, lastTurnId: 'retained-turn' })
  expect(fake.acknowledged.has('lost-binding')).toBe(true)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(0)
  expect(fake.delivered).toEqual([])
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('restart with an empty store restores native jobs from disk across session IDs, then resumes the real Codex thread before delivery', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, {}, { a1: savedAgent('a1'), elsewhere: savedAgent('elsewhere') }, LIST_NOW)
  fake.agentList.push({ id: 'a1', type: 'codex:sol', name: 'helper' })
  // New relay, older daemon: persistence is served separately from Codex RPCs.
  await start($, fake, { registry: 'http://127.0.0.1:5001/s3cret' })
  const listed = String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)
  expect(listed).toContain('a1 Saved a1 [gpt-6.1-sol/high, full-access, approvals ask] running')
  expect(listed).not.toContain('elsewhere')
  expect(fake.disk.elsewhere?.status).toBe('running')
  expect(fake.disk.a1?.sessionId).toBe('session-1')
  expect(fake.disk.a1?.turnEndedAt).toBe(0)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'a1' } as never)).result)).toContain('previous result')
  fake.waitQueue = [completed('old-turn', 'saved completion')]
  expect(await send($, 'helper', 'continue the saved work')).toEqual({ isDelivered: true })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  expect(fake.rpcs[0]?.params).toMatchObject({ threadId: 'th-a1', model: 'gpt-6.1-sol', sandbox: 'danger-full-access', approvalPolicy: 'on-request' })
  expect(fake.rpcs[1]?.params).toMatchObject({ threadId: 'th-a1', input: [{ text: 'continue the saved work' }], sandboxPolicy: { type: 'dangerFullAccess' } })
  expect(fake.delivered).toEqual([{ to: 'helper', text: 'continue the saved work' }])
  expect(fake.targets.filter(target => target.includes('/registry/')).every(target => target.startsWith(' http://127.0.0.1:5001/'))).toBe(true)
  fake.waitQueue = [completed('turn-1', 'RESUMED RESULT')]
  expect((await awaitCall($, 'a1')).result).toBe('RESUMED RESULT')
  expect(await finalOf($, 'a1')).toBe('RESUMED RESULT')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('restored native jobs with missing records show failed, refuse SendMessage, and end the wrapper without repeated awaits', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, {}, {}, LIST_NOW)
  await start($, fake)
  // Native agents may be restored after session.start, as after compaction.
  fake.agentList.push({ id: 'lost', type: 'codex:sol', name: 'helper' })
  const listed = String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)
  expect(listed).toContain('lost')
  expect(listed).toContain('] failed')
  expect(fake.disk.lost?.turnEndedAt).toBe(LIST_NOW)
  const result = String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'lost' } as never)).result)
  expect(result).toContain('No saved Codex thread for agent lost')
  expect(await send($, 'helper', 'continue')).toMatchObject({ isDelivered: false, reason: 'No saved Codex thread for agent lost. Its job record is missing; start a new codex:* agent. Do not retry codex_await.' })
  expect(fake.delivered).toEqual([])
  expect((await awaitCall($, 'lost')).result).toContain('Codex failed: No saved Codex thread')
  expect(await finalOf($, 'lost')).toContain('Codex failed: No saved Codex thread')
  expect(fake.waits).toEqual([])
  expect(fake.rpcs).toEqual([])
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('a persisted thread that Codex cannot resume fails before the Claude wrapper is restarted', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, {}, { a1: savedAgent('a1', { status: 'idle', currentTurnId: null }) })
  fake.agentList.push({ id: 'a1', type: 'codex:sol' })
  await start($, fake)
  fake.rpcErrors['thread/resume'] = 'thread not found'
  expect(await send($, 'a1', 'continue')).toMatchObject({ isDelivered: false, reason: 'Codex did not take the message: thread not found' })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume'])
  expect(fake.delivered).toEqual([])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'failed', currentTurnId: null })
  expect(await finalOf($, 'a1')).toContain('thread not found')
  done(fake)
})

test('a native agent restored after bridge startup stays live until its exact end is confirmed', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, {}, { late: savedAgent('late') })
  await start($, fake)
  // Wait for startup before the engine restores its native agent rows.
  await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)
  fake.agentList.push({ id: 'late', type: 'codex:sol' })
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toContain('] running')
  expect(await send($, 'late', 'continue')).toMatchObject({ isDelivered: false })
  fake.waitQueue = [completed('old-turn', 'saved completion')]
  expect(await send($, 'late', 'continue')).toEqual({ isDelivered: true })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  done(fake)
})

test('a lazy bridge start migrates legacy records even when session.start did not fire', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, { agents: { a1: savedAgent('a1', { status: 'idle', currentTurnId: null }) } })
  fake.agentList.push({ id: 'a1', type: 'codex:sol' })
  push(fake, { type: 'ready', socket: '/tmp/cxb-test/s', reattached: false, active: {} })
  expect(await send($, 'a1', 'continue')).toEqual({ isDelivered: true })
  expect(fake.disk.a1?.threadId).toBe('th-a1')
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  done(fake)
})

test('an HTTP wait timeout does not lose a long-running Codex turn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [
    { error: { message: '$.http.fetch aborted: no complete answer within 30000ms' } },
    { status: 'timeout' },
    completed('turn-1', 'LONG TURN DONE'),
  ]
  expect((await awaitCall($, 'a1')).result).toBe('LONG TURN DONE')
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([2_000, 2_000, 2_000, 1])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', lastTurnStatus: 'completed', error: null })
  done(fake)
})

test('a refused message does not discard a still-running turn or prevent TaskStop', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.rpcErrors['turn/steer'] = 'steer refused'
  fake.rpcErrors['turn/start'] = 'thread busy'
  expect(await send($, 'a1', 'continue')).toMatchObject({ isDelivered: false })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-1' })
  expect(fake.delivered).toEqual([{ to: 'a1', text: 'continue' }])
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/interrupt')?.params).toMatchObject({ threadId: 'th-1', turnId: 'turn-1' })
  done(fake)
})

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }

/** The drawn tree as the lines it shows: a column Box stacks its children, a Text runs them on. */
function linesOf(node: Node): string {
  if (typeof node === 'string') return node
  const parts = (node.children ?? []).map(linesOf)
  return node.type === 'Box' && node.props?.flexDirection === 'column' ? parts.join('\n') : parts.join('')
}

/** The color of the row's bullet. */
function dotColor(node: Node): unknown {
  if (typeof node === 'string') return undefined
  if (node.type === 'Text' && node.children?.[0] === '●') return node.props?.color
  for (const child of node.children ?? []) {
    const color = dotColor(child)
    if (color !== undefined) return color
  }
  return undefined
}

test('Codex events replay full assistant blocks and native Bash receipts with no execution or model calls', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  let executions = 0
  on('tool.call', { tool: 'Bash' }, () => { executions++; return { deny: 'must never execute replay' } })
  await start($, fake)
  await spawn($, fake)
  const text = `## Verification\n\n${'Full markdown paragraph. '.repeat(300)}\n\n- **passed**\n- follow up`
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: 'intro', type: 'agentMessage', text } }))
  for (let i = 0; i < 7; i++) push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: `cmd${i}`, type: 'commandExecution', command: `API_TOKEN=fixture-secret npm test${i}`, exitCode: i ? 0 : 1, durationMs: 1200, aggregatedOutput: 'DO NOT SHOW RAW OUTPUT' } }))
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: 'summary', type: 'reasoning', summary: ['Checking final verification.', 'All checks reviewed.'], content: ['PRIVATE RAW REASONING'] } }))
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: 'msg', type: 'agentMessage', text: 'The focused tests passed.', phase: 'commentary' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.lastMessage === 'The focused tests passed.', 'message')
  // Await only wakes the wrapper. It neither consumes nor draws the events.
  expect((await awaitCall($, 'a1')).result).toBe('')
  const replay = await step($, 'a1', 1)
  expect(replay.chunks.filter(c => c.kind === 'text')).toEqual([
    { kind: 'text', index: 0, text },
    { kind: 'text', index: 8, text: 'Checking final verification.\n\nAll checks reviewed.' },
    { kind: 'text', index: 9, text: 'The focused tests passed.' },
  ])
  expect(replay.result.answer).toBe(`${text}\n\nChecking final verification.\n\nAll checks reviewed.\n\nThe focused tests passed.`)
  expect(replay.result.stopReason).toBe('tool_use')
  expect(replay.result.toolUses.map(t => t.name)).toEqual([...Array(7).fill('Bash'), 'mcp__codex__codex_await'])
  const tools = replay.chunks.filter(c => c.kind === 'tool' && c.name === 'Bash') as { kind: 'tool'; index: number; id: string; name: string }[]
  for (const [i, chunk] of tools.entries()) {
    const args = JSON.parse(replay.chunks.filter(c => c.kind === 'input' && c.index === chunk.index).map(c => (c as { json: string }).json).join(''))
    expect(args).toEqual({ command: `… npm test${i}` })
    const result = await $.tool.call({ tool: 'Bash', tool_use_id: chunk.id, agentId: 'a1', ...args } as never)
    expect(result).toMatchObject({ result: { stdout: `exit ${i ? 0 : 1}, 1.2s`, stderr: '', interrupted: false } })
    expect(await $.tool.call({ tool: 'Bash', tool_use_id: chunk.id, agentId: 'a1', ...args } as never)).toMatchObject({ deny: 'Codex command replay receipt unavailable; no command was executed.' })
  }
  expect(JSON.stringify(replay)).not.toMatch(/fixture-secret|RAW OUTPUT|RAW REASONING|Message:|Progress:|truncated/)
  expect((await step($, 'a1', 2)).result.toolUses).toEqual([{ name: 'mcp__codex__codex_await', input: {} }])
  fake.waitQueue = [completed('turn-1', 'FINAL RESULT')]
  expect((await awaitCall($, 'a1')).result).toBe('FINAL RESULT')
  expect(executions).toBe(0)
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('assistant, Bash and collapsed or expanded group components delegate to native rendering on both surfaces', { timeoutMs: 30_000 }, async ($, on) => {
  const text = `## Markdown\n\n${'A full paragraph. '.repeat(500)}\n\n- **passed**`
  const tools = Array.from({ length: 7 }, (_, i) => ({ id: `toolu_codex_replay_render${i}` }))
  const outputs = tools.map(() => ({ stdout: 'exit 0, 1.2s', stderr: '', interrupted: false }))
  // The SDK mount exercises ui.render, but has no built-in transcript layout.
  // Supply the renderer below the plugin and prove every native component
  // reaches it untouched, on both surfaces, including expanded group state.
  const rendered: Record<string, unknown>[] = []
  for (const component of ['AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup'] as const) {
    on('ui.render', { component }, (_$, e) => { rendered.push(e.props as Record<string, unknown>); return { type: 'Text', children: ['native renderer'] } })
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const targets = [
      { component: 'AssistantMessage', props: { text, isFirstOfReply: true } },
      { component: 'ToolUse', props: { tool_use_id: tools[0]!.id, tool: 'Bash', input: { command: '… npm test0' }, output: outputs[0], isRunning: false, isErrored: false, isInterrupted: false } },
      { component: 'ToolResult', props: { tool_use_id: tools[0]!.id, tool: 'Bash', output: outputs[0], isErrored: false } },
      ...[false, true].map(isExpanded => ({ component: 'ToolGroup', props: { calls: tools.map((t, i) => ({ tool_use_id: t.id, tool: 'Bash', input: { command: `… npm test${i}` }, output: outputs[i], isRunning: false, isErrored: false, isInterrupted: false })), isActive: false, isExpanded } })),
    ]
    for (const target of targets) {
      const ui = await $.ui.mount({ plugin: 'codex', surface, requestId: `replay-${target.component}`, ...target } as never)
      expect(linesOf((await ui.drawn()) as Node)).toBe('native renderer')
      expect(rendered.at(-1)).toEqual(target.props)
      await ui.unmount()
    }
  }
})

test("codex rows are one header and one result line; the result text stays the model's", { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const row = (tool: string, input: Record<string, unknown>, output: unknown, flags: Record<string, boolean> = {}) => ({
    component: 'ToolUse' as const,
    requestId: `tu-${tool}`,
    props: { tool_use_id: `tu-${tool}`, tool: `mcp__codex__${tool}`, input, isRunning: false, isErrored: false, isInterrupted: false, output, ...flags },
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const running = await $.ui.mount({ plugin: 'codex', surface, ...row('codex_await', {}, undefined, { isRunning: true }) })
    expect(linesOf((await running.drawn()) as Node)).toBe('')
    await running.unmount()

    // The result block under the row draws nothing.
    const result = await $.ui.mount({
      plugin: 'codex',
      surface,
      component: 'ToolResult',
      requestId: 'tu-codex_list',
      props: { tool_use_id: 'tu-codex_list', tool: 'mcp__codex__codex_list', output: 'x', isErrored: false },
    })
    expect(linesOf((await result.drawn()) as Node)).toBe('')
    await result.unmount()

    const cases: [string, Record<string, unknown>, string, string][] = [
      ['codex_list', {}, 'abc w1 [gpt-6-luna/low, workspace-write, approvals auto] running 3s: thinking\ndef w2 [gpt-6-luna/low, workspace-write, approvals auto] idle, ran 9s, finished 2m ago: completed', 'Codex(list)\n  ⎿  2 agents · 1 running'],
      ['codex_result', { id: 'w1' }, 'abc w1 [gpt-6-luna/low, workspace-write, approvals auto] idle, ran 9s, finished 2m ago: completed\nFinal message:\nDONE BANANA\nmore', 'Codex(result w1)\n  ⎿  done · DONE BANANA'],
    ]
    for (const [tool, input, output, expected] of cases) {
      const ui = await $.ui.mount({ plugin: 'codex', surface, ...row(tool, input, output) })
      expect(linesOf((await ui.drawn()) as Node)).toBe(`● ${expected}`)
      await ui.unmount()
    }

    // An errored call: a red dot and the reason's first line.
    const failed = await $.ui.mount({ plugin: 'codex', surface, ...row('codex_result', { id: 'nope' }, 'No Codex agent "nope". codex_list shows them.', { isErrored: true }) })
    expect(linesOf((await failed.drawn()) as Node)).toBe('● Codex(result nope)\n  ⎿  failed: No Codex agent "nope". codex_list shows them.')
    expect(dotColor((await failed.drawn()) as Node)).toBe('error')
    await failed.unmount()
  }
  done(fake)
})

test('codex_list and codex_result read the jobs', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toContain('subagent_type codex:luna')
  await spawn($, fake)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toMatch(/^a1 Sleep a while \[gpt-6-luna\/max, workspace-write, approvals auto\] running/)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'ALL GREEN', phase: 'final_answer' }] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'Sleep a while' } as never)).result)).toContain('Final message:\nALL GREEN')
  done(fake)
})

const CAPACITY = 'Selected model is at capacity. Please try a different model.'
const finished = (text: string) => note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] } })

const overloaded = (id: string) => ({ status: 'completed', turn: { id, status: 'failed', items: [], error: { message: 'model at capacity', codexErrorInfo: 'serverOverloaded' } } })

/** Wait for the durable retry reservation, then advance the SDK's virtual sleep. */
async function awaitCapacityDelay($: Engine, fake: Fake, attempt: number, delay: number) {
  const pending = awaitCall($, 'a1')
  await until(fake, async () => (await agentsOf(fake)).a1?.capacityAttempts === attempt &&
    (await agentsOf(fake)).a1?.capacityNotBefore !== undefined, 'capacity reservation')
  await fake.clock.advance(delay)
  return pending
}

test('terminal structured capacity retries the same input/thread/model at most twice', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'original capacity input')
  fake.waitQueue = [overloaded('turn-1')]
  expect(String((await awaitCapacityDelay($, fake, 1, 2000)).result)).toContain('waiting to retry')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'starting', capacityAttempts: 1 })
  fake.waitQueue = [overloaded('turn-2')]
  expect(String((await awaitCapacityDelay($, fake, 2, 4000)).result)).toContain('waiting to retry')
  fake.waitQueue = [overloaded('turn-3')]
  expect(String((await awaitCall($, 'a1')).result)).toContain('model at capacity')
  const starts = fake.rpcs.filter(rpc => rpc.method === 'turn/start')
  expect(starts).toHaveLength(3)
  for (const rpc of starts) expect(rpc.params).toMatchObject({ threadId: 'th-1', model: 'gpt-6-luna', input: [{ text: 'original capacity input' }] })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'failed', capacityAttempts: 2 })
  await until(fake, async () => releases(fake).length === 1, 'exhausted capacity release')
  done(fake)
})

test('observed work blocks terminal capacity retries and explicit next input resets the policy', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  push(fake, note('item/started', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'task command' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.capacityWorkObserved === true, 'work observed')
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: 'task-done', type: 'commandExecution', command: 'task command', exitCode: 0 } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.digest.some(line => line.includes('task command')) === true, 'command completion')
  expect((await awaitCall($, 'a1')).result).toBe('')
  const work = await step($, 'a1', 1)
  expect(work.result.toolUses[0]?.name).toBe('Bash')
  fake.waitQueue = [overloaded('turn-1')]
  expect(String((await awaitCall($, 'a1')).result)).toContain('model at capacity')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  expect(await send($, 'a1', 'new explicit task')).toMatchObject({ isDelivered: true })
  expect((await agentsOf(fake)).a1).toMatchObject({ capacityAttempts: 0, capacityInput: 'new explicit task', capacityWorkObserved: false })
  done(fake)
})

test('an expired durable capacity reservation cannot start a turn after reload', async ($, on) => {
  const reserved = savedAgent('a1', { sessionId: 'session-1', status: 'starting', currentTurnId: null,
    lastTurnId: 'failed-turn', lastTurnStatus: 'failed', capacityInput: 'original input',
    capacityAttempts: 1, capacityStartedAt: 1, capacityNotBefore: 2001 })
  const fake = fakeBridge(on, { agents: { a1: reserved } })
  fake.agentList.push({ id: 'a1', type: 'codex:sol' })
  await start($, fake, { reattached: true })
  expect(String((await awaitCall($, 'a1')).result)).toContain('retry budget expired')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(0)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'failed', currentTurnId: null })
  done(fake)
})

test('TaskStop cancels a pending capacity retry before it can start another turn', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [overloaded('turn-1')]
  expect(String((await awaitCapacityDelay($, fake, 1, 2000)).result)).toContain('waiting to retry')
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'interrupted', currentTurnId: null })
  await awaitCall($, 'a1')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  done(fake)
})

test('wrapper registry recovery failure keeps awaiting locally without a Claude model', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.registryError = 'fixture bridge unavailable'
  const response = await step($, 'a1')
  expect(response.chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect(response.result.stopReason).toBe('tool_use')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('a real engine hook timeout keeps the Codex wrapper awaiting without a Claude request', { timeoutMs: 30_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  // Hook budgets use real wall time; advancing the SDK clock cannot cancel them.
  fake.sessionDelayMs = 10_500
  const response = await step($, 'a1')
  expect(response.chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect(response.result.stopReason).toBe('tool_use')
  expect(fake.modelSteps).toBe(0)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-1' })
  done(fake)
})

test('a model-capacity error is a warning: the job runs on to its real end', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  push(fake, note('error', { threadId: 'th-1', turnId: 'turn-1', willRetry: false, error: { message: CAPACITY } }))
  push(fake, note('item/started', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'blender -b' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.warning === CAPACITY, 'the warning')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', error: null })
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toContain(`running 0s, 0 tok: $ blender -b (warning: ${CAPACITY})`)
  expect((await step($, 'a1')).chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  push(fake, finished('DONE'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect(await finalOf($, 'a1', 1)).toBe('DONE')
  done(fake)
})

test('compaction warnings stay live but terminal failures cannot be revived by an old item', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  const compact = `Error running remote compact task: ${CAPACITY}`
  push(fake, note('error', { threadId: 'th-1', turnId: 'turn-1', willRetry: false, error: { message: compact } }))
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'compaction failed, going on', phase: 'commentary' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.warning === compact, 'the warning')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', error: null })
  // Recovery during the hold belongs to the daemon. A delivered terminal is final here.
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'failed', error: { message: compact }, items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'failed', 'failed')
  push(fake, note('item/started', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'blender -b' } }))
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect((await agentsOf(fake)).a1).toMatchObject({ currentTurnId: null, status: 'failed' })
  await until(fake, async () => releases(fake).length === 1, 'failed-thread release')
  expect(String(await finalOf($, 'a1'))).toContain(compact)
  done(fake)
})

const LIST_NOW = 3_600_000
const LIST_CUTOFF = LIST_NOW - 30 * 60_000
const listAgent = (id: string, extra: Partial<CodexAgent> = {}): CodexAgent => savedAgent(id, {
  sessionId: 'session-1', status: 'idle', currentTurnId: null, lastTurnStatus: 'completed',
  lastMessage: 'OLD RESULT', turnEndedAt: LIST_NOW, ...extra,
})

const HIDDEN_NOTICE = 'older finished jobs hidden; codex_list with all: true lists them. codex_result and SendMessage still reach any of them.'

test('codex_list defaults to active and recently finished jobs of this session', () => {
  const agents = [
    listAgent('starting', { status: 'starting', turnEndedAt: 0 }),
    listAgent('running', { status: 'running', turnEndedAt: 1 }),
    listAgent('completed'),
    listAgent('failed', { status: 'failed', lastTurnStatus: 'failed' }),
    listAgent('interrupted', { status: 'interrupted', lastTurnStatus: 'interrupted' }),
    listAgent('old-completed', { turnEndedAt: 1 }),
    listAgent('old-failed', { status: 'failed', turnEndedAt: 1 }),
    listAgent('old-interrupted', { status: 'interrupted', turnEndedAt: 1 }),
    listAgent('elsewhere', { sessionId: 'session-0' }),
  ]
  const listed = listText(agents, 'session-1', LIST_NOW)
  expect(listed.split('\n').slice(0, -1).map(line => line.split(' ')[0])).toEqual(['starting', 'running', 'completed', 'failed', 'interrupted'])
  expect(listed.endsWith(`3 ${HIDDEN_NOTICE}`)).toBe(true)
})

test('codex_list uses the turn end time and includes the exact 30-minute boundary', () => {
  const agents = [
    listAgent('recent', { startedAt: 1, turnEndedAt: LIST_CUTOFF + 1 }),
    listAgent('boundary', { turnEndedAt: LIST_CUTOFF }),
    listAgent('older', { startedAt: LIST_NOW, updatedAt: LIST_NOW, turnEndedAt: LIST_CUTOFF - 1 }),
  ]
  const listed = listText(agents, 'session-1', LIST_NOW)
  expect(listed.split('\n').map(line => line.split(' ')[0])).toEqual(['recent', 'boundary', '1'])
  expect(listText([agents[1]!], 'session-1', LIST_NOW + 1)).toContain('No active or recently finished Codex jobs')
})

test('finished job lines distinguish runtime from time since finishing, without changing the filter', () => {
  const now = 1_800_000_000_000
  const ended = now - 53 * 60_000
  const agent = listAgent('finished', {
    turnStartedAt: ended - 442_000, turnEndedAt: ended,
  })
  expect(describeAgent(agent, now)).toContain('] idle, ran 7m 22s, finished 53m ago, 123 tok: completed')
  expect(resultText(agent, false, now)).toContain('ran 7m 22s, finished 53m ago')
  expect(listText([agent], 'session-1', now, true)).toContain('ran 7m 22s, finished 53m ago')
  expect(listText([agent], 'session-1', now)).toContain('No active or recently finished Codex jobs')
  expect(listText([agent], 'session-1', ended + 5 * 60_000)).toContain('ran 7m 22s, finished 5m ago')
})

test('running and starting job lines keep their elapsed time and omit a previous finish time', () => {
  for (const status of ['running', 'starting'] as const) {
    const agent = listAgent(status, { status, turnStartedAt: LIST_NOW - 190_000, turnEndedAt: LIST_NOW - 300_000 })
    const line = describeAgent(agent, LIST_NOW)
    expect(line).toContain(`] ${status} 3m 10s, 123 tok:`)
    expect(line).not.toContain('ran ')
    expect(line).not.toContain('finished ')
  }
})

test('failed and interrupted job lines retain their status and label both times', () => {
  for (const status of ['failed', 'interrupted'] as const) {
    const agent = listAgent(status, { status, lastTurnStatus: status, turnStartedAt: LIST_NOW - 15_000, turnEndedAt: LIST_NOW - 5_000 })
    expect(describeAgent(agent, LIST_NOW)).toContain(`] ${status}, ran 10s, finished 5s ago, 123 tok: ${status}`)
  }
})

test('finished job lines omit timing when an older record has no turn end timestamp', () => {
  const agent = listAgent('missing-end', { turnEndedAt: 0 })
  expect(describeAgent(agent, LIST_NOW)).toContain('] idle, 123 tok: completed')
  expect(resultText(agent, false, LIST_NOW)).not.toContain('finished ')
  expect(describeAgent(agent, LIST_NOW)).not.toContain('ran ')
})

test('codex_list all=true includes older finished jobs but only this session', () => {
  const agents = [listAgent('old', { turnEndedAt: 1 }), listAgent('elsewhere', { sessionId: 'session-0' })]
  const listed = listText(agents, 'session-1', LIST_NOW, true)
  expect(listed).toMatch(/^old Saved old /)
  expect(listed.split('\n')).toHaveLength(1)
  expect(listed).not.toContain('hidden')
  expect(listed).not.toContain('elsewhere')
})

test('codex_list ends with the hidden count only when jobs are hidden', () => {
  const agents = [listAgent('recent'), listAgent('old', { turnEndedAt: 1 })]
  expect(listText(agents, 'session-1', LIST_NOW).split('\n').at(-1)).toBe(`1 ${HIDDEN_NOTICE}`)
  expect(listText([agents[0]!], 'session-1', LIST_NOW)).not.toContain('hidden')
  expect(listText(agents, 'session-1', LIST_NOW, true)).not.toContain('hidden')
})

test('codex_list distinguishes an empty default list from a session with no jobs', () => {
  const listed = listText([listAgent('old', { turnEndedAt: 1 })], 'session-1', LIST_NOW)
  expect(listed).toBe(`No active or recently finished Codex jobs in this session; 1 ${HIDDEN_NOTICE}`)
  expect(listed.split('\n')).toHaveLength(1)
  expect(listText([], 'session-1', LIST_NOW)).toContain('No Codex agents in this session')
  expect(listText([listAgent('elsewhere', { sessionId: 'session-0' })], 'session-1', LIST_NOW, true)).toContain('No Codex agents in this session')
})

test('codex_list advertises its default window and optional boolean all argument', () => {
  const spec = TOOL_SPECS.find(tool => tool.name === 'codex_list')!
  expect(spec.description).toContain('30 minutes')
  expect(spec.description).toContain('all=true')
  expect(spec.inputSchema).toMatchObject({ type: 'object', properties: { all: { type: 'boolean' } } })
})

test('codex_list all=true shows the full session history, newest first; hidden jobs remain reachable', { timeoutMs: 20_000 }, async ($, on) => {
  const agents: Record<string, CodexAgent> = {
    other: listAgent('other', { startedAt: 99, sessionId: 'session-0', turnEndedAt: 2 }),
  }
  for (let i = 1; i <= 12; i += 1) agents[`j${i}`] = listAgent(`j${i}`, { name: `job ${i}`, startedAt: i, turnEndedAt: 2 })
  const fake = fakeBridge(on, { agents }, {}, {}, LIST_NOW)
  fake.agentList.push({ id: 'j1', type: 'codex:sol', name: 'job 1' })
  await start($, fake, { reattached: true })
  const defaultList = String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)
  expect(defaultList).toBe(`No active or recently finished Codex jobs in this session; 12 ${HIDDEN_NOTICE}`)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list', all: false } as never)).result)).toBe(defaultList)
  const listed = String((await $.tool.call({ tool: 'mcp__codex__codex_list', all: true } as never)).result).split('\n')
  expect(listed).toHaveLength(12)
  expect(listed[0]).toMatch(/^j12 job 12 \[gpt-6.1-sol\/high, full-access, approvals ask\] idle, ran 0s, finished 1h 0m ago, 123 tok: completed$/)
  expect(listed[9]).toMatch(/^j3 job 3 /)
  expect(listed[11]).toMatch(/^j1 job 1 /)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'j1' } as never)).result)).toContain('Final message:\nOLD RESULT')
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'other' } as never)).result)).toContain('Final message:\nOLD RESULT')
  expect(await send($, 'job 1', 'continue the hidden job')).toEqual({ isDelivered: true })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toContain('j1 job 1 [gpt-6.1-sol/high, full-access, approvals ask] running')
  done(fake)
})

test('running agents show beside the prompt hint, and nothing once none runs', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  on('ui.render', { component: 'PromptHint' }, (_$, e) => ({ type: 'Text', children: [`${e.props.hint}|${e.props.tail ?? ''}`] }))
  await start($, fake)
  const hint = { component: 'PromptHint' as const, requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }
  const ui = await $.ui.mount({ plugin: 'codex', surface: 'terminal', ...hint })
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|')
  await spawn($, fake)
  await ui.redraw()
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|codex: Sleep a while (luna)')
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  await ui.redraw()
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|')
  await ui.unmount()
  done(fake)
})

test('NODE_OPTIONS: preloads of missing absolute files are found and left out, everything else is kept', () => {
  const options = '--require=/gone/restore.cjs --max-old-space-size=4096 -r /kept.cjs --import "file:///gone/a b.mjs" -r ts-node/register'
  expect(nodeOptionPreloads(options)).toEqual(['/gone/restore.cjs', '/kept.cjs', '/gone/a b.mjs'])
  expect(withoutPreloads(options, new Set(['/gone/restore.cjs', '/gone/a b.mjs']))).toBe('--max-old-space-size=4096 -r /kept.cjs -r ts-node/register')
  expect(withoutPreloads('--require "/x y/a.cjs" --inspect', new Set())).toBe('--require "/x y/a.cjs" --inspect')
})

test("the bridge runs without NODE_OPTIONS preloads whose file is gone, which would stop node before it starts", async ($, on) => {
  const fake = fakeBridge(on, {}, { '/kept.cjs': '' })
  fake.env.NODE_OPTIONS = '--require=/var/folders/T/cmux-claude-node-options/restore-node-options.cjs --max-old-space-size=4096 -r /kept.cjs'
  await start($, fake)
  expect(fake.spawnEnvs).toEqual([{ NODE_OPTIONS: '--max-old-space-size=4096 -r /kept.cjs' }])
  done(fake)
})

test('NODE_OPTIONS whose preloads are all on disk leaves the bridge the host environment', async ($, on) => {
  const fake = fakeBridge(on, {}, { '/kept.cjs': '' })
  fake.env.NODE_OPTIONS = '-r /kept.cjs'
  await start($, fake)
  expect(fake.spawnEnvs).toEqual([undefined])
  done(fake)
})

test('a bridge that stops before it is ready refuses the spawn with why and what to do; the next call starts it again', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  // As a stale NODE_OPTIONS preload ends node: stderr, then exit code 1, no ready line.
  fake.queue.push({ stderr: "Error: Cannot find module '/tmp/restore.cjs'\nRequire stack:\n- internal/preload\n" })
  fake.exitCode = 1
  fake.closed = true
  const refused = await $.agent.spawn(spawnInput('sleep 20'))
  expect(refused.deny).toContain('the codex bridge stopped before it was ready (exit code 1)')
  expect(refused.deny).toContain("Cannot find module '/tmp/restore.cjs'")
  expect(refused.deny).toContain('The next codex call or Agent spawn starts the bridge again')
  expect(fake.spawnEnvs.length).toBe(1)

  // The cause is gone: the next spawn starts a new relay, with no restart of Claude Code.
  fake.closed = false
  fake.exitCode = 0
  push(fake, { type: 'ready', socket: '/tmp/cxb-test/s', reattached: false, active: {} })
  const spawned = await $.agent.spawn(spawnInput('sleep 20'))
  expect(spawned.deny).toBeUndefined()
  expect(fake.spawnEnvs.length).toBe(2)
  expect(fake.rpcs.map(rpc => rpc.method)).toContain('turn/start')
  done(fake)
})

test("a relay's fatal line refuses the spawn with its message and the daemon log's tail", { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  push(fake, { type: 'fatal', message: 'cannot run the Codex CLI /nope/codex (spawnSync /nope/codex ENOENT). Install or update it', logTail: '' })
  fake.closed = true
  const refused = await $.agent.spawn(spawnInput('sleep 20'))
  expect(refused.deny).toContain('codex bridge failed: cannot run the Codex CLI /nope/codex')
})

test('the Codex CLI version: older than the minimum is refused with the found and needed versions and the fix; newer or unknown passes', () => {
  expect(codexVersionError('codex-cli 0.150.3')).toBe(`the Codex CLI is 0.150.3, older than ${MIN_CODEX_VERSION}, the oldest this plugin runs on. ${UPDATE_HINT}`)
  expect(codexVersionError('codex-cli 0.162.0-alpha.2')).toBeUndefined()
  expect(codexVersionError(`codex-cli ${MIN_CODEX_VERSION}-alpha.1`)).toBeUndefined()
  expect(codexVersionError('codex-cli 1.0.0')).toBeUndefined()
  expect(codexVersionError(undefined)).toBeUndefined()
  expect(codexVersionError('codex (dev build)')).toBeUndefined()
})

test('an outdated Codex CLI refuses each codex:* spawn before any thread starts; codex_list still reads jobs and warns', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake, { codexVersion: 'codex-cli 0.150.3' })
  const refused = await $.agent.spawn(spawnInput('sleep 20'))
  expect(refused.deny).toBe(`codex: the Codex CLI is 0.150.3, older than ${MIN_CODEX_VERSION}, the oldest this plugin runs on. ${UPDATE_HINT}`)
  expect(fake.spawned).toEqual([])
  expect(fake.rpcs).toEqual([])
  const listed = String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)
  expect(listed).toContain('Warning: the Codex CLI is 0.150.3')
  done(fake)
})

test('a current Codex CLI version lets the spawn run', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake, { codexVersion: 'codex-cli 0.162.0-alpha.2' })
  await spawn($, fake)
  expect(fake.rpcs.map(rpc => rpc.method)).toContain('turn/start')
  done(fake)
})

test('SendMessage native wrapper resume preserves the original thread, prompt history and sandbox', async ($, on) => {
  const fake = fakeBridge(on, {}, { '/work/.claude/codex.json': '{"sandbox":"workspace-write"}' })
  await start($, fake)
  await spawn($, fake, 'Original task with durable context')
  // Defaults changed since launch, as after reinstall. A resumed wrapper must
  // not allocate a thread or deliver its latest message a second time.
  fake.files['/work/.claude/codex.json'] = '{"sandbox":"full-access"}'
  expect(await send($, 'a1', 'continue the original task')).toMatchObject({ isDelivered: true })
  await $.agent.spawn(spawnInput('continue the original task', { resume: { agentId: 'a1' } }))
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(1)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer')).toHaveLength(1)
  expect((await agentsOf(fake)).a1).toMatchObject({ threadId: 'th-1', sandbox: 'workspace-write', capacityInput: 'Original task with durable context' })
  push(fake, finished('original complete'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'original completion')
  await send($, 'a1', 'follow-up after completion')
  await $.agent.spawn(spawnInput('follow-up after completion', { resume: { agentId: 'a1' } }))
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(1)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params)).toMatchObject([
    { threadId: 'th-1', sandboxPolicy: { type: 'workspaceWrite' } },
    { threadId: 'th-1', sandboxPolicy: { type: 'workspaceWrite' } },
  ])
  expect((await agentsOf(fake)).a1?.sandbox).toBe('workspace-write')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('TaskStop keeps an unconfirmed interruption live and settles only an exact terminal receipt', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.registryWriteError = 'ECONNREFUSED fixture registry'
  const stopped = await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  expect(stopped.result).toMatchObject({ task_id: 'a1', task_type: 'local_agent', command: 'fixture task' })
  expect((stopped.result as { message: string }).message).toContain('Codex is still running')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/interrupt')).toHaveLength(1)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-1' })
  expect(String(fake.disk.a1?.status)).toBe('running')
  fake.registryWriteError = undefined
  fake.interruptAnswer = { status: 'completed', turn: { id: 'turn-1', status: 'interrupted', items: [] } }
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'interrupted', currentTurnId: null, lastTurnId: 'turn-1', warning: null })
  done(fake)
})

test('ready registry-write failure does not poison a healthy bridge or claim its live turns ended', async ($, on) => {
  const original = savedAgent('a1', { sessionId: 'session-1' })
  const fake = fakeBridge(on, { agents: { a1: original } })
  fake.agentList.push({ id: 'a1', type: 'codex:sol' })
  fake.registryWriteError = 'ECONNREFUSED fixture registry'
  await start($, fake, { active: { 'th-a1': 'old-turn' } })
  expect((await step($, 'a1')).chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  fake.registryWriteError = undefined
  fake.waitQueue = [completed('old-turn', 'survived registry outage')]
  expect((await awaitCall($, 'a1')).result).toBe('survived registry outage')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('writer conflict retries only a currently released lock, with a bounded retry budget', async ($, on) => {
  const fake = fakeBridge(on, {}, {}, { a1: savedAgent('a1', { status: 'idle', currentTurnId: null }) })
  fake.agentList.push({ id: 'a1', type: 'codex:sol' })
  await start($, fake)
  fake.writerStatus = 'held'
  fake.rpcErrors['thread/resume'] = 'thread already has an active writer'
  expect(await send($, 'a1', 'continue')).toMatchObject({ isDelivered: false })
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/resume')).toHaveLength(1)
  fake.writerStatus = 'released'
  fake.rpcErrors['thread/resume'] = 'thread already has an active writer'
  expect(await withRetryClock(fake, () => send($, 'a1', 'continue'))).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/resume')).toHaveLength(3)
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(0)
  expect((await agentsOf(fake)).a1?.threadId).toBe('th-a1')
  fake.disk.a2 = savedAgent('a2', { status: 'idle', currentTurnId: null })
  fake.agentList.push({ id: 'a2', type: 'codex:sol' })
  fake.rpcErrors['thread/resume'] = 'thread already has an active writer'
  fake.rpcHook = rpc => { if (rpc.method === 'thread/resume') fake.rpcErrors['thread/resume'] = 'thread already has an active writer' }
  expect(await withRetryClock(fake, () => send($, 'a2', 'continue'))).toMatchObject({ isDelivered: false })
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/resume' && rpc.params.threadId === 'th-a2')).toHaveLength(3)
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(0)
  done(fake)
})


test('a requested stop fences a late capacity failure until explicit new input', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: overloaded('turn-1').turn }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'failed', 'stopped terminal failure')
  expect((await agentsOf(fake)).a1).toMatchObject({ stopRequested: true, currentTurnId: null })
  expect((await agentsOf(fake)).a1?.capacityNotBefore).toBeUndefined()
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  await send($, 'a1', 'explicit new input after stop')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(2)
  expect((await agentsOf(fake)).a1?.stopRequested).toBe(false)
  done(fake)
})

test('engine delivery refusal admits no native start or steer, for both running and idle jobs', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'original', { name: 'helper' })
  fake.deliveryRefusal = 'a plugin declined the resume: fixture refusal'
  const before = fake.rpcs.filter(r => ['turn/start', 'turn/steer'].includes(r.method)).length
  expect(await send($, 'a1', 'must not steer')).toMatchObject({ isDelivered: false, reason: fake.deliveryRefusal })
  push(fake, finished('original complete'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle before refused delivery')
  expect(await send($, 'helper', 'must not start')).toMatchObject({ isDelivered: false, reason: fake.deliveryRefusal })
  expect(fake.rpcs.filter(r => ['turn/start', 'turn/steer'].includes(r.method))).toHaveLength(before)
  expect(fake.delivered).toEqual([])
  expect((await agentsOf(fake)).a1?.status).toBe('idle')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('actual engine resume objects recover legacy records by ID across sessions without replacing their thread', async ($, on) => {
  // Legacy records used this same schema, without the newer
  // optional stop/capacity fields. Neither record is listed by the engine yet.
  const legacy = savedAgent('legacy', { sessionId: 'previous-session', status: 'idle', currentTurnId: null, sandbox: 'workspace-write' })
  const fake = fakeBridge(on, {}, {}, { legacy })
  await start($, fake)
  const resumed = await $.agent.spawn(spawnInput('resume', { resume: { agentId: 'legacy' } }))
  expect(resumed).toMatchObject({ agentId: 'legacy' })
  expect(fake.rpcs.filter(r => ['thread/start', 'turn/start', 'turn/steer'].includes(r.method))).toEqual([])
  let entered!: () => void
  let release!: () => void
  const handoff = new Promise<void>(resolve => { entered = resolve })
  const accepted = new Promise<void>(resolve => { release = resolve })
  fake.deliveryHook = () => { entered(); return accepted }
  const sending = send($, 'legacy', 'follow-up')
  await handoff
  // Reproduce the engine's nested resume while session.send is still awaiting
  // its acceptance; top-level kit calls use the actual engine, not another SDK.
  expect(await $.agent.spawn(spawnInput('follow-up', { resume: { agentId: 'legacy' } }))).toMatchObject({ agentId: 'legacy' })
  expect((await step($, 'legacy')).chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect(String((await withRetryClock(fake, () => awaitCall($, 'legacy'))).result)).toContain('awaiting native admission')
  release()
  expect(await sending).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'thread/resume').map(r => r.params)).toMatchObject([{ threadId: 'th-legacy', sandbox: 'workspace-write' }])
  expect(fake.rpcs.filter(r => r.method === 'turn/start').map(r => r.params)).toMatchObject([{ threadId: 'th-legacy' }])
  expect(fake.rpcs.filter(r => r.method === 'thread/start')).toEqual([])
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('missing or unsupported resume bindings refuse with a readable identity and no native work', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  for (const resume of [{ agentId: 'missing-agent' }, 'missing-agent']) {
    const refused = await $.agent.spawn(spawnInput('must not start', { resume }))
    expect(refused.deny).toContain('agent missing-agent')
    expect(refused.deny).not.toContain('[object Object]')
  }
  const malformed = await $.agent.spawn(spawnInput('must not start', { resume: { other: 'missing' }, name: 'helper' }))
  expect(malformed.deny).toContain('agent helper')
  expect(fake.spawned).toEqual([])
  expect(fake.rpcs.filter(r => ['thread/start', 'thread/resume', 'turn/start', 'turn/steer'].includes(r.method))).toEqual([])
  done(fake)
})

test('accepted starts and steers remain delivered when acknowledgement or binding persistence fails', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.ackError = 'fixture lost acknowledgement'
  expect(await send($, 'a1', 'steer once')).toMatchObject({ isDelivered: true })
  push(fake, finished('original complete'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle before follow-up')
  fake.rpcHook = rpc => { if (rpc.method === 'turn/start') fake.registryWriteError = 'fixture persistence unavailable after native start' }
  expect(await send($, 'a1', 'start once')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(2)
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toHaveLength(1)
  expect((await step($, 'a1')).chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect(fake.active['th-1']).toBe('turn-2')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('lost native submit responses retain acceptance and never repeat the input', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.submitError = 'fixture connection lost after submit'
  expect(await send($, 'a1', 'steer once')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toHaveLength(1)
  fake.submitError = undefined
  push(fake, finished('original complete'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle before uncertain admission')
  fake.submitError = 'fixture connection lost after submit'
  expect(await send($, 'a1', 'new turn once')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(2)
  fake.submitError = undefined
  fake.waitQueue = [completed('turn-2', 'recovered retained admission')]
  expect((await awaitCall($, 'a1')).result).toBe('recovered retained admission')
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(2)
  done(fake)
})

test('refused TaskStop has no native effect; accepted stop preserves every required output field', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.stopRefusal = 'fixture owner refuses this stop'
  expect(await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)).toMatchObject({ deny: fake.stopRefusal })
  expect(fake.rpcs.filter(r => r.method === 'turn/interrupt')).toEqual([])
  expect((await agentsOf(fake)).a1?.stopRequested).not.toBe(true)
  fake.stopRefusal = undefined
  fake.stopError = true
  expect(await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)).toMatchObject({ isError: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/interrupt')).toEqual([])
  fake.stopError = false
  fake.interruptAnswer = { status: 'completed', turn: { id: 'turn-1', status: 'interrupted', items: [] } }
  expect((await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)).result).toEqual({ message: 'wrapper stopped', task_id: 'a1', task_type: 'local_agent', command: 'fixture task' })
  expect(fake.stopCalls).toBe(3)
  done(fake)
})

test('a spawn with a registry write failure never starts native work or falls through to Claude', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  fake.registryWriteError = 'fixture cannot save new job'
  const spawned = await $.agent.spawn(spawnInput('must not start'))
  expect(spawned).toMatchObject({ agentId: 'a1' })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toEqual([])
  expect((await step($, 'a1')).chunks[0]).toMatchObject({ kind: 'tool', name: 'SubagentHandback' })
  fake.registryWriteError = undefined
  expect(String((await awaitCall($, 'a1')).result)).toContain('could not be saved')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('a real engine deadline after native admission cannot turn a started turn into a refused delivery', { timeoutMs: 25_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  push(fake, finished('original complete'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle before deadline fixture')
  fake.rpcHook = rpc => { if (rpc.method === 'turn/start') fake.storeDelayMs = 11_000 }
  const delivered = await send($, 'a1', 'start once across deadline')
  expect(delivered).toMatchObject({ isDelivered: true })
  expect(fake.active['th-1']).toBe('turn-2')
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(2)
  fake.storeDelayMs = undefined
  expect((await step($, 'a1')).chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__codex__codex_await' })
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('an engine deadline before native admission refuses without any later start or steer', { timeoutMs: 25_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.sessionDelayMs = 11_000
  expect(await send($, 'a1', 'must not arrive late')).toMatchObject({ isDelivered: false })
  fake.sessionDelayMs = undefined
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toEqual([])
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('a structured daemon admission refusal is truthful and sends no native input', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.operationRefusal = 'fixture admission refused'
  expect(await send($, 'a1', 'must not steer')).toMatchObject({ isDelivered: false, reason: 'Codex did not take the message: fixture admission refused' })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toEqual([])
  expect(fake.active['th-1']).toBe('turn-1')
  done(fake)
})

test('lost initial start and capacity-retry responses remain owned until their exact retained outcome', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  fake.submitError = 'fixture initial native response lost'
  await spawn($, fake, 'original input')
  expect(fake.active['th-1']).toBe('turn-1')
  fake.submitError = undefined
  fake.waitQueue = [overloaded('turn-1')]
  expect(String((await awaitCapacityDelay($, fake, 1, 2000)).result)).toContain('waiting to retry')
  fake.submitError = 'fixture retry native response lost'
  fake.waitQueue = [completed('turn-2', 'retry recovered')]
  expect((await awaitCall($, 'a1')).result).toBe('retry recovered')
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(2)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', lastTurnId: 'turn-2' })
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('codex_list, codex_result and codex_await return string results and validation failures admit no input', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  for (const input of [{ tool: 'mcp__codex__codex_list' }, { tool: 'mcp__codex__codex_result', id: 'a1' }]) {
    expect(typeof (await $.tool.call(input as never)).result).toBe('string')
  }
  expect(await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'missing' } as never)).toMatchObject({ deny: 'No Codex agent "missing". codex_list shows them.' })
  expect((await awaitCall($, 'non-codex')).deny).toContain('serves codex:* agents only')
  fake.waitQueue = [completed('turn-1', 'fixture final result')]
  expect(typeof (await awaitCall($, 'a1')).result).toBe('string')
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toEqual([])
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('an engine spawn refusal starts no native turn and releases its provisional thread', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  fake.spawnRefusal = 'fixture spawn refused'
  expect(await $.agent.spawn(spawnInput('must not start'))).toMatchObject({ deny: fake.spawnRefusal })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toEqual([])
  await until(fake, async () => releases(fake).length === 1, 'release after engine spawn refusal')
  expect(fake.spawned).toEqual([])
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('TaskStop recovery errors preserve its object shape and invoke the engine stop once', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.registryError = 'fixture registry unavailable after engine stop'
  const stopped = await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  expect(stopped.result).toMatchObject({ task_id: 'a1', task_type: 'local_agent', command: 'fixture task' })
  expect((stopped.result as { message: string }).message).toContain('native Codex outcome is unconfirmed')
  expect(fake.stopCalls).toBe(1)
  fake.registryError = undefined
  const other = await $.tool.call({ tool: 'TaskStop', task_id: 'non-codex' } as never)
  expect(other.result).toEqual({ message: 'wrapper stopped', task_id: 'non-codex', task_type: 'local_agent', command: 'fixture task' })
  done(fake)
})

test('a restored native ID wins over historical name collisions, while ambiguous saved names refuse cleanly', async ($, on) => {
  const fake = fakeBridge(on, {}, {}, {
    historical: savedAgent('historical', { name: 'helper', status: 'idle', currentTurnId: null }),
    current: savedAgent('current', { name: 'helper', status: 'idle', currentTurnId: null }),
  })
  fake.agentList.push({ id: 'current', name: 'helper', type: 'codex:sol' })
  await start($, fake)
  expect(await send($, 'helper', 'use current native identity')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/start').map(r => r.params)).toMatchObject([{ threadId: 'th-current' }])
  fake.agentList = []
  expect(await send($, 'helper', 'ambiguous name')).toMatchObject({ isDelivered: false, reason: 'Codex did not take the message: More than one saved Codex job has this name; use its agent ID. No native input was admitted.' })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(1)
  fake.agentList.push({ id: 'foreign', name: 'helper', type: 'general-purpose' })
  expect(await send($, 'helper', 'ordinary engine message')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toEqual([])
  done(fake)
})


test('quiet awaits last 45 seconds, draw nothing, and subsequent progress returns promptly', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitHook = async body => { await fake.clock.advance(Number(body.timeoutMs)) }
  expect((await awaitCall($, 'a1')).result).toBe('')
  expect(fake.waits).toHaveLength(23)
  expect(fake.waits.reduce((sum, body) => sum + Number(body.timeoutMs), 0)).toBe(45_000)
  fake.waitHook = async () => {
    push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: 'progress', type: 'agentMessage', text: 'Checking now.' } }))
    await until(fake, async () => (await agentsOf(fake)).a1?.lastMessage === 'Checking now.', 'live progress')
    fake.waitHook = undefined
  }
  expect((await awaitCall($, 'a1')).result).toBe('')
  expect((await step($, 'a1', 1)).chunks[0]).toEqual({ kind: 'text', index: 0, text: 'Checking now.' })
  expect(fake.waits).toHaveLength(24)
  fake.interruptAnswer = { status: 'completed', turn: { id: 'turn-1', status: 'interrupted', items: [] } }
  await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/interrupt')).toHaveLength(1)
  expect(fake.modelSteps).toBe(0)
  done(fake)
})


test('TaskStop proceeds while a quiet await HTTP poll is outstanding', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  let entered!: () => void, release!: () => void
  const pollEntered = new Promise<void>(resolve => { entered = resolve })
  const heldPoll = new Promise<void>(resolve => { release = resolve })
  fake.waitHook = () => { entered(); return heldPoll }
  const waiting = awaitCall($, 'a1')
  await pollEntered
  try {
    fake.interruptAnswer = { status: 'completed', turn: { id: 'turn-1', status: 'interrupted', items: [] } }
    await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
    expect(fake.rpcs.filter(rpc => rpc.method === 'turn/interrupt')).toHaveLength(1)
    expect((await agentsOf(fake)).a1?.status).toBe('interrupted')
  } finally {
    fake.waitHook = undefined
    fake.waitAnswer = completed('turn-1', 'fixture cleanup')
    release()
  }
  expect(String((await waiting).result)).toContain('interrupted')
  expect(fake.modelSteps).toBe(0)
  done(fake)
})

test('replay receipts reject foreign agents, altered commands, cancelled and unknown IDs; ordinary Bash delegates', async ($, on) => {
  const fake = fakeBridge(on)
  let executions = 0
  on('tool.call', { tool: 'Bash' }, () => {
    executions++
    return { result: { stdout: 'ordinary Bash delegated', stderr: '', interrupted: false } }
  })
  await start($, fake)
  await spawn($, fake)
  for (let i = 0; i < 3; i++) push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { id: `receipt-${i}`, type: 'commandExecution', command: `echo receipt-${i}`, exitCode: 0 } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.digest.length === 3, 'command receipts')
  const replay = await step($, 'a1')
  const tools = replay.chunks.filter(c => c.kind === 'tool' && c.name === 'Bash') as { id: string }[]
  expect(tools).toHaveLength(3)
  const refused = [
    { tool_use_id: tools[0]!.id, agentId: 'foreign', command: 'echo receipt-0' },
    { tool_use_id: tools[1]!.id, agentId: 'a1', command: 'touch MUST_NOT_RUN' },
    { tool_use_id: 'toolu_codex_replay_unknown', agentId: 'a1', command: 'touch MUST_NOT_RUN' },
  ]
  for (const input of refused) expect(await $.tool.call({ tool: 'Bash', ...input } as never)).toMatchObject({ deny: 'Codex command replay receipt unavailable; no command was executed.' })
  // Steering still goes straight to the existing native turn during replay.
  expect(await send($, 'a1', 'change direction')).toMatchObject({ isDelivered: true })
  expect(fake.rpcs.filter(r => r.method === 'turn/steer')).toHaveLength(1)
  fake.interruptAnswer = { status: 'completed', turn: { id: 'turn-1', status: 'interrupted', items: [] } }
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  expect(await $.tool.call({ tool: 'Bash', tool_use_id: tools[2]!.id, agentId: 'a1', command: 'echo receipt-2' } as never)).toMatchObject({ deny: 'Codex command replay receipt unavailable; no command was executed.' })
  expect(executions).toBe(0)
  expect(await $.tool.call({ tool: 'Bash', command: 'ordinary command' } as never)).toMatchObject({ result: { stdout: 'ordinary Bash delegated' } })
  expect(executions).toBe(1)
  expect(fake.rpcs.filter(r => r.method === 'turn/interrupt')).toHaveLength(1)
  expect(fake.modelSteps).toBe(0)
  done(fake)
})


test('await chrome stays hidden for quiet, terminal, relay, error and interrupted outcomes', { timeoutMs: 30_000 }, async ($) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const state of [
      { output: '', isRunning: true },
      { output: 'Codex is still running: reconnecting' },
      { output: 'Final report' },
      { output: 'Codex sent a message for the main session.' },
      { output: 'transport error', isErrored: true },
      { output: 'interrupted', isInterrupted: true },
    ]) {
      const ui = await $.ui.mount({ plugin: 'codex', surface, component: 'ToolUse', requestId: 'quiet',
        props: { tool_use_id: 'quiet', tool: 'mcp__codex__codex_await', input: {}, isRunning: false, isErrored: false, isInterrupted: false, ...state } })
      expect(linesOf((await ui.drawn()) as Node)).toBe('')
      await ui.unmount()
    }
    const result = await $.ui.mount({ plugin: 'codex', surface, component: 'ToolResult', requestId: 'quiet-result',
      props: { tool_use_id: 'quiet-result', tool: 'mcp__codex__codex_await', output: 'Final report', isErrored: false } })
    expect(linesOf((await result.drawn()) as Node)).toBe('')
    await result.unmount()
  }
})


test('terminal notification during binding persistence drains earlier replay events before settling', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [completed('turn-1', 'done')]
  await awaitCall($, 'a1')
  fake.storeDelayMs = 100
  let notified!: () => void
  const notification = new Promise<void>(resolve => { notified = resolve })
  let notificationError: unknown
  fake.rpcHook = rpc => {
    if (rpc.method !== 'turn/start') return
    void (async () => {
      try {
        await until(fake, async () => (await agentsOf(fake)).a1?.currentTurnId === 'turn-2', 'binding before persistence')
        push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-2', item: { id: 'fast-command', type: 'commandExecution', command: 'true', exitCode: 0 } }))
        push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-2', item: { id: 'fast-note', type: 'agentMessage', text: 'A complete note before the terminal event.' } }))
        push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: 'Fast final', phase: 'final_answer' }] } }))
      } catch (error) { notificationError = error }
      finally { notified() }
    })()
  }
  await send($, 'a1', 'fast turn')
  await notification
  expect(notificationError).toBeUndefined()
  await until(fake, async () => (await agentsOf(fake)).a1?.lastTurnId === 'turn-2', 'terminal after replay drain')
  const replay = await step($, 'a1', 1)
  expect(replay.chunks[0]).toMatchObject({ kind: 'tool', index: 0, name: 'Bash' })
  expect(replay.chunks[2]).toEqual({ kind: 'text', index: 1, text: 'A complete note before the terminal event.' })
  expect(await finalOf($, 'a1', 2)).toBe('Fast final')
  expect(fake.rpcs.filter(r => r.method === 'turn/start')).toHaveLength(2)
  expect(fake.modelSteps).toBe(0)
  done(fake)
})
