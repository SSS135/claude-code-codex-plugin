# Goldmar rollout and rollback

Release: `0.2.10-goldmar.5`. Upstream: [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin), base `b94d5d08ceff03e85257d0abbdb2698acfdc67f6` / `0.2.10`. MIT copyright and original repository links are preserved. The fork keeps plugin `codex`, marketplace `codex-plugin`, aliases, and local marketplace plugin source `./`.

Develop on a new branch from freshly synchronized fork `main`. After implementation gates pass, merge directly into the fork's `main` and push it; do not open a PR in either repository. Advance `goldmar-stable` when the development engine, Node and native lifecycle gates below pass; this ref promotion is already authorized and requires no additional owner approval. Preserve `goldmar-upstream-0.2.10` at the exact upstream rollback commit before rollout; never advance that ref. Required checks and the development receipt below are distinct from installed acceptance. No installation, reload, live daemon replacement, upstream submission or GitHub Actions change is authorized by a development merge. Installation remains a separately scheduled, owner-approved quiet-window operation, followed by the installed verification checklist.

## Implementation acceptance

Run from the development checkout, never from installed caches:

```sh
claude plugin validate .
claude plugin test .
node --test --test-concurrency=1 tests/registry.test.mjs tests/bridge.test.mjs
CODEX_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 tests/native-lifecycle.test.mjs
git diff --check
```

Use an authorized isolated worker or the host's job-slot/CPU/memory wrapper; keep Node test concurrency at one. CLI help and source were inspected with Claude Code `2.1.304`: `validate` checks manifests; `test` runs every `*.test.ts` and `*.test.tsx` using the actual engine and `claude-code/testing`, each file in a child process. It has no test-concurrency option and buffers results until a file finishes; each file has a ten-minute hard deadline. The separate Node commands run the `*.test.mjs` files; neither runner replaces the other. Do not invent a replacement hook SDK to satisfy a gate.

Required regressions also cover native wrapper resumes without thread creation or sandbox changes; registry failure during ready; wrapper hook exceptions/timeouts that keep awaiting; confirmed versus unconfirmed native stops, late start cancellation and bounded interrupt retries; interrupted notifications followed by continuing native work; and process-scoped writer locks after holder exit (never delete a lock or trust a saved PID/file age). Required regressions cover simultaneous messages from idle; structured steering timeouts/overload without a replacement start; exact-turn holds, waiters and tombstones; recovering failures versus durable failed/interrupted release; rejected and late unsubscribe acknowledgements; cleanup/load races; and visible, bounded, sanitized activity rendering. Slow-resume fixtures must actually take 35 and 90 seconds and complete with one resume through short polls. Also verify cancelled HTTP polls retain operation ownership, late starts bind once, and abandoned idle operations are released. Inject registry failures, wrapper hook exceptions and hook timeouts, checking that no Claude model request occurs. Terminal-overload tests must check same-thread/model retry limits, hints, exhaustion and absence of retries on partial or ambiguous work.

Before accepting stable, an isolated fixture must also prove MCP child process counts return to baseline after repeated success **and failure/interruption** cycles; an unsubscribe acknowledgement alone is insufficient. The opt-in native command above starts the real Codex app-server with a temporary Codex home, a harmless stdio MCP fixture and a local mock Responses provider. It requires two cycles each of completed, failed and interrupted outcomes, measuring a live MCP child before each outcome and baseline recovery after unsubscribe acknowledgement and `thread/closed`. It also resumes a completed thread after unload and checks that the next provider request contains the original user prompt and assistant history. Interrupt cycles use the daemon-owned stop path. It makes six local mock requests and uses no real user servers, credentials, remote providers or installed daemon. Its unload delay is explicitly overridden to one second, so it establishes native teardown behavior rather than the deployed default's timing. Without the opt-in, this test is skipped; a skipped test is not acceptance. Record terminal receipts and exact versions before claiming success.

Keep fake app-server process-lifecycle coverage distinct from that native evidence. The ten-minute quiescent daemon backstop kills its owned app-server process group even when cleanup keeps failing; active turns, pending foreground admissions and server requests remain protected. Mocked provider errors do not prove live provider recovery; engine rendering tests do not prove live installed UI behavior. Installed checks below remain separate rollout acceptance. Keep receipts private; publish only sanitized results and counts.

