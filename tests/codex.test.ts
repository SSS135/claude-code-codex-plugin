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
  rpcErrors: Record<string, string>
  replies: Record<string, unknown>[]
  waits: Record<string, unknown>[]
  /** What the engine's spawn received, and the agentIds it hands out in turn. */
  spawned: Record<string, unknown>[]
  agentIds: string[]
  /** Makes the engine's spawn throw this. */
  spawnError: string | null
  /** What the engine's agent list answers. */
  agentList: { id: string; type: string; name?: string }[]
  /** The agent lists the plugin sent the bridge (/roster), in order. */
  rosters: string[]
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
    replies: [],
    waits: [],
    spawned: [],
    agentIds: ['a1', 'a2', 'a3'],
    spawnError: null,
    agentList: [],
    rosters: [],
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
    fake.spawned.push(JSON.parse(JSON.stringify(e)))
    if (fake.spawnError !== null) throw new Error(fake.spawnError)
    // A resumed subagent keeps its id.
    const resume = (e as { resume?: { agentId: string } }).resume
    if (resume) return { model: 'claude-haiku-4-5', agentId: resume.agentId }
    const agentId = fake.agentIds.shift() as string
    fake.agentList.push({ id: agentId, type: e.subagentType, ...(e.name ? { name: e.name } : {}) })
    return { model: 'claude-haiku-4-5', agentId }
  })
  on('agent.list', () => ({
    value: fake.agentList.map(agent => ({ ...agent, description: '', status: 'running' as const })),
  }))
  on('session.messages', (_$, e) => ({ value: fake.messages[(e as { agentId?: string }).agentId ?? ''] ?? [] }))
  on('tool.check', () => ({ decision: 'ask' as const, reason: 'beneath' }))
  on('session.send', (_$, e) => {
    fake.delivered.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  on('turn.step', async function* (_$, e) {
    fake.modelSteps += 1
    yield { kind: 'text' as const, index: 0, text: 'from Claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('session.id', () => ({ value: 'session-1' }))
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
  on('store.set', (_$, e) => {
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
      case 'thread/start':
        return { thread: { id: `th-${fake.rpcs.filter(one => one.method === 'thread/start').length}` }, model: rpc.params.model }
      case 'turn/start':
        fake.turnCount += 1
        return { turn: { id: `turn-${fake.turnCount}` } }
      default:
        return {}
    }
  }

  on('http.fetch', (_$, e) => {
    fake.targets.push(`${e.init?.socketPath ?? ''} ${e.url}`)
    // A Windows bridge's paths sit under its secret (see the Windows test).
    const path = new URL(e.url).pathname.replace(/^\/s3cret(?=\/)/, '')
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    let reply: unknown = { ok: true }
    if (path === '/registry/read') {
      const ids = (body.ids ?? []) as string[]
      reply = { agents: Object.fromEntries(Object.values(fake.disk).filter(agent => agent.sessionId === body.sessionId || ids.includes(agent.id) || agent.id === body.ref || agent.name === body.ref).map(agent => [agent.id, agent])) }
    }
    if (path === '/registry/write') {
      const agent = body.agent as CodexAgent
      if (!fake.disk[agent.id] || fake.disk[agent.id]!.updatedAt <= agent.updatedAt) fake.disk[agent.id] = JSON.parse(JSON.stringify(agent))
    }
    if (path === '/rpc') {
      const rpc = { method: String(body.method), params: (body.params ?? {}) as Record<string, unknown> }
      fake.rpcs.push(rpc)
      const error = fake.rpcErrors[rpc.method]
      if (error !== undefined) {
        delete fake.rpcErrors[rpc.method]
        reply = { error: { message: error } }
      } else reply = { result: answer(rpc) }
    }
    if (path === '/reply') fake.replies.push(body)
    if (path === '/roster') fake.rosters.push(String(body.text))
    if (path === '/wait') {
      fake.waits.push(body)
      if (fake.waitError !== null) reply = { error: { message: fake.waitError } }
      else reply = fake.waitQueue.shift() ?? fake.waitAnswer
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
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

let spawnCount = 0

/** What the Agent tool hands `agent.spawn` for a call; each call names a new agent. */
const spawnInput = (prompt: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: 'toolu_test',
  prompt,
  description: 'Sleep a while',
  name: `job_${(spawnCount += 1)}`,
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

/** The report a wrapper's final step hands back. */
async function finalOf($: Engine, agentId: string, index = 0): Promise<unknown> {
  const { chunks } = await step($, agentId, index)
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
  const agent = await spawn($, fake, prompt, { description: 'Write calc tests', name: 'calc_tests' })
  expect(fake.spawned[0]).toMatchObject({ subagentType: 'codex:luna', prompt, background: true })
  expect(agent).toMatchObject({ id: 'a1', name: 'calc_tests', description: 'Write calc tests', model: 'gpt-6-luna', effort: 'max', status: 'running', currentTurnId: 'turn-1', cwd: '/work/app' })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['model/list', 'thread/start', 'thread/name/set', 'turn/start'])
  expect(fake.rpcs[1]?.params).toMatchObject({ model: 'gpt-6-luna', cwd: '/work/app', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', ephemeral: false })
  // The job can message the session: bin/codex-msg as an MCP server, named with the bridge's socket and the job's key.
  const msgKey = String(agent.msgKey)
  expect(msgKey).toMatch(/^[0-9a-f]{32}$/)
  const started = fake.rpcs[1]?.params as { config: { mcp_servers: Record<string, { command: string; args: string[] }> }; developerInstructions: string }
  expect(started.config.mcp_servers.claude_agents?.command).toBe(NODE_DEFAULT)
  expect(started.config.mcp_servers.claude_agents?.args).toEqual([expect.stringMatching(/\/bin\/codex-msg$/), '/tmp/cxb-test/s', msgKey])
  expect(started.developerInstructions).toContain('call the message_agent tool of the claude_agents MCP server')
  expect(fake.rpcs[2]?.params).toEqual({ threadId: 'th-1', name: 'calc_tests' })
  expect(fake.rpcs[3]?.params).toMatchObject({ threadId: 'th-1', effort: 'max', input: [{ type: 'text', text: prompt, text_elements: [] }] })

  // The cwd the Agent call set wins, and the job is called what the call named it.
  await spawn($, fake, 'x', { cwd: '/elsewhere', name: 'other' })
  expect((await agentsOf(fake)).a2).toMatchObject({ name: 'other', description: 'Sleep a while', cwd: '/elsewhere' })

  push(fake, note('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } }))
  push(fake, note('item/started', { threadId: 'th-1', item: { type: 'commandExecution', command: "/bin/zsh -lc 'sleep 20'" } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.activity === '$ sleep 20', 'activity')
  push(fake, note('item/completed', { threadId: 'th-1', item: { type: 'commandExecution', command: "/bin/zsh -lc 'sleep 20'", exitCode: 0, status: 'completed' } }))
  push(fake, note('item/completed', { threadId: 'th-1', item: { type: 'agentMessage', text: 'DONE', phase: 'final_answer' } }))
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
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([20_000, 20_000, 20_000, 1])
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

test('a failed or lost Codex turn ends the wrapper with the reason', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  // A daemon stopped mid-wait (#3: ECONNRESET): interrupted, resumable by SendMessage, not failed.
  fake.waitError = 'ECONNRESET'
  const lost = 'Codex turn interrupted: the Codex bridge was lost (ECONNRESET); a SendMessage to its agent starts a new turn on the thread'
  expect(await awaitCall($, 'a1').then(ran => ran.result)).toBe(lost)
  expect(await finalOf($, 'a1', 1)).toBe(lost)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'interrupted', currentTurnId: null })

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
  expect((await awaitCall($, 'a1')).result).toBe('Codex sent a message for main.')
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
  expect((await agentsOf(fake)).a1?.digest).toEqual(['message to main: Which DB should I use?'])

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

test('message_agent with `to` goes to that agent as the job\'s own SendMessage; a Codex recipient learns the sender', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'sleep 20', { name: 'peer_a' })
  await spawn($, fake, 'sleep 20', { name: 'peer_b' })
  fake.waitQueue = [{ status: 'message', messages: [{ text: 'ping', to: 'peer_b' }] }]
  expect((await awaitCall($, 'a1')).result).toBe('Codex sent a message for peer_b.')
  const relay = await step($, 'a1', 1)
  expect(inputOf(relay.chunks)).toEqual({ to: 'peer_b', summary: 'Codex: ping', message: 'ping' })
  expect(await $.tool.check({ tool: 'SendMessage', input: inputOf(relay.chunks), tool_use_id: (relay.chunks[0] as { id: string }).id, agentId: 'a1' } as never)).toMatchObject({ decision: 'allow' })
  expect((await agentsOf(fake)).a1?.digest).toEqual(['message to peer_b: ping'])

  // The engine delivers it from a1's loop: Codex peer_b reads who wrote.
  expect(await $.session.send({ to: 'peer_b', text: 'ping', origin: { kind: 'model' }, agentId: 'a1' } as never)).toEqual({ isDelivered: true })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer').map(rpc => rpc.params)).toEqual([
    { threadId: 'th-2', expectedTurnId: 'turn-2', input: [{ type: 'text', text: 'Message from agent peer_a:\n\nping', text_elements: [] }] },
  ])
  done(fake)
})

test('a message to a name no agent has is not sent; Codex is told instead', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'sleep 20', { name: 'peer_a' })
  fake.waitQueue = [{ status: 'message', messages: [{ text: 'hello?', to: 'ghost' }] }]
  await awaitCall($, 'a1')
  const next = await step($, 'a1', 1)
  expect(next.result.toolUses[0]?.name).toBe('mcp__codex__codex_await')
  expect(fake.delivered).toEqual([])
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer').map(rpc => (rpc.params.input as { text: string }[])[0]?.text)).toEqual([
    'Message to ghost not delivered: no agent of this session has that name. list_agents shows the agents you can message.',
  ])
  done(fake)
})

test('a codex:* spawn needs a name no recent agent has; list_agents reads the agents the plugin sends the bridge', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const nameless = await $.agent.spawn({ ...spawnInput('x'), name: undefined })
  expect(nameless.deny).toContain('give the agent a `name`')
  await spawn($, fake, 'sleep 20', { name: 'peer_a' })
  expect((await $.agent.spawn(spawnInput('x', { name: 'peer_a' }))).deny).toContain('the name peer_a is taken')
  expect((await $.agent.spawn(spawnInput('x', { name: 'main' }))).deny).toContain('the name main is taken')
  expect(fake.rosters.at(-1)).toBe('- main (the Claude Code session that started the jobs)\n- peer_a (codex:luna, running)')
  done(fake)
})


test('SendMessage steers a running Codex turn and starts a new one once it ended, then delivers', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const spawned = await spawn($, fake, 'effort: low\ntask', { name: 'helper' })

  expect(await send($, 'a1', 'also say BANANA')).toEqual({ isDelivered: true })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/steer')?.params).toMatchObject({ threadId: 'th-1', expectedTurnId: 'turn-1', input: [{ text: 'also say BANANA' }] })
  expect(fake.delivered).toEqual([{ to: 'a1', text: 'also say BANANA' }])

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')

  // By the name the Agent call gave: a new turn on the same thread, before the delivery resumes the subagent.
  await send($, 'helper', 'next task')
  const starts = fake.rpcs.filter(rpc => rpc.method === 'turn/start')
  expect(starts).toHaveLength(2)
  expect(starts[1]?.params).toMatchObject({ threadId: 'th-1', input: [{ text: 'next task' }], sandboxPolicy: { type: 'workspaceWrite' } })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })
  // The delivery resumes the subagent through agent.spawn (#4): it keeps the job, its thread and its settings.
  const resumed = await $.agent.spawn(spawnInput('next task', { name: 'helper', resume: { agentId: 'a1' } }))
  expect(resumed).toMatchObject({ agentId: 'a1' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(1)
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(2)
  expect(Object.keys(await agentsOf(fake))).toEqual(['a1'])
  expect((await agentsOf(fake)).a1).toMatchObject({ name: 'helper', effort: 'low', threadId: 'th-1' })
  expect(spawned).toMatchObject({ effort: 'low' })
  // A resume with no saved thread (a wiped or never-written record) is refused, not run as a new job.
  fake.agentList.push({ id: 'a9', type: 'codex:luna' })
  for (const agentId of ['a9', 'zz']) {
    const refused = await $.agent.spawn(spawnInput('next task', { name: 'helper', resume: { agentId } }))
    expect(refused.deny).toBe(`codex: no saved Codex thread for agent ${agentId}; start a new codex:* agent`)
  }
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start')).toHaveLength(1)
  fake.agentList.pop()
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
  expect(fake.delivered.map(one => one.to)).toEqual(['a1', 'helper', 'someone-else'])
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
  const resumed = fake.rpcs[before]?.params as { threadId: string; config: { mcp_servers: { claude_agents: { args: string[] } } } }
  expect(resumed.threadId).toBe('th-1')
  expect(resumed.config.mcp_servers.claude_agents.args.slice(1)).toEqual(['/tmp/cxb-test/s', agent.msgKey])

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
  expect(releases(fake)).toEqual([])

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'the release')
  done(fake)
})

test('a failed turn end releases its thread too, so its MCP servers stop; the next SendMessage resumes it first', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' }, items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'the release')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'failed' })

  const before = fake.rpcs.length
  expect(await send($, 'a1', 'try again')).toEqual({ isDelivered: true })
  expect(fake.rpcs.slice(before).map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })
  done(fake)
})

test('a steer that timed out is not sent again as a new turn; a refused steer starts one', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  const starts = () => fake.rpcs.filter(rpc => rpc.method === 'turn/start').length

  // Codex may have taken a steer whose answer timed out: the message is reported not delivered, never sent twice.
  fake.rpcErrors['turn/steer'] = 'turn/steer timed out after 25000 ms'
  expect(await send($, 'a1', 'also this')).toEqual({ isDelivered: false, reason: 'Codex did not take the message: turn/steer timed out after 25000 ms' })
  expect(starts()).toBe(1)
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-1' })

  // Codex refuses a steer when the turn has ended: a new turn takes the message.
  fake.rpcErrors['turn/steer'] = 'no active turn to steer'
  expect(await send($, 'a1', 'and this')).toEqual({ isDelivered: true })
  expect(starts()).toBe(2)
  fake.rpcErrors['turn/steer'] = 'expected active turn id `turn-2` but found `turn-9`'
  expect(await send($, 'a1', 'and that')).toEqual({ isDelivered: true })
  expect(starts()).toBe(3)
  done(fake)
})

