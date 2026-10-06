// Pure logic of the codex plugin: no `$` here (the engine follows `$` only
// within one file, so every engine call lives in register.tsx). Codex
// protocol parameters, how events change an agent, and the texts the model
// and the person read.

import type { ToolSpec } from 'claude-code'

import type { CodexAgent, CodexApprovals, CodexSandbox } from '../types'

export type Settings = {
  codexPath: string
  nodePath: string
  defaultModel: string
  defaultEffort: string
  defaultSandbox: CodexSandbox
  defaultApprovals: CodexApprovals
}

export type BridgeEvent =
  | { type: 'ready'; socket: string; reattached: boolean; active: Record<string, string> }
  | { type: 'notification'; method: string; params: Record<string, unknown> }
  | { type: 'request'; id: number | string; method: string; params: Record<string, unknown> }
  | { type: 'exit'; code: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'fatal'; message: string; logTail: string }

/** A failure to show the model as the tool's error. */
export class CodexError extends Error {}

export const PREFIX = 'mcp__codex__'
export const PANE = 'codex'
export const SANDBOXES: CodexSandbox[] = ['read-only', 'workspace-write', 'full-access']
export const APPROVALS: CodexApprovals[] = ['auto', 'ask', 'never', 'yolo']
export const MAX_AGENTS = 40

export const MODEL_ALIASES: Record<string, string> = {
  luna: 'gpt-6-luna',
  sol: 'gpt-6.1-sol',
  astra: 'gpt-6-astra',
  terra: 'gpt-5.6-terra',
}

export const resolveModel = (model: string): string => MODEL_ALIASES[model] ?? model
export const aliasOf = (model: string): string =>
  Object.entries(MODEL_ALIASES).find(([, id]) => id === model)?.[0] ?? model

// ------------------------------------------------------------ text helpers

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

export const elapsed = (from: number, to: number): string => {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `${tokens} tok`

export const isLive = (agent: CodexAgent): boolean => agent.status === 'running' || agent.status === 'starting'

export const timeOf = (agent: CodexAgent, now: number): string =>
  isLive(agent) ? elapsed(agent.turnStartedAt, now) : agent.turnEndedAt ? elapsed(agent.turnStartedAt, agent.turnEndedAt) : ''

export const statusColor = (agent: CodexAgent): string =>
  isLive(agent) ? 'warning' : agent.status === 'idle' ? 'success' : agent.status === 'failed' ? 'error' : 'inactive'

export const statusDot = (agent: CodexAgent): string =>
  isLive(agent) ? '*' : agent.status === 'idle' ? '+' : agent.status === 'failed' ? 'x' : '-'

/** Splits a stream of text pieces into whole lines. */
export class LineBuffer {
  private pending = ''

  push(text: string): string[] {
    this.pending += text
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }

  rest(): string[] {
    const rest = this.pending.trim()
    this.pending = ''
    return rest === '' ? [] : [rest]
  }
}

// ------------------------------------------------------------ registry

const MAX_DIGEST = 60
const MAX_MESSAGE = 20_000

export const sanitize = (agent: CodexAgent): CodexAgent => ({
  ...agent,
  lastMessage: clip(agent.lastMessage, MAX_MESSAGE),
  digest: agent.digest.slice(-MAX_DIGEST),
})

/** Keeps the live agents and the most recently updated, up to MAX_AGENTS. */
export const trim = (agents: Record<string, CodexAgent>): Record<string, CodexAgent> => {
  const list = Object.values(agents)
  if (list.length <= MAX_AGENTS) return agents
  const keep = list
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_AGENTS)
  return Object.fromEntries(keep.map(agent => [agent.id, agent]))
}

export const findIn = (agents: Record<string, CodexAgent>, ref: string): CodexAgent | undefined =>
  agents[ref] ?? Object.values(agents).find(agent => agent.name === ref)

export const byThread = (agents: Record<string, CodexAgent>, threadId: string): CodexAgent | undefined =>
  Object.values(agents).find(agent => agent.threadId === threadId)