## Live incident findings for goldmar.3

Claude Code 2.1.304 resumes a wrapper with `resume: { agentId }`. The previous hook indexed the registry with that object, producing `[object Object]` despite an intact record. Its SendMessage hook had already started/steered Codex before calling the engine delivery continuation, so a subsequently declined wrapper resume could leave duplicate native work running. The registry schema itself is unchanged in upstream 0.2.10 and goldmar.1; regressions read their synthetic records by restored ID/name without rewriting them. Resume lookup now also passes the ID explicitly when the native agent list has not restored it yet. Native identity wins over historical name collisions; ambiguous saved names require an explicit agent ID, and foreign native agents retain ordinary engine routing.

Delivery now verifies the saved native thread, holds wrapper completion during engine acceptance, then admits native input. Engine refusal admits no start/steer. A native refusal after engine acceptance can leave a harmless wrapper wake, but sends no native input and the tool reports refusal. Once a retained operation is submitted, transport loss/deadlines are acceptance with a pending outcome, never an invitation to repeat the input. Successful native responses cannot be converted into refusals by failed binding persistence or acknowledgement. The daemon's existing retained operation and exact-turn reconciliation remain authoritative.

TaskStop's engine output is an object with required string `message`, `task_id` and `task_type`, plus optional string `command`. Both the previous warning override and its test mock returned a string. The hook now preserves all engine result fields, changes only the warning message, and waits for engine stop acceptance before requesting native interruption. The codex_await/list/result tools have string outputs; native admission failures during await keep a live wrapper waiting instead of reporting a failed operation. No installed plugin, marketplace, live job or record is changed by these development gates.

## Native transcript replay in goldmar.5

The wrapper yields one indexed `turn.step` text block for each Codex commentary message, public reasoning summary or plan, preserving the full sanitized markdown and whitespace. It yields native `Bash` tool blocks for completed command events, in event order, then a hidden `codex_await` tool to keep the wrapper alive. A text-only `end_turn` would finish the wrapper. Startup item/plan notifications stay buffered through binding persistence and drain before buffered terminal completion, preserving event order. Quiet awaits still wait up to 45 seconds with two-second native observation; queued events wake them without being consumed by the await result. Final answers retain the existing SubagentHandback/fallback-text contract.

A synthetic Bash call is a replay receipt for already completed Codex work. The `tool.call` hook matches its generated ID, wrapper ID and exact sanitized command, consumes the receipt once and returns the native Bash result shape (`stdout`, `stderr`, `interrupted`). It never calls the execution continuation. Missing, mismatched, stale or repeated replay IDs refuse locally. Ordinary Bash calls still delegate normally. Receipts are bounded and cleared when their wrapper completes. Neither replay nor recovery calls a Claude model.

The inspected [official engine declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts) expose text/tool/input/stop chunks, with no synthetic tool-result chunk. `session.append` cannot create assistant or tool rows. Real tool-call replay is therefore necessary to obtain a paired native result. `AssistantMessage` draws markdown; `ToolUse`, `ToolResult` and `ToolGroup` own native compact rows and expansion. The plugin leaves all four native components untouched for replay. It hides await ToolUse/ToolResult components for all statuses, including terminal and message-relay results. List/result tools keep their existing summary rows.

Expected transcript (illustrative; grouping and wording belong to Claude Code):

```text
● I checked the implementation. Here is the full explanation.

  - Markdown lists, paragraphs and code fences remain intact.

● Bash(rg -n 'pattern' src)
  ⎿  exit 0, 0.1s

● Ran 7 shell commands (ctrl+o to expand)

● The focused tests passed. Next I will verify cancellation.
```

Limits:

