export type CodexSandbox = 'read-only' | 'workspace-write' | 'full-access'
/** yolo: no sandbox and no approvals; only on the user's explicit request or a project default. */
export type CodexApprovals = 'ask' | 'auto' | 'never' | 'yolo'
export type CodexStatus = 'starting' | 'running' | 'idle' | 'interrupted' | 'failed'
/** A message a Codex job sent with message_agent: to an agent by name or id, or to main when `to` is absent. */
export type OutboxItem = { text: string; to?: string }

/** One Codex job: a Codex thread run under a native `codex:<alias>` subagent, keyed by that subagent's agentId. */
export type CodexAgent = {
  /** The native subagent's agentId, which SendMessage and TaskStop take. */
  id: string
  name: string
  /** The short task label the transcript shows (the spawn's description, else its prompt's first line). */
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
  tokens: number
  error: string | null
  /** The latest non-terminal Codex error (a retry, a failed compaction, work after a reported end); the job runs on. */
  warning?: string | null
  /** The key bin/codex-msg names this job by (in the thread's developer instructions). */
  msgKey: string
  /** codex-msg messages read from the bridge and not yet passed on; `to` names the recipient agent, absent for main. */
  outbox: OutboxItem[]
  /** Compact lines of the current or last turn: commands, file changes, messages. */
  digest: string[]
  /** Capacity-retry marker: when a turn that failed at capacity is retried with "continue"; set while the job waits for that. */
  capacityRetryAt?: number | null
  /** Capacity-retry marker: the retries made so far; a turn start other than such a retry, or a normal end, resets it to 0. */
  capacityRetries?: number
  /** The ended turn (its lastTurnId, '' for none) whose result the wrapper handed back; null once a turn runs again. */
  handedBackTurnId?: string | null
  /** When the user stopped it (TaskStop, codex_stop): other agents' messages are refused until main's SendMessage resumes it. */
  stoppedAt?: number | null
  /** The Codex job whose relayed message last resumed the wrapper: the engine hands the wrapper's report to that job's wrapper, which never reads it, so main gets a copy (#18). */
  resumedBy?: string | null
  startedAt: number
  updatedAt: number
  turnStartedAt: number
  turnEndedAt: number
  sessionId: string
}

declare module 'claude-code' {
  interface PluginState {
    codex: {
      agents: Record<string, CodexAgent>
      /** Survives reloads: names this session's bridge daemon. */
      bridgeKey: string | null
    }
  }
}