export const sorted = (agents: Record<string, CodexAgent>): CodexAgent[] =>
  Object.values(agents).sort((a, b) => b.startedAt - a.startedAt)

export const uniqueName = (agents: Record<string, CodexAgent>, wanted: string): string => {
  const taken = new Set(Object.values(agents).map(agent => agent.name))
  if (!taken.has(wanted)) return wanted
  let n = 2
  while (taken.has(`${wanted}-${n}`)) n += 1
  return `${wanted}-${n}`
}

// ------------------------------------------------------------ codex params

export const sandboxMode = (sandbox: CodexSandbox): string =>
  sandbox === 'full-access' ? 'danger-full-access' : sandbox

/** Passed on every turn/start: a resumed thread otherwise falls back to read-only. */
export const sandboxPolicy = (sandbox: CodexSandbox): Record<string, unknown> => {
  if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (sandbox === 'full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

/** ask: the person decides; auto: Codex's reviewer (--approve-for-me); never and yolo: no escalation. */
export const approvalParams = (approvals: CodexApprovals) => ({
  approvalPolicy: approvals === 'never' || approvals === 'yolo' ? 'never' : 'on-request',
  approvalsReviewer: approvals === 'auto' ? 'auto_review' : 'user',
})

export const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]

export const threadResumeParams = (agent: CodexAgent) => ({
  threadId: agent.threadId,
  model: agent.model,
  cwd: agent.cwd,
  sandbox: sandboxMode(agent.sandbox),
  ...approvalParams(agent.approvals),
  excludeTurns: true,
})

export const turnStartParams = (agent: CodexAgent, text: string) => ({
  threadId: agent.threadId,
  input: textInput(text),
  model: agent.model,
  effort: agent.effort,
  cwd: agent.cwd,
  sandboxPolicy: sandboxPolicy(agent.sandbox),
  ...approvalParams(agent.approvals),
})

/** Undefined when the pair fits; otherwise the error naming the valid choices. */
export const modelEffortError = (models: Map<string, string[]>, model: string, effort: string): string | undefined => {
  const efforts = models.get(model)
  if (!efforts) return `Unknown Codex model "${model}". Use luna, sol, astra, terra or one of: ${[...models.keys()].join(', ')}.`
  if (!efforts.includes(effort)) return `Model ${model} does not take effort "${effort}". Its efforts: ${efforts.join(', ')}.`
  return undefined
}

// ------------------------------------------------------------ events

export type Item = {
  type: string
  text?: string
  phase?: string | null
  command?: string
  exitCode?: number | null
  status?: string
  changes?: { path: string; kind: unknown }[]
  server?: string
  tool?: string
  content?: { type: string; text?: string }[]
}

export const finalMessage = (items: readonly Item[]): string | null => {
  const messages = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text !== '')
  const final = messages.filter(item => item.phase === 'final_answer').at(-1) ?? messages.at(-1)
  return final?.text ?? null
}

export const shortCommand = (command: string): string =>
  clip(command.replace(/^\/bin\/(ba|z)?sh -lc '(.*)'$/s, '$2'), 160)

const changeKind = (kind: unknown) =>
  typeof kind === 'string' ? kind : typeof kind === 'object' && kind !== null ? String((kind as { type?: string }).type ?? 'edit') : 'edit'

export function itemStarted(item: Item): Partial<CodexAgent> | null {
  if (item.type === 'commandExecution' && item.command) {
    const command = shortCommand(item.command)
    return { activity: `$ ${command}`, lastCommand: command }
  }
  if (item.type === 'fileChange') return { activity: `editing ${(item.changes ?? []).map(one => one.path).join(', ')}` }
  if (item.type === 'reasoning') return { activity: 'thinking' }
  if (item.type === 'mcpToolCall') return { activity: `tool ${item.server}.${item.tool}` }
  if (item.type === 'webSearch') return { activity: 'searching the web' }
  return null
}

