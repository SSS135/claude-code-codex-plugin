import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { approvalAnswer, approvalOptions, configDirs, effectiveDefaults, permissionsFor, WakeLedger, withoutRule } from '../hooks/model'

// A fake bridge: the relay's stdout is a queue the test pushes NDJSON into,
// and its HTTP endpoints are answered by an `http.fetch` hook.

type Rpc = { method: string; params: Record<string, unknown> }

type Fake = {
  argv: readonly string[]
  queue: string[]
  closed: boolean
  wake: () => void
  rpcs: Rpc[]
  replies: Record<string, unknown>[]
  waits: Record<string, unknown>[]
  submitted: string[]
  appended: string[]
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
  turnCount: number
  store: Record<string, unknown>
  clock: MockClock
}

// The kit has nothing beneath a plugin's $.session.append (a test hook does not
// see it either), so the plugin's call is rejected and it logs that: the log is
// how the test sees an append was made.
const APPEND_TRIED = 'codex: wake failed: HooksError: no implementation for session.append'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function fakeBridge(on: On, stored: Record<string, unknown> = {}, files: Record<string, string> = {}): Fake {
  const fake: Fake = {
    argv: [],
    queue: [],
    closed: false,
    wake: () => undefined,
    rpcs: [],
    replies: [],
    waits: [],
    submitted: [],
    appended: [],
    asked: [],
    askedOptions: [],
    files: { ...files },
    askAnswer: 'Allow once',
    waitAnswer: { status: 'completed', turn: { id: 'turn-1', status: 'interrupted', items: [] } },
    turnCount: 0,
    waitQueue: [],
    store: { ...stored },
    clock: mock.clock(on, { now: 1_000_000 }),
  }
  // The engine beneath the plugin.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codex__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work' }))
  on('fs.exists', (_$, e) => ({ value: e.path in fake.files }))
  on('fs.read', (_$, e) => (e.path in fake.files ? { value: fake.files[e.path] as string } : { deny: `no file ${e.path}` }))
  on('fs.write', (_$, e) => {
    fake.files[e.path] = e.text
    return { value: undefined }
  })
  mock.env(on, { HOME: '/home/u' })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    if (e.text === APPEND_TRIED) fake.appended.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

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
          data: [
            { id: 'gpt-6-luna', supportedReasoningEfforts: EFFORTS.map(reasoningEffort => ({ reasoningEffort })) },
            { id: 'gpt-6.1-sol', supportedReasoningEfforts: [...EFFORTS, 'ultra'].map(reasoningEffort => ({ reasoningEffort })) },
          ],
          nextCursor: null,
        }
      case 'thread/start':
        return { thread: { id: 'th-1' }, model: rpc.params.model }
      case 'turn/start':
        fake.turnCount += 1
        return { turn: { id: `turn-${fake.turnCount}` } }
      default:
        return {}
    }
  }

  on('http.fetch', (_$, e) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    let reply: unknown = { ok: true }
    if (path === '/rpc') {
      const rpc = { method: String(body.method), params: (body.params ?? {}) as Record<string, unknown> }
      fake.rpcs.push(rpc)
      reply = { result: answer(rpc) }
    }
    if (path === '/reply') fake.replies.push(body)
    if (path === '/wait') {
      fake.waits.push(body)
      reply = fake.waitQueue.shift() ?? fake.waitAnswer
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

  on('prompt.submit', (_$, e) => {
    fake.submitted.push(e.text)
    return { text: e.text }
  })



  return fake
}

const push = (fake: Fake, event: unknown) => {
  fake.queue.push(`${JSON.stringify(event)}\n`)
  fake.wake()
}

const note = (method: string, params: Record<string, unknown>) => ({ type: 'notification', method, params })

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

async function spawn($: Engine, fake: Fake) {
  const ran = await $.tool.call({ tool: 'mcp__codex__codex_spawn', prompt: 'sleep 20', model: 'luna', effort: 'low', name: 'w1' })
  expect(ran.deny).toBeUndefined()
  const agents = Object.values(await agentsOf(fake))
  return agents[0] as Record<string, unknown>
}

const CODEX_DEFAULT = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
const NODE_DEFAULT = '/opt/homebrew/bin/node'

test('configured binaries missing from disk fall back to node and codex on PATH', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(fake.argv[0]).toBe('node')
  expect(fake.argv[2]).toBe('codex')
})

