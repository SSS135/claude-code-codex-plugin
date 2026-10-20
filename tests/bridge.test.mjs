// Run with: node --test tests/bridge.test.mjs
// The daemon over a fake `codex app-server` that echoes the notifications a `test/emit` request carries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writerStatus } from '../bin/writer-owner.mjs'

const BRIDGE = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url))
const HOLD_MS = 300
const FAKE_CODEX = `#!/usr/bin/env node
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const threads = new Map()
const calls = []
const config = new Map()
const mcp = new Map()
const mcpDir = process.env.CODEX_BRIDGE_FIXTURE_MCP_DIR
const loaded = id => {
  if (!mcpDir || mcp.has(id)) return
  const ready = path.join(mcpDir, 'mcp-' + mcp.size)
  // A real isolated process, never a configured/live MCP or model provider.
  const script = 'const fs = require("node:fs"); ' + (process.env.CODEX_BRIDGE_FIXTURE_MCP_STUBBORN ? 'process.on("SIGTERM", () => {}); ' : '') + 'fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)'
  const child = spawn(process.execPath, ['-e', script, ready], { stdio: 'ignore' })
  mcp.set(id, child)
  child.on('exit', () => { if (mcp.get(id) === child) mcp.delete(id) })
}
let serial = 0
const state = id => {
  if (!threads.has(id)) threads.set(id, { id, status: { type: 'idle' }, turns: [] })
  return threads.get(id)
}
const emit = note => {
  const p = note.params ?? {}
  if (note.method === 'turn/started') { loaded(p.threadId); state(p.threadId).turns = [{ ...p.turn, status: 'inProgress' }]; state(p.threadId).status = { type: 'active' } }
  if (note.method === 'turn/completed') {
    const thread = state(p.threadId)
    const current = thread.turns.at(-1)
    if (!current || current.id === p.turn.id) { thread.turns = [p.turn]; thread.status = { type: 'idle' } }
  }
  if (note.method.startsWith('item/') && state(p.threadId).turns.at(-1)?.id === p.turnId && ['failed', 'inProgress'].includes(state(p.threadId).turns.at(-1)?.status)) { state(p.threadId).turns.at(-1).status = 'inProgress'; state(p.threadId).status = { type: 'active' } }
  send(note)
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const { method, params = {} } = message
  calls.push({ method, params })
  if (method === 'test/emit') params.messages.forEach(emit)
  if (method === 'test/config') config.set(params.method, params)
  const configured = config.get(method) ?? {}
  const fail = configured.failures > 0
  if (fail) configured.failures -= 1
  let result = {}
  if (method === 'test/calls') result = calls.filter(call => call.method === params.method)
  if (method === 'test/process-count') result = { count: [...mcp.values()].filter(child => child.exitCode === null && child.signalCode === null).length }
  if (method === 'test/state') { Object.assign(state(params.threadId), params.thread); result = { ok: true } }
  if (method === 'thread/read') result = { thread: state(params.threadId) }
  if (method === 'thread/resume') { if (!fail) loaded(params.threadId); result = { thread: state(params.threadId) } }
  if (method === 'thread/start') { const id = 'created-' + ++serial; if (!fail) loaded(id); result = { thread: state(id), model: 'fixture-model' } }
  if (method === 'turn/interrupt' && !fail && configured.endTurn) {
    const current = state(params.threadId).turns.at(-1)
    if (current?.id === params.turnId) setTimeout(() => emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...current, status: 'interrupted', items: [] } } }), configured.endDelayMs ?? 0)
  }
  if (method === 'turn/start' && !fail) {
    const turn = { id: 'started-' + ++serial, status: 'inProgress', items: [] }
    state(params.threadId).turns = [turn]
    state(params.threadId).status = { type: 'active' }
    result = { turn }
    if (configured.completeBeforeReply) {
      emit({ method: 'turn/started', params: { threadId: params.threadId, turn } })
      emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: 'completed' } } })
    }
  }
  if (method === 'thread/resume' && !fail && configured.completeBeforeReply) {
    const turn = state(params.threadId).turns.at(-1)
    if (turn) emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: 'completed' } } })
  }
  if (method === 'thread/unsubscribe') {
    result = { status: 'unsubscribed' }
    // Acknowledgement precedes the app-server's asynchronous MCP unload.
    if (!fail) setTimeout(() => mcp.get(params.threadId)?.kill(), (configured.delayMs ?? 0) + 30)
  }
  setTimeout(() => send(fail ? { id: message.id, error: { code: -32099, message: 'fixture rejection' } } : { id: message.id, result }), configured.delayMs ?? 0)
}).on('close', () => process.exit(0))
`

