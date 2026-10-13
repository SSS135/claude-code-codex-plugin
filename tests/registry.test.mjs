// Run with: node --test tests/registry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readAgents, serveRegistry, writeAgent } from '../bin/registry.mjs'

test('separate sessions persist independently, survive registry-server restart, and retain stale records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-registry-test-'))
  const first = await serveRegistry(dir)
  const second = await serveRegistry(dir)
  let restarted
  const call = async (server, endpoint, body) => {
    const res = await fetch(`${server.address}/registry/${endpoint}`, { method: 'POST', body: JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  const agent = (id, sessionId) => ({
    id, name: id, threadId: `thread-${id}`, sessionId, updatedAt: 10, status: 'interrupted',
    model: 'gpt-6.1-sol', effort: 'high', cwd: '/work', lastMessage: 'Dragon: \u2264 500 words \u2014 \u0433\u043e\u0442\u043e\u0432\u043e', activity: '',
    startedAt: 1, turnStartedAt: 1, turnEndedAt: 10, tokens: 0, digest: [], outbox: [],
    sandbox: 'workspace-write', approvals: 'ask', currentTurnId: null, lastTurnId: null, lastTurnStatus: null, error: null,
  })
  try {
    await Promise.all([
      call(first, 'write', { agent: agent('a1', 'old-session') }),
      call(second, 'write', { agent: agent('a2', 'other-session') }),
    ])
    assert.deepEqual(Object.keys(readAgents({ ids: ['a1', 'a2'] }, dir)).sort(), ['a1', 'a2'])
    first.server.closeAllConnections()
    await new Promise(resolve => first.server.close(resolve))
    restarted = await serveRegistry(dir)
    const recovered = await call(restarted, 'read', { sessionId: 'new-session', ids: ['a1'] })
    assert.equal(recovered.agents.a1.threadId, 'thread-a1')
    assert.equal(recovered.agents.a1.lastMessage, agent('a1', 'old-session').lastMessage)
    assert.equal(recovered.agents.a1.status, 'interrupted')
    assert.equal(recovered.agents.a2, undefined)
    assert.equal((await call(restarted, 'read', { ref: 'a2' })).agents.a2.threadId, 'thread-a2')
    writeAgent({ ...agent('a1', 'old-session'), updatedAt: 1, status: 'running' }, dir)
    assert.equal(readAgents({ ids: ['a1'] }, dir).a1.status, 'interrupted')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a1.json', 'a2.json'])
    // A corrupt record cannot hide its intact neighbor.
    fs.writeFileSync(path.join(dir, 'broken.json'), '{')
    assert.equal(readAgents({ ids: ['a1'] }, dir).a1.threadId, 'thread-a1')
    assert.equal((await call(restarted, 'write', { agent: agent('../escape', 's') })).status, 400)
    assert.equal((await fetch(`${new URL(restarted.address).origin}/registry/read`, { method: 'POST', body: '{}' })).status, 404)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'a1.json')).mode & 0o777, 0o600)
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    }
  } finally {
    for (const server of [first.server, second.server, restarted?.server]) {
      if (!server?.listening) continue
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('registry answers while the main thread is blocked and under concurrent large writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-registry-test-'))
  const registry = await serveRegistry(dir)
  const agent = id => ({
    id, name: id, threadId: `t-${id}`, sessionId: 's', updatedAt: 10, status: 'running',
    model: 'm', effort: 'high', cwd: '/w', lastMessage: 'x'.repeat(500_000), activity: '',
    startedAt: 1, turnStartedAt: 1, turnEndedAt: 0, tokens: 0, digest: [], outbox: [],
    sandbox: 'workspace-write', approvals: 'ask', currentTurnId: null, lastTurnId: null, lastTurnStatus: null, error: null,
  })
  try {
    const post = (endpoint, body) => fetch(`${registry.address}/registry/${endpoint}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    // A separate process asks while this thread is blocked, as the host does while the bridge sits in a synchronous stdout write.
    const client = spawn(process.execPath, ['-e', `
      const t = Date.now()
      fetch(process.argv[1] + '/registry/read', { method: 'POST', body: '{"sessionId":"s"}' }).then(r => r.text()).then(() => console.log(Date.now() - t))
    `, registry.address], { stdio: ['ignore', 'pipe', 'inherit'] })
    const closed = new Promise(resolve => client.once('close', resolve))
    let answered = ''
    client.stdout.on('data', chunk => { answered += chunk })
    await new Promise(resolve => setTimeout(resolve, 100))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
    await closed
    assert.ok(Number(answered) < 1000, `the client waited ${answered} ms for this blocked thread`)
    const writes = Array.from({ length: 10 }, (_, i) => post('write', { agent: agent(`a${i}`) }))
    assert.ok((await Promise.all(writes)).every(res => res.status === 200))
    const read = await (await post('read', { sessionId: 's' })).json()
    assert.equal(Object.keys(read.agents).length, 10)
  } finally {
    await new Promise(resolve => registry.server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