test('spawns the bridge and folds its events into the registry', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, { [CODEX_DEFAULT]: '', [NODE_DEFAULT]: '' })
  await start($, fake)
  expect(fake.argv[0]).toBe(NODE_DEFAULT)
  expect(fake.argv[1]).toMatch(/bin\/bridge\.mjs$/)
  expect(fake.argv[2]).toBe(CODEX_DEFAULT)

  const agent = await spawn($, fake)
  expect(agent).toMatchObject({ name: 'w1', model: 'gpt-6-luna', effort: 'low', status: 'running', currentTurnId: 'turn-1' })
  const threadStart = fake.rpcs.find(rpc => rpc.method === 'thread/start')
  expect(threadStart?.params).toMatchObject({ model: 'gpt-6-luna', cwd: '/work/app', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', ephemeral: false })
  const turnStart = fake.rpcs.find(rpc => rpc.method === 'turn/start')
  expect(turnStart?.params).toMatchObject({ threadId: 'th-1', effort: 'low', sandboxPolicy: { type: 'workspaceWrite' } })

  push(fake, note('turn/started', { threadId: 'th-1', turn: { id: 'turn-1' } }))
  push(fake, note('item/started', { threadId: 'th-1', item: { type: 'commandExecution', command: "/bin/zsh -lc 'sleep 20'" } }))
  await until(fake, async () => (await agentsOf(fake))[String(agent.id)]?.activity === '$ sleep 20', 'activity')
  push(fake, note('item/completed', { threadId: 'th-1', item: { type: 'commandExecution', command: "/bin/zsh -lc 'sleep 20'", exitCode: 0, status: 'completed' } }))
  // A finished command no longer shows as the current activity.
  await until(fake, async () => (await agentsOf(fake))[String(agent.id)]?.activity === 'thinking', 'activity after the command')
  push(fake, note('item/completed', { threadId: 'th-1', item: { type: 'agentMessage', text: 'DONE', phase: 'final_answer' } }))
  push(fake, note('thread/tokenUsage/updated', { threadId: 'th-1', tokenUsage: { total: { totalTokens: 1234 } } }))
  await until(fake, async () => (await agentsOf(fake))[String(agent.id)]?.tokens === 1234, 'tokens')
  const after = (await agentsOf(fake))[String(agent.id)]
  expect(after?.digest).toEqual(['$ sleep 20 -> exit 0', 'answer: DONE'])
  expect(after?.lastMessage).toBe('DONE')
  fake.closed = true
  fake.wake()
})

test('rejects an effort the model does not take', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const ran = await $.tool.call({ tool: 'mcp__codex__codex_spawn', prompt: 'x', model: 'luna', effort: 'ultra' })
  expect(ran.deny).toContain('does not take effort "ultra"')
  fake.closed = true
  fake.wake()
})

test('codex_send steers a running turn and starts a new turn when idle', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const agent = await spawn($, fake)

  await $.tool.call({ tool: 'mcp__codex__codex_send', id: 'w1', message: 'also say BANANA' })
  const steer = fake.rpcs.find(rpc => rpc.method === 'turn/steer')
  expect(steer?.params).toMatchObject({ threadId: 'th-1', expectedTurnId: 'turn-1' })

  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => (await agentsOf(fake))[String(agent.id)]?.status === 'idle', 'idle')

  await $.tool.call({ tool: 'mcp__codex__codex_send', id: String(agent.id), message: 'next task' })
  const starts = fake.rpcs.filter(rpc => rpc.method === 'turn/start')
  expect(starts).toHaveLength(2)
  expect(starts[1]?.params).toMatchObject({ threadId: 'th-1', sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' })
  expect((await agentsOf(fake))[String(agent.id)]?.status).toBe('running')
  fake.closed = true
  fake.wake()
})

