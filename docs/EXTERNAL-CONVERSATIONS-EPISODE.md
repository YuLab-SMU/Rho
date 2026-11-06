# External conversations in the project

2026-11-06. A person changed a volcano plot's palette in DeepSeek Harness, then
opened the same project in Rho. The file and registered image version existed,
but Conversations still showed only the earlier Rho conversation. Outside Rho
counted connection grants, not native conversations. The existing native activity
view depended on a Host that was not running. Sharing a directory had not joined
the client's conversation to its actions and results.

## Implemented boundary

Agent 0.4.29 owns the native version-4 Harness projection, bounded local record,
read contracts and read-only detail component. Rho 0.5.5 assembles these in the
Conversations list alongside its existing conversations, ordered by activity time.
The former Outside Rho setup tab is called Connections so its count cannot be
mistaken for a conversation count. Overview links to the external conversation
and includes the files named by its tools. Detailed Graph/Studio history continues to cover Rho-created conversations.

The dsh-rho 0.1.5 adapter bundles the owner's public entry, with its input digests
and dependency licenses. Harness's public `sessionQuery.observeSession` supplies a
read-only committed cut. Startup backfills at most 64 existing sessions per
configured project; live session events and unfinished-turn heartbeats update the
same native identity. It reads no other project's conversation content. Opening
Rho from a cold conversation can retry observation without resuming that Agent.
The verified existing project connection remains the tools/launcher connection.

The local person can read `agent.sessions.list` and `agent.sessions.read`.
These methods are excluded from default and explicitly selected Agent grants.
Observation starts no Core Host, sends no message and re-executes no tool. Rho
shows where input remains. Unknown outcomes and omitted text remain explicit.
The owner describes [record budgets and conflict behavior](https://github.com/YuLab-SMU/Rho-plugins/blob/main/plugins/agent/README.md#external-conversations).

## Original Harness episode

The installed Harness 0.2.1-rc.5 plugin was upgraded through its normal Desktop
installer. It automatically found the person's existing plot-recoloring session;
no synthetic conversation or new model message was used for this check. Its
910 committed events became two turns, with 69 and 72 tool calls respectively.
Repeated reads kept one native session. The original service had no active Rho
operations or live project Host before the WebUI service was replaced for this
check; the native conversation remained in Harness.

The second turn shows its question, final visible answer, the script deliverable,
the two `skills.change` calls and `resource.register`. The registered PNG has
version `fa1246c09daa0e3f4e5c6eadad1b1ce6a38ce2ddf78013956ae7631ccb5487d0`.
The preview shows purple/green points and orange labels. Its **Show operation**
button opens the original registration call and reply. Opening the result creates
an External results view bound to the exact resource tuple. The script button
explicitly opens current content; no script snapshot is invented. Validation
neither reran the R analysis nor changed the plot bytes.

The first browser check exposed an invalid preview request: a whole resource
object had been passed where only ID/version was allowed. Passing the exact
reference corrected the failure. Results were then moved before the long reply,
with a direct operation link. A browser reload retained both conversations;
wide and narrow (actual CSS width 520) layouts were inspected. The source and
screenshots stay in private local evidence, outside Git. These are functional
and visual checks, not evidence from independent users.

## Verification and delivery

Owner checks cover native identity, visible versus injected content, call/result
joins, exact receipt versions, pending tools, explicit exit status, repeated and
conflicting cuts, missing source events, source/record limits, pagination, stale
running states, symlink containment, live locks and corrupt retained records.
Adapter checks cover two real local services, exact root matching, connection
replacement, native backfill and failed-observation retry without tool replay.
The application check verifies local-person access, default Agent grant exclusion,
source/resource/file links and reads without a Host. Browser checks use the actual
user episode described above.

The first full application run exposed the presentation action count changing from
seven to nine; its assertion was updated. The next full run had 311 passes, two
skips and one failure in the existing short-expiry browser subscription test.
The browser, presentation and external-session suites then passed all 23 tests
in an isolated recheck. The failure remains recorded separately from that recheck.
A later full-suite invocation omitted `RHO_CORE_BINARY`; its managed-execution
tests failed and it was stopped. The corrected invocation explicitly selected
the installed, unchanged Core binary and finished with 312 passes, two skips and
no failures (314 tests). The final adapter suite passed all seven checks.

Agent source is published at
[`00e5c24b`](https://github.com/YuLab-SMU/Rho-plugins/commit/00e5c24bfdfd37a0afc795e6c98391ec9a26ca76).
The application candidate and prebuilt adapter are published at
[`50ccd85b`](https://github.com/YuLab-SMU/Rho/commit/50ccd85b907c08621fd90efde9a76b375af0ee3e).
A fresh Harness home installed that exact Git subdirectory with install scripts
disabled and an empty package store. All twelve distribution files matched the
published commit. Harness's official index parser accepted the generated 0.1.5
index and returned that same pinned target. The installer reported the MCP-client
peer supplied by Harness at runtime; it did not build the adapter.

The person's Desktop installer then upgraded the existing plugin from that
public Git target. Its detail page showed 0.1.5, the selected commit and one
running component. The installed runtime files matched the published package.
Backfill again retained one session, 910 events and the same two turns. The PNG's
SHA-256 still matched its original registered version.

[CI 42276270326](https://github.com/YuLab-SMU/Rho/actions/runs/42276270326)
passed: macOS and Linux each had 312 passes and two skips; Windows had 297 passes
and 17 skips, with no failures. One candidate passed offline installation on
macOS arm64, Linux x64/arm64 and Windows x64, plus Node 24 and 26 on Linux x64.
Its SHA-256 is `2e037ad09caf981f66bf7d27a42b936e5507af3a757ccc8e6e05c3c97b1b02c6`.
[Release 42277885433](https://github.com/YuLab-SMU/Rho/actions/runs/42277885433)
verified and published that candidate as `@rho-workspace/rho@0.5.5`, with provenance,
from tag `v0.5.5`, without rebuilding, at 19:15 UTC on November 6.

The exact candidate was installed offline into the person's existing installation.
After checking both registered projects had no active operations or conversations,
the temporary WebUI was replaced with installed 0.5.5 on the same port and state.
Its composition matches the CI source identities. The real browser again showed
two conversations, the 72-operation recoloring turn, the registered image preview,
the original registration call and a working exact-version image view. It has no
external-session input box. No R analysis was rerun.

At 19:17 UTC the public npm version endpoint still returned 404 despite successful
publication. Registry availability and public Pages delivery are being checked
separately; the installed package above came from the retained CI candidate.