- Native grouping is heuristic and depends on command classification, adjacency, verbosity and the host version/surface. Await boundaries can split groups. The API does not force a particular group label, collapse a standalone Bash row or remove await records from ctrl+o/the stored transcript. No custom grouping override forces collapsed mode over the user's expansion choice.
- Shell reads/searches stay Bash: inferring Read/Grep arguments from arbitrary shell syntax could misrepresent work. Commands appear on completion, with recorded exit status (or `?`/`declined`) and duration, rather than a live native execution spinner. Nonzero exits remain metadata; replay itself successfully read the receipt.
- The input carries a sanitized preview of at most 1,000 characters; native compact rendering may shorten it further. Expanded details retain that longer bounded preview, never heredoc/inline interpreter bodies, later shell statements, or the original raw command. Results contain exit/duration metadata only. Raw output, diffs, config and raw reasoning stay excluded; secret heuristics cannot identify every secret in arbitrary prose.
- Prose has no preview truncation or added ellipsis. An individual message above 256,000 characters is omitted whole with an explicit notice. The per-agent queue holds at most 60 events / 512,000 characters and sheds commands first with an omission notice on overflow. Each step drains at most 16 events toward 16,000 characters; one large message stays whole. At most 256 feeds and 256 dedupe keys per feed are retained. These are transient display queues; the authoritative native turn and final answer remain separate.
- Engine tests exercise real hook dispatch, native tool-result schema validation, streamed blocks, render delegation on terminal/desktop, and zero model/execution fallthrough. The SDK's UI mount has no built-in transcript layout: test renderers below the plugin verify unchanged native props, including collapsed/expanded groups. These are not a pixel/UI acceptance receipt. Installed detail-pane layout and exact grouping remain quiet-window acceptance; development never reloads the installed plugin or touches live jobs/records.

## Development receipt for goldmar.5 (2026-10-20)

Development checkout only, using Claude Code `2.1.304`, Node `v26.12.0` and Codex CLI `0.162.1`. Gates ran sequentially through the host heavy-slot command and CPU/memory wrapper, with Node test concurrency one. Host load admission was respected; no live jobs, records, installed plugin, cache or marketplace were changed.

| Gate | Terminal result |
| --- | --- |
| `claude plugin validate .` | PASS |
| `claude plugin test .` | 111 passed, 0 failed, 3 files |
| Node registry and bridge tests | 26 passed, 0 failed, 0 skipped; real 35/90-second resume fixtures |
| `CODEX_NATIVE_LIFECYCLE=1` native test | 1 passed, 0 failed, 0 skipped |
| `git diff --check` | PASS |

Engine fixtures verify full markdown/whitespace, multiple indexed assistant blocks interleaved with native Bash tool blocks, once-only receipt results, no execution/model fallthrough, foreign/altered/stale/cancelled receipt refusal, ordinary Bash delegation, quiet-await timing, stop/steer and unchanged native render props on terminal/desktop for both group expansion states. Startup persistence and terminal-arrival fixtures verify earlier display events drain in order before settlement. Bounds, overflow notices, script-body hiding, all public summary parts and redaction remain covered.

The native fixture completed two cycles each of success, failure and interruption. Each measured one initialized MCP child, a terminal receipt, acknowledged unsubscribe, `thread/closed` and return to baseline zero. Same-thread follow-up after unload retained original user and assistant history. Six local mock provider requests; no real provider calls. The fixture unload delay was one second. Source hashes matched the final engine-gate snapshot through the other gates; only this receipt documentation was then updated. Installed UI/grouping and deployed-default unload timing remain separate acceptance.

## Development receipt for goldmar.4 (2026-10-20)

Development checkout only, using Claude Code `2.1.304`, Node `v26.12.0` and Codex CLI `0.162.1`. Final implementation commands completed sequentially through the host heavy-slot command and its CPU/memory wrapper; Node test concurrency was one.

| Gate | Terminal result |
| --- | --- |
| `claude plugin validate .` | PASS |
| `claude plugin test .` | 106 passed, 0 failed, 3 files |
| Node registry and bridge tests | 26 passed, 0 failed, 0 skipped; real 35/90-second resume fixtures |
| `CODEX_NATIVE_LIFECYCLE=1` native test | 1 passed, 0 failed, 0 skipped |
| `git diff --check` | PASS |

Engine fixtures verify header-free rendering on terminal and desktop, silent 45-second windows using the SDK mock clock, prompt new-event delivery, and TaskStop proceeding while a quiet HTTP poll is outstanding. Activity fixtures cover completion-only commands, duration/exit retention, shell quoting, physical and escaped newlines, heredocs, inline interpreter bodies, redaction, public summaries without raw reasoning, exact-turn replay, incremental delivery, bounded queues and command burst limits.