export function itemCompleted(agent: CodexAgent, item: Item): Partial<CodexAgent> {
  if (item.type === 'commandExecution' && item.command) {
    const result = item.status === 'declined' ? 'declined' : `exit ${item.exitCode ?? '?'}`
    return { activity: 'thinking', digest: [...agent.digest, `$ ${shortCommand(item.command)} -> ${result}`] }
  }
  if (item.type === 'fileChange') {
    const files = (item.changes ?? []).map(one => `${changeKind(one.kind)} ${one.path}`).join(', ')
    return { activity: 'thinking', digest: [...agent.digest, `files (${item.status ?? 'done'}): ${files}`] }
  }
  if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text !== '') {
    return {
      lastMessage: item.text,
      activity: clip(firstLine(item.text), 160),
      digest: [...agent.digest, `${item.phase === 'final_answer' ? 'answer' : 'note'}: ${clip(firstLine(item.text), 200)}`],
    }
  }
  if (item.type === 'userMessage' && agent.digest.length > 0) {
    const text = (item.content ?? []).map(part => part.text ?? '').join(' ')
    return { digest: [...agent.digest, `steer: ${clip(firstLine(text), 200)}`] }
  }
  return {}
}

/** The agent after its turn ended, from turn/completed's `turn`. */
export function afterTurn(agent: CodexAgent, turn: Record<string, unknown>, now: number): Partial<CodexAgent> {
  const status = String(turn.status ?? 'completed')
  const error = (turn.error as { message?: string } | null)?.message ?? null
  const final = finalMessage((turn.items as Item[] | undefined) ?? [])
  return {
    status: status === 'completed' ? 'idle' : status === 'interrupted' ? 'interrupted' : 'failed',
    currentTurnId: null,
    lastTurnId: String(turn.id ?? agent.currentTurnId ?? ''),
    lastTurnStatus: status,
    error: error ?? (status === 'failed' ? 'the turn failed' : null),
    activity: status,
    turnEndedAt: now,
    notify: false,
    ...(final !== null ? { lastMessage: final } : {}),
  }
}

// ------------------------------------------------------------ approvals

export const ALLOW_ONCE = 'Allow once'
export const ALLOW_SESSION = 'Allow for session'
export const ALLOW_ALWAYS = 'Allow always'
export const DENY = 'Deny'

export type Verdict = { kind: 'once' | 'session' | 'always' | 'deny' } | { kind: 'other'; text: string }

export const verdictOf = (answer: string): Verdict =>
  answer === ALLOW_ONCE
    ? { kind: 'once' }
    : answer === ALLOW_SESSION
      ? { kind: 'session' }
      : answer === ALLOW_ALWAYS
        ? { kind: 'always' }
        : answer === DENY
          ? { kind: 'deny' }
          : { kind: 'other', text: answer }

/**
 * The command prefix Codex proposes to allow from now on, when it proposes one.
 * "Allow always" answers with it, and Codex itself appends a `prefix_rule` to
 * ~/.codex/rules/default.rules, so later matching commands run unasked.
 */
export const proposedRule = (method: string, params: Record<string, unknown>): string[] | null => {
  const proposed = params.proposedExecpolicyAmendment
  if (method !== 'item/commandExecution/requestApproval' || !Array.isArray(proposed) || proposed.length === 0) return null
  return proposed.map(String)
}

/** The dialog's options: "Allow always" only where Codex can persist a rule. */
export const approvalOptions = (method: string, params: Record<string, unknown>): string[] =>
  proposedRule(method, params) ? [ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY] : [ALLOW_ONCE, ALLOW_SESSION, DENY]

export const grantedProfile = (requested: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null))

