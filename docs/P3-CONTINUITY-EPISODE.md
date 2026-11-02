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
