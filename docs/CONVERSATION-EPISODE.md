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

**Next run.** The top remaining problem is the resumed message's refused first call.

```text
Question:       Does a resumed message go straight to work?
Setup:          the full episode above, unchanged
Change:         keep resolved contracts across messages of one conversation, in the
                layered MCP or in Rho's transport; choose after reading how the MCP
                keeps them
Look at:        the first tool call and the text of messages 2 and 3, their turns
Change course:  if the model re-resolves by choice rather than after a refusal,
                its instructions are the owner, not the transport
```

Raw Markdown follows as its own run, together with the base-R reply, which needs the
same change.

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
- The real runs above are the end-to-end evidence. No human has used the panel.

## Evidence

Local evidence is under `work/conversation-episode/`: `run1` to `run4` with
screenshots and `log.jsonl`, the copied conversation records and the drivers used.
Claude Code's own session transcripts and grant files are private and were deleted
with the disposable projects.
