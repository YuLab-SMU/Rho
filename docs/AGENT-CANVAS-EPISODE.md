# Project sidebar and Agent canvas

Updated 2026-10-27.

Later the same day the user asked for the canvas and the workspace to be one page. The
Agent's files now open in the workspace the person shares with it, and the Graph shows
what the Agent did; see [One workspace and the Graph](GRAPH-EPISODE.md). The runs below
describe the separate canvas as it was.

## Question

The user tried working with the Agent inside a project and found it a poor
experience. The project sidebar held almost nothing (Overview, Files, Activity),
and while the Agent worked the main area stayed on the project page. They supplied
a reference screen with a project block, Overview/Studio/Graph/Agent entries, a
Sources section counting Data, Code, Runs, Results & figures and Notes, and a
studio of code, table and figure views. They asked for a sidebar like it, and for
the canvas to move with the Agent while it works.

The reference set layout weight and hierarchy, not values to copy. Rho has no
Graph, so the sidebar shows none. The questions this pass answered:

1. Can a person see what a project holds, by the kind of file they look for, from
   its sidebar?
2. When the person asks the Agent for something, does the canvas show the files
   the Agent reads and changes, as it works, without taking over what the person
   chose to look at?

## Setup

- Real runs: a disposable `air-study` project (`data/airquality.csv` from R's
  `airquality`, `scripts/analysis.R`, `notes.md`, `README.md`), Claude Code 2.1.312
  through Westlake HPC (`westlakehpc/deepseek-v4.1-flash`) over ACP, R 4.5.2, and
  Chrome 155.0.8059.84 at 1440 × 900 and 390 × 844. The message was typed into the
  Agent panel and sent with Start: read the table and the script, change the script
  to compute mean Ozone by Month, write `results/ozone_by_month.csv` and a bar
  chart PNG, and run it. Screens were taken every 2.5 s during the turn.
- Script and evidence: `work/agent-canvas-20261027/` (ignored by Git):
  `episode.mjs` (runs `first`, `second`, `third`, `final`) and `review.mjs` (four
  widths after a turn, without a model).

## Observed before

- The sidebar (screens from the earlier real ACP turn in
  `work/agent-ui-live-20261027/real-rendered-1440.png`) offered Overview, Files and
  Activity, the workspaces by identifier, and settings at its foot. Nothing said
  what the project held.
- While the Agent read `input.txt` and ran `ls`, the main area stayed on the project
  page. The work showed only as rows in the 340 px Agent panel.
- The Documents owner returned an open buffer as it was when first opened. A
  file the Agent changed with its own Edit or Write tool, or with a command, kept
  showing its old text in Rho; reopening it did not help.
- `agent.activity.capture`, the browser's way to show a CSV or image as a file
  snapshot, located the file by walking its whole directory: a file at the project
  root was refused and a folder holding more than 64 files failed the scan.

## Changed

**Rho** (`web/project.tsx`, `web/main.tsx`, `web/sources.ts`, `web/canvas.ts`,
`web/agent-now.ts`, `web/overview.tsx`, `web/shell/workspace.tsx`, CSS):

- **Sidebar.** "All projects" above a project block (initials, name, a menu to
  switch to another open project). Overview, Studio with its workspaces under it,
  Agent with a Working or Needs you badge, and Activity with its run count. Sources
  counts Data, Code, Results & figures and Notes, then Files; `+` adds a source
  folder. Counts come from one bounded walk of the project folders (48 folders,
  5 levels, 4000 files); a partial walk shows `+` and says so. Kinds come from file
  names only. Tables in an output folder (`results`, `output`, `figures`, …) count
  as results; registered results count there too, file snapshots taken only to show
  a file do not.
