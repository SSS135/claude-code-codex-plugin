import type { On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { agentDescription, agentSpecs, aliasOf, approvalAnswer, approvalOptions, bridgeTarget, configDirs, effectiveDefaults, effortFor, listText, modelEffortError, modelFor, parseHeader, permissionsFor, shortCommand, UPDATE_HINT, wrapperAnswer } from '../hooks/model'
import type { CodexAgent } from '../types'

// A fake bridge: the relay's stdout is a queue the test pushes NDJSON into,
// and its HTTP endpoints are answered by an `http.fetch` hook. Beneath the
// plugin, the test stands for the engine: the Agent tool's spawn, the agent
// list, SendMessage's delivery and a Claude model's turn.step.

type Rpc = { method: string; params: Record<string, unknown> }

type Fake = {
  argv: readonly string[]
  queue: string[]
  closed: boolean
  wake: () => void
  rpcs: Rpc[]
  /** Methods whose next call the fake app-server answers with this error. */
  rpcErrors: Record<string, string>
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
  turnCount: number
  registeredAgents: Record<string, unknown>[]
  store: Record<string, unknown>
  /** Where each bridge fetch went: `<socketPath> <url>`. */
  targets: string[]
  /** Transcript lines and toasts the person saw. */
  shown: string[]
  /** What model/list answers, newest first: [id, efforts]. */
  models: [string, string[]][]
  clock: MockClock
}

/** The engine resolves a path on the host's root: on Windows '/work/x' arrives as 'C:\work\x'. */
const posixPath = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function fakeBridge(on: On, stored: Record<string, unknown> = {}, files: Record<string, string> = {}): Fake {
  const fake: Fake = {
    argv: [],
    queue: [],
    closed: false,
    wake: () => undefined,
    rpcs: [],
    rpcErrors: {},
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
    targets: [],
    shown: [],
    models: [
      ['gpt-6-luna', EFFORTS],
      ['gpt-6.1-sol', [...EFFORTS, 'ultra']],
    ],
    clock: mock.clock(on, { now: 1_000_000 }),
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

  on('process.spawn', async function* (_$, e) {
    fake.argv = e.argv
    for (;;) {
      const text = fake.queue.shift()
      if (text !== undefined) {
        yield { stream: 'stdout' as const, text }
        continue
      }
      if (fake.closed) return { value: { code: 0, signal: null } }
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
  expect(luna).toContain('gpt-6-luna')
  expect(luna).toContain('gpt-6-luna, effort medium.')
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

  // The cwd the Agent call set wins, and a second luna gets its own name.
  await spawn($, fake, 'x', { cwd: '/elsewhere' })
  expect((await agentsOf(fake)).a2).toMatchObject({ name: 'Sleep a while', cwd: '/elsewhere' })
  // The same description again: a numbered name.
  await spawn($, fake, 'z')
  expect((await agentsOf(fake)).a3?.name).toBe('Sleep a while (2)')

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
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([25_000, 25_000, 25_000, 1])
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

  // By the name the Agent call gave: a new turn on the same thread, before the delivery resumes the subagent.
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
  expect(releases(fake)).toEqual([])

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [] } }))
  await until(fake, async () => releases(fake).length === 1, 'the release')
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
  expect(shortCommand(`${pwsh} "Write-Output 'it''s'"`)).toBe("Write-Output 'it''s'")
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
  for (const target of fake.targets) expect(target).toMatch(/^ http:\/\/127\.0\.0\.1:5000\/s3cret\/(rpc|wait)$/)
  const started = fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { args: string[] }> } }
  expect(started.config.mcp_servers.claude_session?.args.slice(1)).toEqual(['http://127.0.0.1:5000/s3cret', String(agent.msgKey)])
  done(fake)
})

test('the agent listing: sol is the default, luna for searches and easy work, astra and terra only when asked', () => {
  const defaults = effectiveDefaults({ codexPath: 'c', nodePath: 'n', defaultEffort: undefined, defaultSandbox: 'workspace-write', defaultApprovals: 'auto' }, {})
  expect(agentDescription('sol', defaults)).toContain('Default')
  expect(agentDescription('sol', defaults)).toContain('gpt-6.1-sol')
  expect(agentDescription('luna', defaults)).toContain('searches')
  for (const alias of ['astra', 'terra']) expect(agentDescription(alias, defaults)).toContain('ONLY when the user explicitly asks')
})

