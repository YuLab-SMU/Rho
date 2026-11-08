# External work in the project views

2026-11-08. The person ran a small mean-comparison task in DeepSeek Harness,
opened its Rho project and found an empty Conversations page, Graph and Console.
The shared Notebook had the two real cells and their values, but their workspace
held only a figure. They asked for the same Rho experience whichever window held
the Agent's conversation.

## What the run showed

The project contains six synthetic values: Control 1, 2, 3 and Treatment 2, 4, 6.
Harness had already computed means 2 and 4, written a script, CSV and PNG, and drawn
a second plot in the shared R session. Its native session has two turns and 191
committed events. No analysis was repeated for this investigation.

There were two independent gaps:

- The setup used a plain MCP entry. It supplied project tools but did not configure
  native conversation observation. The installed Harness was now 0.2.2-rc.1; its
  installer refused dsh-rho 0.1.5, which declared only 0.2.1-rc.5. A connection grant
  is not a conversation record.
- Rho's process readers consumed `conversation.read` for sessions started in Rho.
  External sessions had their own list and detail view, but the Graph, Console and
  derived Studio did not read that record. The Graph also returned its empty state
  whenever `snapshot.conversations` was empty, even with real Notebook events.

The original Harness version-4 log was read through the Agent owner's public
projection, retaining its original session, turn and tool-call identities. This
recovered the existing record without starting an Agent, a Core Host or another
R session. dsh-rho was then configured with the existing grant for this exact
folder. The redundant global MCP entry was disabled after the scoped bridge worked.

## Changes and observed results

`src/external-work.ts` projects the public `agent.sessions.read` result into the
same presentation used by Rho conversations. `web/work-turns.ts` reads both sources
for the Graph, Console, answer board and one session's Studio. The shared native
index is polled every three seconds; at most six sessions and eight recent turns
per session are read for the project views. A Studio reads its selected session.
The Graph retains its 160-node drawing limit. Earlier content omitted by the
owners remains omitted; these reads do not recover it.

The original session now has one Conversations row. Its Studio is listed under
Studio and lays out the input, script, Commands/Notebook tabs, figure and summary
table. The person's existing single-figure workspace remains their arrangement.
The default input pane was too short to expose its table rows after the file
description and controls; the three process panes now give inputs and Notebook
more height. Saved personal layouts retain their own proportions.
Opening an external session's Studio keeps the Agent panel optional; the native
conversation is available from the Agent page and panel under the same identity.

The Graph draws two recorded questions, six files and fourteen shell commands.
Its timeline joins the two actual Notebook cells by the cell IDs in their tool
replies. A project grant can serve several native sessions, so it is not used to
assign every cell to one conversation. The notes' undated meaning row remains
available separately: it no longer counts as another native conversation, adds a
pause from 1970 or takes the opening viewport away from the recorded work.

The Studio Notebook initially remained empty because its scope knew only a
Rho-started conversation's principal. Kernel 0.5.10 accepts exact cell IDs from
the retained native receipts. The same two original cells now appear in this
session's Studio. A focused owner check rejects another conversation's cell even
when it shares both the grant and the R session. The project Notebook still shows
the full project session. Its cell filter does not reconstruct earlier output states.

The Console shows the fourteen native shell commands, including two nonzero exits
and their retained output. Run again was checked: it filled a command draft and
required Run; the draft was cleared and no command was dispatched. Notebook cells
remain in Notebook, including its Console form. A shell-command empty state now
explains that distinction. Tables 0.5.1 labels selection feedback for the Agent.

The external answer board shows the reported result links and offers the same
session's conversation. Rho-owned answer decisions and direct follow-up forms are
kept on the records that own those operations; the native record is not submitted
as a fabricated Rho conversation.

## Times, versions and uncertainty

A native answer's file link is labelled reported, not a disk write observation.
It can open the current file; only an exact project/resource/version tuple in a
retained receipt supplies a historical version. Today's file modification time
is not reconstructed as a past observation. Studio's current captures are labelled
as current and are not added retrospectively to the native record.

The older native projection retains a tool's call time but not its result time.
It therefore supplies no invented command duration. A replay before the cut that
retained a result hides that output and says its outcome was unknown then. The
Agent panel's native messages obey the same cut. Failed tool results retain failure
without inventing an exit code; unreported exits and missing bytes remain unknown.

The live R session stayed idle with the same two cell IDs and four values. The
native session still had two turns and source cursor 191; the CSV, script and PNG
were read, not regenerated. The WebUI was built in an isolated checkout with its
selected owners and exercised through a loopback preview forwarding API requests
to the existing service. Neither the existing service nor its R session was restarted.

## Harness compatibility and recovery

The first 0.1.5 installation attempt was refused by Harness's compatibility check.
The installed 0.2.2-rc.1 package and its public documentation retain
[`sessionQuery.observeSession`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-query.md),
its disposable observation lease and `listSessions`. dsh-rho 0.1.6 declares the two
checked Harness versions and reads a cold session's header through that lease,
removing its dependency on `sessionController.inspect`. Both header and capture
leases are disposed. No version exemption was used.

The locally packed 0.1.6 installed normally in the actual Desktop app. Its Rho
entry verified the matching folder, tools and observed conversation. This checks
the current Desktop integration; it does not establish other Harness versions or
other operating systems.

A read outage was injected only in the owned preview. The first run misleadingly
said every conversation was in the trash; that fallback was removed. The repeated
run showed the read error, kept the input disabled until its session was known,
and recovered the same row without a reload or message. The Graph and Studio also
distinguish a failed read from an empty history.

## Verification and scope

The service and WebUI builds and contract check passed. Focused checks cover native
identity and project containment, exact versus reported versions, replay cuts,
failed tools, session deduplication, Notebook event attribution, Studio roles,
existing conversation continuation, conditional layouts and decisions. The adapter
suite also checks a cold read without starting an Agent. Real browser checks cover
the existing session, its work views, a failed command's output, preparing and
clearing a rerun draft, reading failure and recovery, and layouts at CSS widths
1440, 1024, 768 and 392 pixels. No horizontal page overflow was observed; narrow
Studio views use their tab strip and retain the two cells and plot.

Screenshots and bounded API observations are retained locally. This is functional
and visual evidence for the Harness episode, not an independent usability study.
Claude Code and Codex use the same public native-session presentation, but a new
real ChatGPT or Codex-client run was not part of this episode. Source delivery,
the local preview, an npm release and replacement of an installed application
remain separate outcomes.
