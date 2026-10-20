// Harmless stdio MCP used only by native-lifecycle.test.mjs. The private ledger
// records this fixture's own processes, never Codex prompts or thread IDs.
import fs from 'node:fs'
import readline from 'node:readline'

const ledger = process.argv[2]
if (!ledger) process.exit(2)
const started = (() => {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch { return null }
})()
const record = event => fs.appendFileSync(ledger, JSON.stringify({ event, pid: process.pid, started }) + '\n', { mode: 0o600 })
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
record('started')
process.on('exit', () => record('exited'))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    record('initialized')
    return reply(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'isolated-lifecycle-fixture', version: '1.0.0' },
    })
  }
  if (request.method === 'tools/list') return reply(request.id, { tools: [{
    name: 'fixture_ping', description: 'Return a fixed fixture string without external effects.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false },
  }] })
  if (request.method === 'tools/call') return reply(request.id, { content: [{ type: 'text', text: 'fixture' }] })
  reply(request.id, {})
}).on('close', () => process.exit(0))
