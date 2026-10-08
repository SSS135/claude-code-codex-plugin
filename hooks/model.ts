// Pure logic of the codex plugin: no `$` here (the engine follows `$` only
// within one file, so every engine call lives in register.tsx). Codex
// protocol parameters, how events change an agent, and the texts the model
// and the person read.

import type { EngineInterface, ToolSpec } from 'claude-code'

import type { CodexAgent, CodexApprovals, CodexSandbox } from '../types'

export type Settings = {
  codexPath: string
  nodePath: string
  /** Undefined (userConfig per-model): each model's built-in effort (MODEL_EFFORTS). */
  defaultEffort: string | undefined
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

/** Where $.http.fetch sends a bridge endpoint: over the daemon's Unix socket, or on Windows to its loopback URL, which carries the daemon's secret (bin/bridge.mjs). */
export const bridgeTarget = (socket: string, endpoint: string): { url: string; socketPath?: string } =>
  /^https?:/.test(socket) ? { url: `${socket}${endpoint}` } : { url: `http://codex${endpoint}`, socketPath: socket }

export const PREFIX = 'mcp__codex__'
export const SANDBOXES: CodexSandbox[] = ['read-only', 'workspace-write', 'full-access']
export const APPROVALS: CodexApprovals[] = ['auto', 'ask', 'never', 'yolo']
export const MAX_AGENTS = 40

export const MODEL_ALIASES: Record<string, string> = {
  luna: 'gpt-6-luna',
  sol: 'gpt-6.1-sol',
  astra: 'gpt-6-astra',
  terra: 'gpt-5.6-terra',
}

/** Each model's built-in effort, used when neither userConfig nor the project sets one. */
export const MODEL_EFFORTS: Record<string, string> = { luna: 'max', sol: 'high', astra: 'high', terra: 'high' }
/** The defaultEffort userConfig value (its default) that leaves effort to MODEL_EFFORTS. */
export const PER_MODEL_EFFORT = 'per-model'

/** The alias a model id belongs to, by its family suffix (`gpt-5.6-luna` is luna too); else the id. */
export const aliasOf = (model: string): string =>
  Object.keys(MODEL_ALIASES).find(alias => model === MODEL_ALIASES[alias] || model.endsWith(`-${alias}`)) ?? model

export const UPDATE_HINT = 'Update the Codex CLI: npm i -g @openai/codex@latest, or update the ChatGPT app on macOS.'

/**
 * The model a `codex:<alias>` spawn runs: the alias's own when this Codex CLI
 * lists it, else (an older CLI) the first listed, newest, of the alias's family,
 * else the alias's own, which modelEffortError then refuses.
 */
export const modelFor = (models: Map<string, string[]>, alias: string): string => {
  const wanted = MODEL_ALIASES[alias] as string
  if (models.has(wanted)) return wanted
  return [...models.keys()].find(id => id.endsWith(`-${alias}`)) ?? wanted
}

/** The warning when an older Codex CLI made a spawn fall back to `used`. */
export const fallbackWarning = (alias: string, used: string): string =>
  `codex: this Codex CLI has no ${MODEL_ALIASES[alias]}, so codex:${alias} runs ${used}. ${UPDATE_HINT}`

// ------------------------------------------------------------ text helpers

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

export const elapsed = (from: number, to: number): string => {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
}

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `${tokens} tok`

export const isLive = (agent: CodexAgent): boolean => agent.status === 'running' || agent.status === 'starting'

export const timeOf = (agent: CodexAgent, now: number): string =>
  isLive(agent) ? elapsed(agent.turnStartedAt, now) : agent.turnEndedAt ? elapsed(agent.turnStartedAt, agent.turnEndedAt) : ''

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
  while (taken.has(`${wanted} (${n})`)) n += 1
  return `${wanted} (${n})`
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

export const threadResumeParams = (agent: CodexAgent, messaging: MessagingParams | undefined) => ({
  threadId: agent.threadId,
  model: agent.model,
  cwd: agent.cwd,
  sandbox: sandboxMode(agent.sandbox),
  ...approvalParams(agent.approvals),
  excludeTurns: true,
  ...messaging,
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
  if (!efforts) {
    // An alias's own model, missing with no family fallback: the CLI predates it.
    const hint = Object.values(MODEL_ALIASES).includes(model) ? ` This Codex CLI is too old for it. ${UPDATE_HINT}` : ''
    return `Unknown Codex model "${model}". Use luna, sol, astra, terra or one of: ${[...models.keys()].join(', ')}.${hint}`
  }
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

/** Codex on Windows: `"C:\...\pwsh.exe" -NoProfile -Command <script>`, the script quoted when it has spaces. */
const POWERSHELL = /^(?:"[^"]*[\\/]|[^"\s]*[\\/])?"?(?:pwsh|powershell)(?:\.exe)?"? (?:-\w+ )*?-Command (?:'(.*)'|"(.*)"|(.*))$/is

export const shortCommand = (command: string): string =>
  clip(command.replace(/^\/bin\/(ba|z)?sh -lc '(.*)'$/s, '$2').replace(POWERSHELL, '$1$2$3'), 160)

const changeKind = (kind: unknown) =>
  typeof kind === 'string' ? kind : typeof kind === 'object' && kind !== null ? String((kind as { type?: string }).type ?? 'edit') : 'edit'

export function itemStarted(item: Item): Partial<CodexAgent> | null {
  if (item.type === 'commandExecution' && item.command) return { activity: `$ ${shortCommand(item.command)}` }
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

/** `effort` undefined: the model's own built-in (effortFor). */
export type Defaults = { effort: string | undefined; sandbox: CodexSandbox; approvals: CodexApprovals }

export const PROJECT_CONFIG = '.claude/codex.json'

/** Parses a project's .claude/codex.json: optional defaults {effort, sandbox, approvals}. */
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
  for (const key of ['effort', 'sandbox', 'approvals'] as const) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') throw new CodexError(`${path}: "${key}" must be a non-empty string`)
    if (key === 'sandbox' && !SANDBOXES.includes(value as CodexSandbox)) throw new CodexError(`${path}: sandbox must be one of ${SANDBOXES.join(', ')}`)
    if (key === 'approvals' && !APPROVALS.includes(value as CodexApprovals)) throw new CodexError(`${path}: approvals must be one of ${APPROVALS.join(', ')}`)
    if (key === 'sandbox') out.sandbox = value as CodexSandbox
    else if (key === 'approvals') out.approvals = value as CodexApprovals
    else out.effort = value
  }
  return out
}

/** The directories from `cwd` up to `root` (or up to / when cwd is not under root); Windows paths split at \ too and end at the drive, `X:`. */
export function configDirs(cwd: string, root: string): string[] {
  const dirs: string[] = []
  const top = root.replace(/[\\/]+$/, '') || '/'
  let dir = cwd.replace(/[\\/]+$/, '') || '/'
  for (;;) {
    dirs.push(dir)
    const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
    if (dir === top || dir === '/' || cut < 0) return dirs
    dir = dir.slice(0, cut) || '/'
  }
}

/** Precedence: prompt header lines > project config > userConfig > built-ins (sandbox and approvals: the manifest defaults; effort: MODEL_EFFORTS). */
export const effectiveDefaults = (settings: Settings, project: Partial<Defaults>): Defaults => ({
  effort: project.effort ?? settings.defaultEffort,
  sandbox: project.sandbox ?? settings.defaultSandbox,
  approvals: project.approvals ?? settings.defaultApprovals,
})

/** The effort a `codex:<alias>` spawn runs with when its prompt sets none. */
export const effortFor = (defaults: Defaults, alias: string): string => defaults.effort ?? (MODEL_EFFORTS[alias] as string)

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

// ------------------------------------------------------------ codex-msg

/** The MCP server, bin/codex-msg, through which a job messages the session; Codex starts it outside the job's sandbox. */
export const MSG_SERVER = 'claude_session'

/** What thread/start and thread/resume take so a job can message the session: the server in `config`, its use in the developer instructions. */
export const messagingParams = (node: string, root: string, socketPath: string, key: string) => ({
  config: { mcp_servers: { [MSG_SERVER]: { command: node, args: [`${root}/bin/codex-msg`, socketPath, key] } } },
  developerInstructions: [
    'You run as a background job of a Claude Code session, which gets your final message when your turn ends.',
    `To message that session while you work, call the message_claude tool of the ${MSG_SERVER} MCP server with the text.`,
    'Use it for a question you need answered, a blocker, or an important interim finding; never for progress updates, and never for your final result.',
    'A reply, when the session sends one, arrives as a new user message in your turn; keep working on what you can while you wait for it.',
  ].join('\n'),
})

export type MessagingParams = ReturnType<typeof messagingParams>

// ------------------------------------------------------------ native agent types

/**
 * Each model alias is a native agent type, `codex:<alias>`. Its subagent is a
 * wrapper: the plugin starts the Codex turn with the spawn's own prompt, and
 * answers every model request of the wrapper's loop itself (turn.step), so no
 * Claude model reads or rewrites the task or the result.
 */
export const AGENT_PREFIX = 'codex:'
export const AWAIT_TOOL = `${PREFIX}codex_await`
/** The wrapper's Claude model: named because the definition needs one, and never called. */
export const WRAPPER_MODEL = 'haiku'
/** How a background subagent hands its report back where the engine requires it (auto mode); elsewhere its final text is the report. */
export const HANDBACK_TOOL = 'SubagentHandback'

type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

/** The alias a `codex:<alias>` agent type names, or undefined for any other type. */
export const aliasOfType = (subagentType: string): string | undefined => {
  if (!subagentType.startsWith(AGENT_PREFIX)) return undefined
  const alias = subagentType.slice(AGENT_PREFIX.length)
  return alias in MODEL_ALIASES ? alias : undefined
}

/** When to pick each type: the main model reads this first in the agent listing. */
const WHEN_TO_USE: Record<string, string> = {
  sol: 'Default Codex agent for normal tasks: implementation, debugging, analysis, review, anything needing judgement.',
  luna: 'For simple mechanical work and searches: find/grep/list, bulk renames, boilerplate, straightforward well-specified edits, data gathering. Cheap and fast; not for tasks needing judgement (use codex:sol).',
  astra: 'Use ONLY when the user explicitly asks for astra; otherwise use codex:sol.',
  terra: 'Use ONLY when the user explicitly asks for terra; otherwise use codex:sol.',
}

const effortsOf = (alias: string): string => (alias === 'luna' ? 'low|medium|high|xhigh|max' : 'low|medium|high|xhigh|max|ultra')

/** The listing line the main model reads for `codex:<alias>`; `defaults` are the effective ones at session start. */
export function agentDescription(alias: string, defaults: Defaults): string {
  const model = MODEL_ALIASES[alias] as string
  return [
    `${WHEN_TO_USE[alias]} OpenAI Codex on ${model}, effort ${effortFor(defaults, alias)}.`,
    'Codex gets your prompt verbatim, sees nothing of this conversation, and its final message is the result. Always runs in the background.',
    'Optional header lines at the top of the prompt, stripped before Codex sees it:',
    `"effort: ${effortsOf(alias)}";`,
    `"sandbox: read-only|workspace-write|full-access" (OS-enforced; workspace-write writes only in the cwd plus the temp directory; default ${defaults.sandbox});`,
    `"approvals: auto|ask|never|yolo" (default ${defaults.approvals}; auto: Codex's own reviewer decides escalations, looser than Claude's auto mode; ask: the user approves each; never: the sandbox alone decides; yolo: no sandbox and no approvals, ONLY when the user explicitly asked for it).`,
    `Project defaults: ${PROJECT_CONFIG}.`,
    'Codex may message you mid-task as this agent. SendMessage to it steers the running Codex turn, or starts a new turn on the same thread once it finished; TaskStop interrupts it.',
  ].join(' ')
}

/** What the wrapper's model would follow if it ever ran (only when the plugin's turn.step hook failed). */
export const WRAPPER_PROMPT = [
  'You relay one OpenAI Codex job that the codex plugin has already started with your task.',
  `Call the ${AWAIT_TOOL} tool with no arguments: it blocks until the Codex turn ends. While it says the job is still running, call it again.`,
  'When it returns a message from Codex for the main session, send exactly that text with SendMessage to "main", then call it again.',
  `When it returns the result, deliver exactly that text, nothing added, removed or reworded: with ${HANDBACK_TOOL} when you have that tool, else as your reply.`,
  'Never do the task yourself and never call any other tool.',
].join(' ')

export const agentSpecs = (defaults: Defaults): AgentSpec[] =>
  Object.keys(MODEL_ALIASES).map(alias => ({
    name: alias,
    description: agentDescription(alias, defaults),
    prompt: WRAPPER_PROMPT,
    tools: [AWAIT_TOOL, 'SendMessage', HANDBACK_TOOL],
    model: WRAPPER_MODEL,
    background: true,
    omitClaudeMd: true,
  }))

const HEADER_KEYS = ['effort', 'sandbox', 'approvals'] as const
type HeaderKey = (typeof HEADER_KEYS)[number]
export type PromptHeader = Partial<Record<HeaderKey, string>> & { body: string }

const HEADER_LINE = /^[ \t]*(effort|sandbox|approvals)[ \t]*:[ \t]*(\S+)[ \t]*$/i

/** Reads the `effort:`, `sandbox:` and `approvals:` lines at the top of a prompt; `body` is the rest, as given. */
export function parseHeader(prompt: string): PromptHeader {
  const lines = prompt.split('\n')
  const header: PromptHeader = { body: prompt }
  let count = 0
  for (const line of lines) {
    const match = HEADER_LINE.exec(line)
    if (!match) break
    const key = (match[1] as string).toLowerCase() as HeaderKey
    if (header[key] !== undefined) throw new CodexError(`the prompt's header sets ${key} twice`)
    header[key] = (match[2] as string).toLowerCase()
    count += 1
  }
  if (count > 0) header.body = lines.slice(count).join('\n').replace(/^(?:[ \t]*\n)+/, '')
  return header
}

/** The wrapper's final answer once the Codex turn ended: on success the Codex final message, verbatim. */
export function wrapperAnswer(agent: CodexAgent): string {
  if (agent.status === 'failed') return `Codex failed: ${agent.error ?? 'the turn failed'}`
  if (agent.status === 'interrupted') return agent.error ? `Codex turn interrupted: ${agent.error}` : 'Codex turn interrupted.'
  return agent.lastMessage || '(Codex finished without a final message.)'
}

// ------------------------------------------------------------ texts

export function describeAgent(agent: CodexAgent, now: number): string {
  const time = timeOf(agent, now)
  const doing = isLive(agent) ? agent.activity : (agent.lastTurnStatus ?? agent.status)
  return `${agent.id} ${agent.name} [${agent.model}/${agent.effort}, ${agent.sandbox}, approvals ${agent.approvals}] ${agent.status}${time ? ` ${time}` : ''}, ${formatTokens(agent.tokens)}: ${clip(firstLine(doing), 100)}`
}

/** How many of a session's jobs codex_list shows. */
export const LIST_LIMIT = 10

/** codex_list: the session's jobs, newest first (`agents` sorted so), the latest LIST_LIMIT of them. */
export function listText(agents: readonly CodexAgent[], sessionId: string, now: number): string {
  const mine = agents.filter(agent => agent.sessionId === sessionId)
  if (mine.length === 0) return 'No Codex agents in this session. The Agent tool starts one with subagent_type codex:luna, codex:sol, codex:astra or codex:terra.'
  const lines = mine.slice(0, LIST_LIMIT).map(agent => describeAgent(agent, now))
  const older = mine.length - LIST_LIMIT
  if (older > 0) lines.push(`${older} older (codex_result still reads them by id).`)
  return lines.join('\n')
}

export function resultText(agent: CodexAgent, full: boolean, now: number): string {
  const lines = [describeAgent(agent, now)]
  if (agent.error) lines.push(`Error: ${agent.error}`)
  if (full && agent.digest.length > 0) lines.push('Turn digest:', ...agent.digest.map(line => `  ${line}`))
  lines.push(agent.lastMessage ? `Final message:\n${agent.lastMessage}` : 'No final message yet.')
  return lines.join('\n')
}

// ------------------------------------------------------------ transcript rows

export type ToolName = 'codex_list' | 'codex_result' | 'codex_await'

/** The short task label: the spawn's `description`, else its prompt's first line. */
export const taskLabel = (input: { description?: string; prompt?: string }): string =>
  firstLine(input.description ?? '') || clip(firstLine(input.prompt ?? ''), 80)

/** A tool's result as text: a plugin tool's is a string, or text blocks. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(part => (part as { text?: unknown }).text).filter(text => typeof text === 'string').join('\n')
  if (typeof output === 'object' && output !== null && typeof (output as { text?: unknown }).text === 'string') return (output as { text: string }).text
  return ''
}

/** What goes in a row's parentheses: the verb and the agent addressed. */
export function rowArgs(tool: ToolName, input: Record<string, unknown>): string {
  const verb = tool.slice('codex_'.length)
  return typeof input.id === 'string' && input.id.trim() ? `${verb} ${input.id.trim()}` : verb
}

export const STILL_RUNNING = 'Codex is still running'

/** The row's result line once the call succeeded, read from the model's text: main text and a dim tail. */
export function rowResult(tool: ToolName, text: string): { main: string; dim: string } {
  switch (tool) {
    case 'codex_list': {
      const lines = text.split('\n').filter(line => / \[[^\]]*\] \w+/.test(line))
      if (lines.length === 0) return { main: 'No agents', dim: '' }
      const running = lines.filter(line => /\] (running|starting)\b/.test(line)).length
      return { main: `${lines.length} agent${lines.length === 1 ? '' : 's'} · ${running} running`, dim: '' }
    }
    case 'codex_result': {
      const status = /\] (\w+)/.exec(text)?.[1] ?? 'done'
      const final = /^Final message:\n(.*)$/m.exec(text)?.[1]
      return { main: status === 'idle' ? 'done' : status, dim: final ? ` · ${firstLine(final)}` : '' }
    }
    case 'codex_await':
      return text.startsWith(STILL_RUNNING) ? { main: 'still running', dim: '' } : { main: 'done', dim: ` · ${firstLine(text)}` }
  }
}

