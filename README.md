# Codex for Claude Code

A Claude Code plugin that runs OpenAI Codex agents (luna, sol, astra, terra) from Claude Code like background subagents. Claude spawns a Codex agent on a task, keeps working, and is woken with the agent's result when it finishes. A live pane shows every agent, and Codex approval requests come up as Claude Code dialogs.

## Requirements

- Claude Code with the hooks plugin API (function hooks; early access).
- The Codex CLI with `codex app-server` (bundled with the ChatGPT desktop app on macOS, or installed separately).
- Node 18 or newer.
- macOS or Linux (the bridge uses a Unix socket).

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

## Configuration

Set these in the install screen or the plugin's config menu (`userConfig`):

| Option | Default | Meaning |
| --- | --- | --- |
| `codexPath` | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | The Codex CLI. If the path does not exist, `codex` is looked up on PATH. |
| `nodePath` | `/opt/homebrew/bin/node` | Node used to run the bridge. If the path does not exist, `node` is looked up on PATH. |
| `defaultModel` | `gpt-6.1-sol` | luna, sol, astra, terra or a full model id. |
| `defaultEffort` | `high` | low, medium, high, xhigh, max, ultra (ultra is not available on luna). |
| `defaultSandbox` | `workspace-write` | read-only, workspace-write, full-access. |
| `defaultApprovals` | `auto` | auto, ask, never. |

The two path defaults are macOS (Apple Silicon, Homebrew) paths. On other setups either leave them as they are and have `codex` and `node` on PATH, or set them to absolute paths.

A project can set its own defaults in `.claude/codex.json` (the nearest one walking up to the project root):

```json
{ "model": "luna", "effort": "medium", "sandbox": "workspace-write", "approvals": "ask" }
```

Precedence: tool arguments > project `.claude/codex.json` > `userConfig` > built-in defaults.

Model aliases: `luna` = `gpt-6-luna` (fast, cheap), `sol` = `gpt-6.1-sol` (strongest), `astra` = `gpt-6-astra`, `terra` = `gpt-5.6-terra`.

## Tools

The plugin registers these tools for Claude (as `mcp__codex__<name>`):

| Tool | Parameters | What it does |
| --- | --- | --- |
| `codex_spawn` | `prompt` (required), `name`, `model`, `effort`, `sandbox`, `approvals`, `cwd` | Starts an agent in the background and returns its id at once. Claude is notified when it finishes. |
| `codex_send` | `id`, `message` | Steers a running turn, or starts a new turn on an idle, stopped or failed agent's thread. |
| `codex_stop` | `id` | Interrupts the current turn. The thread stays usable. |
| `codex_list` | none | Lists agents with model, status and current activity. |
| `codex_result` | `id`, `full` | Status and final message; with `full=true` also the turn digest (commands with exit codes, file changes, messages). |
| `codex_wait` | `id`, `timeoutSec` (default 600, max 3600) | Blocks until the turn ends or the timeout passes. |

`id` is the agent id or the name given at spawn.

## Approval modes

- `ask`: you approve each escalation in a Claude Code dialog (Allow once, Allow for session, Allow always where Codex can persist a rule, Deny).
- `auto`: Codex's own reviewer decides on escalations. It is looser than Claude Code's auto mode (in testing it approved writes outside the workspace).
- `never`: no escalation; the sandbox alone decides.
- `yolo`: full bypass, no sandbox and no approvals. Claude passes it only when you explicitly ask in the request, or when a project's `.claude/codex.json` makes it the default. It is never offered as a user-wide default.

"Allow always" writes a rule to Codex's global rules file, `~/.codex/rules/default.rules`, so it applies to every Codex session on the machine, not only this plugin.

## Commands

- `/codex`: open the agents pane and list the agents.
- `/codex stop <name>`: stop an agent.
- `/codex models`: list the models Codex offers and their efforts.
- `/codex rules`: list Codex allow rules; `/codex rules rm <n>` removes one.

## Architecture

```
Claude --mcp__codex__* tools--> hooks module --HTTP over Unix socket--> daemon --stdio--> codex app-server
                                     ^                                     |
                                     +------- relay (stdout NDJSON) <------+
```

The hooks module starts `bin/bridge.mjs` as a relay. The relay launches a detached daemon (or reattaches to a live one) that owns `codex app-server` and serves an HTTP API on a Unix socket under `/tmp/cxb-<uid>/` (mode 0700, owned by your user). The relay streams the daemon's events back to the module as NDJSON on stdout; the module sends requests over the socket.

Why a bridge: the plugin API cannot write to a child process's stdin after spawning it, and `codex app-server` speaks JSON-RPC over stdio. The daemon is detached so that running agents survive a plugin reload; after a reload the module reattaches and the agent registry comes back from the plugin store.

## Known limits

- Codex agents are not Claude Code subagents: they do not appear in the native task list, and `TaskStop` and `SendMessage` do not reach them. Use `codex_stop` and `codex_send`.
- The finish notice arrives as a plugin message in the conversation, not as a native task notification.
- Resuming a thread right after Claude Code restarts may take about 20 seconds while Codex reloads it.
- The hooks plugin API is early access and may change between Claude Code releases.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT. See [LICENSE](LICENSE).
