# Rho status

Updated: 2026-10-29.

## Current focus

On 2026-10-27 the user found the project sidebar nearly empty and the main area
still while the Agent worked. The sidebar now names its places and counts its Sources,
one Agent entry opens its page, the Agent and model can be chosen, and the person
arranges views as the Agent can ([record](AGENT-CANVAS-EPISODE.md)). Then came one
shared workspace and a Graph of what the Agent did ([record](GRAPH-EPISODE.md)), Agent
settings with conversation management ([record](AGENT-PAGE-EPISODE.md)), the conversation
window and Agents outside Rho ([record](AGENT-PANEL-EPISODE.md)); all run ([section](#project-sidebar-workspace-and-graph)).

Agent 0.4.11 adds each tool step's title, ACP category and input to the Claude/Codex
ACP connections of 0.4.10. Eight real Westlake HPC turns from the installed package
passed with cancellation, connection loss and session recovery, as did external Codex
observation across restart; the unsigned macOS arm64 package installed and started
([record](ACP-MULTI-AGENT-EPISODE.md); panel: [Agent UI](AGENT-UI-EPISODE.md)).

The home, projects and empty-project pass of 2026-10-27 is in
[its episode](HOME-PROJECT-EPISODE.md) and [summary](#home-projects-and-empty-project).
The [from-scratch design brief](design/2026-10-26/index.html) still describes the larger
product (two navigation scopes, Studio, a panoramic Graph, a dynamic Agent experience, a
conversation component, a plugin design standard); records below are capability
evidence, not the target interface or design acceptance criteria.

| Part | Stage | Evidence | Next question |
| --- | --- | --- | --- |
| Execution identity, recovery and Documents buffers | Hardened | Owner and acceptance suites below | None in the current focus |
| Question → Agent → linked result | Runs; not yet usable from the screens | [Base-R episode](BASE-R-EPISODE.md) | Can the answer be read from one screen? |
| Comparing two results | Runs | Two views split by hand | Can the differences be read by key? |
| Claude/Codex and shared workspace | Both installed loops and external Codex relay run | [ACP acceptance](ACP-MULTI-AGENT-EPISODE.md) | Human usability and passive attachment to uninstrumented clients remain unproven |
| Agent panel presentation | Streams; work folds under each answer; real records and a controlled peer observed | [Agent panel](AGENT-PANEL-EPISODE.md) | Can a person scan a long trace and act on it? |
| Project sidebar, workspace and Graph | Runs; real Claude turns and controlled peers | [Graph episode](GRAPH-EPISODE.md) | Can a person read from the Graph what the Agent did, and step in? |
| Project shell and navigation | Runs | Frontend browser suite below | Does it hold up around the reworked episode? |
| Plugin UI extensions | Runs | Authoring checks below | Does a view built with it serve a real episode? |
| Domain episode (DESeq2) | Not started | — | What carries over from base-R? |

Interaction and frontend design guidance and the airquality interaction specification,
written on 2026-10-25, were withdrawn that day at the user's request: they fixed
grammars, visual values and acceptance criteria before results existed to learn from.
Git retains them at `24d9998b`; they are not requirements or reference designs.

## Project sidebar, workspace and Graph

- The sidebar shows All projects, the project and a menu to switch, then Overview,
  Studio with its workspaces, Agent (Working or Needs you), and Sources: Data, Code,
  Results & figures and Notes from one bounded walk (48 folders, 5 levels, 4000 files;
  partial counts say so), then Files. Each kind unfolds into its files by folder; one
  shown in place writes no layout; ←/→ and ↑/↓ move through it; Open in Studio places it.
- Following, Open in Studio and Files use one workspace the person and the Agent share:
  named files and outputs that appear on disk open once, code and data/figures each in
  its group wherever the person moved it; the last named file's tab carries the Agent's
  verb. Choosing another view, typing, dragging or leaving stops following.
- The Graph draws each message as a row from what it read to what changed on disk
  while its commands ran (recorded per message when it ends), with previews, a focus
  path, the Agent's flag and its pending choices; its timeline gives each conversation a
  lane and each step its kind's colour, and replays at 1–4×. The Overview leads with it
  in small, then results as pictures ([record](GRAPH-EPISODE.md#the-timeline-the-overview-and-host-activity)).
- Tabs drag onto other tabs, into a group or to its side, and the Agent panel's edge
  drags; each drop is the conditional `composition.apply` the Agent's grant also holds.
- The Agent page lists conversations by day (model, effort, context, cost, search,
  Markdown export, a trash); Agents shows versions, models by provider, settings and the
  default. Outside Rho runs the person's own Claude Code or Codex `mcp add` for this
  project with one button (`session.connect`) and shows the access and first call.
- A left rail keeps open projects one click away with their Agent state; All projects
  drops the project sidebar. The Overview leads with counts and figures.
- Documents 0.4.3 adopts a changed file into a buffer with no unsaved text. Agent
  0.4.12 captures one named file; 0.4.13 applies, changes and inspects ACP settings;
  0.4.14 draws Host activity as cards and 0.4.15 shows project paths relative.

Evidence: Rho 218/218 (serial) and Plugins 92/92 ([ledger](VERIFICATION.json));
`acceptance:agent-page` 7/7, `graph` 8/8 and `agent-canvas` 10/10 (controlled peers),
`sources`, `frontend`, `agent-ui`, pages, shell, person, objects, actions, continuity and
plugin UI passed. Real Claude and Codex runs found defects in following, settings, the
Graph and the Agent page; each was fixed and run again. No other person has used them.

## Home, projects and empty project

The home, projects and empty-project screens were reworked against what the
application actually records; the [episode record](HOME-PROJECT-EPISODE.md) keeps
the setup, the observations before and after, and the limits.

- Home is one heading, one primary action and one list. Each row names the folder
  the work lives in, counts its source folders and gives the exact path in its
  tooltip; no projects opens the two real starting actions.
- The create-project sheet closes, lists chosen folders as rows and names what is
  still missing; the page behind is dimmed and blurred.
- A project with nothing recorded opens "Work with Agent" and "Browse files", led as
  its listing decides; activity appears only with runs; the header names the source folder.
- The topbar names the way back and keeps only the current place below 768 px, and
  ends with the one Agent button. Connection & access, at the sidebar foot, shows the
  connection and this tab's access as cards ([record](AGENT-PANEL-EPISODE.md#connection--access)).

The first pass could not list a project's source folders; `project.entries` now lists
the folder and an `@<sourceId>` entry per source and descends into them.

Evidence: Rho 185/185 unit checks, including source-folder listing and this machine's
tab picking a folder; `acceptance:frontend` 11 checks, pages, shell and person; six
interaction and five source-folder checks in Chrome, no page errors
(`work/ui-review-20261027/`). Paths work for the builder; others' use is unobserved.

## From-scratch design requirements

The user's 2026-10-26 clarification supersedes the first handoff at `433f5aa7`.
The rewritten [20-page brief](design/2026-10-26/index.html) and
[PDF](../output/pdf/rho-design-handoff-2026-10-26.pdf) commission a new product design;
current menus, layouts and SDK gaps are not design constraints or implementation
targets. Diagrams express requirements and relationships, not a finished visual design.
The [builder](design/2026-10-26/build.py) retains editable content and diagrams.

The brief covers two navigation scopes, three project work modes, the dynamic Agent
entry and task surface, dedicated conversation variants, shared application
components, a plugin requirements card, four professional plugin examples and three
cross-mode storyboards. Designers supply alternative directions, detailed flows,
components, visual language and prototypes; implementers identify and build gaps.

Document verification is in [verification](design/2026-10-26/verification.json),
with evidence in `work/design-brief-v2-20261026/`; it establishes neither usability
nor behavior, and existing execution/content boundaries do not prescribe the interface.

## External Agent activity

Outside Rho's Host activity section shows Claude Code/dsh sessions, calls,
refusals, process exits and output files. Core pages are read every 1.5 seconds;
connection failure keeps received actions, and Reconnect reads the same cursor.
Opening a CSV or image captures its observed digest through Files and opens an
existing owner view. Original and later file snapshots remain independent.

- Run 6 (Claude Code 2.1.310, dsh 0.2.1-rc.2, WestlakeHPC): 7/10 and 15/24 events,
  each analysis once, exit 7, none added on repeat; pending, Host loss, reconnect,
  CSV/SVG, 1440/390 and reload checked in Chrome (`work/agent-activity/run-6/`).
- Runs 7–8 (2026-10-28, Claude Code 2.1.312): both flows passed again on Agent 0.4.14's
  cards; run 7 found the opened section below the fold and absolute paths, so opening
  scrolls to it and 0.4.15 shows project paths relative ([record](AGENT-ACTIVITY.md#real-episode-and-review)).
- Source selection: Agent 0.4.15, Tables 0.4.3 (runs 1–6: Agent 0.4.7, Core
  `4f5bed86`). This shows the flow, not human usability. External sessions need an explicit
  collector; the UI does not discover or start every native session. Native
  completion, producer attribution and validity remain unknown unless their
  evidence supplies them; export does not archive activity.

## Base-R collaboration loop

The [airquality episode](BASE-R-EPISODE.md) passed in an actual Chrome browser using
R 4.5.2 and Claude Code 2.1.310. A person selects May, asks a Unicode question,
and the real Agent changes the missing-value rule, conditionally saves, runs R,
checks the output and explicitly links its new table and PNG. Five monthly rows
match an independent base-R calculation. May changes from n=24 / 24.125 ppb to
n=26 / 23.615385 ppb; adoption remains pending in the person's notes.

An opened linked result previously lacked layout controls. Rho now lets the person
split or move that exact view through one conditional composition write. The old
version and selection remain; the saved comparison survives reload. Owner APIs,
execution semantics and the existing Plugins table-style override are unchanged.

- `npm run build` and 19 targeted layout/live-workspace checks passed;
  `acceptance:frontend` passed its browser regression.
- `npm run acceptance:base-r` passed from a fresh disposable project: 46 Agent turns
  in 223 s within the 48-turn/ten-minute limits, exactly two native submissions
  (baseline and requested change). Lost acknowledgement plus reload/retry retained
  one exact question; disconnection plus Reconnect retained the request digest, Core
  identity and native operation identity.
- Chrome 155.0.8059.84 checked 1440, 1024, 768 and 390 CSS pixels, including
  compared values, separate version selections, both PNGs, source lines and
  acknowledged unsaved notes, with no browser exceptions. Evidence is in
  `work/base-r-episode-20261025/accepted/`, without a new binary or signed release.

These checks show that the path works, not that a person can follow it; the
[review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records where the screens
fall short and sets the next run. This run does not establish Host crash recovery,
external model-session resumption or scientific validity. Sort/filter controls
keep their existing reload defaults; exact entity/version anchors persist.

## Conversations started in Rho

New conversations select Agent 0.4.11's persistent Claude or Codex ACP connection. Rho holds
original message identities and the visible record; the plugin owns native
protocol/session behavior. Existing CLI conversations retain their original driver.
Rho MCP calls keep their project grant; native tools keep their Agent's permissions.
Only this machine's browser can answer a native permission request.

The panel renders the retained record as it arrives: Markdown, a caret and time on the
live message, one line per action with its kind and target, and an amber permission
card. A message's work and choices then fold into one line above the answer
([panel pass](AGENT-PANEL-EPISODE.md)); settings are one chip and a menu of rows in the
box, plan, context and cost a line under it. New activity is followed only at the end,
then Jump to latest. Tool status and the ACP path are labelled as Agent reports.

- [Agent UI episode](AGENT-UI-EPISODE.md): `acceptance:agent-ui` 7/7,
  `acceptance:frontend` 11/11, Rho 202/202 (one earlier full run cancelled the known
  30 s test; two following runs passed) and Plugins 89/89; build and contract checks
  passed. A controlled ACP peer and one real Westlake HPC Claude turn were observed
  at 1440/390 CSS pixels without page errors.
- The earlier [ACP episode](ACP-EPISODE.md) ran real Claude Code 2.1.311: seven
  messages, Unicode, the same connection/grant, lost acknowledgement, disconnection,
  confirmed cancellation, forced loss, session load and restart. An interrupted
  prompt stays unknown; reads start nothing. Background jobs remain separate.
- Checks then: Rho 188/188, Agent 80/80; Agent 0.4.8 installed outside the
  checkouts. The unsigned macOS arm64 candidate passed installed CLI/homepage and
  seven-turn ACP acceptance; Core remains at `4f5bed8`, unchanged.
- The earlier [CLI episode](CONVERSATION-EPISODE.md) retains its measurements and
  failures. The 64-method Agent grant ceiling remains open; conversation permission
  is local-person-only and consumes no grant slot.

## UI extension authoring

`rho-ui create`, `dev`, `check` and `build` provide a standalone author workflow: a
typed React package reads an existing capability through the public UI contract, with
a fixture preview (states, widths, props, errors, bounded calls, refresh) that gets no
project credentials and starts no runtime. An explicit `RHO_UI_EXTENSIONS` selection
pins package versions or local overrides; Rho generates the browser registry and
registers the same metadata with the capability owner. It adds views, not backend
methods. [Plugin authoring](PLUGIN-AUTHORING.md) is the executable guide.

Then-current checks: Rho 174/174 (scaffolding without overwrites, pinned identities,
reserved names, containment, document bindings, unchanged grants, removal), Chrome
155 preview and installed views at four widths without starting a Host, and an
unsigned tarball outside the checkouts that generated, built and previewed another
package. Evidence is under `work/plugin-dx/`; it is not a signed release.

## Frontend reset

The user stopped the prior frontend work on 2026-10-25, removed all previous frontend
documents, rules and designs, and asked for a reconstruction from the work people
need to do. AGENTS.md and the documentation index no longer direct work through those
plans, and the superseded `work/` evidence is gone; Git retains their history.

The reset built one project sidebar, dedicated project sections, searchable projects
and files, direct workspace controls and an optional Agent inspector; execution
records remain reachable from the Agent page and exact artifact provenance.
In a tab opened from a narrower link, the Agent request field uses an explicit
clipboard handoff to the external Agent, while a tab on this machine holds
conversations started in Rho; the draft survives panel closure, scoped by
principal/project, and copying never claims delivery. Documents, selections, run
identity and conditional writes keep their actual owners.

## Direct browser access

Opening the loopback url in a browser on this machine is now the access. A same-origin
request that carries no credential is authorized as the local person with the reviewed
browser scope, no link, no one-time code and no expiry; Host, Origin and a browser's own
cross-site marking are still checked on every request. A credential that is present must
still be valid, so a stale or forged one is refused rather than silently widening to
local access, and the machine's own identity is not a revocable session.

`rho --pair` still mints a one-time, five-minute link for a narrower or expiring tab.
The browser no longer starts on a gate asking for a link: a link that cannot be used
leaves the page working as this machine and says so, and switching from a link to this
machine forgets only the credential, keeping open projects, unsaved edits and running
work.

The tradeoff is explicit: any process running as this user can call the loopback API
without a credential, which the readable operator connection file already allowed. Human
usability, physical IME behaviour and distribution are not verified here.

## Verification of this reconstruction

The 2026-10-25 reconstruction passed `npm run build`, 171 unit checks and real Chrome
155 at 1440, 1024, 768 and 390 CSS px: project entry, files, table, figure, layout,
activity, settings, plugins and dialogs; clipboard, Unicode, CDP IME composition and
focus return; real R runs with one dispatch after a lost reply, stop, repair, unknown
outcomes, provenance and partial export; unsaved text, undo, selections, documents,
layouts and contexts across re-layout and normal or sudden service exits. An unsigned
tarball installed and launched outside the source repositories. Reports are under
`work/frontend-reset/`; earlier appearance acceptance is not inherited. The unit
result for Plugins in that ledger entry kept its original date.

## Existing application capabilities

- Node local service with authenticated project/method scope, generated public
  contracts, bounded JSON/SSE observation and a project-scoped MCP adapter.
- Conditional shared Documents buffers, author history, own undo, disk conflict
  checks, exact resource references and durable acknowledged recovery.
- Registered table, media, chart, document, annotation and Agent views; composition
  tabs/splits use the same conditional owner layout and preserve view buffers.
- Real R execution through the public Core CLI, original request identity, retained
  output, cancellation facts, partial/unknown outcomes, explicit repair and export.
- Separate execution completion, artifact integrity, domain checks and Agent claims.
- External Claude Code integration and scoped capability discovery, and conversations
  with Claude Code that the person starts and holds in Rho. Explicit linked replies
  remain distinct from a context fetch.

[Headless backend](HEADLESS.md), [Collaboration](COLLABORATION.md) and the historical
backend acceptance records retain their technical scope and immutable candidates.
The three source repositories remain independently owned; the frontend work changed
no Core behavior and no functional component API.

## Delivery scope and limits

The current source targets the local browser application on macOS arm64. Source
checks, accepted package composition, installation and official distribution are
separate evidence. npm registry publication, native desktop windows, signed
distribution, other platforms and physical IME usability are not established by this
frontend change, and human usability has not been evidenced.

[Frontend](FRONTEND.md) describes the current implementation. [Release](RELEASE.md)
describes source publication and the separate future distribution milestone.
