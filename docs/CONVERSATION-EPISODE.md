# Conversation episode

This episode exercises a conversation with Claude Code that a person starts from
Rho's Agent panel: ask about a project, follow the Agent's work, reply, come back
after a reload or a service restart, let the Agent change a file, and stop it. It
also checks how a session started outside Rho appears. It uses the person's own
Claude Code installation, a real service process and installed Chrome; the person
is automated. Each run ends with a review that decides what the next run should
show ([Development](DEVELOPMENT.md#one-iteration)).

## Who holds the input

The user decided this on 2026-10-25: a session owns its conversation and Rho owns
the workspace. Whoever holds a session's input provides its conversation entry, so
each session has exactly one place where a person types to it.

- **A session started outside Rho**, for example Claude Code in a terminal granted
  with `rho --grant`, keeps its input in its own window. Rho shows its work and
  offers one-way feedback, which is not a chat box. The Agent panel lists it under
  "Sessions started elsewhere" and says to continue it where it was started.
- **A conversation started in Rho** is held by Rho. The Agent panel is its input.
  Closing the panel or reloading the page only stops observing it, and a service
  restart keeps it. When a session has ended, the person starts a new one; Rho does
  not take over another window's session.

## How a conversation runs

Rho records each conversation in the project's owner state
(`.rho/rho/conversations/`) with one Claude Code session ID. Each message runs one
`claude -p` process in the project folder: `--session-id` for the first message,
`--resume` once Claude Code has confirmed that session. The process uses the
person's Claude Code configuration and model and only Rho's four MCP tools, under a
project grant like the one `rho --grant` gives (`--tools ''`, `--strict-mcp-config`,
`--permission-mode dontAsk`). Rho reads its stream and keeps the Agent's text, each
tool step with its operation and outcome, provider errors and the ending. Hidden
reasoning is not kept.

Because each message is its own process, the MCP server that message talks to is new
too. The complete contracts and guidance it resolved are kept beside the conversation's
private connection and restored when the next message starts, so a resumed message
works from what it already resolved instead of being refused once. Only immutable
bodies verified by their own digest are kept, the service still rechecks the current
contract before every call, and a superseded contract is dropped rather than reused.

A message has its own identity. Repeating it returns the original, and changed words
under the same identity are refused. Rho writes the message before starting Claude
Code. If Rho stops observing a message, for example because the service died, the
message reads as unknown and is never sent again; while that earlier process may
still be alive, a new message is refused. Closing Rho stops a message that is being
answered and records why. Stop signals the process group and confirms its exit.
Only the person at this machine can start, send to, stop or read these
conversations. Agent grants, the operator connection and paired links cannot.

The limits are in `conversationLimits` (`src/conversations.ts`) and can be changed
with `--limits`. Starting or sending is refused with `limit` beyond 64 conversations
per project, 200 messages or 8 MiB per conversation, 16 KiB per message, or four
messages being answered at once. A message stops, with the reason recorded and its
steps kept, after 64 model turns, 30 minutes, 32 MiB of output or a 4 MiB output
line. Text beyond 64 KiB per step is cut and marked, and steps beyond 256 KiB per
message are counted rather than kept.

## Setup and rerun

The project is a disposable `air-quality` folder: `data.csv` with the first 12 May
rows of R's `airquality` and a two-line `notes.md`. The person asks, in order:

1. "What is in this project? Give me a short overview of each file."
2. "Which column in data.csv has the most missing values, and how many are missing?"
   The page then reloads, and the service restarts on the same state and port.
3. "Add one line at the end of notes.md that records your answer about missing
   values, then save it."
4. "Read data.csv and notes.md again, then describe every column of data.csv in
   detail, one paragraph each." Stop is pressed once a step appears.

A session is then granted the way `rho --grant` does and makes one call, and the
panel is checked at 390 CSS pixels.

```sh
npm run build
node scripts/conversation-episode.mjs RUN_NAME
```

The driver needs Chrome, a configured Claude Code CLI and the Core binary at
`../Rho-core/target/debug/rho-core`. It writes screenshots and `log.jsonl` to
`work/conversation-episode/RUN_NAME/` and leaves the project in a new `/tmp/rho-conv-*`
folder. Four messages cost about US$4 with the configuration below. It is run 3's
script with the outside-session call corrected; in this form it has not yet run
end to end.

Runs used Chrome 155.0.8059.84, Claude Code 2.1.310 with the person's own
configuration (Opus 5.5 with 1M context, maximum effort, their provider) and R
4.5.2. The Agent ran no R in these runs.

## Runs 1 and 2 (2026-10-25)

Run 1 opened the panel before the project had loaded; the driver now waits for the
message box. Run 2 found that the Agent plugin was unavailable: Rho selected Agent
0.4.4 while the Plugins checkout had moved to 0.4.5 (`547bd97`). Neither a
conversation nor `rho --grant` could work in this local composition. Rho now selects
0.4.5, and the lockfile's local link metadata was refreshed.

A probe of the provider found that a Claude Code session with no tools received 502
after Claude Code's retries, while sessions carrying tools were answered. A
conversation in Rho always carries Rho's tools.

## Review of run 3 (2026-10-25, 22:16–22:23 EDT)

The run asked whether a conversation started in Rho works end to end on real
resources. It takes this part to the *runs* stage. The observations come from the
screenshots in `work/conversation-episode/run3/` at 1440 × 900 and 390 × 844 and
from the conversation record.

| Message | Ending | Model turns | Time | Cost |
| --- | --- | ---: | ---: | ---: |
| 1 · overview | Completed without an overview | 40 | 197 s | US$1.04 |
| 2 · missing values | Completed | 5 | 73 s | US$1.38 |
| 3 · edit notes.md | Completed; saved | 5 | 75 s | US$1.82 |
| 4 · long description | Stopped after 20 s | — | — | — |

**What works.** Steps and replies appear while the Agent works. The second message
resumed the same Claude Code session, and so did the third after the reload and the
service restart. The Agent changed `notes.md` through a conditional save, and the
file on disk matched its reply. Stop ended the process 0.58 s after it was pressed
(exit 143), and the message reads "Stopped. Steps already taken stay done." with its
steps kept. The outside session is listed with "Continue this session in the window
where it was started. Rho shows its work here." The list and conversation fit at
390 px.

**What does not work yet.**

1. *Blocking.* The Agent cannot see which files the project has. Asked for an
   overview, it searched the operation index 18 times, read parts of the project
   snapshot and answered after 197 s: "I couldn't give you the overview: none of the
   operations I have here can list what's in the project folder". Cause, at the
   capability level: Agent grants and the capability index left out every
   `project.*` operation, including the read-only, confined `project.entries`. A
   session started outside Rho has its own file tools; one started in Rho has none.
2. *Friction.* A resumed message begins with a refused call and talk about mechanics:
   "The earlier resolution no longer authorizes the call. I'll refresh the index and
   resolve the contract again." Later messages begin by resolving again "for this
   turn". Cause, at the composition level: each message starts a new Claude Code
   process, MCP server and grant token, and the layered MCP keeps resolved contracts
   only in memory, while the model remembers resolving them. The owners are Rho's
   per-message transport and the Agent plugin's layered MCP.
3. *Friction.* The Agent's Markdown is shown raw (`**`, backticks, `>`). This is the
   second consumer after the base-R reply
   ([problem 1](BASE-R-EPISODE.md#review-of-the-2026-10-25-run)).
4. *Misleading.* The newest lines and the ending, such as "Stopped.", sat behind the
   message box. Cause: the scroll target was placed before the sticky box.
5. Each message costs more than the last (US$1.04, 1.38, 1.82), because every
   message resumes the whole session in a new process. The model and effort are the
   person's choice; Rho does not set them.

**Decision.** Fix 1 with the smallest change, an Agent grant that includes
`project.entries`, and fix 4. Then ask the first question again.

## Review of run 4 (2026-10-25, 22:35–22:37 EDT)

The run asked whether a session started in Rho can now say what is in the project. It
used a fresh copy of the same project and only the first message
(`work/conversation-episode/again.mjs`). The changes were:

- Agent grants and the index now include `project.entries`, so sessions started
  outside Rho get it too. The operation lists one folder level, inside the project
  root only, and skips owner state and symbolic links.
- Its response contract now allows the empty path that a listing of the project root
  has always returned. The new boundary test found this mismatch; the browser and
  the MCP client had not validated the reply.
- The scroll target now sits below the message box.

**Observations.**

- The Agent found `project.entries` after three index searches, listed the root,
  opened both files, checked for runs and answered in 13 model turns, 96 s and
  US$0.57. Its overview is correct against the fixture: the column names, missing
  Ozone on May 5 and 10, missing Solar.R on May 5, 6 and 11, and every range.
- "Done in 2 min" stays visible above the message box at 1440 and 390 px.
- The outside session's listing returned the same two files, and its row reads
  "Last active 22:37".
- Markdown is still raw, and the overview has many marks (`` **`data.csv`** `` and lists).
- "Done in 2 min" rounds 96 s up. This is polish.
- The single browser console error is Chrome's request for `/favicon.ico`, which Rho
  has never served.
- The default business grant now has 64 methods, the most a layered grant may have.
  The next operation that Agents can use would make Rho refuse every default grant,
  including `rho --grant` and these conversations.

**Decision.** Keep the change. The first message now answers the question asked.

## Review of run 5 (2026-10-26, 12:34–12:38 EDT)

The run asked whether a resumed message goes straight to work. It used the full
episode above, unchanged, and the same Chrome, Claude Code and project fixture.

**Cause, found before spending a model run.** A conversation runs one MCP server per
message, and the layered MCP kept resolved contracts in memory only, so the next
message's server was empty while the model remembered resolving them. The first call
was refused by the cache check, not by authorization or scope:

```text
Resolve this complete selected contract first; summary, stale references and partial
pages cannot authorize execution.
```

`work/conversation-episode/resume-contract.mjs` runs that boundary with no model: one
MCP process resolves and calls `project.entries`, then a second process under the same
connection calls it straight away. Before the change the second call was refused
(`condition`); after it, `ok`.

**Change, in the owner that keeps the cache.** Resolved bodies are now kept beside the
private connection, one file per content-addressed reference under
`mcp-knowledge-<project and native session>`, bounded by the cache's own entry and byte
budgets, newest kept. Each body is re-verified on load and only bodies the cache
actually retained are kept. Authorization is untouched: the service still rechecks the
current contract reference on every call, a superseded contract is dropped from the
kept set rather than reused, and another connection starts empty. The Agent plugin
moves to 0.4.6, so Rho selects 0.4.6; the owner contract snapshot changes only in its
three `packageVersion` fields, and the contract digests are unchanged.

An earlier attempt (kept as `run5-attempt1-plugin-unavailable`) failed at the first
message: the plugin descriptor still declared 0.4.5 while Rho selected 0.4.6, so Rho
reported the Agent plugin unavailable. The descriptor version moves with the package
version; nothing reached a model in that attempt.

| Message | Ending | Model turns | Time | Cost | First call |
| --- | --- | ---: | ---: | ---: | --- |
| 1 · overview | Completed | 13 | 94 s | US$0.48 | `rho_index` returned |
| 2 · missing values | Completed | 2 | 20 s | US$0.56 | `document.read` returned |
| 3 · edit notes.md (after reload and restart) | Completed; saved | 5 | 68 s | US$0.83 | `rho_resolve` returned |
| 4 · long description | Stopped after 1.1 s | — | — | — | `document.read` returned |

Against run 3, message 2 fell from 5 model turns, 73 s and US$1.38 with a refused first
call to 2 turns, 20 s and US$0.56 with no refusal; message 1 fell from 40 turns, 197 s
and US$1.04 to 13 turns, 94 s and US$0.48.

**What works.** Message 2 opened with "I'll re-read the file's current buffer first, in
case it changed since I opened it" and called `document.read` once; its answer is correct
against the fixture, and it closed with "I checked the current file before counting".
No message explains internal mechanics any more. Message 3 after the page reload and the
service restart resolved only the edit and save contracts it had never held, then read,
edited and saved `notes.md`; the file on disk matches its reply. Stop still ends the
process (exit 143) in 1.1 s with "Stopped. Steps already taken stay done." and its steps
kept. The outside session's listing still returns both files.

**What does not work yet.** Agent text is still raw Markdown (`**`, backticks, `>`),
visible in messages 1 and 3. Each message still costs more than the last in absolute
terms because every message resumes the whole session; the fix removed the re-resolve
turns but not that growth. The 64-method grant limit still needs a decision. One
browser console error is Chrome's request for `/favicon.ico`; the other is the expected
`ERR_CONNECTION_REFUSED` while the service restarts.

**Decision.** Keep the change. Resumed messages now go straight to work.

**Next run.** The top remaining problem is the Agent's raw Markdown, which the base-R
reply shares.

```text
Question:       Is an Agent reply readable as the Agent meant it in the panel?
Setup:          the full episode above, unchanged; also the base-R episode's reply
Change:         render the reply's Markdown in the panel and in the base-R reply, in
                whatever owner draws both
Look at:        messages 1 and 3 in the panel, and the base-R episode's reply
Change course:  if the panels differ in what they can show, the two replies need
                different owners rather than one renderer
```

Before another operation becomes visible to Agents, the 64-method limit needs a
decision: a higher limit, a narrower default grant, or grants chosen per task.

## Checks

- `node --test test/conversations.test.mjs` uses a stand-in Claude Code CLI to cover
  message identity, the conflict for changed words, resuming the same session, the
  refused second message while one is answered, Stop and close, a provider failure,
  a lost message that stays unknown and is not sent again, and the boundary tests:
  the grant has no conversation or session methods, lists the project folder and
  is refused `project.open`.
- The full Rho suite is in [Status](STATUS.md#conversations-started-in-rho).
- `node --test test/layered-mcp.test.mjs` covers the knowledge a connection keeps: a
  new process under the same connection calls what it resolved last message, another
  connection starts empty, a superseded contract is not kept, and a body the cache
  cannot retain never becomes an executable proof.
- `work/conversation-episode/resume-contract.mjs` reproduces the message boundary with
  no model: two MCP processes under one connection, one resolve, then a direct call.
- The real runs above are the end-to-end evidence. No human has used the panel.

## Evidence

Local evidence is under `work/conversation-episode/`: `run1` to `run4` with
screenshots and `log.jsonl`, the copied conversation records and the drivers used.
Claude Code's own session transcripts and grant files are private and were deleted
with the disposable projects.