/** The question for a server request this plugin asks about, or null for one it declines unasked. */
export function approvalQuestion(method: string, params: Record<string, unknown>, who: string): string | null {
  if (method === 'item/commandExecution/requestApproval') {
    const command = typeof params.command === 'string' ? shortCommand(params.command) : '(command not shown)'
    return `${who} wants to run: ${command}`
  }
  if (method === 'item/fileChange/requestApproval') {
    const root = typeof params.grantRoot === 'string' ? ` (write access under ${params.grantRoot})` : ''
    return `${who} wants to change files${root}`
  }
  if (method === 'item/permissions/requestApproval') {
    const requested = (params.permissions as Record<string, unknown> | undefined) ?? {}
    return `${who} asks for extra permissions: ${clip(JSON.stringify(grantedProfile(requested)), 300)}`
  }
  return null
}

/** The JSON-RPC answer to a server request, given the person's verdict (null when not asked). */
export function approvalAnswer(
  method: string,
  params: Record<string, unknown>,
  verdict: Verdict | null,
): { result: unknown } | { error: { code: number; message: string } } {
  if (verdict && (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')) {
    const rule = proposedRule(method, params)
    if (verdict.kind === 'always' && rule) {
      return { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rule } } } }
    }
    const decision =
      verdict.kind === 'once' ? 'accept' : verdict.kind === 'session' || verdict.kind === 'always' ? 'acceptForSession' : 'decline'
    return { result: { decision } }
  }
  if (verdict && method === 'item/permissions/requestApproval') {
    const isAllowed = verdict.kind === 'once' || verdict.kind === 'session' || verdict.kind === 'always'
    const requested = (params.permissions as Record<string, unknown> | undefined) ?? {}
    return { result: { permissions: isAllowed ? grantedProfile(requested) : {}, scope: verdict.kind === 'once' ? 'turn' : 'session' } }
  }
  if (method === 'mcpServer/elicitation/request') return { result: { action: 'decline', content: null, _meta: null } }
  return { error: { code: -32601, message: `${method} is not supported by the Claude Code codex plugin` } }
}

/** The digest line recording how a server request was answered. */
export function approvalDigest(method: string, params: Record<string, unknown>, verdict: Verdict | null): string {
  const what =
    method === 'item/commandExecution/requestApproval'
      ? `$ ${typeof params.command === 'string' ? shortCommand(params.command) : '?'}`
      : method === 'item/fileChange/requestApproval'
        ? 'file change'
        : method === 'item/permissions/requestApproval'
          ? 'extra permissions'
          : method
  return `approval: ${what} -> ${verdictOutcome(verdict, proposedRule(method, params))}`
}

function verdictOutcome(verdict: Verdict | null, rule: string[] | null): string {
  if (verdict === null) return 'declined (not supported here)'
  switch (verdict.kind) {
    case 'once':
      return 'approved by user (once)'
    case 'session':
      return 'approved by user (session)'
    case 'always':
      return rule ? `approved by user (always: rule ${rule.join(' ')})` : 'approved by user (session; no rule offered)'
    case 'deny':
      return 'declined by user'
    case 'other':
      return `declined by user: ${clip(firstLine(verdict.text), 120)}`
  }
}

/** The digest line for Codex's own reviewer (approvals: auto). */
export function autoReviewDigest(params: Record<string, unknown>): string {
  const review = (params.review ?? {}) as { status?: string; riskLevel?: string | null; rationale?: string | null }
  const action = (params.action ?? {}) as { type?: string; command?: string; files?: string[]; host?: string; toolName?: string }
  const what =
    action.type === 'command' && action.command
      ? `$ ${shortCommand(action.command)}`
      : action.type === 'applyPatch'
        ? `files ${(action.files ?? []).join(', ')}`
        : action.type === 'networkAccess'
          ? `network ${action.host}`
          : (action.type ?? 'action')
  const risk = review.riskLevel ? `, ${review.riskLevel} risk` : ''
  const why = review.rationale ? `: ${clip(firstLine(review.rationale), 160)}` : ''
  return `approval: ${what} -> auto-reviewer ${review.status ?? '?'}${risk}${why}`
}

// ------------------------------------------------------------ project config

export type Defaults = { model: string; effort: string; sandbox: CodexSandbox; approvals: CodexApprovals }

export const PROJECT_CONFIG = '.claude/codex.json'

