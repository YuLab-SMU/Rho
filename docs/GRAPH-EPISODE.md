# One workspace and the Graph

Updated 2026-10-27.

## Question

After the drag pass the user said the Agent canvas and the workspace should be one
page: the person and the Agent can share a context only if they work in the same
place. They asked for a Graph page instead, as a way of showing what the Agent did,
and gave four references: a project graph of questions, data, scripts, tables,
figures and notes joined by labelled relations; a task panorama with stages, cards
that carry tables and charts, an Agent flag on the card it works on and a timeline
of small actions; a focus path through one result with a legend separating recorded
relations from Agent suggestions; and a stage flow with a side panel. They left the
treatment open ("你觉得要做出彩，应该怎么做就怎么做").

The references set the kind of page, not values to copy. The questions:

1. Do the person's views and the Agent's files land in one workspace either can
   arrange?
2. Can a person tell from one page what the Agent read, changed and ran for each
   question, and what came of it, without opening the conversation?
3. Can a person trace one result back to its data and question, and watch the work
   happen, live or replayed?

## Observed before

- Following opened the Agent's files in a separate `agent-canvas` workspace. The
  person's own workspace (`workspace`, where Open in Studio and Files placed views)
  never received them, so the two had different views of the same files.
- The Agent page listed each message's files and commands as text. Nothing joined a
  file one message wrote to the message that read it later.
- The conversation record gives each tool step one time, its latest report: when it
  started while it runs and when it returned once it has. A finished command's
  record does not say when it started.
- A folder walk listed names and sizes, not when a file changed, so nothing could
  say which files changed while a command ran.

## Changed

Rho only:

- **One workspace** (`web/canvas.ts`, `web/main.tsx`, `web/project.tsx`,
  `web/preview.tsx`, `web/overview.tsx`). Following, Open in Studio, opening a file
  from Files and a file named on the Agent page all use the workspace on screen,
  else the one last open in this tab, else the first, else a new `workspace`. A file
  the Agent opens joins the group the Agent's work made for its side, else a group
  already holding that side's views (editor for code; table and media for data and
  figures), else an empty workspace's one group; otherwise its side gets a group at
  that edge. Only groups the Agent's work made close their oldest views past six.
  The workspace's own Follow Agent and Step away buttons are hidden there; Studio's
  Follow is the one control. A file the person opens is held while following goes
  on; one following brings is only shown. An existing `agent-canvas` stays an
  ordinary workspace.
- **When files changed** (`src/server.ts`, `src/protocol.ts`): `project.entries`
  returns `modifiedAt` for each entry.
- **What changed during a message** (`src/conversations.ts`, `src/protocol.ts`):
  the service walks the project's files (time and size, without `.rho` and `.git`)
  when a message starts and again when it ends, and keeps the added, modified and
  removed ones on the message as `files`. At most 20000 files are compared and 200
  changes kept, the rest counted; a walk stopped at its limit marks the record
  partial and calls nothing removed. It says what changed meanwhile, not what made
  the change.
- **The work as a graph** (`src/work-graph.ts`, DOM-free). Nodes are each question,
  each project file a message read, edited or wrote, each command, and each file
  that changed on disk during a message. Edges carry their basis:
  - the Agent reported it: read, edited, wrote, ran;
  - named in a command: the script a command runs, or another file it names;
  - seen changing on disk: changed while a command ran (between the step before it
    and its return), or during the message when no command was running. A finished
    message uses its recorded changes; a running one, or a record from before them,
    uses each file's last change time, up to when the next message was sent.

  Messages are named by conversation and message, so two conversations' first
  messages stay apart.

  A file a message changed is its output, not its input; reading it only after it
  changed is looking at the output. Refused steps and paths outside the project are
  left out. At most 6 conversations × 8 messages and 160 nodes are drawn; past that
  the newest messages are kept whole and the page says how many it left out.
- **The Graph page** (`web/graph.tsx`, `web/graph.css`; the sidebar row after
  Studio):
  - each message is one row read left to right, from what it took in to what changed
    while its command ran; a file an earlier row touched appears in a later row as a
    small reference that goes there; questions stand in one column;
  - cards show a table's first rows and size and a figure's pixels (at most 16
    previews a page, two read at a time, figures up to 2 MB), and a question's card
    the start of the Agent's answer;
  - choosing a node shows the path it came by and what it fed, and the inspector
    shows the file in its own view, its history and its relations, with Open in
    workspace; arrow keys walk along the edges and within a column;
  - the timeline marks each message as a band and each action as a tick; dragging,
    the arrow keys or Play show the graph as it stood then, with a caption naming
    the action; long pauses between messages are cut;
  - while the Agent works, its card carries the Agent's flag, new cards arrive with a
    short mark and the line into the live card moves; Follow keeps it in view and
    the files still open in the shared workspace, without leaving the Graph;
  - a step that waits for the person's choice turns its flag amber, the header shows
    Needs your choice, and the inspector answers it with the Agent's own options;
  - pan by dragging or scrolling, zoom with pinch, ⌘/Ctrl-scroll, the buttons or
    +/−/0; far out a card is its name, drawn to be read; a map shows the rest when
    the graph does not fit.

