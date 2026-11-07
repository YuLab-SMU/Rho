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
  tests, 2 skipped, none failed.
- The screens were read at each step. The Agents tab and held-session notice
  were shot again after the narrow-width and link-spacing fixes. In the final
  run, "continue a copy" read as plain text beside the notice; it is now
  underlined, checked again with a listed session held by a live process.

## Limits

Codex continuation was checked with a test Agent and the person's real Codex
records (read only), not a real Codex model run. Harness sessions are listed
only through the dsh-rho adapter's observation; a `dsh headless` session is not
listed, though it continues. Native Harness records were not read directly.
Turns sent from another window are matched to Rho's by their words, so two
identical messages close together can pair wrongly. An idle Claude Code window
that holds a session counts as open, as Claude Code records it; a Codex lock
file is taken as open without testing the lock. Other clients, Windows and
independent users were not observed.