The native fixture completed two cycles each of success, failure and interruption. Each observed one initialized MCP child, a terminal receipt, acknowledged unsubscribe, `thread/closed`, and return to baseline zero. Same-thread follow-up after unload retained original user and assistant history. Six local mock provider requests; no real provider calls. The fixture unload delay was one second. Installed UI behavior and deployed-default unload timing remain separate acceptance. Live jobs, their records, the installed plugin, cache and marketplace were not modified.

## Development receipt for goldmar.3 (2026-10-20)

Development checkout only, using Claude Code `2.1.304`, Node `v26.12.0` and Codex CLI `0.162.1`. Implementation commands ran sequentially through the host heavy-slot command and its CPU/memory wrapper; Node test concurrency was one.

| Gate | Terminal result |
| --- | --- |
| `claude plugin validate .` | PASS |
| `claude plugin test .` | 101 passed, 0 failed, 3 files |
| Node registry and bridge tests | 26 passed, 0 failed, 0 skipped; real 35/90-second resume delays |
| `CODEX_NATIVE_LIFECYCLE=1` native test | 1 passed, 0 failed, 0 skipped |
| `git diff --check` | PASS |

The native fixture completed two cycles each of success, failure and interruption. Each observed one initialized MCP child, a terminal receipt, acknowledged unsubscribe, `thread/closed`, and return to baseline zero. Same-thread follow-up after unload retained original user and assistant history. Six local mock provider requests; no real provider calls. The fixture unload delay was one second. Installed UI/provider behavior and deployed-default unload timing remain separate acceptance; live jobs, their records, the installed plugin, cache and marketplace were not modified.

## Quiet-window prerequisites

1. Schedule an owner-approved quiet window. Stop new admission and drain **all** sessions using this marketplace, including background Codex jobs. Verify no active native turn, approval, pending operation, release or owned background task remains. A completed wrapper alone is insufficient. Close these sessions before switching.
2. Privately preserve installation/settings metadata, relevant plugin userConfig and the current source/version/build identity. Use private permissions; do not print settings, credentials, socket addresses or session identifiers. Marketplace removal uninstalls its plugins and removes enabled entries, so explicitly account for any other plugins from that marketplace. Preserve `~/.claude/plugins/codex-agents/` and `~/.codex` history.
3. Confirm the fork refs and reviewed commit before removal:

   ```sh
   git ls-remote https://github.com/goldmar/claude-code-codex-plugin.git \
     refs/heads/main refs/heads/goldmar-stable refs/heads/goldmar-upstream-0.2.10
   claude plugin marketplace add --help
   claude plugin marketplace remove --help
   claude plugin install --help
   ```

   `main` and stable must name the same accepted commit. The rollback ref must name `b94d5d08ceff03e85257d0abbdb2698acfdc67f6`. Recheck CLI syntax at rollout time; it was inspected with Claude Code `2.1.304` during implementation. The commands below assume user scope: inspect project/local declarations privately and resolve overrides first. Do not run switch commands while this development job or another Codex wrapper is active.

## Switch commands

From a separate terminal after every relevant session is closed:

```sh
goldmar_release_commit=$(git ls-remote https://github.com/goldmar/claude-code-codex-plugin.git refs/heads/goldmar-stable | cut -f1)
test -n "$goldmar_release_commit" || exit 1
test "$(git ls-remote https://github.com/goldmar/claude-code-codex-plugin.git refs/heads/main | cut -f1)" = "$goldmar_release_commit" || exit 1
test "$(git ls-remote https://github.com/goldmar/claude-code-codex-plugin.git refs/heads/goldmar-upstream-0.2.10 | cut -f1)" = b94d5d08ceff03e85257d0abbdb2698acfdc67f6 || exit 1
claude plugin marketplace remove codex-plugin --scope user
claude plugin marketplace add 'goldmar/claude-code-codex-plugin#goldmar-stable' --scope user
claude plugin install codex@codex-plugin --scope user
```

The default sandbox is read from `.claude/codex.json` in the session cwd (or its nearest ancestor up to the project root), above plugin userConfig defaults and below explicit prompt headers. Reinstalling resets plugin userConfig, including `defaultSandbox`, `defaultEffort` and `defaultApprovals`; preserve and restore reviewed values. These defaults apply when creating a job. Follow-ups keep that job's saved sandbox, approvals, model and thread history even if defaults subsequently change.