const call = (address, method, urlPath, body) => new Promise((resolve, reject) => {
  // http.request(url, options) takes a URL first; a Unix socket goes in the options alone.
  const req = http.request(...(address.startsWith('http') ? [new URL(address + urlPath), { method }] : [{ socketPath: address, path: urlPath, method }]), res => {
    let data = ''
    res.on('data', chunk => (data += chunk))
    res.on('end', () => resolve(JSON.parse(data)))
  })
  req.on('error', reject)
  req.end(body === undefined ? undefined : JSON.stringify(body))
})

const note = (method, params) => ({ method, params })
const turn = (threadId, id, status, extra = {}) => note('turn/completed', { threadId, turn: { id, status, items: [], ...extra } })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fixture = async ({ mcp = false, stubborn = false, idleMs } = {}) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const dir = path.join(base, 'd-1')
  fs.mkdirSync(dir)
  const fake = path.join(base, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const mcpDir = path.join(base, 'processes')
  if (mcp) fs.mkdirSync(mcpDir)
  const daemon = spawn(process.execPath, [BRIDGE, '--daemon', fake, dir], {
    stdio: 'ignore', windowsHide: true, env: { ...process.env, CODEX_BRIDGE_FAILED_HOLD_MS: String(HOLD_MS), CODEX_BRIDGE_RELEASE_RETRY_MS: '80', CODEX_BRIDGE_ABANDONED_OPERATION_MS: '500', ...(mcp ? { CODEX_BRIDGE_FIXTURE_MCP_DIR: mcpDir } : {}), ...(stubborn ? { CODEX_BRIDGE_FIXTURE_MCP_STUBBORN: '1' } : {}), ...(idleMs ? { CODEX_BRIDGE_IDLE_MS: String(idleMs), CODEX_BRIDGE_IDLE_CHECK_MS: '25' } : {}) },
  })
  // A subscriber prevents the normal 20 s orphan-daemon grace during slow RPC tests.
  let events
  try {
    const file = path.join(dir, 's')
    let address = ''
    for (let i = 0; i < 100 && !address; i += 1) {
      await sleep(30)
      try {
        const candidate = process.platform === 'win32' ? fs.readFileSync(file, 'utf8') : file
        if ((await call(candidate, 'GET', '/health')).ok) address = candidate
      } catch {}
    }
    assert.ok(address, 'the daemon did not start')
    events = http.get(...(address.startsWith('http') ? [new URL(address + '/events')] : [{ socketPath: address, path: '/events' }]), res => res.resume())
    const post = (endpoint, body) => call(address, 'POST', endpoint, body)
    const rpc = (method, params) => post('/rpc', { method, params })
    return {
      address, post, rpc, mcpDir,
      stopped: () => daemon.exitCode !== null || daemon.signalCode !== null,
      emit: messages => rpc('test/emit', { messages }),
      calls: async method => (await rpc('test/calls', { method })).result,
      config: (method, extra) => rpc('test/config', { method, ...extra }),
      state: threadId => post('/thread-state', { threadId }),
      wait: (threadId, timeoutMs, turnId) => post('/wait', { threadId, timeoutMs, turnId }),
      stop: async () => { events.destroy(); daemon.kill(); if (daemon.exitCode === null && daemon.signalCode === null) await new Promise(resolve => daemon.once('exit', resolve)) },
      close: async () => { events.destroy(); daemon.kill(); if (daemon.exitCode === null && daemon.signalCode === null) await new Promise(resolve => daemon.once('exit', resolve)); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }) },
    }
  } catch (error) {
    events?.destroy(); daemon.kill(); await sleep(150); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); throw error
  }
}

