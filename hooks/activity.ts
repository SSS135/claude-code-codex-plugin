// Display-only replay; never output, patches, config, or raw reasoning.
// Native turn ownership and the durable final answer remain separate.
export const MAX_ACTIVITY_CHUNK = 16_000
export const MAX_ASSISTANT_TEXT = 256_000
const MAX_EVENT = 120
const MAX_BUFFER = 512_000
const MAX_EVENTS = 60
const MAX_KEYS = 256
const MAX_FEEDS = 256

const textOf = (value: unknown): string => typeof value === 'string' ? value : ''
const objectOf = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 15)} [truncated]`

/** Redact before clipping: truncating first can expose a partial credential.
 * No heuristic can identify every secret in arbitrary prose; protocol payloads
 * with a high secret risk (output/diff/config/raw reasoning) never enter this feed.
 */
export function redactActivity(text: string, max = MAX_EVENT, preserveLayout = false): string {
  const safe = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/g, '[redacted token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[redacted authorization]')
    .replace(/((?:proxy-)?authorization|x-api-key)\s*:\s*(?:'[^']*(?:'|$)|"[^"]*(?:"|$)|[^\s"']+)/gi, '$1: [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|api_key|key|token|secret|password|signature|sig)=)[^\s&#"']*/gi, '$1[redacted]')
    // Substitution values can contain whitespace and nested shell syntax; do
    // not attempt to print any part of an assignment with command substitution.
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*=(?:[^\n]*?\$\(|[^\n]*?`)[\s\S]*/g, '[redacted environment assignment and command]')
    .replace(/--?[\w-]*(?:token|secret|password|credential|api[-_]?key)[\w-]*\s+["']?(?:\$\(|`)[\s\S]*/gi, '[redacted credential argument and command]')
    // All environment assignments, including benign ones, avoid guessing names.
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*=)(?:'[^']*(?:'|$)|"(?:\\.|[^"\\])*(?:"|$)|(?:\\.|[^\s;&|])+)/g, '$1[redacted]')
    .replace(/((?:--?(?:[\w-]*(?:token|secret|password|credential|api[-_]?key|session[-_]?id)[\w-]*))\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1[redacted]')
    .replace(/(["']?(?:api[-_]?key|token|secret|password|session[-_]?id|thread[-_]?id)["']?\s*[:=]\s*)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted id]')
    // Prevent terminal escapes, new rows masquerading as UI, and bidi controls.
    .replace(/\x1b(?:\][^\x07]*(?:\x07|$)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(preserveLayout ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g : /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
  return clip(preserveLayout ? safe : safe.replace(/\s+/g, ' ').trim(), max)
}

const compact = (text: string, max = MAX_EVENT): string => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

// Decode shell words without evaluating anything. Offsets preserve ordinary
// quoting for display; decoding is used only to unwrap a shell's script argument.
function shellWords(text: string): { value: string; start: number; end: number }[] {
  const words: { value: string; start: number; end: number }[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    const start = i
    let value = '', quote = ''
    while (i < text.length) {
      const c = text[i++]!
      if (!quote && /\s/.test(c)) break
      if (c === "'" || c === '"') {
        if (!quote) { quote = c; continue }
        if (quote === c) { quote = ''; continue }
      }
      if (c === '\\' && quote !== "'" && i < text.length) {
        const next = text[i]!
        if (!quote || /[$`"\\\n]/.test(next)) { value += next; i++; continue }
      }
      value += c
    }
    words.push({ value, start, end: i })
  }
  return words
}

/** A preview, not a shell parser: uncertainty always hides more of the script. */
export function commandPreview(command: string, max = MAX_EVENT): string {
  let script = command.trim()
  for (let depth = 0; depth < 3; depth++) {
    if (!/^(?:\S*\/)?(?:ba|z|da|k)?sh\s/.test(script)) break
    const words = shellWords(script)
    if (!/^-[a-z]*c[a-z]*$/i.test(words[1]?.value ?? '') || !words[2]) return 'shell script …'
    script = words[2].value
    if (depth === 2) return 'shell script …'
  }
  // Preserve quoted search patterns, but never cross a physical newline or
  // enter a heredoc body. Stop at the first unquoted shell operator.
  let boundary = -1, quote = ''
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!
    if (/[\r\n]/.test(c) || (!quote && (/[;|&]/.test(c) || script.slice(i, i + 2) === '<<'))) { boundary = i; break }
    if (c === '\\' && quote !== "'") {
      if (/[\r\n]/.test(script[i + 1] ?? '')) { boundary = i; break }
      i++; continue
    }
    if (c === "'" || c === '"') {
      if (!quote) quote = c
      else if (quote === c) quote = ''
    }
  }
  let shortened = boundary >= 0
  if (shortened) script = script.slice(0, boundary)
  const words = shellWords(script)
  // Inline interpreter bodies are as noisy and sensitive as heredocs.
  let program = /^(?:.*\/)?env$/.test(words[0]?.value ?? '') ? 1 : 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[program]?.value ?? '')) program++
  if (/^(?:.*\/)?(?:python[\d.]*|node|ruby|perl|php)$/.test(words[program]?.value ?? '')) {
    const body = words.slice(program + 1).find(word => /^-[a-z]*?[cep]/i.test(word.value) || /^--eval(?:=|$)/.test(word.value))
    if (body) {
      const flag = body.value.match(/^-[a-z]*?[cep]/i)?.[0] ?? '--eval'
      script = `${script.slice(0, body.start)}${flag}`
      shortened = true
    }
  }
  const safe = redactActivity(script, Number.MAX_SAFE_INTEGER)
    // Remove the entire redacted fragment, including assignment names and
    // adjacent punctuation; never leave NAME=[redacted] chains in a preview.
    .replace(/\S*\[redacted[^\]]*\]\S*/g, '…').replace(/(?:…\s*)+/g, '… ').trim()
  return compact(`${safe || 'command'}${shortened ? ' …' : ''}`, max)
}

export type ActivityEvent = { kind: 'text'; text: string } | { kind: 'command'; command: string; result: string }

/** Preserve prose and markdown in full. Reject an oversized entry as a whole;
 * never silently turn an assistant paragraph into a truncated preview.
 */
export function assistantText(text: string): string {
  if (text.length > MAX_ASSISTANT_TEXT) return '[Codex message omitted: exceeds the 256,000-character transcript safety limit.]'
  return redactActivity(text, Number.MAX_SAFE_INTEGER, true)
}

/** Allowlist projection before queueing. Command results are metadata only:
 * arbitrary shell output cannot be reliably sanitized with token heuristics.
 */
export function activityEvent(method: string, params: Record<string, unknown>): ActivityEvent | null {
  if (method === 'turn/plan/updated') {
    const plan = Array.isArray(params.plan) ? params.plan : []
    const completed = plan.filter(entry => objectOf(entry).status === 'completed').length
    const steps = plan.map(entry => {
      const step = objectOf(entry)
      return `- [${step.status === 'completed' ? 'x' : ' '}] ${textOf(step.step)}`
    })
    return plan.length ? { kind: 'text', text: assistantText(`Plan: ${completed}/${plan.length} done\n\n${steps.join('\n')}`) } : null
  }
  if (method !== 'item/completed') return null
  const item = objectOf(params.item)
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    const status = item.status === 'declined' ? 'declined' : `exit ${typeof item.exitCode === 'number' && Number.isFinite(item.exitCode) ? item.exitCode : '?'}`
    const duration = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? `, ${(item.durationMs / 1000).toFixed(1)}s` : ''
    return { kind: 'command', command: commandPreview(item.command, 1000), result: status + duration }
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.slice(0, 8).map(entry => redactActivity(textOf(objectOf(entry).path), 500))
    return paths.length ? { kind: 'text', text: `Files changed: ${paths.join(', ')}${changes.length > 8 ? ` (+${changes.length - 8} more)` : ''}` } : null
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim() && item.phase !== 'final_answer') {
    return { kind: 'text', text: assistantText(item.text) }
  }
  // Only the explicitly public summary, never raw reasoning content/text.
  if (item.type === 'reasoning' && Array.isArray(item.summary)) {
    const summary = item.summary.filter(part => typeof part === 'string' && part.trim()).join('\n\n')
    return summary ? { kind: 'text', text: assistantText(summary) } : null
  }
  if (item.type === 'plan' && typeof item.text === 'string') return { kind: 'text', text: assistantText(item.text) }
  return null
}

// IDs are preferred. Anonymous-event dedupe uses a bounded fingerprint so
// retaining 256 keys cannot retain 256 copies of large assistant messages.
function fingerprint(text: string): string {
  let a = 2166136261, b = 5381
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619)
    b = Math.imul(b, 33) ^ text.charCodeAt(i)
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`
}

const sizeOf = (event: ActivityEvent): number => event.kind === 'text' ? event.text.length : event.command.length + event.result.length

type Feed = { turnId: string; events: ActivityEvent[]; chars: number; dropped: number; seen: Set<string> }

/** Bounded, incremental, exact-turn queue. Prefer dropping commands on overflow;
 * any lost entries get an explicit notice. No lossy batch command coalescing.
 */
export class LiveActivity {
  private feeds = new Map<string, Feed>()

  begin(agentId: string, turnId: string): void {
    if (this.feeds.get(agentId)?.turnId === turnId) return
    this.feeds.delete(agentId)
    this.feeds.set(agentId, { turnId, events: [], chars: 0, dropped: 0, seen: new Set() })
    if (this.feeds.size > MAX_FEEDS) this.feeds.delete(this.feeds.keys().next().value!)
  }

  forget(agentId: string): void { this.feeds.delete(agentId) }

  has(agentId: string, turnId: string): boolean {
    const feed = this.feeds.get(agentId)
    return feed?.turnId === turnId && (feed.events.length > 0 || feed.dropped > 0)
  }

  record(agentId: string, turnId: string, method: string, params: Record<string, unknown>): void {
    const feed = this.feeds.get(agentId)
    if (!feed || feed.turnId !== turnId || params.turnId !== turnId) return
    const event = activityEvent(method, params)
    if (!event) return
    const itemId = textOf(objectOf(params.item).id).slice(0, 128)
    const key = itemId ? `${method}:${itemId}` : `${method}:${fingerprint(JSON.stringify(event))}`
    if (feed.seen.has(key)) return
    feed.seen.add(key)
    if (feed.seen.size > MAX_KEYS) feed.seen.delete(feed.seen.values().next().value!)
    feed.events.push(event)
    feed.chars += sizeOf(event)
    while (feed.events.length > MAX_EVENTS || feed.chars > MAX_BUFFER) {
      const command = feed.events.findIndex(event => event.kind === 'command')
      feed.chars -= sizeOf(feed.events.splice(command >= 0 ? command : 0, 1)[0]!)
      feed.dropped += 1
    }
  }

  take(agentId: string, turnId: string): ActivityEvent[] {
    const feed = this.feeds.get(agentId)
    if (!feed || feed.turnId !== turnId) return []
    const batch: ActivityEvent[] = []
    if (feed.dropped) batch.push({ kind: 'text', text: `[${feed.dropped} older Codex activity entries omitted]` })
    feed.dropped = 0
    let chars = 0
    while (feed.events.length && batch.length < 16) {
      const event = feed.events[0]!
      // One full large message may exceed the batch target, never its safety cap.
      if (chars && chars + sizeOf(event) > MAX_ACTIVITY_CHUNK) break
      batch.push(feed.events.shift()!)
      chars += sizeOf(event)
      feed.chars -= sizeOf(event)
    }
    return batch
  }
}
