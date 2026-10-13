# Changelog

## 0.2.7

- Codex `error` notifications (model capacity, rate limits, retries, failed remote compaction) are warnings, never a job failure: `codex_list`, `codex_result` and the turn digest show them, the job stays running and its wrapper keeps awaiting.
- The bridge holds a failed `turn/completed` for 30 s (`CODEX_BRIDGE_FAILED_HOLD_MS`) and drops it when the thread works on; a failure with no work after it ends the turn then.
- A settled job whose thread shows new items runs again, with a warning; a failed turn keeps its thread subscribed so such work is seen.

## 0.2.6

- Save each Codex agent atomically outside temporary and versioned directories; retain jobs across process restarts and independent Claude sessions.
- Reconcile `codex_list` and `codex_result` with native agents, including restored IDs under a changed session ID. List all session jobs and retain interrupted or missing jobs.
- Resume saved Codex threads before delivering `SendMessage`; refuse missing threads and end wrappers instead of retrying `codex_await` errors.
- Keep bridge waits below the host's 30-second HTTP cap and retry that timeout without declaring the Codex turn lost.