const until = async (work, check, message) => {
  for (let i = 0; i < 150; i += 1) { const value = await work(); if (check(value)) return value; await sleep(20) }
  assert.fail(message)
}

test('a failed turn end is held back and dropped when the thread works on; a real failure ends after the hold', async () => {
  const f = await fixture()
  try {
    const { emit, wait } = f
    const capacity = { message: 'Selected model is at capacity. Please try a different model.' }

    // Codex reports the turn failed, then works on in it: the failure never reaches a waiter.
    await emit([
      note('turn/started', { threadId: 'th-1', turn: { id: 't1' } }),
      note('error', { threadId: 'th-1', turnId: 't1', willRetry: false, error: capacity }),
      turn('th-1', 't1', 'failed', { error: capacity }),
      note('item/started', { threadId: 'th-1', turnId: 't1', item: { type: 'commandExecution', command: 'blender -b' } }),
    ])
    assert.equal((await wait('th-1', HOLD_MS * 3)).status, 'timeout')
    await emit([turn('th-1', 't1', 'completed')])
    assert.equal((await wait('th-1', 1000)).turn.status, 'completed')

    // A delayed item cannot revive an acknowledged terminal turn.
    await emit([note('item/started', { threadId: 'th-1', turnId: 't1', item: { type: 'reasoning' } })])
    assert.deepEqual((await call(f.address, 'GET', '/health')).active, {})

    // A failure with no work after it ends the turn once the hold passes.
    const startedAt = Date.now()
    await emit([note('turn/started', { threadId: 'th-2', turn: { id: 't2' } }), turn('th-2', 't2', 'failed', { error: capacity })])
    const failed = await wait('th-2', 5000)
    assert.deepEqual([failed.status, failed.turn.status, failed.turn.error], ['completed', 'failed', capacity])
    assert.ok(Date.now() - startedAt >= HOLD_MS - 50)
  } finally { await f.close() }
})

test('a relay whose Codex CLI does not run says so and what to do in its first line, then exits 1', async () => {
  const relay = spawn(process.execPath, [BRIDGE, path.join(os.tmpdir(), 'no-such-codex-cli'), 'relaytest'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let stdout = ''
  relay.stdout.on('data', chunk => (stdout += chunk))
  const code = await new Promise(resolve => relay.on('exit', resolve))
  const first = JSON.parse(stdout.split('\n')[0])
  assert.equal(code, 1)
  assert.equal(first.type, 'fatal')
  assert.match(first.message, /cannot run the Codex CLI .*no-such-codex-cli/)
  assert.match(first.message, /npm i -g @openai\/codex@latest/)
})

test('old completions and items neither clear a new turn nor settle its exact waiter', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'old' } }), note('turn/started', { threadId: 'thread', turn: { id: 'new' } })])
    const waiting = f.wait('thread', 220, 'new')
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'old' } }), turn('thread', 'old', 'completed'), note('item/started', { threadId: 'thread', turnId: 'old', item: { type: 'reasoning' } })])
    assert.equal((await waiting).status, 'timeout')
    assert.equal((await f.state('thread')).activeTurnId, 'new')
    await f.emit([turn('thread', 'new', 'completed')])
    assert.equal((await f.wait('thread', 500, 'new')).turn.id, 'new')
    assert.equal((await f.wait('thread', 500, 'old')).turn.id, 'old')
  } finally { await f.close() }
})