Restore only reviewed plugin userConfig through `/plugin configure` or `claude plugin configure codex@codex-plugin --values-stdin` with a privately saved JSON object on stdin if removal reset it. Do not print that JSON or hand-edit registry/cached code. Do not enable upstream and fork simultaneously. Launch a fresh Claude session rather than migrating a busy daemon with `/reload-plugins`. In `/plugin` → Marketplaces, review/disable auto-update so deployment stays deliberate. Do not silently alter bytes under the same release/cache version.

Commands follow [marketplace management](https://code.claude.com/docs/en/discover-plugins#manage-marketplaces) and [marketplace sources](https://code.claude.com/docs/en/discover-plugins#add-a-marketplace). The exact installed API and plugin engine tests take precedence over assumptions about unreleased hook APIs.

## Post-switch verification checklist

- [ ] Confirm the configured marketplace source names goldmar's stable ref, plugin version is `0.2.10-goldmar.5`, and `codex:sol/luna/astra/terra` resolve. Confirm the daemon actually uses the new bridge build, not just the on-disk plugin version. Derive its expected build privately from the installed bridge path plus bytes (the bridge uses SHA-256 and the first eight hex characters).
- [ ] Confirm old native and MCP owners exited through normal shutdown. If stale work prevents quiet retirement, diagnose it; any targeted shutdown needs its own authorization. Never use broad `pkill`, or kill only the native app-server while its daemon/relay still owns it.
- [ ] Before the first controlled cycle, record a private baseline of the new app-server's MCP descendants and memory. Count processes under the exact owner, not every Node/Python process. Use only `ps -eo pcpu,comm` for `ps`; collect tree relationships/counts privately from scoped `/proc` metadata without command lines or environment contents. Publish counts only.
- [ ] Use a separate temporary Codex home and harmless MCP fixture. No real user MCP servers or credentials. Provider/paid tasks, if required for real terminal failure, need separate explicit authorization. Development mocks alone are not native cleanup proof.
- [ ] Run repeated **success** cycles and wait for acknowledged unsubscribe, eventual `thread/closed`, and fixture MCP process count to return to baseline. On Codex `0.162.1` the default idle unload delay is 60 seconds; teardown can take longer. Unsubscribe ACK alone is not process-exit proof.
- [ ] Run repeated **failure** cycles and perform the same count-to-baseline check. Verify recovery while active retains its MCP processes, then releases after true settlement; a durable failed turn eventually releases even while unrelated agents continue running.
- [ ] Confirm a rejected unsubscribe remains owned and retryable; confirm a late ACK reconciles without releasing a new active turn. Do not declare success from a lower RSS immediately after restart. Record terminal receipts, exact versions, cycle counts, elapsed time and post-warmup RSS trend privately.
- [ ] Resume the same fixture after unload, including a cold 35–90-second initialization. Verify a single resume operation and the original thread binding. A short HTTP poll timeout must not cause another resume or turn/start.
- [ ] Send two messages together to an idle fixture: one start plus one steer/queue. An ambiguous steer failure must not launch another turn. An old completion/item must neither end nor revive a newer turn.
- [ ] In the agent detail transcript, verify full assistant markdown messages and public progress notes without preview truncation or Message/Progress prefixes. Check native Bash rows and collapsed command groups where the host classifies them, and ctrl+o expansion of the sanitized bounded previews and exit/duration results. Verify no visible await chrome for quiet, terminal, relay, interrupted or error outcomes. Check exact-turn incremental delivery, overflow notices, full messages across batch boundaries and secret-shaped fixtures. Confirm no raw output/diffs/reasoning, prompt stop/steer latency, and the existing final handback. Record the host/surface and actual grouping; do not infer installed UI behavior from engine mocks.
- [ ] Interrupt the wrapper's bridge access in an isolated fixture. Confirm it keeps issuing `codex_await`, retries transient registry/transport failures with a bounded backoff, retains backend ownership for reconciliation, and produces zero fallback Claude model requests. An unavailable bridge must never be reported as a completed wrapper or an interrupted native turn. Record any host-enforced timeout limitation explicitly; a model label alone is not evidence of a request.
- [ ] Inject a confirmed terminal `codexErrorInfo: 'serverOverloaded'` failure with no work beyond typed user input and no observed partial work. Confirm at most two retries within 120 seconds, on the original thread/model, after two then four seconds, respecting `retryAfterMs` hints within the elapsed cap. Check exhaustion is reported, `willRetry:true` is not double-retried, and partial work or uncertain timeouts never qualify. Live provider tests need their own authorization.
- [ ] Check no duplicate wrapper/provider activity and no unexplained retained MCP trees after both cycle types. Preserve evidence; do not add a host process sweeper or change global Codex configuration to mask a failure.

## Rollback commands

Use the **same full quiet procedure**, including draining fork work and privately preserving settings. The pinned ref contains the original upstream bytes, providing an exact rollback even if upstream main moves:

```sh
test "$(git ls-remote https://github.com/goldmar/claude-code-codex-plugin.git refs/heads/goldmar-upstream-0.2.10 | cut -f1)" = b94d5d08ceff03e85257d0abbdb2698acfdc67f6 || exit 1
claude plugin marketplace remove codex-plugin --scope user
claude plugin marketplace add 'goldmar/claude-code-codex-plugin#goldmar-upstream-0.2.10' --scope user
claude plugin install codex@codex-plugin --scope user
```

To restore the upstream marketplace owner as well, first verify upstream main still equals the accepted rollback commit, **before** removal:

```sh
test "$(git ls-remote https://github.com/SSS135/claude-code-codex-plugin.git refs/heads/main | cut -f1)" = b94d5d08ceff03e85257d0abbdb2698acfdc67f6 || exit 1
claude plugin marketplace remove codex-plugin --scope user
claude plugin marketplace add 'SSS135/claude-code-codex-plugin#main' --scope user
claude plugin install codex@codex-plugin --scope user
```

If that guard fails, use the pinned rollback ref above; do not silently adopt newer upstream code. Restore reviewed userConfig, start a fresh session, verify source/version/build and old-owner exit, and repeat success/failure baseline checks. A live source flip is not a rollback.

## Remaining scope

Optional per-job MCP allowlists, persisted plan checkpoints, byte-bounded historical caches and live provider/RSS-soak trials are separate work. This release does not change global Codex configuration, introduce a process sweeper or switch to codex-collab. Its failed/interrupted-turn release, duplicate-protected delivery and selected event previews draw on [Kevin7Qi/codex-collab](https://github.com/Kevin7Qi/codex-collab); retained RPC outcomes and acknowledged cleanup also address gaps identified in that implementation.

## Live incident findings for goldmar.2

The old streaming hook catch returned `end_turn` on any exception, including a ten-second hook timeout, without checking the native turn. The original first-turn exception was not retained in the available bridge log, so its precise triggering error is unproven. Both a registry refusal and the real engine timeout are regression fixtures. A ready-time registry failure could also permanently reject the socket promise while its healthy relay continued running; await transport failures then incorrectly marked jobs interrupted.

TaskStop relied on the wrapper's abort hook and an interrupt RPC acknowledgement, with no independent retained stop or terminal confirmation. Interrupted notifications were accepted immediately, unlike failed notifications, even if native work continued. Stops now remain daemon-owned across cancelled clients/late admissions, retry at most three times and retain running status until the exact native turn is confirmed ended. A saved stop request suppresses late automatic capacity retries until explicit new input.

Claude invokes `agent.spawn` with `resume` when restarting a wrapper for SendMessage. The old hook created a new thread and overwrote the same job ID, reapplying current defaults. This explains the latest-message-only input and sandbox change; neither the capacity retry nor thread/resume deliberately cleared history. Native wrapper resumes now reuse the saved binding without another delivery.

The reported post-reboot hold was backed by a current kernel writer lock when inspected, rather than just an old file. Codex 0.162.1 uses a process-scoped writer lock; a file can survive a reboot, but its held lock cannot. The old diagnostic guessed a previous bridge and promised a short wait without checking. Linux ownership checks now inspect only the requested lock and its current kernel holder; a released lock permits at most two resume retries. Unknown or live ownership refuses safely, without unlinking files, killing an owner, or replacing the thread. Other platforms report ownership as unverified.
