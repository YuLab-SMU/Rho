# Rho status

Updated: 2026-10-27.

## Current focus

Agent 0.4.10 connects Claude and Codex to the shared notes/result loop. Both passed
eight real Westlake HPC turns from the installed package, including cancellation,
connection loss and original-session recovery. External Codex ACP loading, live
observation across Rho restart and reconnect also passed. Core source/binary remain
unchanged. Rho 192/192, Plugins 89/89 and contract/type checks pass. The unsigned
macOS arm64 package passed install/start checks; [the record](ACP-MULTI-AGENT-EPISODE.md)
distinguishes turn cancellation, native jobs and explicit external relay attachment.

The user asked for an optimization of the home, projects and empty-project screens
on 2026-10-27, supplying three reference screens for layout weight and hierarchy.
That pass is recorded in the [home and project episode](HOME-PROJECT-EPISODE.md) and
summarized in [Home, projects and empty project](#home-projects-and-empty-project).
The user's earlier clarification still stands: current implementation is not the
design target. The [from-scratch product design brief](design/2026-10-26/index.html)
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
| Project shell and navigation | Runs | Frontend browser suite below | Does it hold up around the reworked episode? |
| Plugin UI extensions | Runs | Authoring checks below | Does a view built with it serve a real episode? |
| Domain episode (DESeq2) | Not started | — | What carries over from base-R? |

The interaction guidance, frontend design guidance and airquality interaction
specification written earlier on 2026-10-25 were withdrawn the same day at the
user's request. They fixed grammars, visual values, state sequences and acceptance
criteria before the application or its plugins had produced results to learn from.
Git retains them at `24d9998b`; they are not requirements or reference designs.

## Home, projects and empty project

The home, projects and empty-project screens were reworked against what the
application actually records; the [episode record](HOME-PROJECT-EPISODE.md) keeps
the setup, the observations before and after, and the limits.

- Home is one heading, one primary action and one list. Each row names the folder the
  work lives in (source folders counted, exact path in the tooltip) and when it was
  last opened, instead of printing an absolute path. With no projects it opens a
  centred prompt with the two real starting actions.
- The create-project sheet gained a close control, the chosen folders as rows and a
  line naming what is still missing; the page behind is dimmed and blurred.
- A project with nothing recorded opens a centred empty state with "Work with
  Agent" and "Browse files" instead of empty sections; the listing below decides
  which leads. The activity column appears only when there are runs, and the header
  names the folder the work comes from.
- The topbar names the way back (`Projects / project / workspace`, the current place
  only below 768 px); Project settings and Plugins sit at the sidebar foot.

The first pass recorded that a project made from source folders could not list them,
so `project.entries` now lists the project's folder together with an `@<sourceId>`
entry per source folder and descends into them under the reference the file owners
resolve; a moved or missing source is reported instead of followed. Fixing it
surfaced a blocking defect: `State.openSelected` demanded an expiry, so "Open
folder…" was refused as `unauthorized` for the person at this machine, whose access
does not expire. It now uses the same rule as the other checks.

Evidence: `npm run build`; Rho 185/185 unit checks, including a project made from
source folders and this machine's own tab picking a folder — the latter fails on the
previous commit; `acceptance:frontend` passed its 11 checks; `acceptance:pages`,
`acceptance:shell` and `acceptance:person` passed; six interaction and five
source-folder checks passed in real Chrome, with no browser page errors. Screenshots
and scripts are in `work/ui-review-20261027/`. This shows the paths work and that the
screens read as intended to the builder; it is not evidence that another person can
follow them.

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

Document verification is recorded in [verification](design/2026-10-26/verification.json)
with local evidence in `work/design-brief-v2-20261026/`. It does not establish product
usability or change application behavior. The existing execution and content safety
boundaries remain; they do not prescribe the new interface's shape.

## External Agent activity

Activity shows Claude Code/dsh sessions, calls, refusals, process exits and output
files. The Agent panel links to this page. Core pages are read every 1.5 seconds;
connection failure keeps received actions, and Reconnect reads the same cursor.
Opening a CSV or image captures its observed digest through Files and opens an
existing owner view. Original and later file snapshots remain independent.

- Real final runs: Claude Code 2.1.310 and dsh 0.2.1-rc.2 through WestlakeHPC, with
  7 pending / 10 final and 15 / 24 events retained; each analysis entered once,
  showed diagnostic exit 7, and repeat collection added none. Chrome 155.0.8059.84
  checked live pending, owned Host loss, reconnect, CSV/SVG opening, 1440/390 widths,
  reload and both retained sessions after the text-file wording/PDF refusal fix.
- Rho 182/182 and Plugins 76/76 passed; [verification ledger](VERIFICATION.json).
  The Rho suite ran sequentially after the known parallel MCP test timeout.
- Evidence: `work/agent-activity/run-6/`, with exact binary/browser/input hashes
  and explicit source overrides. Earlier failures and visual reviews remain in
  the episode record. This demonstrates the flow, not human usability.
- Source selection: Agent 0.4.7, Tables 0.4.3, unchanged Core at
  `4f5bed8631e15acad44cc86b63ea4779ab8af342`. External sessions need an explicitly
  selected collector; the UI does not discover or start every native session.
  Native completion, producer attribution and scientific validity remain unknown
  unless their own evidence supplies them. Activity is not archived by workspace export.

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

New conversations select Agent 0.4.10's persistent Claude or Codex ACP connection. Rho holds
original message identities and the visible record; the plugin owns native
protocol/session behavior. Existing CLI conversations retain their original driver.
Rho MCP calls keep their project grant; native tools keep their Agent's permissions.
Only this machine's browser can answer a native permission request.

- The earlier [ACP episode](ACP-EPISODE.md) ran real Claude Code 2.1.311 through Westlake HPC
  (`westlakehpc/deepseek-v4.1-flash`): seven messages, Unicode read/write, the same
  ACP connection and MCP grant, lost acknowledgement, browser disconnection,
  confirmed cancellation, forced Agent loss, original-session load and Rho restart.
  An interrupted prompt stays unknown; Retry does not send it again. Reads start
  nothing. The foreground cancellation command exited; background jobs are separate.
- Checks: Rho 188/188 with the existing Core binary, Agent 80/80, generated contracts
  and builds pass. Agent 0.4.8 installs/imports outside the checkouts with its pinned
  ACP dependencies. Initial missing-binary/style failures remain in the episode.
- The base-R fixture packaging mismatch is fixed; its failed assembly is retained.
  A committed unsigned macOS arm64 candidate passes installed CLI/homepage and
  seven-turn ACP acceptance. The Agent-free package and focused ACP/CLI 5/5 pass.
- Core remains at `4f5bed8631e15acad44cc86b63ea4779ab8af342`, unchanged. Screens at
  1440/390 CSS pixels were inspected; automated paths do not establish human usability.
- The earlier [CLI episode](CONVERSATION-EPISODE.md) retains its measurements,
  failures and reviews. Raw Markdown display and the 64-method Agent grant ceiling
  remain open; conversation permission is local-person-only and consumes no grant slot.

## UI extension authoring

`rho-ui create`, `dev`, `check` and `build` provide a standalone author workflow.
A generated typed React package reads an existing capability through the public
UI contract. Its fixture preview supports state/width controls, props editing,
visible errors, a bounded call list and automatic refresh after source changes.
It receives no project credentials and starts no runtime.

An explicit `RHO_UI_EXTENSIONS` JSON selection pins installed package versions or
records local directory overrides. Rho generates the browser registry and registers
the same component/props/bindings metadata with the existing capability owner.
No application adapter or generated operation contract edit is needed. This path
adds views, not backend methods or runtime module injection. The default selection
is unchanged. [Plugin authoring](PLUGIN-AUTHORING.md) contains the executable guide.

- Then-current checks: Rho 174/174 unit tests, covering scaffolding without
  overwrites, pinned identities, reserved names, schema/path containment, real
  document bindings, unchanged grants and retained content after removal; server
  discovery never executes UI code. Chrome 155.0.8059.84 passed preview and
  installed-view checks at four widths, including loading/error/unbound states,
  props changes, Unicode, source refresh, splitting and reload, without starting a
  Host. An unsigned tarball installed outside the checkouts generated, built and
  previewed another package and launched with no Host left behind.
- Browser, package and document evidence is recorded under `work/plugin-dx/`.
  The tarball uses explicit local source overrides; it is not a signed release.

## Frontend reset

The user stopped the prior frontend work on 2026-10-25, removed all previous frontend
documents, rules and designs, and asked for a reconstruction from the work people
need to do. AGENTS.md and the documentation index no longer direct work through those
plans, and the superseded `work/` evidence is gone; Git retains their history.

The browser now has one project sidebar, dedicated Overview/Files/Activity/settings
sections, searchable projects and files, direct workspace controls and an optional
Agent inspector. There is no permanent Agent column or compressed run timeline;
execution records remain reachable from Activity and exact artifact provenance.
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

- `npm run build`: passed.
- The frontend reset passed 171 unit checks; current source checks are recorded above.
- Real Chrome 155.0.8059.84: project entry/creation, files, table, figure, layout,
  activity, settings, plugin catalog/detail and responsive dialogs passed at
  1440, 1024, 768 and 390 CSS pixels. The newer frontend, entry, pages, plugin,
  shell, actions, objects, continuity, document and person-files suites passed.
- Native browser input: real clipboard, Unicode, Chrome CDP IME composition,
  keyboard commands, modal focus containment and focus return passed. Real R
  execution: edited action input, one dispatch after a lost reply, stop
  confirmation, failure/repair, unknown outcomes, exact artifact provenance,
  explicit linked answers and partial exports passed through the rebuilt UI.
- Recovery: unsaved text and own undo survive tab/layout changes; shared selections
  survive re-layout; confirmed documents, layouts and contexts survive normal and
  sudden service exits, and reconnection reads without resubmitting work.
- An unsigned local development tarball installed and launched outside the source
  repositories with no development runtime overrides and no Host left behind,
  separate from a signed release or registry publication.
- Screenshots and detailed reports are retained locally under
  `work/frontend-reset/`; document rendering and link checks are recorded there.
  Previous frontend appearance acceptance is not inherited.

Checks use disposable projects and owned Hosts. The plugin repository's pre-existing
uncommitted `plugins/tables/src/ui.tsx` change was preserved; browser builds record
that local override. No component source was edited or published in this task.
The unit result for Plugins in the ledger remains historical, with its original date.

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