test('failed-turn holds are exact and a durable failure is released after server reconciliation', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'old' } }), turn('thread', 'old', 'failed'), note('turn/started', { threadId: 'thread', turn: { id: 'new' } })])
    assert.equal((await f.wait('thread', 1000, 'old')).turn.status, 'failed')
    assert.equal((await f.state('thread')).activeTurnId, 'new')
    assert.equal((await f.calls('thread/unsubscribe')).length, 0)
    await f.emit([turn('thread', 'new', 'failed')])
    assert.equal((await f.wait('thread', 1000, 'new')).turn.status, 'failed')
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'durable failure was not released')
    assert.equal((await f.calls('thread/unsubscribe')).length, 1)
  } finally { await f.close() }
})

test('failed recovery stays loaded while active then releases when its recovered turn ends', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'turn' } }), turn('thread', 'turn', 'failed'), note('item/started', { threadId: 'thread', turnId: 'turn', item: { type: 'reasoning' } })])
    assert.equal((await f.wait('thread', HOLD_MS * 2, 'turn')).status, 'timeout')
    assert.equal((await f.calls('thread/unsubscribe')).length, 0)
    await f.emit([turn('thread', 'turn', 'completed')])
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'recovered completion was not released')
  } finally { await f.close() }
})

test('rejected unsubscribe remains pending and a late ACK serializes a new load/start', async () => {
  const f = await fixture()
  try {
    await f.config('thread/unsubscribe', { failures: 1, delayMs: 250 })
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'first' } }), turn('thread', 'first', 'completed')])
    await until(() => f.calls('thread/unsubscribe'), calls => calls.length === 1, 'first unsubscribe did not start')
    await sleep(270)
    assert.equal((await f.state('thread')).status, 'releasePending')
    await until(() => f.calls('thread/unsubscribe'), calls => calls.length === 2, 'rejected unsubscribe was not retried')
    const resumed = await f.post('/operation', { id: 'load', method: 'thread/resume', params: { threadId: 'thread' } })
    assert.equal(resumed.status, 'pending')
    assert.equal((await f.calls('thread/resume')).length, 0, 'resume must wait behind uncertain unsubscribe')
    const completed = await f.post('/operation/poll', { id: 'load', timeoutMs: 1000 })
    assert.equal(completed.status, 'completed')
    await f.post('/operation/ack', { id: 'load' })
    await f.rpc('turn/start', { threadId: 'thread' })
    await sleep(200)
    assert.equal((await f.state('thread')).status, 'loaded')
    assert.ok((await f.state('thread')).activeTurnId)
    assert.equal((await f.calls('thread/unsubscribe')).length, 2, 'old release cannot unsubscribe a new active turn')
  } finally { await f.close() }
})

test('retained operations dedupe after cancelled HTTP polls and clean up an unclaimed late start', async () => {
  const f = await fixture()
  try {
    await f.config('thread/start', { delayMs: 250 })
    const body = { id: 'spawn', method: 'thread/start', params: { model: 'fixture' } }
    assert.equal((await f.post('/operation', body)).status, 'pending')
    const req = http.request(...(f.address.startsWith('http') ? [new URL(f.address + '/operation/poll'), { method: 'POST' }] : [{ socketPath: f.address, path: '/operation/poll', method: 'POST' }]))
    req.on('error', () => {})
    req.end(JSON.stringify({ id: 'spawn', timeoutMs: 1000 }))
    await sleep(40)
    req.destroy()
    assert.equal((await f.post('/operation', body)).status, 'pending')
    const answer = await f.post('/operation/poll', { id: 'spawn', timeoutMs: 1000 })
    assert.equal(answer.status, 'completed')
    assert.equal((await f.calls('thread/start')).length, 1)
    const mismatch = await f.post('/operation', { ...body, params: { model: 'other' } })
    assert.equal(mismatch.error.code, -32602)
    await until(() => f.state(answer.result.thread.id), state => state.status === 'unsubscribed', 'abandoned late start stayed subscribed')
    assert.equal((await f.post('/operation', body)).result.thread.id, answer.result.thread.id, 'original job still owns its late thread binding exactly once')
  } finally { await f.close() }
})