test('two messages to an idle job start one turn: the second steers it', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')

  expect(await Promise.all([send($, 'a1', 'first'), send($, 'a1', 'second')])).toEqual([{ isDelivered: true }, { isDelivered: true }])
  const starts = fake.rpcs.filter(rpc => rpc.method === 'turn/start')
  expect(starts.map(rpc => (rpc.params.input as { text: string }[])[0]?.text)).toEqual(['sleep 20', 'first'])
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/steer').map(rpc => rpc.params)).toMatchObject([{ expectedTurnId: 'turn-2', input: [{ text: 'second' }] }])
  done(fake)
})

test('a spawn that fails after its Codex thread started releases the thread', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  fake.spawnError = 'spawn exploded'
  await $.agent.spawn(spawnInput('task')).catch(() => undefined)
  await until(fake, async () => releases(fake).length === 1, 'the release')
  expect(releases(fake)).toEqual([{ threadId: 'th-1' }])
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(0)
  done(fake)
})

test('TaskStop: an aborted wrapper turn interrupts the Codex turn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  // A missed interrupt is sent again while the bridge still reports the turn running; it stops once the turn ended.
  fake.rpcErrors['turn/interrupt'] = 'connection reset'
  fake.waitQueue = [{ status: 'timeout' }, { status: 'idle', turn: null }]
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  const interrupts = () => fake.rpcs.filter(rpc => rpc.method === 'turn/interrupt').map(rpc => rpc.params)
  expect(interrupts()).toEqual([{ threadId: 'th-1', turnId: 'turn-1' }, { threadId: 'th-1', turnId: 'turn-1' }])
  expect(fake.waits.map(wait => wait.threadId)).toEqual(['th-1', 'th-1'])
  // The interrupted turn's end releases the thread.
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'the release')
  // A turn that ended normally, or the main loop's, interrupts nothing.
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 't-a1', agentId: 'a1', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'main', reason: 'aborted' })
  expect(interrupts()).toHaveLength(2)

  // A turn the bridge keeps reporting running gets three interrupts at most.
  await spawn($, fake, 'y')
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a2', agentId: 'a2', reason: 'aborted' })
  expect(interrupts().slice(2)).toEqual([0, 1, 2].map(() => ({ threadId: 'th-2', turnId: 'turn-2' })))
  done(fake)
})