- **Sources pages.** Each kind lists its files across the project and its source
  folders, with a filter. A CSV or image opens in its table or media view, text in
  the editor, a registered result as its exact version. (A later pass shows them in
  place instead; see [Browsing Sources from the sidebar](#browsing-sources-from-the-sidebar).)
- **Studio.** Workspaces are tabs at the top of Studio with their view counts. The
  Agent canvas is the workspace `agent-canvas`, shown as "Agent canvas".
- **Following.** Sending a message from the Agent panel opens the Agent canvas and
  follows the running turn. Each file the Agent's steps name inside the project
  opens there once: a read as soon as it is reported, an edit or write once it
  returned. A finished command opens the project files its command line names, and
  an output that appears or changes on disk during the turn (or in the walk just
  after it) opens too, without a claim about who wrote it. Code sits on the left,
  data and figures on the right, at most six per side; a newer snapshot of a file
  replaces the older one. Every placement is one conditional layout write.
- **The Agent's place.** The tab of the file the Agent last named carries
  Reading/Read, Editing/Edited, Writing/Wrote or Running/Ran, live while that step
  is the newest one running. The topbar shows the Agent and its newest action on
  every project page, amber when a native permission waits; clicking it follows.
- **The person's place.** Choosing another tab, typing in a view or going to
  another page stops following; nothing then opens or moves. "Follow Claude Code"
  resumes and brings the newest file forward. A followed view is not held, so a
  replaced snapshot does not linger as a second tab.
- The workspace's older attention bar is not shown on the Agent canvas; its own
  follow control would have been a second "Follow" with another meaning.
- A tab bar keeps its tab names and moves a view's own controls to a second row
  when both do not fit. The sidebar is hidden by CSS below 768 px, so no frame
  shows it before the page knows it is narrow.

**Documents 0.4.3** (`Rho-plugins/plugins/documents`): a buffer with no unsaved
text follows its file. On `open`, changed disk text is adopted as one `edit` by
the author `disk`, recorded as the smallest changed span, so views show the
current text and history keeps the text before. Unsaved text or a pending save is
never replaced. The editor labels such changes "File on disk" and highlights them
with Agent edits under "Highlight changes".

**Agent 0.4.12** (`Rho-plugins/plugins/agent`): `agent.activity.capture` observes
only the named file: inside the project, reached without symlinks, a regular file
of at most 8 MiB. `expectedDigest` became optional; with it the capture is of that
exact version, without it of the current bytes. The output-list scan is unchanged.
Annotations 0.4.4 only widens its optional Documents peer to include 0.4.3.

## Runs

| Run | What happened | Cause | Change |
| --- | --- | --- | --- |
| `first` | Sidebar counted 1 data, 1 code, 2 notes. Every canvas write was refused: "Remove `axis`". | A split with one child does not match the layout contract. | The canvas is a split only with both sides. |
| `second` | `analysis.R` opened and showed the Agent's rewrite with its lines highlighted. The CSV and PNG were refused; no tab showed the Agent's place. | A `path` prop the table/media views do not declare; presence needed the newest step to be a file step. | Snapshot views are named by a hash of their path; presence follows the last named file. |
| `third` | `analysis.R`, `airquality.csv`, `ozone_by_month.csv` (from `cat` in the command) and the PNG opened; Read, Writing and Ran showed on tabs. A view's header button covered the tab names. | Tabs shrank to make room for owner controls. | Tab names keep their width; controls wrap. |
| `final` (1) | The regenerated PNG appeared twice. | Following used the person's "open and hold" path, so the replaced view was kept. | Following only brings a view forward. |
| `final` (2) | The PNG never opened. | No step named it; the command only listed `results/`. | Outputs that appear on disk during the turn open. |
| `final` (3) | Six views, each file once, nothing duplicated, 0 page errors. | — | — |

## Checks

- `npm run build` and `npm run check:contracts` passed (97 operations, 96 typed).
- Rho unit tests: 202 tests; the full parallel run passed 201 and cancelled the
  known MCP v2 test at its 30 s limit, which passed alone (2/2, 16.4 s). See
  [Status](STATUS.md#project-sidebar-workspace-and-graph) for the serial run.
- Rho-plugins: 90/90, including the new disk-following test (a changed line
  adopted as the span `{from: 12, to: 13}`, its before text readable, an unchanged
  file making no version, unsaved text kept with a save conflict, a non-UTF-8 file
  ignored) and single-file capture (a root-level CSV, a folder of more than 70
  files, a missing file, internal state refused).
- `npm run acceptance:agent-canvas` (new) passed 8 checks with a controlled ACP
  peer and no model: sidebar counts; Start opens the following canvas with the
  topbar and sidebar showing the Agent working; a read CSV opens in its table view
  marked Reading; an edit made outside Rho shows its new text with highlighted
  lines; an SVG no step named opens after appearing on disk; the saved canvas holds
  each file once, code left and data right; choosing another tab stops following
  and leaves the next file unopened until Follow; no overflow at 1024/390 and no
  page errors. Evidence goes to `work/agent-canvas-acceptance/`.
- `acceptance:frontend` 11/11, `acceptance:agent-ui` 7/7, `acceptance:pages`,
  `acceptance:shell`, `acceptance:person`, `acceptance:objects`,
  `acceptance:actions`, `acceptance:continuity` and the plugin UI check passed.
- `review.mjs` at 1440, 1024, 768 and 390: no overflow and no page errors.

These checks show that the paths work and that the screens read as intended to
me. They do not show that another person can follow a fast Agent on the canvas.

## Limits and next questions

- Following reads the conversation record, so the canvas moves at most about four
  times a second and can lag a short step; a file the Agent touched only between
  two reads still opens.
- Command lines are matched for project file names with known extensions; a
  command that writes elsewhere, or by name patterns, is seen only through the
  folder walk. The walk sees sizes, not contents, so an output rewritten with the
  same size is not reopened.
- The walk runs every 5 s at most while records change: up to 48 listings a time.
  A project with more folders shows partial counts.
- Below 768 px the Agent panel is a full-screen sheet, so the canvas follows
  behind it; closing the panel shows where it went.
- A CSV over 8 MiB or a file Rho has no view for (PDF, Excel, RDS) is named in a
  note on the canvas instead of opening.
- The canvas shows files. It does not yet explain a change in the Agent's words
  next to it, show command output, or let the person answer on the view itself.

## Browsing Sources from the sidebar

### Question

The user opened Results & figures in their `test` project (six PNGs in
`ggplot2-demo/out`) and found a page used as the directory awkward: moving from one
figure to the next meant going back to the list. They asked for the sidebar to
browse each kind's files directly.

Before this pass, choosing a file on a Sources page placed it as a new tab in the
`workspace` layout and opened Studio. The next figure needed the list again, and
every figure seen stayed behind as a tab.

### Changed

Rho only (`web/project.tsx`, `web/preview.tsx`, `web/sources.ts`, `web/canvas.ts`,
`web/overview.tsx`, `web/main.tsx`, `web/theme.css`):

- **Sidebar.** A Sources row unfolds into its files and folds again. With more than
  one folder, files sit under folder labels: the project's top level first, then by
  folder and name. Long names take two lines. The sidebar holds 40 files per kind;
  "All N files" opens the kind's page, which keeps its filter. Unfolded kinds are
  remembered per project for the tab, and the kind of the file on screen stays open.
- **In place.** Choosing a file shows it in the main area in its owner's view,
  without writing a layout. The view's own controls stay with it (Fit/100% for a
  figure, Save and Highlight changes for text). Above it: name, folder, size,
  "3 of 6" (to the kind's page), previous/next and Open in Studio.
- **Moving.** ← and → switch files unless focus is in a field, a menu or tab list,
  or inside the view, so a table cell or the editor keeps its keys. ↑ and ↓ in the
  sidebar list move and show. Until the next file resolves, the last one stays
  dimmed instead of blanking.
- Each showing reads the file as it is now. A CSV or image becomes a Files snapshot
  of its current bytes; snapshots are content-addressed, so unchanged bytes give the
  same one. Text opens the project's one buffer of that document.
- The kind's page lists the same files in the same order and shows the chosen one in
  place. A result with several versions is listed as the one its latest run made.

### Runs

Script and evidence: `work/sidebar-browse-20261027/` (ignored by Git): `browse.mjs`
on a disposable copy of the user's `ggplot2-demo`, `mixed.mjs` on a project with
data, scripts in two folders and figures in two output folders. Chrome 1440 × 900,
1024, 768 and 390 × 844.

| Run | What happened | Cause | Change |
| --- | --- | --- | --- |
| `first` | All six listed; the first figure showed in 0.45 s, each next one with → in about 65 ms, one seen before in 38 ms. Open in Studio placed one tab. "02-explore-temperatur…" and "04-model-diagnostics.…" were cut where they differ; at 390 px the header took three rows. | One-line names in a 240 px sidebar; the Studio button's label. | Names wrap to two lines; below 768 px the Studio button shows its icon and keeps its name. |
| `second` | Full names; a two-row header at 390. The one 404 was `composition.read` of `workspace` before it existed, which opening expects. Files were cached by path and size. | A rewrite of the same size would show the older snapshot; the cache saved about 30 ms. | Each showing captures the current bytes. |
| `third` | Without the cache each next figure took about 65 ms and one seen before 57 ms. | — | — |
| `mixed` | The table and editor showed; → in a grid cell and in the editor stayed there. Code listed `scripts/plot.R` before the project's own `analysis.R`. | Folders sorted by display name, the top level under the project's name. | The top level comes first. |

### Checks

- `npm run acceptance:sources` (new) passed 7 checks without a model:
  - kinds unfold, top level first;
  - a file shows in place with its folder, size and place, and no layout is written;
  - ←/→, the buttons and ↑/↓ in the sidebar move, and the shown file is marked;
  - a CSV shows in its table and a script in the editor, and arrow keys inside them
    stay there;
  - Open in Studio places the file;
  - unfolded kinds survive a reload;
  - a file chosen from the 390 px drawer shows, with no overflow at 1024/390 and no
    page errors.
- `acceptance:agent-canvas` now finds the file in the unfolded Data list instead of
  on the Data page.

These show that the paths work and that the screens read as intended to me, not
that another person finds browsing faster.

### Limits

- The lists come from the bounded walk. A new or removed file shows after the next
  walk, which runs when the project's records change or on Refresh.
- Each figure or CSV shown is kept as a Files snapshot in the project's state, as
  opening from the list was before. Neighbours are not fetched ahead; each showing
  costs one capture, about 65 ms for these figures.
- There are no swipe gestures; on a touch screen the buttons move.
- The Tables toolbar touches the view's left edge here and in Studio; that spacing
  belongs to the Tables owner.

## One Agent entry and the Agent page

### Question

The user found two Agent entries confusing. The sidebar's Agent row and the topbar's
Agent button opened the same panel, with different marks. They also found the Agent
interface empty: Activity, where the panel's "View live activity" led, showed nothing
useful. Yet the project held two conversations with real work.

### Observed before

Evidence: a copy of the user's `test` project with its retained records, its root
rewritten to the copy (`work/agent-page-20261027/`, ignored by Git; `before/`).

- Four ways in: the sidebar row, the topbar button, the Overview's Work with Agent,
  and the panel's View live activity.
- Activity showed:
  - Core's feed, "Observation disconnected";
  - an output-folder field with "No output files observed yet";
  - "No managed runs yet".
- The records: in "hi", the last message wrote `ggplot2-demo/analysis.R`, edited it
  nine times, ran eight commands (two refused at permission), read four of the six
  figures and answered. "这个项目在做什么" failed after 5 s on a model configuration
  error. Activity showed none of it. The panel showed one conversation at a time.

### Changed

Rho only (`web/agent-work.tsx`, `web/overview.tsx`, `web/project.tsx`, `web/main.tsx`,
`web/conversation.tsx`, `web/theme.css`):

- **One entry.** The sidebar's Agent row opens the Agent page. A button at its right
  edge shows or hides the Agent panel beside any page. The topbar's button, named the
  same ("Agent panel") and with the same mark, appears only while the sidebar is
  hidden. Activity is no longer a separate row, and the panel no longer carries View
  live activity or the outside-sessions list.
- **The Agent page.** Up to six conversations at a time, a running one first, then
  newest, each with its latest four messages:
  - the request;
  - Changed: files written or edited, with counts;
  - Looked at: files read;
  - Ran: commands, refused ones marked, and existing files they name;
  - the answer, folded past six lines, or the Agent's error;
  - how the message ended and how long it took.

  A file shows in place among its kind, or in the workspace if it has no kind.
  Continue (Follow while running) opens the panel at that conversation; New
  conversation opens its composer.
- Runs follow, only when there are any. Sessions started outside Rho (their access
  list and Core's feed) sit in a closed section that reads only while open.

### Runs

| Run | What happened | Cause | Change |
| --- | --- | --- | --- |
| `before` | As above. | Activity read Core streams, an output folder and managed runs; Rho's own conversation records reached only the panel. | The Agent page. |
| `after` | Both conversations: the model error; `analysis.R` "wrote, edited 9×"; four figures; "8 commands · 2 refused"; the folded answer. A figure showed in place as 5 of 6. A `Solar.R` chip appeared. | Commands are matched by file extension; `Solar.R` is an airquality column in an R call. | Files named only by a command are listed when the folder walk found them. |
| Updating the scripts | With the topbar button hidden, nothing opened the panel from Studio or a preview; the scripts had used that button. | The row's click now opens the page. | A panel button on the Agent row; the scripts use "Agent panel". |
| `agent-canvas` | After the new page check, choosing `airquality.csv` did not stop following. | Coming back from the page remounts the canvas with its first data view in front, so the click was no move. | The check chooses the data view not in front. |

### Checks

- `acceptance:agent-canvas` passed 9 checks. The new one, after the controlled turn,
  finds no topbar Agent button beside the sidebar. The turn's card lists Changed
  `analysis.R` (edited), Looked at `airquality.csv`, Ran 1 command and the answer,
  and the CSV chip shows the table in place.
- `frontend` 11/11, `agent-ui` 7/7, `sources` 7/7, pages, person, objects, actions,
  continuity and the plugin UI check passed after their scripts opened the panel by
  "Agent panel" and runs through the Agent page. `shell` passed once its focus check
  looked for "Agent panel".
- Rho unit tests 202/202, serially.

### Limits

- The page lists what the Agent reported. Outputs a command wrote and the Agent did
  not read back (here two of the six figures) are not under the message; Results &
  figures has them.
- Earlier messages than the latest four are in the panel. A running conversation
  is read again at most once a second.
- The Overview's Work progress still lists the same conversations with observation
  details. Whether it should only point to the Agent page is open.
- When the Host is unavailable, the outside-sessions section shows the feed's own
  disconnected state, once opened.

## Choosing the Agent and its model

### Question

The user asked for settings in the Agent UI so that a person chooses the Agent and
its model themselves.

### Observed before

- The panel's new-conversation header had one select: Configured default, Claude
  Code or Codex. Model, effort and permission mode came only from each Agent's own
  configuration, and no screen said which model answered. The failed conversation
  above ended on a model the gateway said may not exist; nothing in Rho could choose
  another.
- ACP v1 sessions report the settings they accept. Opening a session without a
  message in an empty folder:
  - Claude Code (`claude-agent-acp` 0.97.0, 3.2 s) offered Mode (5 values), Model
    (101), Effort (6), Fast mode and Ultracode.
  - Codex (`codex-acp` 2.3.0, 0.5 s) offered Mode (4), Collaboration mode, Model
    (103) and Reasoning effort (6).

  Neither groups models through ACP. Names end in " · " and where the model comes
  from (a routing group, a provider). Descriptions carry account names; this record
  leaves them out and the screens show them only as tooltips.

### Changed

**Agent 0.4.13** (`Rho-plugins/plugins/agent`):

- The ACP connection keeps the settings a session reports when it opens or changes
  them (`config_option_update`). The session observation carries them, bounded to 12
  settings of at most 256 values each, with the rest counted.
- The person's choices are applied once the session opens and before any message is
  sent. A setting or value the Agent does not offer fails that message; nothing is
  sent.
- `configure()` changes one setting on an open session between messages.
- `inspect()` opens a session, reads its settings, removes the session where the
  Agent supports that, and ends the process. It sends no message.

**Rho** (`src/conversations.ts`, `src/protocol.ts`, `web/agent-settings.tsx`,
`web/conversation.tsx`, `web/overview.tsx`, `web/agent-work.tsx`, `web/theme.css`):

- Four operations for the person at this machine:
  - `conversation.settings.read` reads one file in the service's state directory
    and starts nothing. The file holds the Agent for new conversations, each Agent's
    choices, and what each Agent last offered, from a check or from a conversation's
    first session opened without choices.
  - `conversation.settings.update` refuses a stale `expectedVersion` and any value
    the Agent did not offer.
  - `conversation.settings.check` runs `inspect()` in the project, one check per
    Agent at a time, bounded by `connectTimeoutMs`.
  - `conversation.configure` changes an open conversation's session now. If no
    session is open, it records the choice for the next one. It is refused while the
    Agent is answering.

  `conversation.start` without an Agent or settings uses the saved ones and records
  them on the conversation. A request holds at most 12 settings of 512 characters.
- **Agent page:** a "New conversations use" card above the conversations, with:
  - Claude Code or Codex;
  - a model picker that is searchable, grouped by where each model comes from, and
    starts with the Agent's default named;
  - effort, mode and the other settings as compact selects, each with its default;
  - a line saying which adapter offered them and when, with Check again.

  Before any check, "Ask Claude Code" says that it starts the Agent for a few seconds
  and sends no message.
- **Panel:** one chip under the message box names the Agent, model and effort. It
  opens the same picker, with the Agent switch and effort above the list. In an open
  conversation, the chip shows that conversation's model and effort and changes them
  between messages.
- Each message's ending names the model that answered, in the panel and on the Agent
  page.

### Runs

Evidence: `work/agent-settings-20261027/` (ignored by Git). `look.mjs` drives a
disposable service whose Claude Code and Codex are a test Agent offering 39 models
from five sources. `real.mjs` uses the person's own Claude Code on a disposable
project.

| Run | What happened | Cause | Change |
| --- | --- | --- | --- |
| `look` 1 | Check sent `initialize`, `session/new`, `session/delete` only; the chosen model and effort were set before the prompt; a switch mid-conversation was used by the next message. Effort, Mode and Fast mode chips stood as tall stacked boxes. | The global `label` rule stacks its children. | Chips lay out in a row. |
| `look` 2 | Switched from one source's DeepSeek V4.1 Flash to another's: the chip and the endings read the same before and after. | Names were shown without their source. | Chips and endings show the whole name. |
| `look` 3 | In the panel, the open picker cut off the conversation's header and text. | The picker was wider than the panel; focusing and scrolling to the chosen model scrolled the panel sideways. | The picker fits its panel or page; only its list scrolls; focus does not scroll. |
| `look` 4 | Agent, model and effort took three rows of a 300 px message box. | Three chips. | One chip; the Agent and effort sit above the list. |
| `look` 5 | With a short conversation, the picker opened above the message box and its search and Agent switch were cut off. | It always opened upward. | It opens on the side with room and fits that height. |
| `look` 6 | After Ask Claude Code returned, typing did not search. | Focus moved only when the picker opened. | The search takes focus when the list arrives. |
| `real` | Check 3.9 s: 101 models; "westlake" found four. With Qwen3.8 27B · WestlakeHPC chosen, the first message failed: "API Error: 400 WestlakeHPC: System message must be at the beginning." The ending named the model. The panel switched the conversation to DeepSeek V4.1 Flash · routing group. The next message completed in 6 s with turn model `auto/deepseek-v4.1-flash[1m]`. | That provider refuses the request Claude Code sends; Rho reported it as received. | None in Rho. |

In the real run the answering model said it was Claude. A model's description of
itself is not evidence. The record keeps the model the adapter accepted for the turn.
Claude Code reported its own default as the group model that the earlier failed
conversation named.

### Checks

- `test/agent-settings.test.mjs` covers the operations:
  - a read starts nothing;
  - a check sends no prompt and removes its session;
  - stale and unknown values are refused;
  - saved choices are set before the first prompt;
  - an open session changes between messages, leaving the defaults unchanged;
  - after a restart, a choice is recorded and applied when the session next opens.

  Agent 0.4.13's two new owner tests cover applying, changing and refusing settings
  and `inspect()` removing its session.
- Rho unit tests 203/203 serially, Plugins 92/92, and the contract and type checks.
- `agent-ui` 7/7, `agent-canvas` 9/9, `frontend` 11/11 and `sources` 7/7 passed, as
  did shell, continuity, pages, person, objects, actions and the plugin UI check.
  `acp-episode` now chooses its Agent in the message box's settings; it was not run
  again here.

### Limits

- What an Agent offers is known only from a check or a first session. It can go
  stale. A saved choice the Agent no longer offers fails the next message with that
  reason, and Check again refreshes the list.
- One service keeps one set of choices for every project. A check runs in the current
  project, and another project's own Agent configuration may offer other models.
- Whether a model works through an Agent is known only by sending a message, as the
  WestlakeHPC refusal showed. Rho does not test models.
- Mode lists the Agent's own permission modes, including those that skip its
  questions. Rho shows them as offered and adds no approval of its own.
- No person has used these controls yet; the runs show that the paths work.

## Arranging views: the person drags, the Agent writes

### Question

On 2026-10-27 the user asked whether the Agent arranges the page freely, and said
both the Agent and the person should. The person had no way to arrange views by
dragging.

### Observed before

- Each workspace is one saved layout: a tree of groups and views, where a split group
  keeps its axis and weights. Both the person and the Agent change it through
  `composition.apply` against an expected version, and `composition.undo` reverses
  the last change.
- The person could drag the dividers between panes, and Arrange views offered Split
  right, Split down, Move to the next or previous group, Close view and Undo. Tabs
  could not be dragged. The Agent panel was fixed at 340 px.
- A Rho-started Agent's grant already holds `composition.read`, `composition.apply`,
  `composition.undo` and `composition.put`. Its MCP index was the only description it
  had of them.
- When a person's change put a group other than the canvas's own code and data groups
  under the canvas root, every later file the Agent touched joined the first tab group.

### Changed

Rho only (`src/shell-layout.ts`, `web/shell/regions.tsx`, `web/shell/workspace.tsx`,
`web/shell/shell.css`, `web/canvas.ts`, `web/main.tsx`, `web/theme.css`):

- **Tabs drag.** A tab can be dropped in three places:
  - on another group's tabs, where a line marks the place, to move or reorder it;
  - on the middle of a group, where the group is tinted, to join its tabs;
  - within a quarter of a group's side, where that half is tinted, to give the view a
    pane on that side.

  A pane beside one along the same axis joins that split and halves that pane's share.
  A pane left empty closes. Each drop is one conditional `composition.apply` of the
  saved layout, the same write the menu's commands and the Agent use. Undo reverses
  it. A drop where the tab already is writes nothing. Dragging stops following the
  Agent. Below 768 px the workspace is one tab list and nothing drags.
- **The Agent panel's edge** drags, or moves 24 px per arrow key, between 280 px and
  760 px (at most 60% of the window). A double-click returns it to 340 px. Each browser
  keeps its own width.
- **The canvas keeps its sides.** The Agent's code files join the canvas's code group
  and its data and figures join the data group, wherever the person has moved them. A
  side whose group was emptied comes back at its edge of a left-to-right split.

### Runs

Evidence: `work/layout-drag-20261028/` (ignored by Git). `look.mjs` drags in a
disposable project of four files. `agent.mjs` asks the person's own Claude Code to
arrange the same workspace before the person drags in it.

| Run | What happened | Cause | Change |
| --- | --- | --- | --- |
| `look` | Dropped `notes.md` near its group's right edge: a pane on the right. Then `air.csv` on that pane's tabs, `model.R` before `analysis.R`, and `air.csv` near the bottom of the right pane: three panes. A drop where the tab already was left the version unchanged, and Undo restored the previous arrangement. The panel widened from 340 to 525 px, narrowed 24 px on a key, and kept 501 px after reload. Keyboard focus on the edge drew a double outline. | The outline and the edge's line both drew. | Focus thickens the line only. |
| `agent` | Claude Sonnet 5.5 · routing group received "把 Studio 的 workspace 排成：左边是 analysis.R 和 model.R 两个标签，右边上半是 notes.md，右边下半是 air.csv。只改布局，不要改文件。" It took 83 s and 20 tool calls: four `rho_index`, five `rho_resolve` (one refused for an expired cursor), eight `rho_read` and two `rho_call`. One `composition.apply` took the layout from version 4 to 5 exactly as asked, and no file changed. The person then dragged `notes.md` into the left tabs: version 6, following stopped. | — | None. |
| `frontend` | The new drag check reloaded the page to see the split kept, and the page came back on the Overview. | Before this check, the tab's session store already held a link session from an earlier step, so the reload opened under another browser principal. | The check reads the saved layout. The menu check above it covers reload. |

In its answer the Agent said it could not see how the browser drew the layout and
asked the user to look.

### Checks

- `test/layout-commands.test.mjs` covers moving a tab:
  - reordering, and joining another group;
  - a drop that changes nothing;
  - a pane emptied and closed;
  - a bare view turned into a tab group.

  It also covers docking on each side, beside a pane along the same axis, and across
  it.
- `acceptance:frontend` adds two checks: a dragged tab joins another group's tabs and
  closes its emptied pane, then opens a pane below as the saved layout; the panel
  widens from its edge and keeps the width after reload.
- `acceptance:agent-canvas` adds one check. The person drags `notes.md` below the
  code, and following stops. The Agent's next data file joins the data group, and the
  person's pane stays.
- With the old placement, the new `acceptance:agent-canvas` check fails: the data file
  joins `canvas-code`.
- Rho 205/205 (serial) and Plugins 92/92. `acceptance:frontend` 13/13,
  `agent-canvas` 10/10 and `agent-ui` 7/7 passed, as did `shell`, `continuity`,
  `sources`, `pages`, `person`, `objects`, `actions` and the plugin UI check. Build,
  web type check and contract checks passed.

### Limits

- Tabs cannot be reordered within a group from the keyboard; the commands move a view
  between groups only.
- A drop is relative to one group. There is no full-height column at the workspace's
  edge, no drag between workspaces, and no drag from Sources into Studio.
- Most of the Agent's 83 s went to finding the operation and reading the layout. A
  shorter route has not been tried.
- The Agent cannot see the drawn result.
- A drop computed on a layout older than the Agent's latest write is refused with a
  message and not retried.