test('turn admission atomically resumes after an unsubscribe already started', async () => {
  const f = await fixture()
  try {
    await f.config('thread/unsubscribe', { delayMs: 250 })
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'first' } }), turn('thread', 'first', 'completed')])
    await until(() => f.calls('thread/unsubscribe'), calls => calls.length === 1, 'unsubscribe never started')
    const body = { id: 'next-turn', method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'fixture' }] }, resumeParams: { threadId: 'thread', excludeTurns: true } }
    await f.post('/operation', body)
    const answer = await f.post('/operation/poll', { id: body.id, timeoutMs: 1000 })
    assert.equal(answer.status, 'completed')
    assert.equal((await f.calls('thread/resume')).length, 1)
    assert.equal((await f.calls('turn/start')).length, 1)
    assert.equal((await f.state('thread')).activeTurnId, answer.result.turn.id)
    const mismatch = await f.post('/operation', { ...body, resumeParams: { ...body.resumeParams, excludeTurns: false } })
    assert.equal(mismatch.error.code, -32602, 'resume envelope is part of operation identity')
    await f.post('/operation/ack', { id: body.id })
    await sleep(150)
    assert.equal((await f.calls('thread/unsubscribe')).length, 1)
  } finally { await f.close() }
})

test('admission while release reads server state cancels unsubscribe, including a rejected turn', async () => {
  const f = await fixture()
  try {
    await f.config('thread/read', { delayMs: 250 })
    await f.config('turn/start', { failures: 1 })
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'first' } }), turn('thread', 'first', 'completed')])
    await until(() => f.calls('thread/read'), calls => calls.length >= 1, 'release read never started')
    await f.post('/operation', { id: 'rejected-turn', method: 'turn/start', params: { threadId: 'thread' }, resumeParams: { threadId: 'thread' } })
    const answer = await f.post('/operation/poll', { id: 'rejected-turn', timeoutMs: 1000 })
    assert.equal(answer.error.code, -32099)
    assert.equal((await f.calls('thread/unsubscribe')).length, 0, 'pending admission must fence a read already in progress')
    await f.post('/operation/ack', { id: 'rejected-turn' })
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'rejected admission lost prior terminal cleanup')
  } finally { await f.close() }
})

test('completion before a delayed start response still releases after all operation ACKs', async () => {
  const f = await fixture()
  try {
    await f.config('turn/start', { delayMs: 250, completeBeforeReply: true })
    await f.post('/operation', { id: 'fast-turn', method: 'turn/start', params: { threadId: 'thread' }, resumeParams: { threadId: 'thread' } })
    const answer = await f.post('/operation/poll', { id: 'fast-turn', timeoutMs: 1000 })
    assert.equal(answer.status, 'completed')
    await f.post('/operation/ack', { id: 'fast-turn' })
    assert.equal((await f.wait('thread', 100, answer.result.turn.id)).turn.status, 'completed')
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'early terminal completion lost cleanup after response/ACK')
    assert.equal((await f.calls('thread/unsubscribe')).length, 1)
  } finally { await f.close() }
})

test('completion during delayed resume is preserved and released after the resume ACK', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'resuming-turn' } })])
    await f.config('thread/resume', { delayMs: 250, completeBeforeReply: true })
    await f.post('/operation', { id: 'late-resume', method: 'thread/resume', params: { threadId: 'thread' } })
    const answer = await f.post('/operation/poll', { id: 'late-resume', timeoutMs: 1000 })
    assert.equal(answer.status, 'completed')
    await f.post('/operation/ack', { id: 'late-resume' })
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'late resume response erased terminal cleanup')
  } finally { await f.close() }
})

