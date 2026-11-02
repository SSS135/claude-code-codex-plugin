# Changelog

## 1.0.4

Fixed:

- A `Codex(...)` row in the transcript has the blank line above it that native tool rows have.

## 1.0.3

Fixed:

- Wrapper agents no longer fail en masse under load, losing turns (#7, #12, #14). A wrapper step whose `turn.step` hook fails or runs out of time is answered with another `codex_await` call instead of falling to the wrapper's Claude model, whose prompt now says to call `codex_await` again on an error and never to compose a message or report of its own.
- `codex_await` rides out a bridge outage: while the relay is down or restarting it tries again every 10 s within its wait instead of ending the job. A daemon that stops mid-turn still ends the job as interrupted.
- The relay is started from the session's `session.start` hook, so one restarted during a short hook (such as `codex_await`) is no longer killed when that hook ends. After an outage each call starts it up to 3 times.
- Hooks wait for the bridge without spending their time budget. Agent spawns, `codex_list`, `codex_result` and `SendMessage` retry while the bridge restarts; only a refused connection is retried, so a request that reached the daemon is never sent twice.
- Refusals say why: "the message did not reach Codex", "the Codex job did not start" and the `codex_await`, `codex_list` and `codex_result` refusals now carry the hook failure's kind and message (#11).
- `SendMessage` to a finished or interrupted job, also one Claude Code no longer lists as an agent, starts a new turn on its thread (#8, #14). Where `SendMessage`'s hook did not start it, the resume starts the turn from the message. A resumed wrapper never hands back the previous result again; when no new turn ran, it says so.
- Jobs whose wrapper ended stay reachable while they run or within 30 minutes of finishing: `list_agents` shows them, `message_agent` reaches them, and their names count as taken for new Agent calls.
- The final message is no longer cut at 20,000 characters: the hand-back and `codex_result` carry it whole (#9). The 20,000-character cap on `message_agent` messages is unchanged.
- The daemon no longer ends Codex and its running turns when the relay goes away while Claude Code still runs: it keeps them while the Claude Code process lives, and exits 20 s after that process is gone. The 10-minute idle exit (no turn running, no request) now applies with or without a relay.
- A job started while another spawn or a cold bridge kept the plugin busy no longer stays `starting` forever: the spawn hook returns once the subagent exists and the first turn starts after it, outside the hook's time budget. When that start fails or hangs for 60 s, `codex_await` starts the turn itself; a start lost to a plugin reload ends the job as failed with the reason.
- A relay no longer starts a second daemon over a busy one: it asks `/health` 3 times, 5 s each, and when the daemon's pid lives, waits up to 30 s more, then fails with a message to end that process. A daemon's cleanup removes only its own directory.

Changed:

- `codex_await`'s answer for a Codex message carries each message's recipient and full text, so the wrapper relays the real text.
- Codex's own sub-agents (helpers a job starts with Codex's agent tools) are told to report to their lead through Codex's tools and not to use the `claude_agents` tools; only the job itself messages Claude-side agents (#10).
- The daemon log moved from `<dir>/daemon.log` to `<dir>.log` beside the daemon directory (`/tmp/cxb-<uid>/`, on Windows `%TEMP%\cxb\`), so it survives the daemon's shutdown. It has one timestamped line per lifecycle event: relay attach and detach, the Claude Code pid watched and gone, Codex start and exit (with code and stderr tail), grace, shutdown reason, health waits and relaunches, idle exit. Over 1 MiB at launch it is cut to its last 256 KiB.

## 1.0.2

Fixed:

- An agent type named after a built-in object key (`codex:constructor`, `codex:toString`) is no longer taken for a Codex agent; only `codex:luna`, `codex:sol`, `codex:astra` and `codex:terra` are. Found by @tahirmajid.

Changed:

- The README no longer says a job costs no Claude tokens: the plugin calls no Claude model, but Claude Code's own background-agent summarizer (a small Haiku call reading the wrapper's transcript) runs for these agents as for any background subagent.

## 1.0.1

Fixed:

- A Codex turn that failed now releases its thread too, so Codex unloads it and stops its MCP servers (`codex-msg` and others); a later `SendMessage` resumes the thread first.
- On macOS and Linux, stopping the bridge daemon now also stops the processes Codex started (its MCP servers), not only Codex: Codex runs in its own process group, which gets SIGTERM, then SIGKILL after 1 s. When Codex exits on its own, what is left of that group is stopped too.
- A message is no longer sent to Codex twice: when steering the running turn times out, `SendMessage` reports it as not delivered (Codex may already have it) instead of starting a new turn with it, and two messages sent at once to a finished job start one turn, the second steering it.
- A Codex thread started for an Agent call whose spawn then fails is released instead of staying loaded.
- `SendMessage` to a finished job no longer starts a second, empty Codex thread: the engine resumes the subagent through `agent.spawn`, which now passes such a resume on, so the job keeps its thread, name and settings (#4). A resume of an agent with no saved Codex thread is refused with a reason instead.
- TaskStop no longer misses a stop: it sends `turn/interrupt` up to 3 times, until the bridge reports the turn ended.

Added:

- A turn that fails because the model is at capacity is retried once: after 30 s the job starts one turn on the same thread with the text `continue` (never the original prompt), and its wrapper keeps waiting. A second capacity failure ends the job as failed; TaskStop or a `SendMessage` during the wait cancels the retry.

## 1.0.0

Breaking:

- The Codex-side MCP server is renamed `claude_session` -> `claude_agents`, and its tool `message_claude(text)` -> `message_agent(text, to?)`. The old names are gone; resumed jobs get the new ones on their next turn.
- A `codex:*` Agent call needs a `name`, and one that `main` or a running or recently finished agent (30 minutes) already has is refused. The job is called by that name, not by its description.

Added:

- Agents message each other: `message_agent` takes `to`, a recipient agent's name or id (another Codex job, a Claude subagent, or `main`, the default), and the job's agent sends it with `SendMessage`. A name no agent has is not sent; Codex is told so instead.
- `list_agents`: the session's agents a job can message (running or finished within 30 minutes), with name, type, status and task.
- A message to a Codex job from another agent arrives as `Message from agent <name>:` and the text, so Codex knows whom to answer.

Also:

- A codex binary that is not found (`spawn codex ENOENT`, e.g. after nvm switches Node versions, whose global npm packages are per version) now says how to fix it: install `@openai/codex` for the node on PATH or set `codexPath`.
- On Windows, with no codex on PATH, the bridge runs the Codex desktop app's `codex.exe` (Store package `OpenAI.Codex`, found with `Get-AppxPackage`): no npm install needed, and it survives app updates and nvm switches.

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
