# The Graph as linked levels

Updated 2026-11-11.

## Question

On 2026-11-11 the user judged the Graph shallow. Recording every action of an Agent is
needed, but a drawing that maps those actions one to one shows no value by itself and
becomes a clutter as sessions accumulate. The meaning layer drawn above it was almost
isolated from the behaviour below. Levels should have connection points, so that
behaviour and meaning can be linked and higher abstractions built on them. From this
page a person or an Agent should see at a glance what the workspace did, open it level
by level, and reach the raw behaviour. They added that nothing should be left out for
size ("应该不设上限"), and that the page need not be advanced at once.

1. Can one screen say what was done in a project of several sessions?
2. Is every upper node a fold of lower nodes it can list, down to the recorded steps?
3. Does a statement in the notes lead to the files it rests on and to the steps that
   made them, and to the step that wrote it?

## Observed before

Measured on the real records of the PA14 quorum-sensing project (5 conversations, 11
messages, 237 recorded steps) with a throwaway probe:

- The behaviour graph had 188 nodes. The Graph drew at most 160 and left out the oldest
  message past that, so this project already lost 1 of its 11 messages.
- Messages of 50 and 66 steps were each one row of cards. Nothing stood between a
  message and its steps.
- The meaning layer was a second drawing on the same canvas. It met the behaviour only
  through "kept as" and "written in" edges, and from a finding the old edges reached a
  median of 54 actions across up to 4 sessions: too many to be an answer to "what is
  this based on".
- The page read the 6 newest conversations and the 8 newest messages of each.

## Changed

**One model of levels** (`src/work-layers.ts`, no DOM). The workspace holds lines of
work, a line holds the person's messages, a message holds activities, an activity holds
recorded steps. Each node lists its children, and `trajectory` returns every step under
any node in order.

- A step is one entry of the conversation record, with its command, output and ending.
- An activity is a stretch of steps of one kind: looking around, cells in the live
  session, a script written and run in rounds, the notes, the answer. The Agent's own
  words open the activity that follows them. Its name is counted from its steps
  ("Wrote analysis.R and ran it twice"), not written by a model.
- A line of work is a section of the project notes with the conversation it names, or
  a conversation the notes do not cover. Conversations that made the same files are one
  line. A conversation that changed no file and has no section stands below the work.

**Three kinds of connection.**

- Membership, above.
- Touches: a step read, edited, wrote or ran a file, or a file changed on disk while a
  command ran. Each keeps its basis (reported, named in a command, seen on disk). A line
  drawn to a closed node is the sum of the touches under it (`links`, `shownAs`), so
  opening a node moves each line to the deeper node it was recorded on.
- Statements: a finding or choice in the notes is tied to the files it names, and to
  the step that wrote it, found by the kept version of the notes that first holds it
  and the tool call that kept that version. `support` walks back from those files
  through the steps that made them and what those steps read. A line of work builds on
  another when it used files the other made (`flows`).

**No cap.** The 160-node limit and the limits on conversations and messages are gone.
The page reads every session, four at a time, and each whole in pages of 50 messages;
it reads every kept version of the notes, six at a time. What is drawn is what is open.
A statement first found after a notes version that could not be read is not traced.

**One drawing** (`src/layers-layout.ts`, `web/graph.tsx`). Closed, a project is its
lines of work in the order they began, each a card with its question, newest figure and
counts, joined where one builds on another. Open, a line reads left to right: Used,
Work, Made, Concluded. The work column opens in place, a message into activities and an
activity into steps. Several files taken from another line are one card that leads
there. Choosing a statement lights the files it rests on and the work behind them, and
"Show the step that wrote it" opens the levels down to that step, whose details show the
notes as kept after it. Choosing a file lists what happened to it step by step and what
is concluded from it. Search covers every level and opens what it finds. The timeline,
replay, following and the Agent's flag work on the same nodes; the flag sits on the
deepest open node that stands for the step the Agent is on.

The separate meaning layer, its toggle and the per-message lane layout were removed
(`src/meaning-graph.ts`, `layoutGraph`, `laneLayout`). A command that only looks at a
script (`cat`, `head`, `grep`, `sed -n` and the like) no longer counts as running it
(`ranFiles`).

## Runs

**PA14 quorum sensing, real records, real Chrome.** A copy in `/tmp` served by a
disposable service; evidence in `work/graph-layers-20261111/run6`.

- The page says: "3 lines of work, 11 messages, 237 recorded steps. The notes conclude
  31 things from it." Three cards carry the three questions with their figures; two
  conversations that changed nothing stand below. Swarming and Co-culture each lead
  into RNA-seq ("builds on 4 files", "builds on 2 files").
- 237 steps fold into 37 activities (the largest 30 steps), 11 messages, 5 lines.
- Of 31 findings and choices, 29 name a file a recorded step made; 2 name none. Behind
  each of the 29 stand 6 to 14 steps (median 12), all in its own line of work.
- One finding read: rests on `results/rnaseq_mutant_overlap.csv`, "12 recorded steps in
  3 activities", "Written by Claude Code at 12:34:24, first in version 16 of 23 of the
  notes". Its step, "Edited project-notes.md", opened with the notes as kept after it.

**The same records repeated to 25 conversations** (55 messages, 1,185 steps;
`work/graph-layers-20261111/many3`). The lines were drawn 0.2 s after the click, every
session was read by 0.4 s, and a line opened in 0.07 s, with the service on the same
machine. The first run of this check showed three defects, since fixed: the page opened
on one card in the middle of an empty canvas, lines between rows ran through other
cards, and the timeline's lane names collapsed. Past 8 lines of work a closed line is
now its name and counts, so the 15 lines and 10 other conversations were on one screen
with readable names; the timeline shows 6 lanes and scrolls the rest, newest first.

## Checks

- `test/work-layers.test.mjs`: activities from a recorded message, lines and what they
  build on, a statement's support and the step that wrote it, lifted lines, the layout,
  and the shipped `example/pa14-qs` (every recorded step is in the graph; each named
  statement rests on a file a recorded step made, behind it at most 40 steps).
- `npm run acceptance:graph`: 9 of 9 with a controlled peer that runs the real Rscript.
  `scripts/review-evidence-acceptance.mjs` passed with the Graph opening a
  version-bound review.
- All tests: 347 passed, 3 skipped, none failed (350). `npm run check:contracts` passed.

## Limits

- A change seen on disk while a command ran says when, not that the command made it.
- The record does not say which data a script read. A script's inputs appear only when
  a step read them or a command named them, so a statement's support can stop at the
  script.
- A notes section keeps all the messages of its conversation, including a later
  message about another section's subject.
- Activity names are counted, and a line without a notes section is named by its
  conversation's title. No model writes a summary of a node yet.
- The browser reads every session when the page opens. Nothing is precomputed, and the
  25-conversation run was on one machine with a local service.
- An Agent cannot read these levels yet: they are built in the browser.
- Past 8 lines the closed cards lose their figure. With many more lines than one screen
  holds, the page opens on full rows from the top; there is no level between the
  workspace and its lines.
- Only the builder has read these screens.