test('queued turn admissions cannot start twice, and an unbound outcome remains discoverable', async () => {
  const f = await fixture()
  try {
    await f.config('turn/start', { delayMs: 150 })
    await f.post('/operation', { id: 'first-admission', method: 'turn/start', params: { threadId: 'thread' } })
    assert.equal((await f.state('thread')).pendingOperationId, 'first-admission')
    await f.post('/operation', { id: 'second-admission', method: 'turn/start', params: { threadId: 'thread' } })
    const first = await f.post('/operation/poll', { id: 'first-admission', timeoutMs: 1000 })
    const second = await f.post('/operation/poll', { id: 'second-admission', timeoutMs: 1000 })
    assert.equal(first.status, 'completed')
    assert.equal(second.error.code, -32006)
    assert.equal(second.error.data.kind, 'activeTurn')
    assert.equal((await f.calls('turn/start')).length, 1)
    assert.equal((await f.state('thread')).pendingOperationId, 'first-admission')
    await f.emit([turn('thread', first.result.turn.id, 'completed')])
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'terminal unbound turn was not released')
    assert.equal((await f.state('thread')).pendingOperationId, 'first-admission', 'release compaction must retain binding ownership')
    await f.post('/operation/ack', { id: 'first-admission' })
    assert.equal((await f.state('thread')).pendingOperationId, undefined)
  } finally { await f.close() }
})

test('/wait reconciles lost exact-turn terminal notifications and schedules release', async () => {
  const f = await fixture()
  try {
    for (const status of ['completed', 'failed', 'interrupted']) {
      const threadId = 'missed-' + status
      const turnId = 'turn-' + status
      await f.emit([note('turn/started', { threadId, turn: { id: turnId } })])
      // Change authoritative server state without delivering a notification.
      await f.rpc('test/state', { threadId, thread: { status: { type: 'idle' }, turns: [{ id: turnId, status, completedAt: 1, items: [] }] } })
      const answer = await f.wait(threadId, 1200, turnId)
      assert.equal(answer.status, 'completed')
      assert.equal(answer.turn.status, status)
      await until(() => f.state(threadId), state => state.status === 'unsubscribed', 'wait reconciliation lost terminal cleanup')
    }
    assert.equal((await f.calls('thread/unsubscribe')).length, 3)
  } finally { await f.close() }
})

test('/wait does not turn transient native history projections into interruptions or overwrite held failures', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'turn' } })])
    await f.rpc('test/state', { threadId: 'thread', thread: { status: { type: 'idle' }, turns: [{ id: 'turn', status: 'interrupted', completedAt: null, items: [] }] } })
    assert.equal((await f.wait('thread', 120, 'turn')).status, 'timeout', 'a history projection without a completion receipt must not end a live turn')
    await f.emit([turn('thread', 'turn', 'failed')])
    // Even a conflicting snapshot cannot overwrite an explicit failed event
    // while its exact-turn recovery observation is still pending.
    await f.rpc('test/state', { threadId: 'thread', thread: { status: { type: 'idle' }, turns: [{ id: 'turn', status: 'interrupted', completedAt: 1, items: [] }] } })
    assert.equal((await f.wait('thread', 1000, 'turn')).turn.status, 'failed')
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'reconciled native failure did not release')
  } finally { await f.close() }
})

test('permanent cleanup failures remain owned until the globally idle daemon shuts down', async () => {
  const f = await fixture({ idleMs: 300 })
  try {
    await f.config('thread/unsubscribe', { failures: 1000 })
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'turn' } }), turn('thread', 'turn', 'completed')])
    await until(() => f.calls('thread/unsubscribe'), calls => calls.length >= 2, 'cleanup did not retry before the idle window')
    assert.equal((await f.state('thread')).status, 'releasePending', 'a rejection must not lose cleanup ownership')
    await until(async () => f.stopped(), Boolean, 'cleanup-only requests prevented the daemon idle backstop')
  } finally { await f.close() }
})

