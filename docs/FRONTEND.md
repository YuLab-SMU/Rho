# Browser application

Updated 2026-10-27. The frontend was reset at the user's request. Previous frontend
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
- **Overview** opens existing workspaces and recorded results, with recent runs when
  there are any. Its Work progress shows a conversation while it answers or waits for
  a choice; finished ones are counted and listed on the Agent page. A project with nothing recorded yet shows its two next steps —
  work with the Agent or browse its files — rather than empty sections, leading with
  whichever one the project's listing says has something behind it.
- **Sources** counts the project's Data, Code, Results & figures and Notes from one
  bounded walk of its folders, by file name. Each kind unfolds in the sidebar into
  its files across the project and its source folders: the top level first, then by
  folder, at most 40 there with the rest on the kind's page. Choosing one shows it
  in place in its own view, without writing a layout: a CSV or image as a snapshot
  of its current bytes in the table or media view, text in the editor, a registered
  result as its exact version. ← and → or the buttons beside "3 of 6" move through
  the kind, ↑ and ↓ move in the sidebar, and Open in Studio places the file in the
  workspace ([pass](AGENT-CANVAS-EPISODE.md#browsing-sources-from-the-sidebar)).
  `+` adds a source folder.
- **Files** opens documents, browses the project's folder and the source folders it
  works in, and filters the current folder. A source folder is named as the person
  named it and opens one level at a time, the same way any other folder does.
- **Agent** (the sidebar row) has two tabs. Conversations lists those started in Rho
  by day, searchable and by Agent: each row its title, model, effort, messages, state,
  context use and cost, with Continue, export as Markdown and the trash; opened, its
  facts beside what its latest messages did (the files changed and looked at, each
  shown in place when chosen, the commands and the answer). The trash restores or
  deletes. Runs follow when there are any, with their execution records, output,
  repair context and exports. Sessions started outside Rho — Core-backed Claude
  Code/dsh activity streams, native errors and observed output files — sit in a
  section read only while it is open. Agents shows Claude Code and Codex: version,
  whether asked, the default, model, settings, Claude Code's own model names and the
  providers with their models ([activity episode](AGENT-ACTIVITY.md),
  [Agents and conversations](AGENT-PAGE-EPISODE.md)).
- **Project settings** manages source folders and explicitly checks available tools.
- **Studio** shows the workspaces as tabs, each with its view count; the sidebar lists
  them under Studio. The person and the Agent share one workspace: the one on screen,
  else the one last open in the tab, else the first, else a new `workspace`. Sending a
  message from the Agent panel follows the turn there. Each project file the Agent's
  steps name opens once (a read when reported, an edit or write once it returned,
  files a finished command names), as do outputs that appear on disk during the turn,
  beside the person's own views: code joins code and data and figures join data,
  wherever those groups now are, or get a group at their edge. The tab of the file the
  Agent last named says Reading, Edited, Ran…; the topbar names the Agent's newest
  action on every project page. Choosing another view, typing, dragging a tab or
  leaving stops following until the person follows again
  ([canvas episode](AGENT-CANVAS-EPISODE.md), [one workspace](GRAPH-EPISODE.md)).
- **Graph** draws what the Agent did: each message a row from the files it read to
  the question, what it edited and ran, and what changed on disk while its command
  ran; a later row refers to an earlier output. Lines say whether the Agent reported
  it, a command named it, or a change was seen on disk. Cards preview tables and
  figures; choosing one shows its path and the file in its own view; the timeline
  replays the work. While the Agent works the Graph stays and follows it, and its
  files still open in the shared workspace; a step waiting for the person's choice
  turns amber and is answered there. A file opened from it is held in the workspace
  while following goes on ([episode](GRAPH-EPISODE.md)).
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
  names the model, its provider, the effort and what is switched on: the saved choices
  for a new conversation and the open conversation's own, changed between messages. It
  opens a short menu with a row per setting the Agent offers (the Agent for a new
  conversation, the model with its search, effort, mode); a row opens its list in place,
  an On/Off setting is a switch, and Escape steps back, then closes the menu, not the
  panel. Each ending names the model that answered ([settings pass](AGENT-CANVAS-EPISODE.md#choosing-the-agent-and-its-model)). The panel renders the retained
  record rather than protocol events ([panel pass](AGENT-PANEL-EPISODE.md)): the
  Agent's last words stay open as Markdown prose, lists, code with Copy and tables
  that wrap; what it did before them folds into one line ("Worked · Ran 8 commands ·
  Edited 1 file · 6 choices"), open while it works. Inside, each tool step names what it
  did (`Read data.csv`, `Ran Rscript analysis.R`, `Wrote results/summary.csv`,
  `Called data.page`) with an icon for its kind and the Agent's title and reported path
  behind a disclosure; files are counted once; answered choices stay in the fold. Each
  message ends with its outcome, model, time and Copy. A native permission request is
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
workspace — and keeps only the current place below 768 CSS px. The project sidebar
starts with All projects and the project (its menu switches to another open project),
then Overview, Studio, and Agent (Working or Needs you while a turn runs), then
Sources. Project settings, Plugins and Connection & access sit together at its foot;
the last opens the connection, this tab's access and a document's Changes. The sidebar and optional
inspector adapt to available space. Narrow screens show one workspace view at a time.
Closing a panel does not cancel work.

The [home and project episode](HOME-PROJECT-EPISODE.md) records the 2026-10-27 pass
over these screens, its checks and the listing gap it left open.

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
`src/work-graph.ts` builds the Graph from `conversation.read` records (a finished
message keeps the project files that changed on disk while it ran) and the folder walk
(`project.entries` gives each file's `modifiedAt`), and lays each message out as a row; `web/graph.tsx` draws it, its previews, the inspector and the timeline.
`web/work-progress.tsx` reads `project.work.read` for the local person's project
Overview: Agent-reported plans/usage, retained native source identities and current
referenced files. It shows a conversation started in Rho only while it answers or
waits for a choice, and links to the Agent page for the finished ones.
`web/agent-manage.tsx` draws the Agent page's tabs from the conversation summaries in
the snapshot and `conversation.list` for the trash; an opened row reads its latest
four messages through `web/agent-work.tsx`, the same step model as the panel.
`web/agent-settings.tsx` keeps one copy of `conversation.settings.read` per tab for
the Agents tab and the panel's settings menu (`web/settings-menu.tsx`);
asking an Agent what it offers (`conversation.settings.check`) is always the
person's click.
Shared notes opens `project-notes.md` in the existing Documents owner; saving is
explicit before asking Agent to read it. A failed work read keeps the previous
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
that Start follows in the workspace the person has open, the table, editor and media
views the Agent's files open in beside the person's script with the Agent's place on
their tabs, the edited text on disk, the one saved layout, the Agent page's record of
the turn and a file it names shown in place, that choosing another view stops
following until Follow, that a pane the person drags out stays while the Agent's next
data file joins the data group, and overflow at 1024/390. Evidence goes to
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
path, a reference going to its output, Play's narration, the files in the one shared
workspace, and overflow at 1024/390. Set `RHO_RSCRIPT` if `Rscript` is not on the
path. Evidence goes to `work/graph-acceptance/` by default.

`npm run acceptance:sources` browses a project of data, scripts in two folders and
figures in two output folders from the sidebar, without a model. It checks the
unfolded lists and their order, a file shown in place with no layout written, ←/→,
the buttons and ↑/↓, the table and editor keeping their own arrow keys, Open in
Studio, unfolded kinds after a reload, and the 390 px drawer. Evidence goes to
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