test('an older Codex CLI: each alias falls back to the newest model of its family; with none the error says to update', () => {
  // As codex-cli 0.153 lists them, newest first.
  const old = new Map(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5-luna'].map(id => [id, EFFORTS]))
  expect(['luna', 'sol', 'astra', 'terra'].map(alias => modelFor(old, alias))).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra'])
  // A current CLI lists the alias's own model, even behind a newer one of the family.
  expect(modelFor(new Map([['gpt-6.1-sol', EFFORTS], ['gpt-6-sol', EFFORTS]]), 'sol')).toBe('gpt-6.1-sol')
  expect(modelFor(new Map([['gpt-7-sol', EFFORTS], ['gpt-6.1-sol', EFFORTS]]), 'sol')).toBe('gpt-6.1-sol')
  // No family at all: the alias's own model, which modelEffortError refuses with the update advice.
  const none = new Map([['gpt-5.5', EFFORTS]])
  expect(modelFor(none, 'luna')).toBe('gpt-6-luna')
  expect(modelEffortError(none, 'gpt-6-luna', 'max')).toContain(UPDATE_HINT)
  expect(modelEffortError(none, 'some-model', 'max')).not.toContain(UPDATE_HINT)
  expect(aliasOf('gpt-5.6-luna')).toBe('luna')
  expect(aliasOf('gpt-6.1-sol')).toBe('sol')
  expect(aliasOf('o3')).toBe('o3')
})

test('a spawn on an older Codex CLI runs the family fallback and warns once to update', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  fake.models = [['gpt-5.6-luna', EFFORTS], ['gpt-5.6-sol', [...EFFORTS, 'ultra']]]
  await start($, fake)
  const first = await spawn($, fake, 'x')
  await spawn($, fake, 'y', { subagentType: 'codex:sol' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'thread/start').map(rpc => rpc.params.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol'])
  expect(first.model).toBe('gpt-5.6-luna')
  const warnings = fake.shown.filter(line => line.includes(UPDATE_HINT))
  expect(warnings).toEqual([
    `codex: this Codex CLI has no gpt-6-luna, so codex:luna runs gpt-5.6-luna. ${UPDATE_HINT}`,
    `toast: codex: this Codex CLI has no gpt-6-luna, so codex:luna runs gpt-5.6-luna. ${UPDATE_HINT}`,
  ])
  // The listing still names the intended model.
  expect(String(fake.registeredAgents[1]?.description)).toContain('gpt-6.1-sol')
  done(fake)
})

test('a spawn whose alias has no model of its family on this Codex CLI is refused with the update advice', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  fake.models = [['gpt-5.5', EFFORTS]]
  await start($, fake)
  const refused = await $.agent.spawn(spawnInput('x'))
  expect(refused.deny).toContain('Unknown Codex model "gpt-6-luna"')
  expect(refused.deny).toContain(UPDATE_HINT)
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
  expect(descriptions[0]).toContain('gpt-6-luna, effort max.')
  expect(descriptions[1]).toMatch(/^Default Codex agent for normal tasks/)
  expect(descriptions[1]).toContain('gpt-6.1-sol, effort high.')
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
  expect(String(fake.registeredAgents[0]?.description)).toContain('gpt-6-luna, effort medium.')
  await spawn($, fake, 'x')
  fake.files['/work/.claude/codex.json'] = JSON.stringify({ effort: 'low' })
  await spawn($, fake, 'y')
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start').map(rpc => rpc.params.effort)).toEqual(['medium', 'low'])
  const settings = { codexPath: 'c', nodePath: 'n', defaultEffort: undefined, defaultSandbox: 'workspace-write' as const, defaultApprovals: 'auto' as const }
  const builtIn = effectiveDefaults(settings, {})
  expect(['luna', 'sol', 'astra', 'terra'].map(alias => effortFor(builtIn, alias))).toEqual(['max', 'high', 'high', 'high'])
  expect(agentDescription('terra', builtIn)).toContain('gpt-5.6-terra, effort high.')
  done(fake)
})

test('after a reload the registry comes back from the store and live turns reattach', async ($, on) => {
  const base = {
    threadId: 'th-old', model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write', approvals: 'ask', cwd: '/work',
    currentTurnId: 'turn-9', lastTurnId: null, lastTurnStatus: null, lastMessage: '', activity: 'x', lastCommand: '',
    tokens: 0, error: null, digest: [], startedAt: 1, updatedAt: 1, turnStartedAt: 1, turnEndedAt: 0, sessionId: 's',
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
      ['codex_list', {}, 'abc w1 [gpt-6-luna/low, workspace-write, approvals auto] running 3s: thinking\ndef w2 [gpt-6-luna/low, workspace-write, approvals auto] idle 9s: completed', 'Codex(list)\n  ⎿  2 agents · 1 running'],
      ['codex_result', { id: 'w1' }, 'abc w1 [gpt-6-luna/low, workspace-write, approvals auto] idle 9s: completed\nFinal message:\nDONE BANANA\nmore', 'Codex(result w1)\n  ⎿  done · DONE BANANA'],
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
  await spawn($, fake)
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result)).toMatch(/^a1 Sleep a while \[gpt-6-luna\/max, workspace-write, approvals auto\] running/)
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'ALL GREEN', phase: 'final_answer' }] } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'Sleep a while' } as never)).result)).toContain('Final message:\nALL GREEN')
  done(fake)
})

test("codex_list shows this session's latest 10 jobs, newest first; codex_result reads any job", { timeoutMs: 20_000 }, async ($, on) => {
  const base = {
    model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write', approvals: 'auto', cwd: '/work', status: 'idle',
    currentTurnId: null, lastTurnId: 'turn-1', lastTurnStatus: 'completed', lastMessage: 'OLD RESULT', activity: 'completed', msgKey: 'k', outbox: [],
    tokens: 0, error: null, digest: [], updatedAt: 1, turnStartedAt: 1, turnEndedAt: 2, description: '',
  }
  const agents: Record<string, unknown> = {
    other: { ...base, id: 'other', name: 'elsewhere', threadId: 'th-x', startedAt: 99, sessionId: 'session-0' },
  }
  for (let i = 1; i <= 12; i += 1) agents[`j${i}`] = { ...base, id: `j${i}`, name: `job ${i}`, threadId: `th-${i}`, startedAt: i, sessionId: 'session-1' }
  const fake = fakeBridge(on, { agents })
  await start($, fake, { reattached: true })
  const listed = String((await $.tool.call({ tool: 'mcp__codex__codex_list' } as never)).result).split('\n')
  expect(listed).toHaveLength(11)
  expect(listed[0]).toMatch(/^j12 job 12 \[gpt-6-luna\/low, workspace-write, approvals auto\] idle 0s, 0 tok: completed$/)
  expect(listed[9]).toMatch(/^j3 job 3 /)
  expect(listed[10]).toBe('2 older (codex_result still reads them by id).')
  expect(String((await $.tool.call({ tool: 'mcp__codex__codex_result', id: 'other' } as never)).result)).toContain('Final message:\nOLD RESULT')
  expect(listText([], 'session-1', 0)).toContain('No Codex agents in this session')
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
