# Browser application

Updated 2026-10-30. The frontend was reset at the user's request. Previous frontend
plans, visual specifications, Paper references and appearance rulers have been
removed from the working repository. Git retains their history; they do not govern
this implementation. This document describes the current application, not another
prescriptive design system. How it changes next is decided by reviewing real runs
([Development](DEVELOPMENT.md#stages)); the current
[base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records what the
screens do not yet show. Avoid unnecessary secondary labels and descriptions: let the
layout do the explaining.

## Starting from the work

A person needs to find a project, work on its contents, ask an Agent for help and
inspect what happened. The application gives those actions direct places:

- **Projects** lists and searches available projects, names the folder each one works
  in, opens folders and creates a named project from selected source folders. It
  opens as one list with one primary action, and with no projects it shows what can
  be started instead of an empty page.
- **Overview** opens with the answer board: the newest message that produced results,
  derived from the Graph. It shows the question and the answer, then the results by
  role. The figure or table the answer names leads, with the other results beside and
  below it. Then come the method (an outline of the script), the run that produced
  them with its command and output, the message's other commands (which open in the
  Console), the data it read and any report. A result or script the project notes
  describe carries that description, and the session's choices follow the results:
  what each is about and what was taken, with any other option the notes name, under
  the choice or in the same sentence, in a well below with what it gives. Each result has Ask, and selecting a
  passage of the answer offers Ask about this. Either one sends a question to the
  same conversation with what it is about (the exact kept version for a file).
  Questions that make no new results are listed under Asked since with their
  answers, and the board stays on the answer they ask about; a header link names a
  question being answered now. Use this answer or Needs changes (with a note, also
  sent to the Agent) records the person's word for the file versions that message
  kept, and the board names results it does not cover and files changed since.
  Earlier answers are chosen from a menu. Below the board come a count for each kind
  of step (asked, read, edited, ran, changed on disk, answered), which is also the
  legend and filter of the Graph's timeline below it, one lane per conversation.
  Without conversations, the results show as pictures, newest first: the newest at
  twice the size, then two or five more, with the rest in Files. A side column draws
  each workspace as its panes, opens the shared notes, and lists the files the
  Agent's tools named, most used first, each with a bar for its tool calls. Its Work
  progress shows Agent sessions started outside Rho and any choice waiting in a
  session; conversations started in Rho answer on the board.
  A project with nothing recorded yet shows its two next steps — work with the Agent
  or browse its files — rather than empty sections, leading with whichever one the
  project's listing says has something behind it.
- **Sources** counts the project's Data, Code, Results & figures and Notes from one
  bounded walk of its folders, by file name. Each kind unfolds in the sidebar into
  its files across the project and its source folders: the top level first, then by
  folder, at most 40 there with the rest on the kind's page. Choosing one shows it
  in place in its own view, without writing a layout: a CSV or image as a snapshot
  of its current bytes in the table or media view, a Markdown file in the Markdown
  reader (its to-dos tick in place; Edit shows the editor with a formatting toolbar,
  Source when the tab cannot edit), other text in the editor, highlighted when Rho
  has its language, a registered result as its exact version. ← and → or the buttons beside "3 of 6" move through
  the kind, ↑ and ↓ move in the sidebar, and Open in Studio places the file in the
  workspace ([pass](AGENT-CANVAS-EPISODE.md#browsing-sources-from-the-sidebar)).
  `+` adds a source folder.
- **Console** runs the person's own shell commands in the project folder. Newest
  first, it lists each message's commands under that message in the order they ran,
  with the person's commands between them and Rho's managed runs at the end. Each
  command leads with the Agent's own words on what it was for, over the command with
  the project folder read as "."; without those words, it is named by what each part
  runs ("grep → python3 analysis.py"). Commands in a row that changed no file fold into
  one line. A row shows its time, its duration, any ending other than a clean exit,
  and the files that changed on disk while it ran; opening it shows the whole command
  and its output, which streams while it runs. A running command
  has Stop. Run again runs the person's command again, and puts an Agent's command
  into the prompt to check before Run. The board's command count opens the Console
  at that message. Only the person at this machine can run or stop commands; an
  Agent may read them ([episode](SIMULATED-PROJECT-EPISODE.md#second-pass)).
- **Files** opens documents, browses the project's folder and the source folders it
  works in, and filters the current folder. A source folder is named as the person
  named it and opens one level at a time, the same way any other folder does.
- **Agent** (the sidebar row) has three tabs. Conversations lists those started in Rho
  by day, searchable and by Agent: each row its title, model, effort, messages, state,
  context use and cost, with Continue, export as Markdown and the trash; opened, its
  facts beside what its latest messages did (the files changed and looked at, each
  shown in place when chosen, the commands and the answer). The trash restores or
  deletes. Runs follow when there are any, with their execution records, output,
  repair context and exports. Agents shows Claude Code and Codex: version, whether
  asked, the default, model, settings, Claude Code's own model names and the providers
  with their models. Outside Rho adds Rho to the person's own Claude Code or Codex with
  one button (`session.connect`) and shows three steps in the state Rho observes:
  access to this project, Rho in that Agent, its first call; Other ACP clients gives
  the `rho --acp` commands. Core-backed Claude Code/dsh activity streams, native errors
  and observed output files sit below in a section read only while it is open
  ([activity episode](AGENT-ACTIVITY.md), [Agents and conversations](AGENT-PAGE-EPISODE.md),
  [Agents outside Rho](AGENT-PANEL-EPISODE.md#agents-outside-rho)).
- **Project settings** manages source folders and explicitly checks available tools.
- **Studio** shows how a conversation's work was done. The sidebar lists under Studio
  each session started in Rho, newest first (eight, then All sessions), and then the
  person's own workspaces; the Studio bar names the one shown. A session is titled by its
  section of the project notes, else by the Agent's title, else by its first message.
  The **project notes** (`project-notes.md` at the project root) are one Markdown file
  shared by the person and every session, shown beside any Studio layout and hidden or
  shown from the bar. Rho appends to each session's Agent instructions that it keep one
  section there: a level-2 heading naming its task with a `<!-- rho:session <id> -->`
  marker below it, then Question, Data & method, Key results with a figure, and To do as
  a task list. The panel reads the file formatted, opens at the shown session's section,
  ticks to-dos in place, and edits it as Markdown with a formatting toolbar; the person's
  own edits are saved after a 1.5 s pause (`notesTiming`) with the buffer's write
  conditions, and the Agent's edits arrive through the file. The notes are opened only
  when the project has sessions or the panel is shown; below 768 px they replace the
  stage, open only when asked, and a window that narrows closes them. The notes take no
  place in a conversation's Studio layout. A conversation's Studio
  lays its files out by what each is to the work, as the answer board names them: the
  data it read above the script it wrote and a Commands view of what ran, figures above
  the tables and reports beside them, each role in one place up to its limit
  (`studioLimits`). A file's view says which kept version it shows, with earlier and later.
  The parts of the work sit in a chip in the Studio bar, named by the Agent's own words
  between steps or by what the steps did, with rounds of editing and running; time runs
  down the stage's right edge beside the Agent panel, long pauses folded. Choosing a
  moment there, a part, or another version replays it: the views, the commands, the
  part and the conversation in the Agent panel all show the record as it stood then, to
  the second, and a text file shows its version kept then, read only. Arranging the
  views saves the layout as `conversation-<id>`; later files join their role's place and
  files the person closed stay closed. Studio opens on the work going on now, else the
  Studio last open, else the newest conversation's. The person's workspace is shared with
  the Agent: nothing opens there by itself. Sending a message from another page follows
  the turn on the Overview's board; sent from Studio, it leaves the person where they
  are (a new conversation started from a conversation's Studio opens its own), and
  Follow opens the running conversation's Studio. The tab of an open file the Agent last
  named says Reading, Edited, Ran…, and the topbar names the Agent's newest action on
  every project page. Files open from the board, the Graph and Sources
  ([canvas episode](AGENT-CANVAS-EPISODE.md),
  [second pass](SIMULATED-PROJECT-EPISODE.md#second-pass),
  [process Studio](SIMULATED-PROJECT-EPISODE.md#process-studio)).
  Eight views render at once: those on screen, then the most recently shown, then the
  rest in layout order. A hidden view past that unmounts and mounts again from its
  owner when shown, keeping its buffer and undo but not its scroll or selection.
- **Review** is listed while a project has review records, since asking and deciding
  now happen on the answer board. It brings a frozen question, explicit Agent replies, exact result versions, keyed
  table differences, captured code changes and append-only human decisions together. Table
  row and document selection controls open the same record; whole-resource questions cover
  figures. The page offers the person's questions and the kept results as choices, the
  newest version of each result first with a count of earlier ones; any other exact
  version stays selectable. Sending a frozen context is a separate action from deciding. A result can focus
  Graph; Graph links back. Reload restores Review and its selected record. Evidence export
  previews that record and its retained references before writing a static offline reader
  ([episode](REVIEW-EVIDENCE-EPISODE.md)).
- **Graph** draws what the Agent did: each message a row from the files it read to
  the question, what it edited and ran, and what changed on disk while its command
  ran; a later row refers to an earlier output. Lines say whether the Agent reported
  it, a command named it, or a change was seen on disk. A message draws one card per
  file holding every version kept during it, and three or more of its commands that
  touched no project file fold into one card listing each with its ending, duration
  and output. Cards preview tables and
  figures from captured versions; choosing one shows those retained bytes and related
  reviews. Older records explicitly lack a historical snapshot. Opening the current
  file is a separate action, and replay hides captures later than its cursor. The timeline
  below gives each conversation a lane and each step a block coloured by kind (asked,
  read, edited, ran, changed on disk, answered), lanes with the same title carrying
  their start time; the legend counts and filters them,
  refused or unknown steps are marked, pauses fold to a short gap, and the work
  replays at 1×, 2× or 4×. While the Agent works the Graph stays and follows it; a
  step waiting for the person's choice turns amber and is answered there. Card labels
  and previews are drawn from 62% zoom up ([episode](GRAPH-EPISODE.md)).
  Above the process rows, a **meaning layer** draws what the project notes say: one row
  per session's section, from its question to its findings and choices, the files they
  rest on (each titled by what the notes say it holds), and how those files came about
  (made by a script, reading data, taken from the process record with its basis).
  Meaning + process, Meaning or Process shows both layers or one (remembered in this
  browser). Each statement is traced to the first kept version of the notes that holds
  it: who wrote it and when, or that no kept version holds it. The files it names are the
  versions kept then, and a newer kept version or a later write on disk is named. A
  file's "kept as" and a statement's "written in" lead into the process rows. A choice
  shows the option in use beside the others with what each gives; Use this instead
  drafts a message to the same conversation that the person edits and sends. Nothing
  there waits on the person ([meaning layer](SIMULATED-PROJECT-EPISODE.md#meaning-layer)).
  While a message runs, each file it writes is read once it rests: its facts (a table's
  rows and columns, an image's size, a script's lines and functions) show at once, then
  a sentence from the model the conversation's Agent uses, marked with that model and
  the version it read. The notes' words replace both when the Agent writes them. Results
  and figures join their conversation's meaning row as they appear, in a row of its own
  when the notes have no section yet
  ([descriptions](SIMULATED-PROJECT-EPISODE.md#descriptions-while-the-work-goes-on)).
- **Workspaces** hold real owner views in tabs and splits. Arrange views exposes
  split, move, close and undo operations; the command palette offers the same actions.
  A tab drags onto another group's tabs (a line marks the place), onto the middle of a
  group to join it, or within a quarter of a group's side to open a pane there; the
  tinted area shows where it lands. Each drop is one conditional write of the saved
  layout, the same the commands and the Agent use, and Undo reverses it. Below 768 px
  nothing drags ([episode](AGENT-CANVAS-EPISODE.md#arranging-views-the-person-drags-the-agent-writes)).
- **The Agent panel** opens beside any page from the Agent button at the right end
  of the topbar, or from Continue on the Agent page. Its one header is the
  conversation's title, New conversation and Close; the title opens the recent
  conversations, the last entry leading to the Agent page's full list. A new
  conversation shows only what the Agent can do here. In a tab on this machine it holds conversations with
  Claude Code or Codex started in Rho: follow a streaming reply and its actions, reply,
  stop a turn and return to it after a reload
  ([conversation episode](CONVERSATION-EPISODE.md)). Its left edge drags, or moves
  24 px per arrow key, between 280 px and 760 px (at most 60% of the window); a
  double-click returns it to 340 px, and each browser keeps its own width. One chip under the message box
  names the model (Default model until one is chosen), its provider, the effort and what is switched on: the saved choices
  for a new conversation and the open conversation's own, changed between messages. It
  opens a short menu with a row per setting the Agent offers (the Agent for a new
  conversation, the model with its search, effort, mode); a row opens its list in place,
  an On/Off setting is a switch, and Escape steps back, then closes the menu, not the
  panel. Each ending names the model that answered ([settings pass](AGENT-CANVAS-EPISODE.md#choosing-the-agent-and-its-model)). The panel renders the retained
  record rather than protocol events ([panel pass](AGENT-PANEL-EPISODE.md)): the
  Agent's last words stay open as Markdown prose, lists, code with Copy and tables
  that scroll sideways with their numbers whole; what it did before them folds into one line ("Worked · Ran 8 commands ·
  Edited 1 file · 6 choices"), open while it works. Inside, each tool step names what it
  did (`Read data.csv`, `Ran Rscript analysis.R`, `Wrote results/summary.csv`,
  `Called data.page`) with an icon for its kind and the Agent's title and reported path
  behind a disclosure; files are counted once; answered choices stay in the fold. Each
  message ends with its outcome, model, time and Copy; a failure the Agent's last words
  already state is shown once. A native permission request is
  an amber choice card. The message box is one rounded surface with the settings chip and
  a round Send or Stop; under it, the plan entry in progress and the context and cost
  the Agent reported open a card with context as a bar, the cost and the whole plan. New activity is followed only while
  the person is at the end; scrolling up keeps the position and offers "Jump to latest". The Agent's tool status and
  reported path are distinct from Work progress's independently observed files.
  Sessions started elsewhere are listed with where to continue them. In an open
  workspace it also shows the Agent's recorded work and linked questions. A tab
  opened from a narrower link keeps a request draft for an external Agent: copying a
  request is not sending it or receiving a reply. The [live activity
  episode](AGENT-UI-EPISODE.md) records the observations, checks and limits.

The topbar names the way back — the projects list, then the project, then the open
workspace — and keeps only the current place below 768 CSS px. A rail at the far left
belongs to the application: Rho opens the projects list, then the eight most recently
opened projects as avatars in the service's order (where initials collide, by the part
of the name that differs, such as 18 and 41), a dot on each one whose Agent is
answering (from one bounded `conversation.list` per project every five seconds while
the page is visible; the open project's own record also says when it needs a choice),
and Open or create a project. Choosing a project there returns to where it was left in
this tab; choosing one from the projects list opens its Overview. The projects list has
no project sidebar. The project sidebar starts with All projects and the project (its
menu switches to another open project), then Overview, Studio with its sessions and
workspaces, Graph, Console, and Agent (Working or
Needs you while a turn runs), then Sources, with Project settings and Plugins at its
foot. Connection & access, at the foot of the rail, opens a drawer: the focused document's Changes, then the connection (its state,
when it was last read, Refresh or Reconnect, and why the service did not answer) and this
tab (this machine or a link, its folder and expiry, what it can and cannot do, and for a
link the way back to this machine's access), each as a card
([episode](AGENT-PANEL-EPISODE.md#connection--access)). The sidebar and optional
inspector adapt to available space; below 768 CSS px the navigation drawer holds the
rail beside the project sidebar. Narrow screens show one workspace view at a time.
Closing a panel does not cancel work.

The [home and project episode](HOME-PROJECT-EPISODE.md) records the 2026-10-27 pass
over these screens, its checks and the listing gap it left open. The
[simulated-project episode](SIMULATED-PROJECT-EPISODE.md) records the 2026-10-29 run
of two capsule projects and the changes it led to.

## State and code

`web/main.tsx` owns navigation and session observation. `web/home.tsx` handles project
entry, `web/overview.tsx` the project sections, and `web/plugins.tsx` the installed
capability catalog. `web/shell/` renders the persisted composition tree and embeds
registered owner views. `web/agents.tsx` handles the explicit external-Agent handoff and the session list;
`web/conversation.tsx` shows a conversation started in Rho. Its presentation comes
from `src/conversation-presentation.ts` (text, action lines, folded runs, plan entry),
and Agent prose is rendered by `src/agent-markdown.ts` with `web/markdown.tsx`.
`web/project.tsx` draws the project sidebar; `web/sources.ts` walks the project folders
within its limits, names each file's kind and orders each kind's files for the sidebar,
its page and `web/preview.tsx`, which shows one file in place. `web/agent-now.ts` reads the running
turn's record (`conversation.read`, last turn) and maps its steps to project paths;
`web/canvas.ts` resolves a file's owner view (`viewFor`) and places it in a workspace
with one conditional `composition.apply`, through `document.open` for text and `agent.activity.capture`
for a CSV or image. Following is a tab-local choice; the workspace layout is saved.
Every owner view receives the shell's services (`ShellServices` in `src/ui-contract.ts`,
made in `web/shell-services.ts`): a linked project file opens in place, or in the
workspace on screen in Studio; an image is read as its current bytes (`readImage` in
`web/previews.ts`, at most 64 per page of 8 MiB each, past which the view shows its
description); `web/languages.ts` gives Python, R and Markdown to the editor and to code
in rendered text, one set of token classes coloured in `theme.css`.
A command the Agent ran shows how it ended (its exit code when the Agent reported one; a
command that ran and failed is "failed", not "refused"), how long the call took from its
last description to its result, and the last lines it printed, opened at their end, in
the panel row and the Graph's run card and details (`commandEnd`, `stepDuration` in
`src/conversation-presentation.ts`). A leading `rtk` output wrapper is left out of the
command's name; the row's details keep what ran.
`src/work-graph.ts` builds the Graph from `conversation.read` records (a finished
message keeps the project files that changed on disk while it ran) and the folder walk
(`project.entries` gives each file's `modifiedAt`), and lays each message out as a row; `web/graph.tsx` draws it, the inspector, the timeline and the
Overview's `WorkStrip`. `src/answer-board.ts` derives the Overview's answer board from
the same graph: `answerBoard` gives each file and command of a message a role,
`boardThreads` keeps a later question that made no results with the answer it asks
about, and `src/asking.ts` writes and reads back what a question was asked about.
`web/answer-board.tsx` draws the board and records decisions (`conversation.decide`);
`web/console.tsx` draws the Console from the same graph and `console.list`.
A conversation's Studio (`web/studio-process.tsx`) reads its record, builds the graph
whole and as cut at the moment shown (`turnsAt` in `src/replay.ts`), takes each file's
role and kept versions from the whole record (`studioFiles` in `src/studio-layout.ts`)
and lays the files out (`studioTree`, `studioMerge` over a saved arrangement).
`src/project-notes.ts` reads the notes' sections and session markers (`notesSections`,
`sessionTitles`, bounded by `notesLimits`) and writes the instructions a session is
given; `web/project-notes.tsx` keeps the notes' one buffer open for the project, saves the
person's edits and draws the panel. `src/notes-meaning.ts` reads each section into
statements with the files they link (`notesMeaning`, `fileDescriptions`) and traces each
to the kept notes versions (`traceStatement`); `src/meaning-graph.ts` builds the meaning
layer and the layered graph; `web/meaning.ts` reads the kept notes versions
(`meaningLimits`) and `web/choices.tsx` draws a choice's options. `src/file-describer.ts`
reads a file's facts (`fileFacts`, `describeLimits`) and chooses what a file holds as shown
(`holdsOf`); `Conversations` checks the project while a message runs and asks the Agent
component's `describeFile` for the sentence. A figure goes as an image when the Agent
component's `./models` finds the model on models.dev taking images, else `figureContext`
gathers what made it. `web/holds.tsx` draws the line with its source and the cost of its
call. The session popover in `web/conversation.tsx` holds the person's switch for
describing (`describeFiles` in `web/agent-settings.tsx`) and the conversation's spend.
`src/studio-chapters.ts` names the parts of a message. The views find their file and
moment through `web/process-context.ts`; `web/shell/process-views.tsx` frames a file's
versions and `CommandPane` in `web/console.tsx` shows the conversation's commands. For the Graph, `foldVersions` merges a message's versions of one
file and folds its unrelated commands (`foldLimits`); the `WorkStrip` keeps every step. `web/previews.ts` reads the card and Overview previews from a captured
snapshot, or a registered result at its exact version: at most 16 files, two at a time, figures
up to 2 MiB and tables to 3 rows by 4 columns.
`web/work-progress.tsx` reads `project.work.read` for the local person's project
Overview: Agent-reported plans/usage, retained native source identities and current
referenced files. Under the answer board it shows a conversation started in Rho only
while it waits for a choice (without the board, also while it answers), and links to
the Agent page for the finished ones; references the observation left out are counted
under the file list.
`web/agent-manage.tsx` draws the Agent page's tabs from the conversation summaries in
the snapshot and `conversation.list` for the trash; an opened row reads its latest
four messages through `web/agent-work.tsx`, the same step model as the panel.
`web/agent-settings.tsx` keeps one copy of `conversation.settings.read` per tab for
the Agents tab and the panel's settings menu (`web/settings-menu.tsx`);
asking an Agent what it offers (`conversation.settings.check`) is always the
person's click.
Shared notes opens `project-notes.md` in the existing Documents owner. A failed work read keeps the previous
view and offers Refresh. The cursor invalidates the read model; individual sources
and resources retain their own versions. See the [observed loop](ACP-EPISODE.md#shared-workspace-loop).
External ACP sessions use the same work surface with their own source identity,
plans, usage and read-only latest reply. Their input and permission choices stay
in the original client. The visible Overview rereads external projections every
1.5 seconds; it does not start a collector, Agent or Host. Turn cancellation keeps
unfinished tool outcomes unknown and does not claim all native processes exited.

The browser calls the existing `BrowserClient` contract. Document content, undo,
conditional save, execution identity, output and versions remain with their existing
owners. Views of the same document do not acquire independent document buffers.
Opening exact results uses both resource identity and version. Reconnect only reads.

A linked result initially opens as a local view. When the person arranges it, Rho
includes that exact descriptor in the same conditional composition write as the
split or move. The original view and its selection retain their own version;
reload restores the saved arrangement. No unrelated preview is saved with it.
The [base-R episode](BASE-R-EPISODE.md) exercises this path with a real Agent reply.

Opening the service URL on this machine is the access: the tab starts as the local
person, so there is no link to redeem, no session credential in tab storage and no
first screen asking for one. A deliberately narrower link (`rho --pair`, one folder
or an expiring tab) still arrives as a one-time code in the fragment; the page
redeems it, keeps that credential only in this tab's session storage, and says when
the link could not be used. A tab that falls back to this machine keeps its open
projects, unsaved edits and running work: leaving a link forgets a credential, it
does not close a view or submit anything.

A request draft is scoped to the project and to the principal using the tab in
session storage. It is local preparation, not a saved project document or Agent
message. Using this machine's access instead of a link forgets only that link's
credential. The existing Documents editor owns acknowledged document recovery; a
view change makes no new save claim.

A conversation's messages, steps and endings belong to the service's record, not to
the tab. The tab keeps only an unsent message per conversation and the identity of
a message being sent. When the reply to a send is lost, Retry sends that same message
once; when the service refuses it, the words go back into the box. A session started
elsewhere has no message box in Rho: its input stays in its own window.

The palette and responsive dialogs use native dialog focus containment and Escape.
Typography, color and layout are implemented in the three CSS files under `web/`.
These are current implementation values, not an accepted design system; they change
when a reviewed result calls for it. The shared CSS variable interface lets owner
views use the application's colors.

## Verification

`npm run acceptance:frontend` exercises the application using disposable projects,
real R output and the installed Chrome executable. It records screenshots of the
project entry, overview, files, table, figure, activity, settings, plugins and Agent
panel. Its assertions cover navigation, editing and undo, an unsent conversation message,
the clipboard handoff in a link tab,
conditional layout changes, dragged tabs, the Agent panel's width, reload, keyboard input, responsive overflow and accessible
control names. The report and images go to `work/frontend-reset/browser/` by default.

`npm run acceptance:agent-canvas` drives a controlled ACP peer that reads, edits and
runs project files and writes an output no step names. It checks the sidebar counts,
that a message sent from Studio leaves the person's workspace as they arranged it,
the edited text on disk in the open editor, that nothing else opened there, the Agent
page's record of the turn and a file it names shown in place, that Follow opens the
conversation's Studio, marked in the sidebar's sessions, with its data, script,
commands, output, parts and timeline, that
a moment chosen on the timeline shows the views and the conversation as they were then,
that the answer board is led by the figure the turn made, with the next question and its
answer under it, and overflow at 1024/390. Evidence goes to
`work/agent-canvas-acceptance/` by default.

`npm run acceptance:agent-page` drives controlled peers for Claude Code and Codex
that offer models, settings and Claude Code's own names and report a title, context
and cost. It checks asking an Agent, its names, providers and models, saving the model,
effort and default; the message box's chip naming them and its menu changing the
effort in place, with Escape stepping back and closing the menu but not the panel; the
rows with their model, effort, context and cost, search and
the Agent filter; an opened row's facts and rendered table and the Markdown export;
the trash with Undo, restore and delete, never while the Agent answers; and overflow
at 1024/390. Evidence goes to `work/agent-page-acceptance/` by default.

`npm run acceptance:graph` drives a controlled peer that runs the real Rscript for two
messages. It checks the empty Graph, the Agent's flag on the card it reads while the
Graph stays and follows, the two rows with their lines and the reference between them,
table and figure previews, a figure's path and its own view, arrow keys along the
path, a reference going to its output, Play's narration, that following opens no
files in the workspace while a node the person opens goes there, and overflow at
1024/390. Set `RHO_RSCRIPT` if `Rscript` is not on the
path. Evidence goes to `work/graph-acceptance/` by default.

`npm run acceptance:sources` browses a project of data, scripts in two folders and
figures in two output folders from the sidebar, without a model. It checks the
unfolded lists and their order, a file shown in place with no layout written, ←/→,
the buttons and ↑/↓, the table and editor keeping their own arrow keys, an R script's
colours, Open in Studio, unfolded kinds after a reload, a Markdown note read with its
image, math, table and highlighted code, following another writer's edit, Edit and Read,
a link to a script, and the 390 px drawer. Evidence goes to
`work/sources-acceptance/` by default.

`npm run acceptance:agent-ui` drives a controlled ACP peer through the real service
and Chrome; it uses no model credentials. It checks that reply text arrives in more
than one visible piece, that read/command/write actions name their target while they
run, that the plan line follows the entry in progress, that a native permission is
shown, answered and retained in the work that folds when the message ends, that the
Agent's Markdown renders, and that reading
earlier lines is not interrupted by new activity. Evidence and screenshots go to
`work/agent-ui-acceptance/` by default.

`npm run acceptance:base-r` runs the complete selected-row question, external Agent
edit, real R execution, two-version comparison and browser-disconnection episode.
It requires the configured Claude Code client and never substitutes a simulated
model. Its [record](BASE-R-EPISODE.md) separates fresh execution from browser-only
continuation and independent aggregate checks from scientific review.

Action, object, shell, document and continuity suites exercise the existing owner
behavior through the rebuilt UI. Only executed checks in [Status](STATUS.md) are
current evidence. Historical component and installed-package results do not accept
this new frontend automatically. Native physical IME behavior and human usability
require their own evidence. The frontend reset did not implement a Project Notebook
owner, native desktop windows or a registry release.
Functional browser evidence shows that paths work, not that the screens can be read;
the [base-R review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records where
they cannot.

`node scripts/conversation-episode.mjs` drives the conversation episode with the
configured Claude Code. It stops only when a step cannot be performed; the reviews
in its [record](CONVERSATION-EPISODE.md) judge what its screenshots show.
