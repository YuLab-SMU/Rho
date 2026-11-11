# Continuing any Agent session in Rho

Date: 2026-11-07. Source changes after Rho 0.5.5, with Agent 0.4.30 in Rho-plugins.
Core is unchanged. Package publication and installation are separate.

## Question

The person asked why a conversation started outside Rho was read-only in Rho:
with the same Agent, a session should continue seamlessly wherever it started.
They also found the Agent settings panel ugly, and the two kinds of
conversation and the ways of connecting an Agent confusing. They pointed to
[magpie](https://github.com/yetone/magpie) for how it manages Agents and
sessions.

The read-only rule had been a product decision (2026-10-25: whoever starts a
session holds its input), not a limit of the Agents. Rho already continued its
own conversations by loading the Agent's session over ACP, and the bundled
adapters (claude-agent-acp 0.97.0, codex-acp 2.3.0) list, load, resume and fork
sessions. Harness's `dsh acp` profile resumes sessions too.

## What magpie does, and what Rho takes from it

magpie is a gateway and a reader of each Agent's own session files. It treats
each Agent's own record and session ID as the truth and keeps only a derived
cache. It lists sessions started anywhere, so nothing is imported, and builds
the `claude --resume`/`codex resume` command on the server. Where Agents keep
locks it defers to them, plus a one-minute recent-write check. It is not an
Agent host and has no composer, so continuing a session there means a terminal.

Rho runs Agents, so it continues the session in place. It reads the same native
records and adds no session identity of its own for them.

## What changed

- **One list.** Conversations shows every session in the project folder: Rho's
  conversations, Claude Code and Codex sessions read from their own files, and
  Harness conversations observed by the dsh-rho adapter. The "Outside Rho" type
  is gone. A row names its Agent and where it started (Terminal, VS Code, Codex
  app, Script…), and shows when another window has it open. Once Rho continues
  a session, its row is that conversation; the session is not listed twice.
- **Continue anywhere.** Opening a row shows the session's history in the Agent
  panel, and the next message continues that same session: `session/load` for
  Claude Code and Codex, `session/resume` for Harness. Turns sent later from a
  terminal appear in place between Rho's own, matched by their text. A row and
  the panel copy the terminal command (`cd … && claude --resume ID`).
- **Open elsewhere.** Claude Code names each live process and the session it
  holds in `sessions/<pid>.json`; Codex keeps `thread-writer-locks/<id>.lock`.
  While another process holds the session, Rho refuses to write into it and
  says where it is open. Rho's own adapter's child processes do not count. The
  person can instead continue a copy (ACP `session/fork`); the original record is
  not written. Harness cannot fork; a Harness session is refused only while
  Harness is answering in it.
- **Stale connections.** An idle connection that Rho kept open does not know
  about turns sent from another window. When the session's record changed after
  Rho's last message, Rho closes that connection and loads the session again.
- **Agents tab.** It replaces "New conversation settings" and "Connect your
  agent". It lists the Agents this service can start, with a radio button for
  new conversations, a model chip and folded settings; an Agent that is not
  found is shown greyed out. Below that is the setup prompt for using the
  project from an Agent window the person runs elsewhere. DeepSeek Harness is
  detected when `dsh` and its `acp` profile are installed, without starting
  anything.
- **Session markers.** Starting Claude Code from a Rho that was itself started
  inside Claude Code (as an Agent running the setup does) passed on
  `CLAUDE_CODE_CHILD_SESSION`. Claude Code then saves no transcript, which was
  observed directly ("Transcript saving is off — inherited
  CLAUDE_CODE_CHILD_SESSION marker"). The adapter now drops those markers.

`agent.sessions.list` and `agent.sessions.read` remain local-person only and
excluded from Agent grants. `conversation.start` takes
`continue: { session, copy? }`. Listing and reading open files only and start
no Agent. Native reads are bounded: 64 sessions, 256 KiB head and tail for a
listing, a streamed read of at most 256 MiB, 200 turns, 256 tools per turn.

## Real runs

`node scripts/session-continuity-episode.mjs` uses a disposable project, Rho
state and Claude Code configuration (credentials only in the environment), a
real Claude Code (haiku), Chrome, and an interactive Claude Code in a
pseudo-terminal to hold a session open. The final run, after the last source
changes (`work/session-continuity/1794039903484`), passed:

1. `claude -p` in the project folder started a session ("remember heron-42").
   Rho listed it as started in Script, with no Rho conversation.
2. Continue opened it in the panel. The next message ("What code word…?") ran in
   the same session ID and answered `heron-42`.
3. `claude -p --resume` in a terminal answered what Rho had asked. The panel
   showed that turn in place.
4. With an interactive Claude Code holding the session, the API and the panel
   refused the message ("This session is open in Terminal").
5. Released, Rho's next message asked for the previous message word for word. It
   quoted the terminal's prompt. In Claude Code's own record its parent is the
   terminal's answer, not Rho's earlier message.
6. A second session, held open, continued as a copy that answered `osprey-7`.
   The original transcript does not contain the copy's message.
7. Conversations and Agents had no overflow or unnamed buttons at 1440, 1024,
   768 and 390 px, with the panel closed.

Earlier runs found real defects:

- The first time window for matching Rho's turns took the terminal turn for
  Rho's; matching now uses the turn's text.
- Treating every holder as Rho's while Rho's connection was open hid the
  interactive terminal; Rho now checks the holder's parent process.
- A `.session-row` class collided with the panel's usage strip and cut the row
  short.
- At 390 px the panel covered the page, so those screenshots measured the
  panel; the run now closes it first.
- One answer was too vague to show that Rho saw the terminal turn; the check
  now asks for a quotation and reads the record's parent link.

Harness was checked separately (`work/session-continuity/harness/resume.mjs`):
`dsh headless` started a session ("remember kestrel-9"), Rho's ACP driver
resumed it through `dsh acp` under the same session ID and answered
`kestrel-9`, and `dsh headless --session-id` then answered what the driver had
asked. A service started from the CLI reported Claude Code, Codex and DeepSeek
Harness as available, with Claude Code still the default.

## Checks

- `test/session-continuity.test.mjs` (new): native listing and reading from
  fixture Claude Code and Codex records, with nothing started; another folder's
  session excluded; a held session refused; a copy forked and the original
  never loaded; continuing in place loads that session ID; a second continue
  refused; a later holder refused on send; Codex continues with Codex.
- 53 related Rho tests pass with the debug Core selected: ACP conversations,
  Agent connection, observation, settings, browser, presentation,
  conversations, evidence, external sessions and continuity. 32 Agent plugin
  tests pass (ACP, external sessions and ACP observation, process, intents,
  describe, activity). `npm run check:contracts` is current.
- `node scripts/agent-page-acceptance.mjs` passes in Chrome after its steps
  moved to the Agents tab.
- CI run 42356741141 for `81471c2c` failed one test on macOS, Linux and
  Windows: the underlined link read `--color-text`, which no stylesheet
  declares, so it silently kept the notice's grey. It now reads `--color-ink`.
  The full local suite then failed once in
  `acp-conversations.test.mjs`: that test took a finished turn as settled
  before the folder comparison was attached to it (an older race, seen under
  load). It now waits for the comparison. The full suite then passed: 315
  tests, 2 skipped, none failed. CI run 42357593474 for `94d363d1` then passed
  every job: the four Cores, tests on macOS, Linux and Windows, the packed
  candidate and its offline installs.
- The screens were read at each step. The Agents tab and held-session notice
  were shot again after the narrow-width and link-spacing fixes. In the final
  run, "continue a copy" read as plain text beside the notice; it is now
  underlined, checked again with a listed session held by a live process.

## Codex in Rho's own panel

On 2026-11-10 the person's own Codex conversation in Rho (the PA14 project)
answered its first messages, and then every new message was refused with "This
session is open in Codex. Close it there to continue here. Nothing was sent."
No other window had the session open.

A disposable run reproduced it: Codex through codex-acp 2.3.0, Westlake HPC
`westlakehpc/glm-5.3-flash` through the local gateway, Rho and Codex sharing
one Codex home, as on the person's machine. The first message was answered.
The second was refused at once and again 5 s later, and so was the third. Codex
keeps `thread-writer-locks/<thread>.lock` while a thread is loaded for writing.
`lsof` named the holder as the `codex` app-server that Rho's own adapter
started. The adapter keeps it for its idle period (5 min), so Rho read its own
connection as another window. A Claude Code holder is a named process, which
Rho traces back to its adapter. A Codex lock names no process, so this
conversation could never pass the check.

The lock is exclusive. With Rho's adapter holding a thread, an outside
`codex exec resume` of that thread failed with "thread … already has an active
writer", and the adapter's next prompt then succeeded. So while this
conversation's own connection has the thread open, no other window can hold
it. Rho now counts a Codex lock as its own in that case, for sending and in
the session list. Without that connection, a lock still means another window.

After the change, the same run answered four messages in a row, and the
session list showed the thread as not open elsewhere after each one. In Chrome,
the Agent panel with Codex answered three messages in a row (48, 12 and 13 s),
with no refusal on screen. `test/session-continuity.test.mjs` now holds a
fixture Codex lock: the next message goes through while Rho's connection is
open, and is refused after that connection's process is killed. Without the
change, this test fails.

Seen in the same runs, not changed here:

- With the Codex on PATH (0.167.0), codex-acp 2.3.0 failed every prompt of the
  Westlake configuration (`MODEL_PROVIDER` and `CODEX_CONFIG`) with "This chat
  uses westlake-hpc, but your current provider is openai", which reached the
  panel only as "Internal error". `codex exec` with the same provider answered.
  The runs above used the Codex bundled with the Agent plugin (0.164.0).
- From the second message on, Codex's "Model metadata for
  `westlakehpc/glm-5.3-flash` not found" warning appears in the answer text.

## Another project's Codex sessions

On 2026-11-11 the person made a new project, P3 bulkrna, and its Studio listed
the example project's conversations: "请解释一张已有图形…", Codex's own
approval-review sessions and a `rho_index` probe. Codex keeps every folder's
sessions in one place, `~/.codex/sessions`. The Agent plugin kept each file's
summary by file alone, not by the project it had been checked for. Once one
project was listed, a project opened later in the same Rho listed the first
project's Codex sessions and could read them. In the other order a project
missed its own.

Plugins `b2c6197` keeps each file with the folder its session ran in and
compares that folder with the project on every listing. A file is still read
once per change, which matters with the person's 2,470 Codex session files.
In Chrome, with two fixture Codex sessions in an example project shown first,
the new project's Studio listed both sessions and an Agent count of 2 with the
previous Plugins, and nothing with `b2c6197`; the example kept both.
`test/session-continuity.test.mjs` opens a second project in the same service
and fails on the previous Plugins. The person's own machine was not checked;
its project folder is not on this one.

## Limits

Codex continuation of a session started outside Rho was checked with a test
Agent and the person's real Codex records (read only); a real Codex model ran
only in Rho's own conversations. If Codex released a thread while Rho's
connection stayed open and another window then took it, Rho would send, and
Codex would refuse the turn. Harness sessions are listed
only through the dsh-rho adapter's observation; a `dsh headless` session is not
listed, though it continues. Native Harness records were not read directly.
Turns sent from another window are matched to Rho's by their words, so two
identical messages close together can pair wrongly. An idle Claude Code window
that holds a session counts as open, as Claude Code records it; a Codex lock
file not held by this conversation's own connection is taken as open without
testing the lock. Other clients, Windows and independent users were not
observed.

## npm delivery

On 2026-11-07 the user selected publication of the latest combined sources.
The remote `main` heads matched the clean checkouts: Core
`8bed8ef5dbb841c61845317b330e2e7f755d8f50` and Plugins
`434d9a33d82125e7b3f291fae83e7b33a0fc2a24`, already selected in
`components.json`. Rho includes every commit since `v0.5.5`, through the
retained-evidence and checkout cleanup at `26c8cb2f`. No component source
change or local override is needed to assemble them.

The registry's current `latest` was 0.5.5. Version 0.5.6 selects these sources,
the Agent connection prompt, session continuation and its fixes, and the retained
sclet reports. [CI 42360742470](https://github.com/YuLab-SMU/Rho/actions/runs/42360742470)
passed every job on `26c8cb2f`, including the three test systems and four-platform
offline installs with Linux Node 24 and 26. That candidate still names 0.5.5;
the version change needed its own CI candidate before tagging `v0.5.6`.

[CI 42361803786](https://github.com/YuLab-SMU/Rho/actions/runs/42361803786)
on release commit `cd559cc0f832cd4f68386caa351ddad942f41e21` passed all 15 jobs.
macOS and Linux each passed 315 of 317 tests, with two skipped; Windows passed
300, with 17 skipped and no failures. The same candidate passed all six offline
installation checks: macOS arm64, Linux x64/arm64, Windows x64, and Linux x64 on
Node 24 and 26. Its 3,166-file tarball is 25,665,590 bytes, with SHA-256
`022694a50a6a0b437f3d013a25df5de7e3a8c43a6a6b4594d7e0fd1235ad0eaf`.
The composition matches the selected sources above, with no local overrides.

Tag `v0.5.6` names that release commit. [Release 42362238297](https://github.com/YuLab-SMU/Rho/actions/runs/42362238297)
found the candidate, verified its hash and installation reports, and published
it without rebuilding. npm returned the publication receipt at 10:03:07 UTC on
2026-11-07, with [provenance log entry 3735209363](https://search.sigstore.dev/?logIndex=3735209363).
The exact-version registry endpoint still returned 404 at 10:03:45 UTC. A local
read first found 0.5.6 at 10:58:41 UTC, about 56 minutes after the receipt. The
25,665,590 downloaded bytes matched both the candidate SHA-256 above and npm's
SHA-512 integrity. The registry now selects 0.5.6 as `latest`.

A fresh `npm install --omit=dev --ignore-scripts @rho-workspace/rho@0.5.6` into a
disposable prefix succeeded.
Its lock names the public registry tarball and the same integrity; the installed
CLI's `--help` exits 0, its composition matches all three selected source trees
with no overrides, and all four installed Core binaries match their recorded
hashes and sizes. The macOS arm64 binary retains its executable permission.
These are installation and integrity checks, not another real-model trial.

During that wait, the maintainer's [Versions page](https://www.npmjs.com/package/@rho-workspace/rho?activeTab=versions)
showed 0.5.6 as `Validating`, explicitly identifying unfinished automated review.
For the registry's scan timing, see the [official scanning notice](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
An inventory of this exact tarball found 86,586,989 unpacked bytes: 25,484,472 in
the four Core binaries and 38,768,199 in bundled dependencies. These measurements
do not identify which content, if any, caused this version's delay.

The website was assembled from checked source `515ec7b1` and published as
`gh-pages` commit `da2822a9`. Only `index.html` and `docs/` changed; all 124 files
outside them, including the recorded demo, update feeds, setup, Skills and market,
kept their original bytes. The generated new record page had two whitespace-only
lines normalized before committing. Local checks covered 4,488 links and assets
and 806 anchors across 66 HTML pages. The updated home/version area, Status and
this delivery record were inspected at 1440 and 390 pixels without page overflow
or page errors.

[Pages run 42366857163](https://github.com/YuLab-SMU/Rho/actions/runs/42366857163)
first stayed in `syncing_files` until the action's ten-minute timeout. Its
cancellation request was acknowledged; a later deployment read returned an empty
status, retained as unknown. Rerunning only the failed deploy job reused the
8,913,779-byte built site artifact on the same commit and succeeded on attempt 2.
The native deployment read then said `succeed`. The legacy latest-build endpoint
still returned `errored` with its earlier 11:18:13 UTC timestamp; that read is kept
separate from the retry and public delivery facts.

At 11:22:57 UTC, all 97 added or changed public files matched the selected website
bytes, including the homepage and the updated Status and episode. Eight unchanged
public files had already matched during the first read and were reused, giving
105 checked paths in the retained report. The public homepage names npm 0.5.6.

This is the existing npm/WebUI release route. No existing service is replaced
and no signed desktop build is published. The independently delivered dsh-rho
0.1.5 and its pinned market entry do not change. The real-model coverage and
native-client limits above remain; this publication does not add a new model run.
