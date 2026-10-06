export type CodexSandbox = 'read-only' | 'workspace-write' | 'full-access'
/** yolo: no sandbox and no approvals; only on the user's explicit request or a project default. */
export type CodexApprovals = 'ask' | 'auto' | 'never' | 'yolo'
export type CodexStatus = 'starting' | 'running' | 'idle' | 'interrupted' | 'failed'

export type CodexAgent = {
  id: string
  name: string
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
  /** Compact lines of the current or last turn: commands, file changes, messages. */
  digest: string[]
  /** Wake the main session when the running turn ends. */
  notify: boolean
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
      /** tool_use_id of a codex_spawn / codex_send row -> agent id */
      calls: Record<string, string>
      mainBusy: boolean
      approvals: CodexApproval[]
      /** Survives reloads: names this session's bridge daemon. */
      bridgeKey: string | null
    }
  }
}
