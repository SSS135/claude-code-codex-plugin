<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Codex for Claude Code. Illustration of a Claude Code session: one Codex agent is still running npm test, another has completed, and a one-line notice wakes Claude with its result.">
</p>

A Claude Code plugin that runs OpenAI Codex agents (luna, sol, astra, terra) the way Claude runs its own background subagents. Claude hands a task to a Codex agent and carries on. When the agent finishes, its result arrives in the conversation and Claude picks it up. A live pane lists every agent, and Codex approval requests show up as Claude Code dialogs.

## How it works

<p align="center">
  <img src="./assets/readme/flow.svg" width="100%" alt="Four steps: codex_spawn returns an id at once; Codex works in its own sandbox while the /codex pane shows progress; escalations go to a Claude Code dialog in ask mode or to Codex's reviewer in auto mode; the result reaches Claude as a message and codex_send continues the thread.">
</p>

Claude calls the tools itself, so you can ask in plain words, for example "have a Codex agent on luna fix the flaky retry test". Claude turns that into a `codex_spawn` call with input like this:

```json
{ "prompt": "Fix the flaky test in retry.test.ts", "name": "flaky", "model": "luna", "effort": "medium" }
```

The call returns an id straight away. Claude can keep working, check in with `codex_list` or `codex_result`, steer the agent with `codex_send`, or block on `codex_wait` when it has nothing else to do.

## Install

At a Claude Code prompt:

```
/plugin marketplace add SSS135/claude-code-codex-plugin
/plugin install codex@codex-plugin
```

Or in one line, answering `y` to add the marketplace and then choosing a scope:

```
/plugin install codex --marketplace SSS135/claude-code-codex-plugin
```

From a shell:

```
claude plugin marketplace add SSS135/claude-code-codex-plugin
claude plugin install codex@codex-plugin
```

### Requirements

- Claude Code with the hooks plugin API (function hooks, currently early access).
- The Codex CLI with `codex app-server`. It ships inside the ChatGPT desktop app on macOS, or you can install it separately.
- Node 18 or newer.
- macOS or Linux, because the bridge talks over a Unix socket.

## Tools

Claude sees these as `mcp__codex__<name>`:

| Tool | Parameters | What it does |
| --- | --- | --- |
| `codex_spawn` | `prompt` (required), `name`, `model`, `effort`, `sandbox`, `approvals`, `cwd` | Starts an agent in the background and returns its id at once. Claude is notified when it finishes. |
| `codex_send` | `id`, `message` | Steers a running turn. On an idle, stopped or failed agent it starts a new turn on the same thread. |
| `codex_stop` | `id` | Interrupts the current turn. The thread stays usable. |
| `codex_list` | none | Lists agents with model, status and current activity. |
| `codex_result` | `id`, `full` | Status and final message. With `full=true` it adds the turn digest: commands with exit codes, file changes and messages. |
| `codex_wait` | `id`, `timeoutSec` (default 600, max 3600) | Blocks until the turn ends or the timeout passes. |

`id` can be the agent id or the name given at spawn.

## Commands

- `/codex` opens the agents pane and lists the agents.
- `/codex stop <name>` stops an agent.
- `/codex models` lists the models Codex offers and the efforts each one takes.
- `/codex rules` lists Codex allow rules, and `/codex rules rm <n>` removes one.

## Configuration

Set these in the install screen or the plugin's config menu (`userConfig`):

| Option | Default | Meaning |
| --- | --- | --- |
| `codexPath` | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | The Codex CLI. If the path does not exist, `codex` is looked up on PATH. |
| `nodePath` | `/opt/homebrew/bin/node` | Node used to run the bridge. If the path does not exist, `node` is looked up on PATH. |
| `defaultModel` | `gpt-6.1-sol` | luna, sol, astra, terra or a full model id. |
| `defaultEffort` | `high` | low, medium, high, xhigh, max, ultra (luna does not take ultra). |
| `defaultSandbox` | `workspace-write` | read-only, workspace-write, full-access. |
| `defaultApprovals` | `auto` | auto, ask, never. |

Both path defaults are macOS paths (Apple Silicon with Homebrew). Elsewhere, either keep them and put `codex` and `node` on PATH, or set absolute paths.

A project can set its own defaults in `.claude/codex.json`. The plugin uses the nearest one found walking up to the project root:

```json
{ "model": "luna", "effort": "medium", "sandbox": "workspace-write", "approvals": "ask" }
```

When a setting comes from several places, tool arguments beat the project's `.claude/codex.json`, which beats `userConfig`, which beats the built-in defaults.

Model aliases: `luna` is `gpt-6-luna` (fast, cheap), `sol` is `gpt-6.1-sol` (strongest), `astra` is `gpt-6-astra`, and `terra` is `gpt-5.6-terra`.

## Approval modes

- `ask`: you approve each escalation in a Claude Code dialog. The choices are Allow once, Allow for session and Deny, plus Allow always where Codex can save a rule.
- `auto`: Codex's own reviewer decides on escalations. It is looser than Claude Code's auto mode; in testing it approved writes outside the workspace.
- `never`: no escalation. The sandbox alone decides.
- `yolo`: full bypass with no sandbox and no approvals. Claude uses it only when you ask for it explicitly in the request, or when a project's `.claude/codex.json` makes it the default. You cannot set it as a user-wide default.

"Allow always" writes a rule to Codex's global rules file, `~/.codex/rules/default.rules`. That rule then applies to every Codex session on the machine, including ones started outside this plugin.

## Architecture

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="The hooks module in Claude Code sends requests over HTTP on a Unix socket to a detached daemon, which runs codex app-server over stdio. The relay, bin/bridge.mjs, reads the daemon's event stream and passes it back to the hooks module as NDJSON on stdout.">
</p>

The hooks module starts `bin/bridge.mjs` as a relay. The relay launches a detached daemon, or reattaches to one that is still running. The daemon owns `codex app-server` and serves an HTTP API on a Unix socket under `/tmp/cxb-<uid>/` (mode 0700, owned by your user). The module sends requests over that socket, and the relay streams the daemon's events back to it as NDJSON on stdout.

The bridge exists because the plugin API cannot write to a child process's stdin once it has spawned it, and `codex app-server` speaks JSON-RPC over stdio. The daemon runs detached so that agents keep running through a plugin reload. After a reload the module reattaches, and the agent list is restored from the plugin store.

## Known limits

- Codex agents are not Claude Code subagents. They do not appear in the native task list, and `TaskStop` and `SendMessage` cannot reach them; use `codex_stop` and `codex_send` instead.
- The finish notice arrives as a plugin message in the conversation, not as a native task notification.
- Resuming a thread right after Claude Code restarts can take about 20 seconds while Codex reloads it.
- The hooks plugin API is early access and may change between Claude Code releases.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT. See [LICENSE](LICENSE).
