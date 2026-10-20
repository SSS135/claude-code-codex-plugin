# Changelog

## 0.2.10-goldmar.5

- Replay Codex commentary, public progress summaries and plans as full assistant markdown blocks. Preserve paragraphs, lists and code fences instead of flattening and truncating messages into activity lines.
- Replay completed shell commands as native Bash tool calls with recorded exit/duration results. Receipt-bound hooks return metadata without executing commands or invoking a Claude model; native transcript rendering owns compact rows, grouping and expansion.
- Preserve replay order through startup persistence and terminal completion. Hide all await transport chrome, including completed/message-relay waits. Keep the 45-second quiet window, two-second observation, stop/steer behavior and final handback.
- Keep command previews sanitized and bounded with script bodies hidden; never replay raw output, patches, config or raw reasoning. Bound queued activity with explicit omission notices, preserving each accepted message whole.
- Add engine regressions for multiple text/tool blocks, native render delegation on both surfaces, receipt isolation, cancellation and zero fallback model requests. Installation remains a separate quiet-window operation.

## 0.2.10-goldmar.4

- Make live activity header-free and suppress routine await rows, including silent 45-second quiet waits. Keep internal two-second observation and the independent native stop path.
- Show each command once on completion, with exit code and duration when available. Strip shell wrappers, hide heredoc and inline interpreter bodies, drop redacted fragments, and limit every event line to 120 characters.
- Lead batches with Codex commentary and public reasoning summaries; never display raw reasoning. Show plan completion counts, at most the last three commands and an omitted-command count. Keep incremental, exact-turn, sanitized and bounded delivery.
- Add activity and real-engine regressions for quiet waits, both UI surfaces, command coalescing, script previews, redaction, summaries and burst limits. Installation remains a separate quiet-window operation.

## 0.2.10-goldmar.3

- Read the engine's `{ agentId }` resume binding, with compatibility for the old string form. Find saved 0.2.10/goldmar.1 jobs by explicit ID or name across session changes; preserve their thread and permissions. Prefer native IDs over historical name collisions; ambiguous saved names and missing records refuse with a readable reason.
- Verify the saved thread and obtain engine delivery acceptance before starting or steering native work. Keep the wrapper awaiting during this handoff; an engine refusal admits no native input. A confirmed native refusal stays refused, while lost responses after admission remain accepted and pending without repeating the payload.
- Preserve accepted native outcomes across registry persistence, acknowledgement and hook deadline failures. Failed new-job persistence starts no native turn; uncertain initial starts and capacity retries remain owned for reconciliation rather than being marked failed.
- Preserve TaskStop's object output (`message`, `task_id`, `task_type`, optional `command`) on every path. A refused/failed engine stop does not interrupt Codex; unconfirmed native stops remain explicit.
- Add real-engine handoff, resume-object, deadline, TaskStop-shape and persistence regressions, plus read-only legacy registry fixtures. Installation remains a separate quiet-window operation.

## 0.2.10-goldmar.2

- Keep wrappers awaiting through transient hook, registry and bridge failures with bounded retries; a ready-time registry failure no longer poisons a healthy relay. An unknown backend outcome stays live.
- Retain stop requests in the daemon across wrapper cancellation and late starts, retry interruption at most three times and require the exact native terminal outcome before reporting interrupted. Reconcile interrupted notifications against continued native work; a saved stop request suppresses late automatic capacity retries until explicit new input.
- Preserve the existing Codex thread, history and saved permissions when Claude resumes a wrapper for SendMessage; never replace its record with a thread containing only the follow-up.
- Verify current Linux kernel writer ownership rather than guessing a previous bridge or trusting stale files/PIDs. Retry released-owner resume conflicts at most twice; never remove locks or disturb another process.
- Add engine, bridge and native regressions, including original prompt/assistant history after unload. Document project sandbox defaults and userConfig reset on reinstall. Installation remains a separate quiet-window operation.

## 0.2.10-goldmar.1

- Serialize the full SendMessage decision and preserve structured RPC errors. A refused or ambiguous steer never starts a replacement turn.
- Correlate activity, failure holds, completions and waiters by exact turn; terminal/superseded items cannot revive old work or settle a newer turn.
- Reconcile all terminal threads, including failures and wait-observed completions, against server activity. Keep release ownership until a recognized unsubscribe acknowledgement, retry rejected cleanup, and serialize it with new loads/starts.
- Retain asynchronous RPC outcomes in the daemon across cancelled/timed-out HTTP polls, deduplicate operation handles, and release abandoned idle starts/resumes.
- Show bounded, sanitized Codex activity batches in the agent detail transcript while waiting, including messages, command exits, changed paths and plans.
- Retry only confirmed terminal structured overload with no partial work, at most twice within 120 seconds on the same thread/model; respect retry hints and avoid duplicating Codex-owned recovery.
- Fail closed on known Codex wrapper hook/bridge failures through the engine's streaming error handler, preserving backend ownership instead of falling through to a Claude model.
- Stop the owned app-server process group on daemon shutdown; cleanup-only failures cannot indefinitely postpone the ten-minute idle backstop, while active turns and pending admissions remain protected.
- Keep upstream MIT attribution, links, plugin and marketplace names. Installation remains a separate quiet-window operation; see `docs/goldmar-rollout.md`.

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

## 0.2.7

- Codex `error` notifications (model capacity, rate limits, retries, failed remote compaction) are warnings, never a job failure: `codex_list`, `codex_result` and the turn digest show them, the job stays running and its wrapper keeps awaiting.
- The bridge holds a failed `turn/completed` for 30 s (`CODEX_BRIDGE_FAILED_HOLD_MS`) and drops it when the thread works on; a failure with no work after it ends the turn then.
- A settled job whose thread shows new items runs again, with a warning; a failed turn keeps its thread subscribed so such work is seen.

## 0.2.6

- Save each Codex agent atomically outside temporary and versioned directories; retain jobs across process restarts and independent Claude sessions.
- Reconcile `codex_list` and `codex_result` with native agents, including restored IDs under a changed session ID. List all session jobs and retain interrupted or missing jobs.
- Resume saved Codex threads before delivering `SendMessage`; refuse missing threads and end wrappers instead of retrying `codex_await` errors.
- Keep bridge waits below the host's 30-second HTTP cap and retry that timeout without declaring the Codex turn lost.