test('idle shutdown cannot interrupt a pending foreground admission with no turn notification yet', async () => {
  const f = await fixture({ idleMs: 250 })
  try {
    await f.config('turn/start', { delayMs: 700 })
    await f.post('/operation', { id: 'idle-protected-admission', method: 'turn/start', params: { threadId: 'thread' } })
    await sleep(400)
    assert.equal(f.stopped(), false, 'a pending admission owns the daemon even before turn/started')
    assert.equal((await f.state('thread')).pendingOperationId, 'idle-protected-admission')
    const answer = await f.post('/operation/poll', { id: 'idle-protected-admission', timeoutMs: 1000 })
    assert.equal(answer.status, 'completed')
    assert.equal((await f.state('thread')).activeTurnId, answer.result.turn.id)
    await f.post('/operation/ack', { id: 'idle-protected-admission' })
    await sleep(350)
    assert.equal(f.stopped(), false, 'an active turn must protect daemon lifetime')
  } finally { await f.close() }
})

test('isolated MCP processes return to baseline after success, failure and interruption cycles', async () => {
  const f = await fixture({ mcp: true })
  const count = async () => (await f.rpc('test/process-count')).result.count
  try {
    const baseline = await count()
    assert.equal(baseline, 0)
    for (const status of ['completed', 'failed', 'interrupted', 'completed', 'failed']) {
      await f.rpc('thread/resume', { threadId: 'mcp-cycle' })
      assert.equal(await count(), baseline + 1, 'the fixture must actually load a real MCP child before ending a turn')
      const turnId = 'cycle-' + (await f.calls('thread/resume')).length
      await f.emit([note('turn/started', { threadId: 'mcp-cycle', turn: { id: turnId } }), turn('mcp-cycle', turnId, status)])
      assert.equal((await f.wait('mcp-cycle', 1200, turnId)).turn.status, status)
      await until(count, value => value === baseline, 'MCP process count did not return to baseline')
    }
    assert.equal((await f.calls('thread/unsubscribe')).length, 5)
  } finally { await f.close() }
})

test('daemon shutdown kills its app-server process group including a stubborn MCP child', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture({ mcp: true, stubborn: true })
  try {
    await f.rpc('thread/resume', { threadId: 'shutdown-fixture' })
    const children = await until(async () => fs.readdirSync(f.mcpDir).map(name => Number(fs.readFileSync(path.join(f.mcpDir, name), 'utf8'))), ids => ids.length === 1, 'fixture MCP child never became ready')
    const running = pid => {
      try {
        // An unreaped zombie has exited and holds no MCP runtime/resources.
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
      } catch (error) {
        if (error.code === 'ENOENT') return false
        try { process.kill(pid, 0); return true } catch { return false }
      }
    }
    assert.equal(children.every(running), true, 'the shutdown fixture must contain a live child')
    await f.stop()
    await until(async () => children.some(running), value => !value, 'a fixture MCP process survived daemon shutdown')
  } finally { await f.close() }
})

test('35–90 second resumes complete through short polls without a second resume', async () => {
  const f = await fixture()
  try {
    const cases = [{ id: 'resume-35', threadId: 'slow-35', delayMs: 35_000 }, { id: 'resume-90', threadId: 'slow-90', delayMs: 90_000 }]
    for (const one of cases) {
      await f.config('thread/resume', { delayMs: one.delayMs })
      await f.post('/operation', { id: one.id, method: 'thread/resume', params: { threadId: one.threadId } })
      assert.equal((await f.state(one.threadId)).operationId, one.id)
    }
    await Promise.all(cases.map(async one => {
      let result
      do { result = await f.post('/operation/poll', { id: one.id, timeoutMs: 20_000 }) } while (result.status === 'pending')
      assert.equal(result.result.thread.id, one.threadId)
      await f.post('/operation/ack', { id: one.id })
    }))
    assert.equal((await f.calls('thread/resume')).length, 2)
    assert.equal((await f.state('slow-35')).status, 'loaded')
    assert.equal((await f.state('slow-90')).status, 'loaded')
  } finally { await f.close() }
})

