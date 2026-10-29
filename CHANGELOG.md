# Changelog

## 0.2.10

- Clarify timing in `codex_list` and `codex_result`: running jobs show their elapsed time; finished jobs show `ran 7m 22s, finished 53m ago` alongside their status. The finish age uses the same `turnEndedAt` as the 30-minute filter. Older records without an end timestamp omit timing.
- Keep the default filter unchanged: a short runtime does not mean a job finished recently.

## 0.2.9

- Keep `codex_list` focused on active jobs and jobs finished within the last 30 minutes, newest first. With `all: true`, list the full session history.
- Record end times for jobs interrupted by a restart or failed outside a normal turn end, so they remain visible for the same 30-minute window.
- Report the number of older finished jobs hidden, including when no active or recently finished job remains. `codex_result` and `SendMessage` still reach every saved job.

## 0.2.8

- Fix a bridge that stayed down until Claude Code restarted. A terminal can preload a file of its own through `NODE_OPTIONS` and delete it later (cmux's `restore-node-options.cjs`); from then on every node the session started exited before running a line, so each restart of the bridge failed at once with "the codex bridge stopped". The bridge now runs with `NODE_OPTIONS` minus preloads of files no longer on disk, and its daemon, Codex and Codex's own node commands inherit that.
- A bridge that stops before it is ready refuses the Agent spawn or codex call with how it ended, the last lines it wrote to stderr (or the daemon log's tail) and what to do. Every later codex call or spawn starts it again; no restart of Claude Code is needed.
- Check the Codex CLI version at each bridge start (`codex --version`, read once by the relay): a CLI older than 0.160.0 refuses each codex:* spawn with the version found, the version needed and how to update; `codex_list` and `codex_result` still read jobs and add a warning. A CLI that does not run refuses with the reason and how to install it.
- Fix a deadlock under many simultaneous jobs: the bridge's registry HTTP server now runs on a worker thread. Before, a bridge blocked in a synchronous stdout write (host not draining the pipe while its handler awaited a registry call) left every registry read/write timing out after 30 s until the bridge was restarted.
- A codex binary that is not found (`spawn codex ENOENT`, e.g. after nvm switches Node versions, whose global npm packages are per version) now says how to fix it: install `@openai/codex` for the node on PATH or set `codexPath`.

## 0.2.7

- Codex `error` notifications (model capacity, rate limits, retries, failed remote compaction) are warnings, never a job failure: `codex_list`, `codex_result` and the turn digest show them, the job stays running and its wrapper keeps awaiting.
- The bridge holds a failed `turn/completed` for 30 s (`CODEX_BRIDGE_FAILED_HOLD_MS`) and drops it when the thread works on; a failure with no work after it ends the turn then.
- A settled job whose thread shows new items runs again, with a warning; a failed turn keeps its thread subscribed so such work is seen.

## 0.2.6

- Save each Codex agent atomically outside temporary and versioned directories; retain jobs across process restarts and independent Claude sessions.
- Reconcile `codex_list` and `codex_result` with native agents, including restored IDs under a changed session ID. List all session jobs and retain interrupted or missing jobs.
- Resume saved Codex threads before delivering `SendMessage`; refuse missing threads and end wrappers instead of retrying `codex_await` errors.
- Keep bridge waits below the host's 30-second HTTP cap and retry that timeout without declaring the Codex turn lost.
