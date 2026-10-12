# Changelog

## 0.2.6

- Save each Codex agent atomically outside temporary and versioned directories; retain jobs across process restarts and independent Claude sessions.
- Reconcile `codex_list` and `codex_result` with native agents, including restored IDs under a changed session ID. List all session jobs and retain interrupted or missing jobs.
- Resume saved Codex threads before delivering `SendMessage`; refuse missing threads and end wrappers instead of retrying `codex_await` errors.
- Keep bridge waits below the host's 30-second HTTP cap and retry that timeout without declaring the Codex turn lost.