/** The footer text while agents run, beside the prompt's hint line; undefined when none run. */
export function runningTail(agents: CodexAgent[]): string | undefined {
  const live = agents.filter(isLive)
  if (live.length === 0) return undefined
  if (live.length > 3) return `${live.length} codex agents running`
  return `codex: ${live.map(agent => `${agent.name} (${aliasOf(agent.model)})`).join(' · ')}`
}

// ------------------------------------------------------------ tool specs

const ID_PARAM = { type: 'string', description: "The agent id (the codex:* agent's agentId) or its name, as codex_list shows them." }

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'codex_list',
    description: `List this session's Codex jobs (codex:* agents), newest first, the latest ${LIST_LIMIT}: model, status and what each is doing.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codex_result',
    description:
      "Read a Codex job's result: its status and the final message of the last turn. With full=true also a digest of the turn: commands with exit codes, file changes and messages.",
    inputSchema: {
      type: 'object',
      properties: { id: ID_PARAM, full: { type: 'boolean', description: 'Include the turn digest.' } },
      required: ['id'],
    },
  },
  {
    name: 'codex_await',
    description: "Internal to codex:* agents, which call it themselves: blocks until the agent's Codex turn ends. Never call it.",
    inputSchema: { type: 'object', properties: {} },
  },
]

/** The label of the wrapper's own SendMessage row (not sent: the message is). */
export const messageSummary = (text: string): string => `Codex: ${clip(firstLine(text), 60)}`
