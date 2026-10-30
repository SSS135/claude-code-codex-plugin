// Per-agent files survive daemon/session/version changes without one session
// replacing another session's registry snapshot.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

export const registryDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'codex-agents')

const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string')
/** An outbox item, {text, to?}; a bare string is a record written before 1.0. */
const outboxItem = item => typeof item === 'string' ||
  (typeof item?.text === 'string' && (item.to === undefined || typeof item.to === 'string'))
const outboxItems = value => Array.isArray(value) && value.every(outboxItem)
const validAgent = agent => agent && validId(agent.id) && typeof agent.threadId === 'string' &&
  ['name', 'model', 'effort', 'cwd', 'lastMessage', 'activity', 'sessionId'].every(key => typeof agent[key] === 'string') &&
  ['updatedAt', 'startedAt', 'turnStartedAt', 'turnEndedAt', 'tokens'].every(key => Number.isFinite(agent[key])) &&
  strings(agent.digest) && (agent.outbox === undefined || outboxItems(agent.outbox)) &&
  ['read-only', 'workspace-write', 'full-access'].includes(agent.sandbox) &&
  ['ask', 'auto', 'never', 'yolo'].includes(agent.approvals) &&
  [agent.currentTurnId, agent.lastTurnId, agent.lastTurnStatus, agent.error].every(value => value === null || typeof value === 'string') &&
  ['starting', 'running', 'idle', 'interrupted', 'failed'].includes(agent.status)

export function readAgents(query, dir = registryDir) {
  if (!fs.existsSync(dir)) return {}
  const agents = {}
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const agent = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (!validAgent(agent) || name !== `${agent.id}.json`) continue
      agent.outbox = (agent.outbox ?? []).map(item => (typeof item === 'string' ? { text: item } : item))
      if (agent.sessionId === query.sessionId || query.ids?.includes(agent.id) ||
          (query.ref && (agent.id === query.ref || agent.name === query.ref))) agents[agent.id] = agent
    } catch (error) {
      // A damaged record must not hide the other agents or prevent startup.
      process.stderr.write(`codex registry: cannot read ${name}: ${error.message}\n`)
    }
  }
  return agents
}

export function writeAgent(agent, dir = registryDir) {
  if (!validAgent(agent)) throw new Error('invalid Codex agent record')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${agent.id}.json`)
  // A reload can migrate an old plugin-store snapshot; keep the newer file.
  if (fs.existsSync(file)) {
    try {
      const held = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (validAgent(held) && held.id === agent.id && held.updatedAt > agent.updatedAt) return
    } catch {}
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(agent), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

/** The new relay serves persistence even when it reattaches to an older daemon. */
export async function serveRegistry(dir = registryDir) {
  // The HTTP server runs on its own thread: the bridge's main thread blocks in a synchronous
  // stdout write whenever the host stops draining the pipe, and the host drains it only after
  // its registry calls return. A main-thread server would deadlock that cycle.
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { dir } })
  const address = await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  worker.unref()
  const server = {
    listening: true,
    closeAllConnections() {},
    close(done) {
      server.listening = false
      worker.terminate().then(() => done?.())
    },
  }
  return { server, address }
}

async function listenRegistry(dir) {
  const secret = randomUUID().replaceAll('-', '')
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method !== 'POST' || ![`/${secret}/registry/read`, `/${secret}/registry/write`].includes(req.url)) {
      return reply(404, { error: { message: 'not found' } })
    }
    try {
      let text = ''
      let bytes = 0
      req.setEncoding('utf8')
      for await (const chunk of req) {
        text += chunk
        bytes += Buffer.byteLength(chunk)
        if (bytes > 4 * 1024 * 1024) throw new Error('Codex registry request exceeds 4 MiB')
      }
      const body = JSON.parse(text)
      if (req.url.endsWith('/read')) return reply(200, { agents: readAgents(body, dir) })
      writeAgent(body.agent, dir)
      reply(200, { ok: true })
    } catch (error) {
      reply(400, { error: { message: error.message } })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, address: `http://127.0.0.1:${server.address().port}/${secret}` }
}

if (!isMainThread && workerData?.dir) {
  const { server, address } = await listenRegistry(workerData.dir)
  parentPort.postMessage(address)
}
