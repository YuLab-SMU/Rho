# One workspace and the Graph

Updated 2026-10-28.

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

## The timeline, the Overview and Host activity

Updated 2026-10-28. The user called the Host activity section on Outside Rho "still
like shit", asked for the Overview too, and for the bar under the Graph to be richer,
with two references: a panoramic timeline with a legend of kinds, coloured blocks, a
time axis and a labelled current-time marker; and one swimlane per Agent with
thinking, tool, waiting and failed blocks, play and 1×/2× speed.

Observed before, on a copy of the person's own project (two real conversations, five
messages, six figures in `ggplot2-demo/out`), at 1440 and 390 px:

- The Graph's bar was one flat strip of equal dots. It could not say which
  conversation a step belonged to, what kind of step it was, or how long a pause was.
- The Overview listed workspaces and results as text and carried the observation's
  diagnostics as paragraphs. None of the six figures was shown as a picture.
- Host activity (the Agent plugin's `ActivityFeed`) was paragraphs under a heading:
  the lost Host, the counts, each action and the output folder all in the same text.

Changed:

- **Timeline.** One lane per conversation, named by its title and Agent mark. Each
  step is a block in its kind's colour, read from the same `GraphEvent` actions the
  Graph draws (asked, read, edited, ran, changed on disk, answered); a refused or
  unknown step is marked as failed. The legend counts each kind and filters to it.
  Messages less than 30 s apart form one stretch, sized by the square root of its length;
  between stretches the pause folds to a 44 px gap labelled with its length. The
  axis picks a tick step that keeps labels 72 px apart. Hovering a block names it
  and its time; replay labels the head with its time and plays at 1×, 2× or 4×.
- **Overview.** The same timeline in small (no controls) heads the page under "What
  the Agent did" and one line: questions, conversations, commands, files changed and
  the last time. Results follow as cards newest first, a figure as its pixels and a
  table as its first rows (`web/previews.ts`, shared with the Graph's cards), eight
  in all. Workspaces are cards naming their views. Shared notes is one row with its
  unsaved state; what the observation left out folds under Observation notes.
- **Host activity** (Rho-plugins, Agent 0.4.14). `ActivityFeed` draws itself with a
  prefixed stylesheet on the embedding's colour tokens: a lost Host is one card with
  Reconnect, counts are tiles, each action a card with its state, and Outputs a
  folder field and file rows. Its reads, limits and wording of facts are unchanged.

Runs (`work/timeline-20261028/look.mjs`, evidence in `before/`, `after*/`):

| Run | Observed | Change |
| --- | --- | --- |
| 1440, Graph | Both lanes were titled "hi", the first message | Lanes use the Agent's title for the conversation |
| 1440, Graph | The pause label sat on the next stretch's first tick | The gap became 44 px and the label a small pill |
| 390, Host | Rho's label style stacked "Project folder" over its field | The plugin's form row sets its own direction and margin |
| 390, Host | "Refresh outputs" broke onto two lines | Buttons keep one line; the form wraps instead |
| `acceptance:frontend`, four widths | The Overview card selector had changed. Registered run results showed only their kind under a hashed `.rho/plugins/runs/…` folder; on phones shared notes stood centred in a column | The check opens the workspace card; a result previews its exact version and reads Run output; the notes keep icon and text side by side |
| 1440 and 390, all three | 23 actions in two lanes with a 2.8 h fold; six figure thumbnails; the lost-Host card; no page errors, no horizontal overflow | — |

Checks: ledger Rho 218/218 and Plugins 92/92 ([ledger](VERIFICATION.json)); `graph` 8/8,
`frontend` 13/13, `continuity` 7/7, `agent-page` 7/7, `agent-canvas` 10/10, `agent-ui`
7/7, `sources` 7/7, `objects` 5/5, `actions` 6/6, `plugin-dx` 3/3, shell, pages at four
widths, person and plugin UI; build, the web type check and `check:contracts` passed.

Limits:

- Block colours say what the record says a step was, not whether its result is
  right. Changed on disk keeps the Graph's limit: it says when, not who.
- The Overview shows eight results. A file's preview captures a snapshot through
  Files and a registered result is read at its version; at most 16 per page, two at
  once, figures up to 2 MiB and tables to 3 rows by 4 columns. A file that cannot be
  previewed shows its kind.
- The activity feed was then run with real Claude Code and dsh through the collector
  ([runs 7–8](AGENT-ACTIVITY.md#real-episode-and-review)): paths now read relative to the
  project and opening the section brings it into view.
- No person other than the builder has used these pages.
