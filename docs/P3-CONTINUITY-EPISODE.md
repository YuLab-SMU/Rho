# Returning to a stopped P3 analysis

2026-11-02. This pass tests whether a person can find a real conversation after
closing its tab and continue after Claude Code reaches its per-message turn limit.
It is not an unattended-run or scientific-reproduction acceptance.

## Before the change

An isolated project copied the P3 README and the public GSE232853 processed
matrix (16,560 genes and 578 AOIs). It used the same original question, Claude
Code through `claude-agent-acp` 0.97.0, the configured Haiku 5.5 model, Medium
effort and Rho's 64-turn limit. The service used its own state directory, native
Agent and Notebook, and no Core Host. A small harness chose the Agent's offered
one-time permissions; those choices are not unattended execution.

The baseline used the existing Rho 0.5.2 build while the checkout was at
`1ae9d07f`; the build was not independently tied to that source commit. The
continuation used the local application changes in this pass and the selected
Agent plugin 0.4.25 at Rho-plugins `90e68cfada22fe939ba5e47180823a8372370771`.
Node was 22.22.3 on macOS arm64. This is local composition evidence, not an
installed-package acceptance.

In a real Chrome tab the conversation row expanded details but did not open the
conversation. The page address did not identify the project or conversation.
The Agent reached `Internal error: Reached maximum number of turns (64)` after
104 recorded steps and 19 distinct one-time choices. Its original turn remained
`failed` with its steps and partial files. The new run did not reproduce an
identical sequence of calls, but reproduced the original reported stopping error.

## Change and result

The row now opens the retained conversation; its fragment identifies the project
and conversation, not a credential. Opening the address reads the record and
starts no Agent. The first query-parameter implementation failed because the
service refuses that browser entry; the fragment passed in a separate Chrome
context and in another tab observing the real P3 run. Pairing codes still leave
the address when redeemed.

The panel, list and Overview name a confirmed Agent turn limit as such. An Agent
ending its reply is no longer presented in the panel as proof that the analysis
finished. A person can explicitly continue the latest confirmed limit stop. Rho
retains the original turn and creates a new message with its own request identity,
linked to that turn and supplied with the original task. The action checks the
latest retained state and cannot continue an unknown or stale turn. Duplicate
requests with the same identity return the original message. A session-not-found
error after dispatch is unknown and is not automatically retried.

The owned service was closed and restarted using the same isolated project and
state. A fresh browser tab reopened the stopped turn without sending a message;
the person-equivalent action selected **Continue unfinished work**. The retained
native ACP session loaded with the same session identity. A new `t2` linked to
`t1` finished with `end_turn` after 116 seconds, ten retained steps and four
further one-time permission choices. The script, marker and differential-expression
tables, Hallmark table and dotplot, and findings file were present afterward.
The old `t1` and its 104 steps remained. No scientific result was independently
verified in this pass.

The service restart did not preserve the R Notebook's in-memory objects. Despite
the original request to work in the shared Notebook, the Agent chose to run the
saved script with `Rscript`; its final answer disclosed that the final files came
from the script. The four additional choices were answered by the harness. These
facts limit the conclusion: the observed path restored a conversation and
continued its task, but did not demonstrate uninterrupted Notebook execution,
correct scientific conclusions, or unattended completion. The Agent's claims
about the analysis remain its claims.

The initial stop and completion screenshots and local run records are under
`work/continuity-repair/`; they contain the actual test project and are not part
of the source release. The first stop screenshot also exposed an Overview label
that still said Failed; the Overview was changed to use the retained limit fact.

## Checks

- `node --test test/acp-conversations.test.mjs test/conversations.test.mjs test/conversation-presentation.test.mjs test/protocol.test.mjs`: 23 passed. The ACP peer is deterministic; it checks identity, restart, unknown outcomes and no duplicate dispatch, not real model behavior.
- `node scripts/agent-page-acceptance.mjs`: real Chrome with a controlled ACP peer; the run checks row opening, a fresh browser context and the limit presentation as well as the existing Agent-page paths.
- `npm run check:contracts`: checks the generated public contracts and TypeScript.

