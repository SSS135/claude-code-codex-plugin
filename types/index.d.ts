export type CodexSandbox = 'read-only' | 'workspace-write' | 'full-access'
/** yolo: no sandbox and no approvals; only on the user's explicit request or a project default. */
export type CodexApprovals = 'ask' | 'auto' | 'never' | 'yolo'
export type CodexStatus = 'starting' | 'running' | 'idle' | 'interrupted' | 'failed'

/** One Codex job: a Codex thread run under a native `codex:<alias>` subagent, keyed by that subagent's agentId. */
export type CodexAgent = {
  /** The native subagent's agentId, which SendMessage and TaskStop take. */
  id: string
  name: string
  /** The short task label the transcript and the pane show (the spawn's description, else its prompt's first line). */
  description: string
  threadId: string
  model: string
  effort: string
  sandbox: CodexSandbox
  approvals: CodexApprovals
  cwd: string
  status: CodexStatus
  /** The running turn, null when none runs. */
  currentTurnId: string | null
  /** The last turn that ended, null before the first ends. */
  lastTurnId: string | null
  /** completed | interrupted | failed, as Codex reported the last turn. */
  lastTurnStatus: string | null
  /** The final answer of the last turn (or the latest agent message). */
  lastMessage: string
  /** One line of what it is doing now. */
  activity: string
  lastCommand: string
  tokens: number
  error: string | null
  /** The key bin/codex-msg names this job by (in the thread's developer instructions). */
  msgKey: string
  /** codex-msg messages read from the bridge and not yet passed on to the main session. */
  outbox: string[]
  /** Compact lines of the current or last turn: commands, file changes, messages. */
  digest: string[]
  startedAt: number
  updatedAt: number
  turnStartedAt: number
  turnEndedAt: number
  sessionId: string
}

export type CodexApproval = {
  agentId: string
  requestId: number | string
  summary: string
}

declare module 'claude-code' {
  interface PluginState {
    codex: {
      agents: Record<string, CodexAgent>
      selected: string | null
      showResult: boolean
      approvals: CodexApproval[]
      /** Survives reloads: names this session's bridge daemon. */
      bridgeKey: string | null
    }
  }
}