/** Parses a project's .claude/codex.json: optional defaults {model, effort, sandbox, approvals}. */
export function parseProjectConfig(text: string, path: string): Partial<Defaults> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CodexError(`${path} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CodexError(`${path} must hold a JSON object`)
  const config = parsed as Record<string, unknown>
  const out: Partial<Defaults> = {}
  for (const key of ['model', 'effort', 'sandbox', 'approvals'] as const) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') throw new CodexError(`${path}: "${key}" must be a non-empty string`)
    if (key === 'sandbox' && !SANDBOXES.includes(value as CodexSandbox)) throw new CodexError(`${path}: sandbox must be one of ${SANDBOXES.join(', ')}`)
    if (key === 'approvals' && !APPROVALS.includes(value as CodexApprovals)) throw new CodexError(`${path}: approvals must be one of ${APPROVALS.join(', ')}`)
    if (key === 'sandbox') out.sandbox = value as CodexSandbox
    else if (key === 'approvals') out.approvals = value as CodexApprovals
    else out[key] = value
  }
  return out
}

/** The directories from `cwd` up to `root` (or up to / when cwd is not under root). */
export function configDirs(cwd: string, root: string): string[] {
  const dirs: string[] = []
  let dir = cwd.replace(/\/+$/, '') || '/'
  for (;;) {
    dirs.push(dir)
    if (dir === root || dir === '/') return dirs
    const up = dir.slice(0, dir.lastIndexOf('/')) || '/'
    dir = up
  }
}

/** Precedence: tool args > project config > userConfig (whose manifest defaults are the built-ins). */
export const effectiveDefaults = (settings: Settings, project: Partial<Defaults>): Defaults => ({
  model: project.model ?? settings.defaultModel,
  effort: project.effort ?? settings.defaultEffort,
  sandbox: project.sandbox ?? settings.defaultSandbox,
  approvals: project.approvals ?? settings.defaultApprovals,
})

/** The sandbox and approvals a spawn runs with; yolo forces full access. */
export function permissionsFor(
  args: { sandbox?: string; approvals?: string },
  defaults: Defaults,
): { sandbox: CodexSandbox; approvals: CodexApprovals } {
  let approvals = (args.approvals ?? defaults.approvals) as CodexApprovals
  if (!APPROVALS.includes(approvals)) throw new CodexError(`approvals must be one of ${APPROVALS.join(', ')}`)
  // A project default of yolo with an explicit narrower sandbox: that sandbox, still no prompts.
  if (approvals === 'yolo' && args.approvals === undefined && args.sandbox !== undefined && args.sandbox !== 'full-access') {
    approvals = 'never'
  }
  if (approvals === 'yolo') {
    if (args.sandbox !== undefined && args.sandbox !== 'full-access') {
      throw new CodexError(`approvals yolo runs with sandbox full-access; sandbox "${args.sandbox}" contradicts it`)
    }
    return { sandbox: 'full-access', approvals }
  }
  const sandbox = (args.sandbox ?? defaults.sandbox) as CodexSandbox
  if (!SANDBOXES.includes(sandbox)) throw new CodexError(`sandbox must be one of ${SANDBOXES.join(', ')}`)
  return { sandbox, approvals }
}

// ------------------------------------------------------------ wake ledger

/**
 * Wake notices appended into a running main turn. A notice the engine stored
 * before one of the turn's model requests (a main-loop turn.step) began has
 * been read; one stored after the last request has not, and when the turn
 * ends it is pointed to with a short prompt; one whose append failed is sent
 * whole. Every notice thus reaches the model exactly once.
 */
export class WakeLedger {
  private entries: { name: string; text: string; state: 'pending' | 'stored' | 'failed' | 'seen' }[] = []

  add(name: string, text: string): number {
    this.entries.push({ name, text, state: 'pending' })
    return this.entries.length - 1
  }

  settle(index: number, isStored: boolean): void {
    const entry = this.entries[index]
    if (entry && entry.state === 'pending') entry.state = isStored ? 'stored' : 'failed'
  }

  /** A main-loop model request began: every stored notice is in it. */
  step(): void {
    for (const entry of this.entries) if (entry.state === 'stored') entry.state = 'seen'
  }

  /** At turn end: the prompt to submit (or null), and the ledger cleared. */
  flush(): string | null {
    const unread = this.entries.filter(entry => entry.state === 'stored' || entry.state === 'pending')
    const failed = this.entries.filter(entry => entry.state === 'failed')
    this.entries = []
    const parts = failed.map(entry => entry.text)
    if (unread.length > 0) {
      parts.push(
        `Codex agent${unread.length > 1 ? 's' : ''} ${unread.map(entry => entry.name).join(', ')} finished while your last turn was ending; the result notice is in the conversation above.`,
      )
    }
    return parts.length > 0 ? parts.join('\n\n') : null
  }

  reset(): void {
    this.entries = []
  }
}

// ------------------------------------------------------------ texts

export function describeAgent(agent: CodexAgent, now: number): string {
  const time = timeOf(agent, now)
  const doing = isLive(agent) ? agent.activity : (agent.lastTurnStatus ?? agent.status)
  return `${agent.id} ${agent.name} [${agent.model}/${agent.effort}, ${agent.sandbox}, approvals ${agent.approvals}] ${agent.status}${time ? ` ${time}` : ''}: ${clip(firstLine(doing), 100)}`
}

export function resultText(agent: CodexAgent, full: boolean, now: number): string {
  const lines = [describeAgent(agent, now)]
  if (agent.error) lines.push(`Error: ${agent.error}`)
  if (full && agent.digest.length > 0) lines.push('Turn digest:', ...agent.digest.map(line => `  ${line}`))
  lines.push(agent.lastMessage ? `Final message:\n${agent.lastMessage}` : 'No final message yet.')
  return lines.join('\n')
}

export const WAKE_PATTERN = /^Codex agent (\S+) \(([^)]+)\) finished: (\w+)/

export const wakeText = (agent: CodexAgent): string =>
  `Codex agent ${agent.name} (${agent.model}) finished: ${agent.lastTurnStatus ?? agent.status}` +
  ` after ${elapsed(agent.turnStartedAt, agent.turnEndedAt)}.` +
  `${agent.error ? ` Error: ${agent.error}.` : ''} Result: ${clip(agent.lastMessage || '(no message)', 1500)}` +
  `\n(id ${agent.id}; codex_result with full=true lists its commands and file changes, codex_send continues it.)`

export const spawnedText = (agent: CodexAgent): string =>
  `Spawned Codex agent ${agent.name} (id ${agent.id}) on ${agent.model}, effort ${agent.effort}, sandbox ${agent.sandbox}, approvals ${agent.approvals}, cwd ${agent.cwd}. ` +
  'It is working in the background; you will be notified with its result when it finishes. Do not poll: continue with other work, or codex_wait if there is nothing else to do.'

// ------------------------------------------------------------ tool specs

/** The tool specs; `defaults` are the effective ones (project config over userConfig) at session start. */
export function toolSpecs(defaults: Defaults): ToolSpec[] {
  const id = { type: 'string', description: 'The agent id or name (from codex_spawn or codex_list).' }
  return [
    {
      name: 'codex_spawn',
      description: [
        'Launch an OpenAI Codex agent as a background worker on a task, like the Agent tool but run by Codex.',
        'Returns at once with the agent id; the agent works in the background and you are notified with its result when it finishes (do not poll).',
        'Write a complete, self-contained prompt: the agent sees nothing of this conversation.',
        `model: luna (fast, cheap), sol (strongest), astra, terra, or a full Codex model id; default ${defaults.model}.`,
        `effort: thinking effort low, medium, high, xhigh, max (every model) or ultra (not luna); default ${defaults.effort}.`,
        `sandbox (OS-enforced): read-only, workspace-write (writes only inside cwd, plus /tmp and $TMPDIR as Codex allows by default), full-access; default ${defaults.sandbox}.`,
        `approvals: auto (Codex's own reviewer decides on escalations; in testing it approved writes outside the workspace, so it is looser than Claude's auto mode), ask (the user approves each escalation in a dialog), never (no escalation, the sandbox alone decides), yolo (full bypass: no sandbox and no approvals; pass it ONLY when the user explicitly asked for it in this request, never on your own initiative); default ${defaults.approvals}.`,
        `Per-project defaults for model, effort, sandbox and approvals can be set in ${PROJECT_CONFIG} (a project may make yolo its default); explicit arguments override them.`,
        'Follow up with codex_send (steer or continue), codex_stop, codex_result, codex_list, codex_wait.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for the agent.' },
          name: { type: 'string', description: 'A short name to address it by (default: the model alias, numbered).' },
          model: { type: 'string', description: `luna, sol, astra, terra or a full model id. Default ${defaults.model}.` },
          effort: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            description: `Thinking effort. Default ${defaults.effort}. ultra is not available on luna.`,
          },
          sandbox: { type: 'string', enum: SANDBOXES, description: `Default ${defaults.sandbox}.` },
          approvals: {
            type: 'string',
            enum: APPROVALS,
            description: `Default ${defaults.approvals}. yolo only on the user's explicit request (it implies sandbox full-access).`,
          },
          cwd: { type: 'string', description: "Absolute working directory (the writable workspace). Default: this session's directory." },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'codex_send',
      description:
        'Send a message to a Codex agent. While it is running the message is steered into the current turn (it reads it between steps); when it is idle, stopped or failed it starts a new turn on the same thread, keeping its history, sandbox and approvals. You are notified when that turn finishes.',
      inputSchema: {
        type: 'object',
        properties: { id, message: { type: 'string', description: 'What to tell the agent.' } },
        required: ['id', 'message'],
      },
    },
    {
      name: 'codex_stop',
      description: "Interrupt a running Codex agent's current turn. The thread stays usable: codex_send continues it.",
      inputSchema: { type: 'object', properties: { id }, required: ['id'] },
    },
    {
      name: 'codex_list',
      description: 'List the Codex agents with model, status and what each is doing.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'codex_result',
      description:
        "Read a Codex agent's result: its status and the final message of the last turn. With full=true also a digest of the turn: commands with exit codes, file changes and messages.",
      inputSchema: {
        type: 'object',
        properties: { id, full: { type: 'boolean', description: 'Include the turn digest.' } },
        required: ['id'],
      },
    },
    {
      name: 'codex_wait',
      description:
        'Block until a running Codex agent finishes its turn (or the timeout passes) and return its result. Only when you have nothing else to do: otherwise keep working, you are notified anyway.',
      inputSchema: {
        type: 'object',
        properties: { id, timeoutSec: { type: 'number', description: 'Seconds to wait, default 600, at most 3600.' } },
        required: ['id'],
      },
    },
  ]
}

export const COMMAND = {
  name: 'codex',
  description: 'Codex agents: open the pane, stop one, list models, or list and remove Codex allow rules',
  argumentHint: '[stop <name> | models | rules | rules rm <n>]',
}

// ------------------------------------------------------------ Codex allow rules

/** Codex's own rules file, where "Allow always" lands (relative to $HOME). */
export const RULES_FILE = '.codex/rules/default.rules'

/** The file's rule lines with their line index, numbered from 1 for /codex rules. */
export const ruleLines = (text: string): { line: number; rule: string }[] =>
  text
    .split('\n')
    .map((rule, line) => ({ line, rule: rule.trim() }))
    .filter(entry => entry.rule.startsWith('prefix_rule('))

/** The file without its n-th rule (1-based), or null when there is no such rule. */
export function withoutRule(text: string, n: number): { text: string; removed: string } | null {
  const target = ruleLines(text)[n - 1]
  if (!target) return null
  const lines = text.split('\n')
  lines.splice(target.line, 1)
  return { text: lines.join('\n'), removed: target.rule }
}
