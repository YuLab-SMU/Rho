# Rho status

Updated: 2026-10-26.

## Current focus

The current deliverable is a [from-scratch product design brief](design/2026-10-26/index.html).
The user clarified that current implementation must not become the design target.
The brief requires separate application and project navigation, Studio, panoramic
Graph, a dynamic Agent experience, a dedicated conversation component and a shared
plugin design standard with professional differences. Implementation records below
remain capability evidence, not the target interface or design acceptance criteria.

| Part | Stage | Evidence | Next question |
| --- | --- | --- | --- |
| Execution identity, recovery and Documents buffers | Hardened | Owner and acceptance suites below | None in the current focus |
| Question → Agent → linked result | Runs; not yet usable from the screens | [Base-R episode](BASE-R-EPISODE.md) | Can the answer be read from one screen? |
| Comparing two results | Runs | Two views split by hand | Can the differences be read by key? |
| Conversation started in Rho | Runs | [Conversation episode](CONVERSATION-EPISODE.md) | Does a resumed message go straight to work? |
| Project shell and navigation | Runs | Frontend browser suite below | Does it hold up around the reworked episode? |
| Plugin UI extensions | Runs | Authoring checks below | Does a view built with it serve a real episode? |
| Domain episode (DESeq2) | Not started | — | What carries over from base-R? |

The interaction guidance, frontend design guidance and airquality interaction
specification written earlier on 2026-10-25 were withdrawn the same day at the
user's request. They fixed grammars, visual values, state sequences and acceptance
criteria before the application or its plugins had produced results to learn from.
Git retains them at `24d9998b`; they are not requirements or reference designs.

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

- Real final runs: Claude Code 2.1.310 and dsh 0.2.1-rc.2 through WestlakeHPC.
  Claude retained 7 pending / 10 final events; dsh retained 15 / 24. Each analysis
  entered once, showed diagnostic exit 7, and repeat collection added zero events.
- Chrome 155.0.8059.84 checked live pending, owned Host loss, reconnect, CSV/SVG
  opening, 1440/390 widths and reload. Independent means matched 11/3 and 8/3.
  The existing frontend regression passed all four of its widths.
  A rebuilt browser continuation checked both retained sessions after the final
  text-file wording/PDF refusal fix; repeated Open kept two views and one execution.
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

- `npm run build` passed; 19 targeted layout/live-workspace checks passed.
- `npm run acceptance:frontend` passed its existing browser regression.
- `npm run acceptance:base-r` passed from a fresh disposable project. The external
  Agent completed 46 turns in 223 seconds, within the 48-turn/ten-minute limits.
- Lost question acknowledgement plus reload/retry retained one exact question.
  Browser disconnection during execution plus explicit Reconnect retained the
  request digest, Core identity and native operation identity. Exactly two native
  submissions occurred: baseline and requested change.
- Chrome 155.0.8059.84 checked 1440, 1024, 768 and 390 CSS-pixel widths, including
  horizontal access to compared values, separate version selections, both PNGs,
  source lines and recovery of acknowledged unsaved notes. No browser exceptions.
- Final evidence is in `work/base-r-episode-20261025/accepted/`; diagnostic failures
  and browser-only continuations remain separate. The source composition and its
  local override are recorded, without a new binary or signed-release claim.