The one-click continuation path is intentionally limited to explicit turn-limit
reports. Wall-time cancellation, a lost reply, a cancelled native tool and the
Agent's assertion that background work will wake it are not evidence that an
analysis is complete or safe to replay. Persistent authorization, resource-path
discovery and real background wakeup remain separate work.

## Defaults chosen afterwards

The user then chose Claude Code's Auto permission mode as the default and no turn limit. Rho
now sets no step cap (`maxAgentTurns`) and no message wall time (`turnWallMs`) unless a
`--limits` file names them; output, line and record limits remain, and the person can stop a
message. Agent 0.4.26 (Rho-plugins `2a9cd421`) passes Claude Code a step cap only when one is
set, and applies `preferred` settings to a new session. Rho prefers `mode: auto` over Manual
(`default`); a mode chosen in Rho or named in the person's Claude settings stays, and a loaded
session keeps its own, so this pass's P3 conversation would continue in Manual. The pinned
`claude-agent-acp` 0.97.0 offers Auto and falls back to Accept edits, with a warning, when the
model does not support it. Codex's adapter already opens in its auto-review mode.

A stand-in ACP peer checks the result: a new session receives no `maxTurns` and is switched
from Manual to Auto; a chosen mode, a mode from the Agent's own settings, an unoffered value
and a loaded session are left alone; a configured cap of 64 is still passed.

## Running P3 again with the defaults

The user chose to let the harness answer any remaining permission request with its one-time
allow and started it themselves, since the permission check here would not. Each run copied the
README and matrix into a new `/tmp` project, started an isolated service and sent the original
question with only the original Medium effort; nothing else was configured. The session reported
`auto` on `fusecode-lab/claude-haiku-5-5[1m]` through `claude-agent-acp` 0.97.0 both times.

| Run | Bridge | Steps | Time | Permission requests | Outputs required by the README |
| --- | --- | --- | --- | --- | --- |
| Before (above) | 30 s | 104, then 10 | stopped at 64 turns, then 116 s | 19, then 4 | after the continuation |
| 1 | 30 s | 62 | 4.2 min, `end_turn` | 0 | 1 of 6 when the reply ended |
| 2 | waitMs + 30 s | 34 | 12.9 min, `end_turn` | 0 | all 6, in the shared R session |

Run 1 ended without finishing. The limma cell was sent with `waitMs` 120000, as Rho's
instructions suggest, but the Agent's MCP bridge ended every call to the service at 30 s, so the
call came back as an unknown outcome while the cell went on running. The Agent interrupted it,
started `nohup Rscript scripts/analysis.R` in the background (Claude Code refused `sleep` and
pointed to Monitor), and ended its reply saying it was waiting on a Monitor. Nothing resumed it.
The orphaned script wrote the DE table, Hallmark ORA and dotplot about five minutes later;
`notes/findings.md` was never written.

Agent 0.4.27 (Rho-plugins `1eb1d3e9`) gives a call the `waitMs` it asked for plus 30 s. In run 2 a
cell waited 259 s and returned. Another, sent with `waitMs` 600000, still came back unknown after
exactly 300 s: Node's fetch stops waiting for a reply's headers then, and the service answers a
waited cell only when it ends. The Agent read the session, found the cell running and sent the
same change identity again, which returned that cell rather than a second one, and went on. The
bridge now uses `node:http`; a 310 s cell sent through it with `waitMs` 400000 returned `done` after
310 s. Whether Claude Code's own MCP call limit allows such a call was not observed.

Run 2 stayed in the Notebook throughout, wrote the six outputs and a paired-only alternative, and
checked its own claim that the alternative was "essentially unchanged" before keeping numbers
(1,043 shared DEGs, logFC correlation 0.995). For ten minutes after the reply the service stayed
up and nothing changed. Its counts equal the earlier literature run's: 1,111 DEGs (833 up in CD68,
278 down) and 13 of 50 Hallmark sets, led by allograft rejection (BH 2.8e-7). That is agreement
between runs on the same data, not a check against the paper, which the README gives no numbers
for. One run each is not a rate; the harness, not a person, would have answered any request.
