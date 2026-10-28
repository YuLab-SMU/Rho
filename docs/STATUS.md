# Rho status

Updated: 2026-10-27.

## Current focus

On 2026-10-27 the user found the project sidebar nearly empty and the main area
still while the Agent worked. The sidebar now names its places and counts its Sources,
the [Agent canvas](#project-sidebar-and-agent-canvas) opens the files the Agent reads
and changes, and each Sources kind unfolds so a file shows in place and ←/→ move
through the kind. Documents 0.4.3 and Agent 0.4.12 carry the owner repairs;
[the record](AGENT-CANVAS-EPISODE.md) keeps the runs.

Agent 0.4.11 adds each tool step's human title, ACP category and identifying input
to the Claude/Codex ACP connections accepted at 0.4.10. Both Agents passed eight
real Westlake HPC turns from the installed package, including cancellation,
connection loss and original-session recovery. External Codex ACP loading, live
observation across Rho restart and reconnect also passed. Core source/binary remain unchanged.
At that point Rho 202/202, Plugins 89/89 and contract/type checks passed. The unsigned macOS arm64
package passed install/start checks; [the record](ACP-MULTI-AGENT-EPISODE.md)
distinguishes turn cancellation, native jobs and explicit external relay attachment.
The Agent panel's streamed text, action rows, plan and permission treatment are in
[Agent panel live activity](AGENT-UI-EPISODE.md).

The 2026-10-27 home, projects and empty-project pass is in the
[home and project episode](HOME-PROJECT-EPISODE.md) and
[its summary](#home-projects-and-empty-project). Current implementation is still not
the design target. The [from-scratch product design brief](design/2026-10-26/index.html)
still describes the larger product: separate application and project navigation,
Studio, panoramic Graph, a dynamic Agent experience, a dedicated conversation
component and a shared plugin design standard. Implementation records below remain
capability evidence, not the target interface or design acceptance criteria.

| Part | Stage | Evidence | Next question |
| --- | --- | --- | --- |
| Execution identity, recovery and Documents buffers | Hardened | Owner and acceptance suites below | None in the current focus |
| Question → Agent → linked result | Runs; not yet usable from the screens | [Base-R episode](BASE-R-EPISODE.md) | Can the answer be read from one screen? |
| Comparing two results | Runs | Two views split by hand | Can the differences be read by key? |
| Claude/Codex and shared workspace | Both installed loops and external Codex relay run | [ACP acceptance](ACP-MULTI-AGENT-EPISODE.md) | Human usability and passive attachment to uninstrumented clients remain unproven |
| Agent panel presentation | Streams; controlled peer and one real turn observed | [Agent UI episode](AGENT-UI-EPISODE.md) | Can a person scan a long trace and act on it? |
| Project sidebar and Agent canvas | Runs; four real Claude turns and a controlled peer | [Agent canvas episode](AGENT-CANVAS-EPISODE.md) | Can a person follow a long, fast turn on the canvas and step in? |
| Project shell and navigation | Runs | Frontend browser suite below | Does it hold up around the reworked episode? |
| Plugin UI extensions | Runs | Authoring checks below | Does a view built with it serve a real episode? |
| Domain episode (DESeq2) | Not started | — | What carries over from base-R? |

The interaction guidance, frontend design guidance and airquality interaction
specification written earlier on 2026-10-25 were withdrawn the same day at the
user's request. They fixed grammars, visual values, state sequences and acceptance
criteria before the application or its plugins had produced results to learn from.
Git retains them at `24d9998b`; they are not requirements or reference designs.

## Project sidebar and Agent canvas

- The sidebar shows All projects, the project and a menu to switch, then Overview,
  Studio with its workspaces, Agent (Working or Needs you), Activity with its run
  count, and Sources: Data, Code, Results & figures and Notes from one bounded walk
  (48 folders, 5 levels, 4000 files; partial counts say so), then Files. Each kind
  unfolds into its files by folder; one chosen shows in place with no layout written,
  ←/→ and ↑/↓ move through the kind, Open in Studio places it.
- Sending from the Agent panel opens the Agent canvas and follows the turn: files the
  steps name, files a finished command names and outputs that appear on disk open
  once, code left and data/figures right; the tab of the last named file carries the
  Agent's verb. Choosing another view, typing or leaving stops following.
- Documents 0.4.3 adopts a changed file into a buffer with no unsaved text; Agent
  0.4.12 captures one named file without scanning its folder, digest optional.

Evidence: Rho 202/202 (serial) and Plugins 90/90 ([ledger](VERIFICATION.json));
`acceptance:agent-canvas` 8/8 (controlled peer), `acceptance:sources` 7/7, `frontend`
11/11, `agent-ui` 7/7, pages, shell, person, objects, actions, continuity and plugin
UI passed. Four real Westlake HPC Claude turns found and fixed five defects. This shows
the paths work, not that a person can follow a fast Agent or browse faster there.

## Home, projects and empty project

The home, projects and empty-project screens were reworked against what the
application actually records; the [episode record](HOME-PROJECT-EPISODE.md) keeps
the setup, the observations before and after, and the limits.

- Home is one heading, one primary action and one list. Each row names the folder
  the work lives in, counts its source folders and gives the exact path in its
  tooltip; no projects opens the two real starting actions.
- The create-project sheet closes, lists chosen folders as rows and names what is
  still missing; the page behind is dimmed and blurred.
- A project with nothing recorded opens "Work with Agent" and "Browse files"; the
  listing decides which leads. The activity column appears only with runs, and the
  header names the source folder.
- The topbar names the way back and keeps only the current place below 768 px;
  Project settings and Plugins sit at the sidebar foot.

The first pass could not list a project's source folders; `project.entries` now
lists the folder and an `@<sourceId>` entry per source and descends into them.
Fixing it surfaced that `State.openSelected` demanded an expiry, refusing "Open
folder…" for this machine's non-expiring access; it now uses the same rule.

Evidence: `npm run build`; Rho 185/185 unit checks, including source-folder listing
and this machine's own tab picking a folder; `acceptance:frontend` 11 checks;
`acceptance:pages`, `acceptance:shell` and `acceptance:person` passed; six
interaction and five source-folder checks in real Chrome, no page errors.
Screenshots and scripts are in `work/ui-review-20261027/`; this shows the paths work
to the builder, not that another person can follow them.

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

Activity shows Claude Code/dsh sessions, calls, refusals, process exits and output
files. The Agent panel links to this page. Core pages are read every 1.5 seconds;
connection failure keeps received actions, and Reconnect reads the same cursor.
Opening a CSV or image captures its observed digest through Files and opens an
existing owner view. Original and later file snapshots remain independent.

- Real final runs: Claude Code 2.1.310 and dsh 0.2.1-rc.2 through WestlakeHPC
  retained 7 pending / 10 final and 15 / 24 events; each analysis entered once,
  showed diagnostic exit 7, and repeat collection added none. Chrome checked
  pending/Host loss/reconnect, CSV/SVG opening, 1440/390 widths, reload and both
  sessions after the text-file wording/PDF refusal fix.
- Rho 182/182 and Plugins 76/76 passed then.
- Evidence: `work/agent-activity/run-6/` records exact hashes, failures and reviews;
  this demonstrates the flow, not human usability.
- Source selection: Agent 0.4.7, Tables 0.4.3, Core unchanged at
  `4f5bed8631e15acad44cc86b63ea4779ab8af342`. External sessions need an explicit
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

The panel renders the retained record as it arrives: Markdown prose, a caret and
elapsed time on the live message, one line per action with its file, command,
pattern or project operation, open short runs and folded longer runs, the live plan
entry, an amber permission card and a retained human choice. It follows new activity
only at the end and offers Jump to latest after the person scrolls up. Tool status
and the ACP path are labelled as Agent reports; observed files remain in Work progress.

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
  is local-person-only and consumes no grant slot. Raw Markdown display is fixed by
  this pass.

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
records remain reachable from Activity and exact artifact provenance.
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