These checks show that the path works, not that a person can follow it; the
[review](BASE-R-EPISODE.md#review-of-the-2026-10-25-run) records where the screens
fall short and sets the next run. This run does not establish Host crash recovery,
external model-session resumption or scientific validity. Sort/filter controls
keep their existing reload defaults; exact entity/version anchors persist.

## Conversations started in Rho

The user decided on 2026-10-25 that whoever holds a session's input provides its
conversation entry. A person can now start a conversation with Claude Code in the
Agent panel, follow its steps and replies, reply, stop it, and return to it after a
reload or a service restart. Rho holds the input and the record and runs the
person's Claude Code for each message under a project grant like `rho --grant`.
Sessions started outside Rho keep their input in their own window; the panel lists
them and says where to continue. The [conversation episode](CONVERSATION-EPISODE.md)
records how it runs, its limits and the reviews of five real runs.

- Real runs used Claude Code 2.1.310 and Chrome 155.0.8059.84 at 1440 and 390 CSS
  pixels: four messages, a reload, a service restart, a conditional save checked
  on disk and a Stop confirmed by the process exit.
- The first question, "What is in this project?", went unanswered after 40 model
  turns because Agent grants left out every `project.*` operation. They now include
  the read-only `project.entries`, for sessions started outside Rho as well; the
  same question was then answered in 13 turns and 96 s. The root listing's empty
  `path` now matches its published contract.
- A resumed message goes straight to work. Each message is a new process, so the
  complete contracts a message resolved are kept beside the conversation's private
  connection and restored for the next one; the service still rechecks the current
  contract before a call and drops a superseded one. Message 2 fell from 5 model
  turns, 73 s and US$1.38 with a refused first call to 2 turns, 20 s and US$0.56.
- Rho selects the Agent plugin 0.4.6 that the Plugins checkout carries. With 0.4.4
  the plugin was unavailable, and so was `rho --grant`; with the descriptor left at
  0.4.5 while 0.4.6 was selected it was unavailable again, so the descriptor version
  moves with the package version.
- At that stage Rho 181/181 unit checks and Plugins 74/74 passed in one ledger run. `test/mcp.test.mjs` "real stdio MCP v2
  tools…" passed in it; that test has reached its 30 s limit in four of six earlier
  full runs on this machine and in one of two at the commit before, and alone it
  passes in 17.5 s. Rebuilding the 211 KB `capability.list` reply takes 430 MCP reads,
  the same number at both commits.
- Browser suites: `acceptance:frontend` passed once its local-tab Agent step became
  an unsent conversation message, with the clipboard handoff now checked in a real
  link tab; `acceptance:shell`, `acceptance:pages` and `acceptance:person` passed.
  `acceptance:ui` waits for a heading, "This link has already been used", that the
  application does not have at the previous commit either.
- Open: Agent text is shown as raw Markdown; each message costs more than the last
  because it resumes the whole session; the default Agent grant now has 64 methods,
  the layered limit, so the next Agent-visible operation would refuse every default
  grant. No person other than the builder has used it.

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

- Rho 174/174 unit checks passed at that time.
- New tests cover scaffolding without overwrites, pinned identities, reserved names,
  schema/path containment, real document bindings, unchanged grants and retained
  content after removing an extension. Server discovery never executes UI code.
- Chrome 155.0.8059.84 passed preview and installed-view checks at 1440, 1024, 768
  and 390 CSS pixels. Loading/error/unbound states, props changes, Unicode and
  source refresh passed. A separately packed and installed extension read the
  shared document and survived splitting and reload, without starting a Host.
- The default build and existing plugin presentation browser suite passed.
- An unsigned application tarball was installed outside the checkouts. Its
  production-only SDK generated, checked, built and previewed another author
  package with source refresh. The installed application also passed launch,
  four-width entry checks and shutdown with no Host left behind.
- Browser, package and document evidence is recorded under `work/plugin-dx/`.
  The tarball uses explicit local source overrides; it is not a signed release.

## Frontend reset

The user stopped the prior frontend work and requested removal of all previous
frontend documents, rules and designs, followed by a reconstruction from the work
people need to do. The old plans and visual specifications are removed, including
the UI/UX Notebook plan, visual replay prototype and E/M/R appearance rulers.
AGENTS.md and the documentation index no longer direct work through those plans.
The locally preserved pre-reset copy under `work/frontend-reset/before/` was
removed with the other superseded `work/` evidence on 2026-10-26 at the user's
request; it was never a requirement or a reference design.

The browser now has one project sidebar, dedicated Overview/Files/Activity/settings
sections, searchable projects and files, direct workspace controls and an optional
Agent inspector. The visual layer is rewritten across the app, workspace and plugin
catalog. There is no permanent Agent column or compressed run timeline. Existing
execution records remain reachable from Activity and exact artifact provenance.

In a tab opened from a narrower link, the Agent request field uses an explicit
clipboard handoff to the external Agent; a tab on this machine holds conversations
started in Rho instead. The draft survives panel closure within this tab, scoped by
principal/project. Copying never claims delivery. Documents, selections, run identity and conditional
writes keep their actual owners. The frontend does not invent Notebook capabilities.

## Direct browser access

Opening the loopback url in a browser on this machine is now the access. A same-origin
request that carries no credential is authorized as the local person with the reviewed
browser scope, no link, no one-time code and no expiry; Host, Origin and a browser's own
cross-site marking are still checked on every request. A credential that is present must
still be valid, so a stale or forged one is refused rather than silently widening to
local access, and the machine's own identity is not a revocable session.

`rho --pair` still mints a one-time, five-minute link for a tab that must be narrower —
one folder below the service root — or must expire. That path, its single-use redemption
and its expiry are unchanged. The browser no longer starts on a gate asking for a link: a
link that cannot be used leaves the page working as this machine and says so, and
switching from a link to this machine forgets only the credential, keeping open projects,
unsaved edits and running work.

The tradeoff is explicit: any process running as this user can call the loopback API
without a credential, which the readable operator connection file already allowed. This
change was not verified against human usability, physical IME behaviour or distribution.

## Verification of this reconstruction

- `npm run build`: passed.
- The frontend reset passed 171 unit checks; current source checks are recorded above.
- Real Chrome 155.0.8059.84: project entry/creation, files, table, figure, layout,
  activity, settings, plugin catalog/detail and responsive dialogs passed at
  1440, 1024, 768 and 390 CSS pixels. The newer frontend, entry, pages, plugin,
  shell, actions, objects, continuity, document and person-files suites passed.
- Native browser input: real clipboard, Unicode, Chrome CDP IME composition,
  keyboard commands, modal focus containment and focus return passed. A portalled
  Agent panel focus escape found during this work was fixed and rechecked.
- Real R execution: edited action input, one dispatch after a lost reply, stop
  confirmation, failure/repair, unknown outcomes, exact artifact provenance,
  explicit linked answers and partial exports passed through the rebuilt UI.
- Recovery: unsaved text and own undo survive tab/layout changes; shared selections
  survive re-layout; confirmed documents, layouts and contexts survive normal and
  sudden service exits. Reconnection reads without resubmitting work.
- An unsigned local development tarball passed installation and Chrome launch outside
  the source repositories, with no development runtime overrides and no Host left
  behind. Its composition records the selected Core and local source overrides;
  this is separate from a signed release or registry publication.
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
The three source repositories remain independently owned. No Core behavior or
functional component API was changed by the frontend reconstruction.

## Delivery scope and limits

The current source targets the local browser application on macOS arm64. Source
checks, accepted package composition, installation and official distribution are
separate evidence. npm registry publication, native desktop windows, official
signed distribution, additional platforms and physical IME usability are not
established by this frontend change. Human usability has not yet been evidenced.

[Frontend](FRONTEND.md) describes the current implementation. [Release](RELEASE.md)
describes source publication and the separate future distribution milestone.