test('an interrupted notification cannot end ownership while native work continues', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'turn' } }), turn('thread', 'turn', 'interrupted'),
      note('item/started', { threadId: 'thread', turnId: 'turn', item: { type: 'commandExecution', command: 'fixture' } })])
    // Model the real app-server's continued active state after reporting aborted.
    await f.rpc('test/state', { threadId: 'thread', thread: { status: { type: 'active' }, turns: [{ id: 'turn', status: 'inProgress' }] } })
    assert.equal((await f.wait('thread', HOLD_MS * 3, 'turn')).status, 'timeout')
    assert.equal((await f.state('thread')).activeTurnId, 'turn')
    assert.equal((await f.calls('thread/unsubscribe')).length, 0)
    await f.emit([turn('thread', 'turn', 'completed')])
    assert.equal((await f.wait('thread', 1000, 'turn')).turn.status, 'completed')
  } finally { await f.close() }
})

test('stop retries are bounded, an ACK alone stays running, and a late admitted turn is interrupted', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'turn' } })])
    assert.equal((await f.post('/interrupt', { threadId: 'thread', turnId: 'turn' })).status, 'stillRunning')
    assert.equal((await f.calls('turn/interrupt')).length, 3)
    assert.equal((await f.state('thread')).activeTurnId, 'turn')
    await f.post('/interrupt', { threadId: 'thread', turnId: 'turn' })
    assert.equal((await f.calls('turn/interrupt')).length, 3)
    await f.emit([turn('thread', 'turn', 'interrupted')])
    assert.equal((await f.wait('thread', 1000, 'turn')).turn.status, 'interrupted')
    assert.equal((await f.post('/interrupt', { threadId: 'thread', turnId: 'turn' })).status, 'completed')

    await f.config('turn/start', { delayMs: 2500 })
    await f.config('turn/interrupt', { endTurn: true })
    await f.post('/operation', { id: 'late-start-stop', method: 'turn/start', params: { threadId: 'late' } })
    assert.equal((await f.post('/interrupt', { threadId: 'late' })).status, 'stillRunning')
    const answer = await f.post('/operation/poll', { id: 'late-start-stop', timeoutMs: 5000 })
    const ended = await f.wait('late', 5000, answer.result.turn.id)
    assert.equal(ended.turn.status, 'interrupted')
    assert.equal((await f.calls('turn/start')).length, 1)
    assert.ok((await f.calls('turn/interrupt')).some(call => call.params.threadId === 'late' && call.params.turnId === answer.result.turn.id))
  } finally { await f.close() }
})

test('stop recovers from a refused interrupt and confirms the native terminal outcome', async () => {
  const f = await fixture()
  try {
    await f.emit([note('turn/started', { threadId: 'thread', turn: { id: 'turn' } })])
    await f.config('turn/interrupt', { failures: 1, endTurn: true })
    const stopped = await f.post('/interrupt', { threadId: 'thread', turnId: 'turn' })
    assert.equal(stopped.status, 'completed')
    assert.equal(stopped.turn.status, 'interrupted')
    assert.ok((await f.calls('turn/interrupt')).length >= 2)
    await until(() => f.state('thread'), state => state.status === 'unsubscribed', 'confirmed stop must release its thread')
  } finally { await f.close() }
})

test('writer ownership follows the current kernel holder and never stale files or persisted PIDs', { skip: process.platform !== 'linux' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writer-test-'))
  fs.mkdirSync(path.join(home, 'thread-writer-locks'))
  const lock = path.join(home, 'thread-writer-locks', 'fixture.lock')
  fs.writeFileSync(lock, 'stale saved owner from an earlier boot')
  let child
  try {
    assert.equal(writerStatus(home, 'fixture').status, 'released')
    child = spawn('flock', ['--no-fork', lock, process.execPath, '-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    assert.equal(writerStatus(home, 'fixture').status, 'held')
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
    assert.equal(fs.existsSync(lock), true)
    assert.equal(writerStatus(home, 'fixture').status, 'released')
    assert.equal(writerStatus(home, '../other').status, 'unknown')
    assert.equal(writerStatus(home, 'fixture', 'darwin').status, 'unknown')
    assert.equal(writerStatus(home, 'fixture', 'linux', path.join(home, 'missing-proc')).status, 'unknown')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