test('codex_stop interrupts the running turn', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  const ran = await $.tool.call({ tool: 'mcp__codex__codex_stop', id: 'w1' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/interrupt')?.params).toEqual({ threadId: 'th-1', turnId: 'turn-1' })
  expect(fake.waits[0]).toMatchObject({ threadId: 'th-1' })
  expect(ran.text ?? JSON.stringify(ran.result)).toContain('stopped (interrupted)')
  fake.closed = true
  fake.wake()
})

test('an approval asks the person and posts the reply; a dismissed dialog declines', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)

  push(fake, { type: 'request', id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', command: "/bin/zsh -lc 'touch /x'" } })
  await until(fake, async () => fake.replies.length === 1, 'first reply')
  expect(fake.asked[0]).toContain('Codex w1 (gpt-6-luna) wants to run: touch /x')
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
  await until(fake, async () => (Object.values(await agentsOf(fake))[0]?.digest as string[]).length === 5, 'review digest')
  expect(Object.values(await agentsOf(fake))[0]?.digest).toEqual([
    'approval: $ touch /x -> approved by user (once)',
    'approval: file change -> declined by user',
    'approval: $ ls -> approved by user (session)',
    'approval: $ touch /x -> approved by user (always: rule touch /x)',
    'approval: $ echo hi > ~/x -> auto-reviewer approved, low risk: benign',
  ])
  fake.closed = true
  fake.wake()
})

test('a finished agent wakes an idle session with prompt.submit and a busy one with session.append', { timeoutMs: 30_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const agent = await spawn($, fake)
  push(fake, note('item/completed', { threadId: 'th-1', item: { type: 'agentMessage', text: 'first result', phase: 'final_answer' } }))
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', items: [] } }))
  await until(fake, async () => fake.submitted.length === 1, 'prompt.submit')
  expect(fake.submitted[0]).toContain('Codex agent w1 (gpt-6-luna) finished: completed')
  expect(fake.submitted[0]).toContain('first result')
  expect(fake.appended).toHaveLength(0)

  // A wake during a main turn goes in by session.append, never by a prompt while the turn runs.
  // (The kit stores no plugin append, so the append fails here: at the turn's end the
  // notice is sent whole, once. The stored and read cases are the WakeLedger tests.)
  await $.tool.call({ tool: 'mcp__codex__codex_send', id: 'w1', message: 'again' })
  await $.turn.start({ text: 'working', turnId: 'main-1' })
  push(fake, note('turn/completed', { threadId: 'th-1', turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', text: 'second result', phase: 'final_answer' }] } }))
  await until(fake, async () => fake.appended.length === 1, 'session.append')
  expect(fake.submitted).toHaveLength(1)
  await $.turn.complete({ answer: 'noted', durationMs: 1, isAborted: false, turnId: 'main-1', reason: 'answer' })
  await until(fake, async () => fake.submitted.length === 2, 'resent wake')
  expect(fake.submitted[1]).toContain('second result')

  // The next turn ends with nothing owed: nothing is sent again.
  await $.turn.start({ text: 'more', turnId: 'main-2' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'main-2', reason: 'answer' })
  await fake.clock.settle()
  expect(fake.submitted).toHaveLength(2)
  fake.closed = true
  fake.wake()
})

test('codex_wait polls in slices under the 30 s fetch cap until the turn ends', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitQueue = [
    { status: 'timeout', turnId: 'turn-1' },
    { status: 'timeout', turnId: 'turn-1' },
    { status: 'completed', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'waited', phase: 'final_answer' }] } },
  ]
  const ran = await $.tool.call({ tool: 'mcp__codex__codex_wait', id: 'w1', timeoutSec: 3600 })
  expect(String(ran.result)).toContain('waited')
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([25_000, 25_000, 25_000])

  // A short wait is one poll of exactly that long, and reports the timeout.
  fake.waits = []
  fake.waitQueue = [{ status: 'timeout', turnId: 'turn-1' }]
  const short = await $.tool.call({ tool: 'mcp__codex__codex_wait', id: 'w1', timeoutSec: 10 })
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([10_000])
  expect(String(short.result)).toContain('Still running after 10s')
  fake.closed = true
  fake.wake()
})

test('the wake ledger delivers each notice exactly once', () => {
  const ledger = new WakeLedger()
  // Stored, then a model request began: read, nothing to send.
  ledger.settle(ledger.add('a', 'A done'), true)
  ledger.step()
  expect(ledger.flush()).toBeNull()
  // Stored after the last request: pointed to once, never resent whole.
  ledger.settle(ledger.add('b', 'B done'), true)
  expect(ledger.flush()).toContain('Codex agent b finished while your last turn was ending')
  expect(ledger.flush()).toBeNull()
  // The append failed: sent whole, once.
  ledger.settle(ledger.add('c', 'C done'), false)
  ledger.step()
  expect(ledger.flush()).toBe('C done')
  expect(ledger.flush()).toBeNull()
  // A step before the append settled does not count as read.
  const index = ledger.add('d', 'D done')
  ledger.step()
  ledger.settle(index, true)
  expect(ledger.flush()).toContain('agent d finished')
})

test('permissions: auto by default, yolo forces full access and refuses a contradicting sandbox', () => {
  const settings = { codexPath: 'c', nodePath: 'n', defaultModel: 'gpt-6.1-sol', defaultEffort: 'high', defaultSandbox: 'workspace-write' as const, defaultApprovals: 'auto' as const }
  const defaults = effectiveDefaults(settings, {})
  expect(defaults).toEqual({ model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write', approvals: 'auto' })
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
})

test('yolo on request runs with no sandbox and no approvals', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const ran = await $.tool.call({ tool: 'mcp__codex__codex_spawn', prompt: 'x', model: 'luna', effort: 'low', approvals: 'yolo' })
  expect(ran.deny).toBeUndefined()
  expect(fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/start')?.params).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' })
  fake.closed = true
  fake.wake()
})