test('an approval asks the person and posts the reply; a dismissed dialog declines', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'sleep 20', { name: 'sleeper' })

  push(fake, { type: 'request', id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', command: "/bin/zsh -lc 'touch /x'" } })
  await until(fake, async () => fake.replies.length === 1, 'first reply')
  expect(fake.asked[0]).toContain('Codex sleeper (gpt-6-luna) wants to run: touch /x')
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
  push(fake, note('item/autoApprovalReview/completed', { threadId: 'th-1', review: { status: 'approved', riskLevel: 'low', rationale: 'benign' }, action: { type: 'command', command: "/bin/zsh -lc 'echo hi > ~/x'" } }))
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
  for (const target of fake.targets) expect(target).toMatch(/^ http:\/\/127\.0\.0\.1:5000\/s3cret\/(rpc|wait|roster|registry\/(read|write))$/)
  const started = fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { args: string[] }> } }
  expect(started.config.mcp_servers.claude_agents?.args.slice(1)).toEqual(['http://127.0.0.1:5000/s3cret', String(agent.msgKey)])
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
  await until(fake, async () => (await agentsOf(fake)).bbb222?.status === 'interrupted', 'lost turn settled')
  const agents = await agentsOf(fake)
  expect(agents.aaa111).toMatchObject({ status: 'running', currentTurnId: 'turn-9' })
  expect(agents.bbb222?.error).toContain('lost')

  // A message to the lost agent resumes its thread first, then starts a turn.
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