## Runs

Evidence: `work/graph-20261027/` (ignored by Git). `look.mjs` drives a controlled
peer that runs the real Rscript in a disposable project; `agent.mjs` asks the
person's own Claude Code.

| Run | What was looked at | Observed | Change |
| --- | --- | --- | --- |
| `look.mjs` 1 | Two messages, whole graph | Inputs were drawn right of the question that read them | Layers keep each edge's direction; sources sit just before their reader |
| `look.mjs` 2 | Edge labels | Every output said "changed meanwhile": a finished step's time is its return | A command spans the step before it to its return; its card sits at the start |
| `look.mjs` 3–4 | Fit, 1440 px | One long chain; at fit no title could be read | One row per message with references; large names far out; a map; opening at 78% |
| `look.mjs` 5 | Labels, replay | Labels overlapped; the caption lower-cased the command | Wider gaps, two-line labels, the question→run line hidden when a file joins them |
| Claude Code 1 | Real run from the Graph | Claude asked to run a command and waited 8 minutes; the card said Running | A waiting step turns amber, the header says so and the inspector answers it |
| Claude Code 2 | Two messages (English, Chinese), Sonnet 5.5 | 5 and 3 choices answered on the Graph; 61 s and 37 s; 9 views in one workspace, no page errors. Message 2 reran `analysis.R`, so the figure message 1 made was drawn only as message 2's output | Each message keeps what changed on disk while it ran |
| acceptance | Back-to-back messages | `plot.R`, written in message 2, was drawn as changed in message 1: its 2.5 s grace ran past the next send | Changes belong to a message until the next one is sent |
| acceptance | Open in workspace while following | The workspace opened on `airquality.csv`, not the table asked for | A file the person opens is held |
| Claude Code 3 | The same two messages again | 5 and 3 choices answered on the Graph; 76 s and 40 s; no page errors. The figure reads Changed 2× and its path reaches both commands that rewrote it. The inspector's history squeezed each message's name into a sliver beside a long command | The name goes on its own line under what happened (`inspect.mjs`) |

## Checks

- `test/work-graph.test.mjs` (6): edges and the window of a finished command; later
  messages, refused steps, paths outside the project, the live step and a waiting
  choice; a change after the next message was sent, and two conversations' messages
  kept apart; recorded changes that survive a later rewrite; a layout that is
  deterministic, without overlaps and with sources before readers; rows, references
  and aligned questions.
- `test/acp-conversations.test.mjs`: a message records the files added and removed
  on disk while it ran; a comparison stopped at its limit says it is partial and
  calls nothing removed. `test/web-style.test.mjs` caught a stylesheet token (`--k`)
  read but not declared.
- Ledger: Rho 212/212 (serial) and Plugins 92/92 ([ledger](VERIFICATION.json)).
- `npm run acceptance:graph` 8/8 (above); `acceptance:agent-canvas` 10/10, now
  checking one workspace with the Agent's data group beside the person's script and
  Graph in the sidebar; `frontend` 13/13, `agent-ui` 7/7, `continuity` 7/7, `sources`
  7/7, `objects` 5/5, `actions` 6/6, shell, pages, person and plugin UI (9 checks).
- `build:service`, `build:web`, the web type check and `check:contracts` passed.
- Documents: links and anchors of this page, Status, Frontend, the index and the
  canvas episode were checked and their rendered pages read.

## Limits

- Edges come from the Agent's reports, command lines and file times. A change seen
  while a command ran says when, not that the command made it; a file changed by
  something else at that moment would be drawn the same way.
- A file a message is still writing, or one in a record from before the change
  record, is placed by its last change: a later message that rewrites it moves it
  there. Earlier versions are not drawn, only that each message changed the file.
- Commands the Agent runs outside the project, such as reading its own Skill files,
  are drawn like the project's; their titles show paths outside the project.
- At the opening zoom the map can cover the lower-left card until the view moves.
- Only files the folder walk reaches (48 folders, 5 levels, 4000 files) can be seen
  changing.
- The Agent's own account of its work (`task.map.declare`, items with `from`) is not
  drawn yet; the Graph shows only what the records show.
- Previews capture a snapshot of the file through Files, as showing it in place
  does.
- No person other than the builder has used the page.
