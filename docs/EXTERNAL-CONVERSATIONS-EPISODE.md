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

Publication and installed package evidence will be recorded after the checked
source combination completes the release workflow. The source change alone is
not registry or installed-version evidence.
