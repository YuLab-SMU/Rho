# Rho status

Updated: 2026-10-25.

## Current development direction

The current discussion selects an adaptive research workspace: shared real objects,
stable interaction rules, constrained view changes and continuous human/Agent work.
[Interaction guidance](INTERACTION.md) defines eight interaction verbs, four levels
of workspace effect and separate operation/workspace/review evidence. It applies
Nielsen, Saarinen, Apple and SpaceX references as documented Rho design choices.
[Development](DEVELOPMENT.md) now uses episode briefs; the
[roadmap](ROADMAP.md#interaction-system-validation) prioritizes grammar, constrained
views, a base-R collaboration loop, recovery, domain validation and user observation.

The first base-R episode below now supplies concrete browser and external-Agent
evidence for this direction. It does not restore withdrawn designs or implement a
new proposal/decision API. The six experiments retain their individual completion
conditions; human usability remains unverified.

## Frontend design guidance

[Frontend design guidance](FRONTEND-DESIGN.md) now supplies the missing visual and
presentation direction, with primary references to Nielsen, Karri Saarinen and
Apple. It specifies hierarchy, layout, type/spacing/color baselines, components,
Agent context, paired comparison, recovery, responsive behavior and accessibility.
The development workflow requires distinct visual review alongside functional
checks and user observation. These are new targets; the withdrawn designs remain
withdrawn, and this documentation change implements no frontend behavior.

The current frontend has not passed this design acceptance. Repeated chrome,
competing controls and misaligned comparisons need correction. The first UI
implementation priority is the complete airquality episode under this guidance,
including constrained layouts, failure and return. Existing functional evidence
below remains valid within its recorded scope.

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

Next work remains external-write conflicts and broader unknown outcomes, a domain
episode, and researcher observation. This run does not establish Host crash
recovery, external model-session resumption or scientific validity. Sort/filter
controls keep their existing reload defaults; exact entity/version anchors persist.

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

- Rho 174/174 unit checks passed: [verification ledger](VERIFICATION.json).
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
Uncommitted pre-reset work is preserved locally in `work/frontend-reset/before/`.

The browser now has one project sidebar, dedicated Overview/Files/Activity/settings
sections, searchable projects and files, direct workspace controls and an optional
Agent inspector. The visual layer is rewritten across the app, workspace and plugin
catalog. There is no permanent Agent column or compressed run timeline. Existing
execution records remain reachable from Activity and exact artifact provenance.

The Agent request field uses an explicit clipboard handoff to the external Agent.
Its draft survives panel closure within this tab, scoped by principal/project.
Copying never claims delivery. Documents, selections, run identity and conditional
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
- External Claude Code integration and scoped capability discovery; no built-in model
  conversation. Explicit linked replies remain distinct from a context fetch.

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
