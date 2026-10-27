# Project sidebar and Agent canvas

Updated 2026-10-27.

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
  the editor, a registered result as its exact version.
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
  [Status](STATUS.md#project-sidebar-and-agent-canvas) for the serial run.
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