test('project config: args > .claude/codex.json (nearest up to the root) > userConfig', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, { '/work/.claude/codex.json': JSON.stringify({ model: 'luna', effort: 'medium', approvals: 'yolo' }) })
  await start($, fake)
  // Project defaults apply: luna, medium, yolo (so full access).
  await $.tool.call({ tool: 'mcp__codex__codex_spawn', prompt: 'x', name: 'p1' })
  expect(fake.rpcs.find(rpc => rpc.method === 'thread/start')?.params).toMatchObject({ model: 'gpt-6-luna', sandbox: 'danger-full-access', approvalPolicy: 'never' })
  expect(fake.rpcs.find(rpc => rpc.method === 'turn/start')?.params).toMatchObject({ effort: 'medium' })
  // Arguments win over the project.
  await $.tool.call({ tool: 'mcp__codex__codex_spawn', prompt: 'y', name: 'p2', effort: 'low', approvals: 'ask', sandbox: 'read-only' })
  const second = fake.rpcs.filter(rpc => rpc.method === 'thread/start')[1]
  expect(second?.params).toMatchObject({ model: 'gpt-6-luna', sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' })
  expect(fake.rpcs.filter(rpc => rpc.method === 'turn/start')[1]?.params).toMatchObject({ effort: 'low' })
  // A broken config is reported, not ignored.
  fake.files['/work/.claude/codex.json'] = '{"sandbox": "everything"}'
  const ran = await $.tool.call({ tool: 'mcp__codex__codex_spawn', prompt: 'z' })
  expect(ran.deny).toContain('sandbox must be one of')
  fake.closed = true
  fake.wake()
})

test('/codex rules lists and removes Codex allow rules', async ($, on) => {
  const path = '/home/u/.codex/rules/default.rules'
  const text = 'prefix_rule(pattern=["touch", "/x"], decision="allow")\nprefix_rule(pattern=["ls"], decision="allow")\n'
  const fake = fakeBridge(on, {}, { [path]: text })
  await start($, fake)
  const presentation = { isFullscreen: false, columns: 120 }
  const origin = { kind: 'plugin' as const, name: 'test' }
  const listed = await $.command.run({ command: 'codex', args: 'rules', origin, presentation })
  expect(listed.text).toContain('1. prefix_rule(pattern=["touch", "/x"]')
  expect(listed.text).toContain('2. prefix_rule(pattern=["ls"]')
  const removed = await $.command.run({ command: 'codex', args: 'rules rm 1', origin, presentation })
  expect(removed.text).toContain('Removed prefix_rule(pattern=["touch", "/x"]')
  expect(fake.files[path]).toBe('prefix_rule(pattern=["ls"], decision="allow")\n')
  expect((await $.command.run({ command: 'codex', args: 'rules rm 5', origin, presentation })).text).toContain('No rule 5')
  expect(withoutRule(text, 0)).toBeNull()
  fake.closed = true
  fake.wake()
})

test('after a reload the registry comes back from the store and live turns reattach', async ($, on) => {
  const base = {
    threadId: 'th-old', model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write', approvals: 'ask', cwd: '/work',
    currentTurnId: 'turn-9', lastTurnId: null, lastTurnStatus: null, lastMessage: '', activity: 'x', lastCommand: '',
    tokens: 0, error: null, digest: [], notify: true, startedAt: 1, updatedAt: 1, turnStartedAt: 1, turnEndedAt: 0, sessionId: 's',
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
  await $.tool.call({ tool: 'mcp__codex__codex_send', id: 'lost', message: 'continue' })
  const methods = fake.rpcs.map(rpc => rpc.method)
  expect(methods).toEqual(['thread/resume', 'turn/start'])
  expect(fake.rpcs[0]?.params).toMatchObject({ threadId: 'th-lost', sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  fake.closed = true
  fake.wake()
})

test('the pane draws on terminal and desktop', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const agent = await spawn($, fake)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'codex',
      surface,
      component: 'Pane',
      requestId: 'codex',
      props: { title: 'Codex agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await pane.find({ key: `pick-${agent.id}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /gpt-6-luna\/low/ })).toBeDefined()
    await pane.press({ key: 'result' })
    expect(await pane.find({ key: 'stop' })).toBeDefined()
    await pane.unmount()

  }
  fake.closed = true
  fake.wake()
})