test('restart with an empty store restores native jobs from disk across session IDs, then resumes the real Codex thread before delivery', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, {}, { a1: savedAgent('a1'), elsewhere: savedAgent('elsewhere') }, LIST_NOW)
  fake.agentList.push({ id: 'a1', type: 'codex:sol', name: 'helper' })
  // New relay, older daemon: persistence is served separately from Codex RPCs.
  await start($, fake, { registry: 'http://127.0.0.1:5001/s3cret' })
  const listed = String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)
  expect(listed).toContain('a1 Saved a1 [gpt-6.1-sol/high, full-access, approvals ask] interrupted')
  expect(listed).not.toContain('elsewhere')
  expect(fake.disk.elsewhere?.status).toBe('running')
  expect(fake.disk.a1?.sessionId).toBe('session-1')
  expect(fake.disk.a1?.turnEndedAt).toBe(LIST_NOW)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'a1' } as never)).result)).toContain('previous result')
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
  const fake = fakeBridge(on, {}, {}, { a1: savedAgent('a1') })
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

test('a native agent restored after bridge startup is still listed as interrupted and resumes its saved thread', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, {}, { late: savedAgent('late') })
  await start($, fake)
  // Wait for startup before the engine restores its native agent rows.
  await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)
  fake.agentList.push({ id: 'late', type: 'codex:sol' })
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toContain('] interrupted')
  expect(await send($, 'late', 'continue')).toEqual({ isDelivered: true })
  expect(fake.rpcs.map(rpc => rpc.method)).toEqual(['thread/resume', 'turn/start'])
  done(fake)
})

test('a lazy bridge start migrates legacy records even when session.start did not fire', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, { agents: { a1: savedAgent('a1') } })
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
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([20_000, 20_000, 20_000, 1])
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
  expect(fake.delivered).toEqual([])
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
    expect(linesOf((await running.drawn()) as Node)).toBe('● Codex(await)')
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
      ['codex_await', {}, 'DONE BANANA\nmore', 'Codex(await)\n  ⎿  done · DONE BANANA'],
      ['codex_await', {}, 'Codex is still running: a1 luna [...] running', 'Codex(await)\n  ⎿  still running'],
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
  await spawn($, fake, 'sleep 20', { name: 'sleeper' })
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toMatch(/^a1 sleeper \[gpt-6-luna\/max, workspace-write, approvals auto\] running/)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'ALL GREEN', phase: 'final_answer' }] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'sleeper' } as never)).result)).toContain('Final message:\nALL GREEN')
  done(fake)
})

const CAPACITY = 'Selected model is at capacity. Please try a different model.'
const finished = (text: string) => note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text, phase: 'final_answer' }] } })

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

test('a failed compaction, even a reported failed turn, does not end a job whose thread works on', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  const compact = `Error running remote compact task: ${CAPACITY}`
  push(fake, note('error', { threadId: 'th-1', turnId: 'turn-1', willRetry: false, error: { message: compact } }))
  push(fake, note('item/completed', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'compaction failed, going on', phase: 'commentary' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.warning === compact, 'the warning')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', error: null })
  // Liveness: work after a reported failure (at capacity: the job waits to retry) revives the job.
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'failed', error: { message: compact }, items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'starting', 'waiting to retry')
  push(fake, note('item/started', { threadId: 'th-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'blender -b' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'running', 'running again')
  expect((await agentsOf(fake)).a1).toMatchObject({ currentTurnId: 'turn-1', error: null, warning: `Codex kept working after its turn was reported failed: ${compact}` })
  push(fake, finished('DONE'))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect(await finalOf($, 'a1')).toBe('DONE')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1)
  done(fake)
})

test('a turn that failed at capacity is retried once with "continue" on its thread after 30 s; a second failure ends the job', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  const starts = () => fake.rpcs.filter(rpc => rpc.method === 'turn/start')
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'failed', error: { message: CAPACITY, codexErrorInfo: 'serverOverloaded' }, items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'starting', 'waiting to retry')
  expect((await agentsOf(fake)).a1).toMatchObject({ currentTurnId: null, lastTurnId: 'turn-1', digest: ['capacity: retrying with continue'] })

  // The wrapper keeps awaiting; nothing is retried before the 30 s are up.
  const early = awaitCall($, 'a1')
  await fake.clock.advance(5_000)
  expect(String((await early).result)).toContain('still')
  expect(starts()).toHaveLength(1)

  // Then one turn on the same thread, with "continue", never the original prompt; the retry's own capacity failure ends the job.
  fake.waitQueue = [{ status: 'completed', turn: { id: 'turn-2', status: 'failed', error: { message: CAPACITY }, items: [] } }]
  for (let i = 0; i < 6 && starts().length < 2; i += 1) {
    const poll = awaitCall($, 'a1')
    await fake.clock.advance(5_000)
    await poll
  }
  expect(starts().map(rpc => [rpc.params.threadId, (rpc.params.input as { text: string }[])[0]?.text])).toEqual([['th-1', 'sleep 20'], ['th-1', 'continue']])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'failed', error: CAPACITY, capacityRetryTurnId: 'turn-2' })
  expect(await finalOf($, 'a1')).toBe(`Codex failed: ${CAPACITY}`)
  expect(starts()).toHaveLength(2)

  // TaskStop while a job waits for its retry: no retry follows.
  await spawn($, fake, 'y')
  push(fake, note('turn/completed', { threadId: 'th-2', turn: { id: 'turn-3', status: 'failed', error: { message: CAPACITY }, items: [] } }))
  await until(fake, async () => (await agentsOf(fake)).a2?.status === 'starting', 'a2 waiting to retry')
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a2', agentId: 'a2', reason: 'aborted' })
  await until(fake, async () => releases(fake).some(release => release.threadId === 'th-2'), 'the release')
  for (let i = 0; i < 7; i += 1) await fake.clock.advance(5_000)
  expect(await awaitCall($, 'a2').then(ran => ran.result)).toBe('Codex turn interrupted.')
  expect(starts()).toHaveLength(3)
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
  await spawn($, fake, 'sleep 20', { name: 'sleeper' })
  await ui.redraw()
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|codex: sleeper (luna)')
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
