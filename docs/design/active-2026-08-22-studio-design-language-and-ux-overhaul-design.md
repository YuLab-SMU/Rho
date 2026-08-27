# Studio Design Language And UX Overhaul

Status: active implementation contract; proposed and owner-authorized
2026-08-22; WP0-WP5 complete; WP6 automated implementation present but its
manual interaction acceptance was rejected by the owner; WP6-R1 implementation
and automated/browser verification are complete, with owner feel acceptance
open on the exact rebuilt local application; WP11 Source-to-Console execution
continuity implemented and automated/real-Monaco verified 2026-08-22, with
owner exact-app selection feel acceptance open; WP12 user-triggered component
emergence implemented and automated/real-Monaco verified 2026-08-22, with
owner exact-app emergence feel acceptance open; WP13 residual-space resizing
and Console result projection implemented and automated/exact-app verified
2026-08-22, with owner feel acceptance open; WP14 remaining-component
optimization program owner-authorized 2026-08-22, with WP14-A Agent and
Environment focus-first interaction implemented and verified 2026-08-22 and
WP14-B scientific history/review Surface projection implemented and verified
2026-08-22; WP14-C shared state/extension alignment and human-labelled adaptive
recovery implemented and verified 2026-08-22. Owner feel acceptance remains
open; WP15 complete-R-expression execution and History correction implemented
and automated/browser/debug-app verified 2026-08-23, but owner interaction
rejected its empty-line navigation and generic Runtime failure projection;
WP15-R1 repair implemented and automated/browser verified 2026-08-23; the
newest raw debug binary is rebuilt and launched, with owner exact-app
interaction acceptance open. WP16 whole-workbench reliability architecture
and every-component optimization owner-authorized 2026-08-23; WP16-A
development identity and real-interaction harness implementation/automated
acceptance complete, exact live-window acceptance open because two pre-existing
debug processes remain; WP16-B1 frontend failure/operation-trace/invalidation
boundary complete; WP16-C1 Source-to-Console execution router extraction
complete; WP16-C2 project-switch transaction controller complete; WP16-C3
Console execution/persistence controller complete; WP16-C4 component-
requirement controller complete; WP16-C5 Studio mutation controller complete;
WP16-C6 common Surface mutation boundary complete; WP16-C orchestration phase
complete; WP16-D1 and WP16-D2 component-matrix/navigation/mode/error-state
presentation slices complete; WP16-D3 Vibe/Compose/status/developer and 200%
zoom optimization complete; WP16-E automated integration and post-
implementation review complete. Its original exact raw-debug-window identity
gate remained open at that checkpoint because two pre-existing debug processes
were preserved; owner feel acceptance remains open. WP16-R1 one-command debug
restart later closed that exact-window identity gate and was implemented and
verified 2026-08-24. WP8-R1 narrow Navigator reachability and WP16-R3 project-transition
epoch repair implementation plus merged-candidate automated/visual verification
passed 2026-08-27 under their bounded owning contracts.
Studio Agent Surface presentation rounds 1-3 also completed under
`plans/implemented-2026-08-27-studio-agent-surface-ux-spec.md`; that component-
internal contract does not move the broader Studio design or owner-feel gates.

Date: 2026-08-22

Change class: D3 because this contract defines a shared visual language and the
default Studio scene composition that every Surface, workspace plugin, and
future component inherits. Risk: R1 for presentation-only packages (WP1, WP2,
WP5, WP4) and R2 for WP3 where the kernel default-scene bootstrap and the
generated contract fixtures change together.

Authorization record: the project owner instructed "begin optimizing the
frontend; the design in `UI-design/` is the initial direction" on 2026-08-22
and approved the staged WP0-WP5 execution plan in the same session. The
document is created directly with the `active-` prefix; the proposal,
cross-review, and authorization facts are recorded in this single documentation
change per governance §4.

WP6-R1 authorization record: after trying WP6, the owner reported on
2026-08-22 that components still could not be moved freely and asked for the
interaction to be redesigned and improved. This authorizes one D1/R1 repair
slice inside the already-active visual contract. It does not authorize
floating windows, a new Scene edit, schema, persistence, broker, or Tauri
surface.

WP11 authorization record: after reviewing the rebuilt Source editor and
Console, the owner explicitly requested RStudio-like execution of the code on
the cursor line into the Console. This authorizes one D2/R2 continuity package
that restores the already-implemented WP2 selection/current-line behavior over
the accepted multi-instance Surface Runtime. It does not authorize smart R
statement/block inference, whole-file execution, a new Runtime command,
execution payload, schema, parser, or persistence owner.

WP12 authorization record: after exercising WP11 with the Console placement
closed, the owner rejected the passive "No visible R Console" recovery and
explicitly requested component auto-emergence so a required component appears
in an appropriate place. This authorizes one D2/R2 trusted-shell orchestration
slice for the existing Source Run requirement. It does not authorize
background component creation, implicit Runtime creation, arbitrary plugin
activation, a new Scene edit, schema, persistence owner, broker command, or
cross-project component reuse.

WP13 authorization record: after exercising the rebuilt Source/Console layout,
the owner reported that a large unused region could not be assigned by dragging
the adjacent component boundary and that Console exposed an almost unrendered
Workspace bridge JSON envelope. This authorizes one bounded D2/R2 repair slice:
make one eligible work-area child consume otherwise unclaimed container space
without changing the persisted Scene grammar, and project existing Runtime
events into a human-readable Console transcript. It does not authorize a new
Scene edit, schema, Tauri/Rust command, execution payload, output persistence,
artifact viewer, terminal emulator, or release operation.

WP14 authorization record: after guiding the Navigator/file/Console component
repairs, the owner explicitly delegated autonomous optimization of every
remaining component and permitted current-design research through AnySearch.
This authorizes the staged WP14 program below. Governance still requires one
reviewable integration checkpoint at a time; WP14-A, WP14-B and WP14-C were
therefore activated only after the preceding checkpoint remained buildable,
verified and reconciled. The delegation does not authorize new backend
commands, schema, scientific/environment mutation authority, plugin permission,
release, signing or distribution work; any such need stops and amends the
contract first.

WP15 authorization record: after exercising Command+Enter inside a complete
multi-line R call, the owner observed that the physical cursor line was sent in
isolation and failed parsing. The same Source-origin execution was durably
presented as a Console command, and the owner rejected the Runs product name in
favor of History. This authorizes one D2/R2 correction across the existing
Source → Console → Runtime request and read-only run-history projection. It
does not authorize a new execution command, R parser service, schema/table,
retry policy, retention rule, project path authority or execution owner.

WP15-R1 authorization record: the owner exercised the rebuilt debug app and
reported that sequential Command+Enter stopped on script gaps with an
empty/incomplete toast, while a later rejected Runtime operation collapsed to
the generic `Runtime operation failed` message. This rejects WP15 interaction
acceptance and authorizes one bounded R2 defect repair over cursor navigation,
Console view-state sequencing, existing Runtime error projection and existing
invalidation subscriptions. It does not authorize a new Runtime/History
command or event, implicit restart, schema, retry policy, parser service,
project authority, execution owner or historical-record rewrite.

WP16 authorization record: after reviewing the structural audit, the owner
explicitly instructed Rho to begin construction, complete the overall
optimization, and re-optimize every current component. This authorizes one
continuous D3/R3 reliability and interaction program over the trusted shell,
frontend module boundaries, transport/error/invalidation projection, debug
identity, deterministic fault injection, browser/exact-app evidence, and all
first-party Surface presentations. The work remains staged at mandatory
reviewable checkpoints; only WP16-A is initially active. The authorization
does not weaken the RSR project/revision/permission owners, grant plugins raw
DOM/CSS/geometry authority, change scientific truth, add implicit Runtime or
filesystem authority, publish a release, sign/package an application, or
guess historical ownership.

WP16-R1 authorization record: after the safe launcher rejected two live
same-checkout debug processes and required manual PID/window maintenance, the
owner explicitly required one-command startup and rejected maintaining that
process lifecycle by hand. This authorizes one bounded R2 developer-workflow
repair: `npm run rsr:dev:desktop` may request termination of exact current-
checkout debug processes, wait for confirmed exit, then perform its existing
build/identity/start sequence. It must never signal a foreign-path installed
Rho process, use an ungraceful/force-kill fallback, conceal a timeout or signal
failure, or broaden product shutdown, persistence, release or installer
authority.

WP16-R3 authorization record: a release-blocking integration review found that
the debug acceptance bridge drained Store mutations before project switching,
while the ordinary Workbench path did not close frontend admission or quiesce
the Studio/Surface queues. A late project-A Surface rejection could therefore
repopulate the global action error after B or a same-root A2 activation was
installed. The owner's existing emergency-correction and no-shortcut
construction authorization activates the bounded D3/R3
PROJECT-TRANSITION-EPOCH-1 repair. WP16-R3 owns only session-local
frontend admission, queue quiescence, and epoch-scoped error presentation at
the composition root. BH2 keeps project transaction outcomes and restoration;
RSR/Studio/Profile/Runtime/Resource/Agent owners keep every identity, revision,
CAS, mutation, permission, and recovery contract. The epoch is ephemeral and
adds no schema, command, retry policy, cancellation, persistence, credential,
approval, release, or backend authority.

WP16-R3 closure record: the bounded repair is implemented under
`plans/implemented-2026-08-27-project-transition-epoch-repair-spec.md`. The
final App suite passed 133/133, the frozen merged source passed the complete
stable frontend matrix (76 Vitest files / 578 tests) and locked Rust matrix,
and its immutable S0/S3/S9 run passed 35/35 gates with 31/31 frames reviewed.
This closes WP16-R3 only; the Studio contract's separately recorded raw-window
and owner-feel acceptance items remain open.

## Problem And Evidence

The Rho Surface Runtime (RSR) replaced the legacy fixed IDE shell with a
trusted-kernel plugin architecture
(`accepted-2026-08-21-plugin-native-surface-runtime-design.md`,
`plans/implemented-2026-08-21-rsr-full-construction-plan.md`). The architecture
is complete, but the visual layer is still the engineering skin grown during
construction:

- one hand-written stylesheet
  (`desktop/ui/src/styles/foundation.css`, 518 lines) with seven token
  variables and dozens of ad-hoc hard-coded colors;
- interface text down to `0.46rem` (~7px), below readable product sizes;
- mixed type voices (system sans, Georgia serif for agent answers/file cards,
  ui-monospace) without a rule;
- a teal accent palette (`#087e64`) plus per-state hard-coded status colors
  (`#079976`, `#d18428`, `#c34c42`) with no semantic scale;
- internal debugging vocabulary (revision numbers, instance ids, generation
  counters) surfaced in chrome and footers;
- a dense left "Compose inspector" as the permanent left rail, exposing layout
  internals as the primary navigation object.

The owner-provided design direction (`UI-design/`, four sheets, 2026-08-22)
defines the target: a monochrome ink-on-paper workbench with measured geometry,
a complete component state catalog, layout behaviors that match the accepted
RSR container grammar, and a six-state runtime status language.

## Goals And Non-Goals

Goals:

- define one design language (tokens, type, geometry, component states, status
  language) that the trusted kernel enforces and every Surface inherits;
- rebuild the workbench frame (56px top bar, 28px status bar, 240-340px
  navigator, 340-520px context stack) per sheet 1;
- recompose the default Studio scene per sheets 1 and 3 while preserving the
  accepted recursive container grammar and per-instance Surface behavior;
- implement the component state catalog (sheet 2) and the runtime state
  language (sheet 4) with existing kernel state;
- keep browser/mock and Tauri behavior aligned throughout, verified by the
  existing mechanical checks.

Non-goals:

- no Surface contract, plugin permission, Wasm ABI, command registry, or
  kernel state-machine changes;
- no dark theme, no multi-platform/release/signing work, no responsive
  redesign beyond the existing breakpoints;
- no new Tauri commands in WP1-WP3; if the Project Navigator file listing
  proves impossible over existing commands, that capability becomes a
  separately gated follow-up;
- no rewrite of `App.tsx` architecture; visual work is CSS-first with minimal
  structural edits;
- legacy old-shell compatibility is not restored or referenced.

## Authority And Ownership

This document owns:

- the Studio design language: color tokens, type scale, spacing scale, radius,
  borders, elevation, focus treatment, target sizes;
- component presentation and state catalog for the trusted shell and the
  default styling that plugin Surface documents inherit;
- the workbench frame geometry (top bar, status bar, default three-column
  scene) and the default Scene seed composition;
- the visual vocabulary of the runtime status language (sheet 4).

This document explicitly does not own:

- Surface/Command/Studio/Scene/Vibe contracts, the layout graph schema,
  revision/CAS semantics, focus authority, accessibility behavior, or theme
  *behavior* — those remain with
  `design/accepted-2026-08-21-plugin-native-surface-runtime-design.md`;
- plugin identity, permission, lifecycle, or contribution contracts — those
  remain with the implemented Phase 2 documents;
- runtime/agent/environment domain data or mutation lanes;
- release, signing, updater, or distribution decisions.

Relationship to prior visual owners:

- `plans/proposed-2026-07-26-interface-modernization-plan.md` owned "visual
  tokens, icons, component presentation, responsive behavior, themes" as a
  proposed umbrella whose Phase 4 was never authorized. This document
  supersedes that umbrella's unauthorized Phase 4 for the RSR shell; the
  umbrella remains proposed for any pre-RSR claims it still records.
- The M1-M3 specs (`active-2026-08-04-interface-modernization-*-spec.md`)
  implemented semantic tokens and shell hierarchy for the **deleted** legacy
  shell. Their installed-app/display-scale acceptance gates stay open and
  unchanged; where their token values conflict with this language, this
  document wins for the RSR shell.
- `design/ux1-interaction-inventory.md` inventories the deleted `app.js` shell
  and remains an intent-history reference, not a current-state map; this
  document does not amend it line by line.

## Current Behavior

- Styling: single `desktop/ui/src/styles/foundation.css`
  (`@layer reset, tokens, studio`), imported once from
  `desktop/ui/src/main.tsx`; Monaco ships its own CSS; no other stylesheet.
- Chrome: top bar (`desktop/ui/src/app/App.tsx` `rho-studio-bar`), permanent
  left Compose inspector (`rho-studio-inspector`), layout tree with stacks,
  resize handles, collapse rail, Surface chrome/footer, dark-teal Console
  (`rho-console-surface`), Agent panel, ten generic domain Surfaces
  (`DOMAIN_SURFACE_IDS`), status strip as an in-layout `rho.status` Surface.
- Default Scene is data: mock seed in
  `crates/rho-ui-contract/src/fixture.rs` (`scene:rho-studio`), real bootstrap
  in the kernel/store path, generated TS fixtures via
  `scripts/generate-rsr-contract-fixtures.mjs`.
- Fast iteration loop: `npm run rsr:dev` (Vite + mock transport, HMR);
  full check `npm run rsr:check` (typecheck, lint, contract parity, vitest,
  build, asset freshness, headless Chromium smoke).

## Design Language

Source of truth: `UI-design/` sheets 1-4. Where a sheet is silent, the token
table below is normative.

### Color

Monochrome ink on paper. Functional color is reserved for status semantics and
is never the only carrier of meaning (icon + label accompany it).

| Token | Value | Use |
| --- | --- | --- |
| `--rho-ink` | `#1b1b1b` | primary text, strong borders |
| `--rho-ink-2` | `#4a4a4a` | secondary text |
| `--rho-muted` | `#767676` | tertiary text, disabled |
| `--rho-line` | `#d9d9d9` | hairline borders |
| `--rho-line-strong` | `#1b1b1b` | active/selected borders |
| `--rho-paper` | `#ffffff` | surface background |
| `--rho-panel` | `#fafafa` | panel background |
| `--rho-canvas` | `#f0f0f0` | workbench canvas between surfaces |
| `--rho-fill` | `#efefef` | hover fill |
| `--rho-fill-2` | `#e4e4e4` | pressed fill |
| `--rho-inverse` | `#1b1b1b` | selected/primary fill (white text on it) |
| `--rho-ok` | `#1e7f4f` | ready/success status only |
| `--rho-warn` | `#9a6a00` | busy/degraded status only |
| `--rho-danger` | `#b3261e` | failed status only |

Selected states use shape + weight + the inverse fill, never color alone.
Warning/failure panels use the ink border + icon + label, optionally a hatched
or tinted paper background at ≤4% functional color; the saturated warning
banners of the construction skin are retired.

### Typography

| Token | Value | Use |
| --- | --- | --- |
| `--rho-font-ui` | system sans stack | all interface text |
| `--rho-font-mono` | ui-monospace stack | code, console, diagnostics |
| `--rho-font-doc` | Georgia, serif | Vibe long-form document body only |
| scale | 11 / 12 / 13 / 15 / 17 / 20 / 24 px | 12px is the default UI size; 11px only for meta captions; nothing below 11px |

Weights: 400 regular, 500 medium, 650 semibold. Eyebrow labels use 11px,
uppercase, +0.08em tracking, `--rho-ink-2`.

### Space, Radius, Borders, Elevation

- spacing scale: 2 / 4 / 8 / 12 / 16 / 24 / 32 px (`--rho-space-1..7`);
- radius: 3px controls, 6px cards/surfaces (`--rho-radius-1/2`);
- borders: 1px `--rho-line`; selected/active 1px `--rho-line-strong`;
- elevation: one shadow only, `0 8px 24px rgb(0 0 0 / 12%)`, for floating
  menus/dialogs; no decorative shadows on docked surfaces.

### Interaction Geometry (sheet 2)

- focus: 2px solid `--rho-ink` ring + 2px offset, never color-only;
- pointer targets: 28×28px minimum, 36px preferred for primary actions;
- busy: visible label, stable width, cancel remains reachable;
- reduced motion: no animated displacement (existing
  `prefers-reduced-motion` block is preserved).

### Workbench Geometry (sheet 1)

- top bar: 56px; status bar: 28px, fixed, not an in-layout Surface;
- navigator column: 240-340px; context column: 340-520px;
- window chrome, tabs, and stacks follow the sheet 1 measurements; minimum
  supported workbench width remains governed by existing breakpoints.

### Component State Catalog (sheet 2)

Ten component families, each with REST / HOVER / FOCUS / SELECTED (or ACTIVE) /
PRESSED / DISABLED / BUSY / ATTENTION states as applicable:

1. select / menu trigger (incl. OPEN with listbox);
2. segmented choice (Studio/Vibe);
3. primary action (Run → Running → Stop);
4. secondary action (Source);
5. icon button (28×28px minimum; +, ×, attachment, send glyphs);
6. tab (closable; ATTENTION dot variant);
7. navigation row (file rows with MODIFIED dot);
8. text link (Diagnostics);
9. input / command field (empty, hover, focus, filled, results-open, invalid);
10. resize separator (rest, hover, dragging, keyboard focus, constrained).

### Runtime Status Language (sheet 4)

Six workbench states, all monochrome-first with functional status color only
on the status dot/icon: Ready; Console Busy (progress affordance, Stop
reachable); Agent Running (elapsed time, Stop, status line); Agent Dependency
Failure (banner + copy-ready diagnostic detail); Workspace R Recovering
(overlay + Cancel restart + Open diagnostics); Plugin Surface Unavailable
(placeholder card + Retry + Close Surface). Fault categories use the sheet 4
icon legend (missing package, old version, namespace failure, incompatible
API, credential/network).

## User-Visible Behavior By Work Package

### WP0 — governance (this document)

This document, its cross-review matrix row, and the `docs/README.md` entry.

### WP1 — tokens and stylesheet architecture

- split `foundation.css` into `desktop/ui/src/styles/`: `tokens.css`,
  `base.css`, `workbench.css`, `components.css`, `surfaces.css`, one imported
  entry; `rho-*` class names stay stable; no `App.tsx` structural change;
- replace every hard-coded color and sub-11px size with tokens; Console
  becomes paper-light with monospace ink; Monaco uses the light theme;
- stop point: `npm run rsr:check` green; mock screenshots at desktop and
  narrow widths.

### WP2 — component state catalog

- implement the ten families and their states in `components.css`;
- minimal className/markup adaptation in `App.tsx`
  (`rho-btn`, `rho-btn-primary`, `rho-icon-btn`, segmented, tabs, nav rows,
  links, inputs, separators);
- stop point: `npm run rsr:check` green; keyboard walkthrough of focus ring;
  plugin surface blocks inherit the language.

### WP3 — workbench frame and default Scene

- rebuild the top bar to 56px: brand wordmark, project menu, Studio/Vibe
  segmented control, scene select + overflow menu, command field (⌘K
  affordance), `R ready` status, Run primary action;
- add the fixed 28px status bar: Workspace R / Agent readiness, task count,
  Diagnostics link; the in-layout `rho.status` placement leaves the default
  Scene but keeps rendering for saved scenes;
- left Project Navigator (Files / Runs / Artifacts tabs + Recent outputs)
  composed from existing resource/domain data — no new Tauri command;
- right context stack: Agent / Environment tabs;
- default Scene seed (kernel bootstrap + `fixture.rs` mock seed) becomes
  navigator | document stack + console | context stack; regenerate contract
  fixtures; saved user scenes are untouched (layout schema unchanged);
- Compose inspector becomes an on-demand overlay from the top bar;
- stop point: `npm run rsr:check` green; three-viewport mock captures;
  `npm run rsr:build` + `target/debug/rho-desktop` real-window walkthrough.

### WP4 — runtime status language

- present the six sheet-4 states from existing kernel/store state: Console
  Busy with progress + Stop, Agent Running with elapsed + Stop, dependency
  failure banner with copy-ready diagnostics, Workspace R recovering overlay,
  plugin Surface unavailable with Retry/Close;
- pure presentation; any missing field requires a contract amendment and its
  own gate;
- stop point: deterministic mock scenarios for each state; `npm run rsr:check`.

### WP5 — Vibe and plugin alignment

- Vibe page/chrome adopt the tokens (document body keeps `--rho-font-doc`);
- all `.rho-plugin-*` block styles move to tokens so third-party plugin
  Surfaces inherit the language automatically;
- stop point: `npm run rsr:check`; `?mode=vibe` and `?plugin=surface`
  captures.

## State, Persistence, And Compatibility

- WP0-WP6 add no schema, persistence, revision, or approval change. Their only
  data change is the default Scene seed composition for new/reset Scenes;
  saved user Scenes deserialize unchanged because the layout grammar is
  unchanged. WP7's versioned device-local toolbar preference is the explicit
  exception described in that work package; it never enters Project UI
  Profile or project-authoritative data.
- The `rho.status` Surface stays registered; only its placement in the
  default Scene changes.
- Contract fixtures are regenerated by the documented script; parity tests
  must pass.

## Failure And Recovery Behavior

Unchanged. WP4 only re-presents existing kernel-reported failure/recovery
states (runtime failed/restarting, agent degraded, surface failed) using the
sheet 4 vocabulary; it adds no new failure classes and hides no existing
diagnostic.

## Verification Matrix

Automated (per affected package):

- `npm run rsr:check` (typecheck, eslint, contract parity, vitest, build,
  asset freshness, headless Chromium smoke) — required at every stop point;
- `cargo test --workspace --locked` focused subsets when WP3 touches
  `rho-ui-contract` fixtures;
- `git diff --check`.

Manual (recorded as captures, not claims):

- mock captures at 1920×1080, 1024×680, 900×700 after WP1, WP3, WP5;
- keyboard-only walkthrough of the component catalog after WP2;
- real debug-window walkthrough (`target/debug/rho-desktop`) after WP3.

Browser/mock parity remains mechanically enforced; any new visible state must
exist in `desktop/ui/src/transport/mock.ts` the same round.

## Acceptance Gate And Definition Of Done

Each work package: scope implemented without contract drift; `rsr:check`
green with recorded output; captures archived under the package's evidence
note in this document's handoff section; version/NEWS decision recorded;
residual risks explicit. The contract stays `active-` while WP4/WP5 and the
real-window manual acceptance remain open.

## Version, NEWS, And Release Impact

- The first integrated user-visible candidate bumps the application version
  (`Cargo.toml`, `desktop/src-tauri/tauri.conf.json`) from `0.4.1-dev.13` to
  `0.4.1-dev.14` with a `NEWS.md` Improved entry; one reviewed candidate, one
  bump.
- R package versions are unaffected (no R change).
- No release, signing, installer, updater, or distribution authority; local
  macOS iteration only.

## Handoff And Evidence

### WP1 — tokens and stylesheet architecture (complete 2026-08-22)

- `foundation.css` is now an import aggregator over `tokens.css`, `base.css`,
  `components.css`, `workbench.css`, `surfaces.css`
  (`desktop/ui/src/styles/`); `rho-*` class names unchanged; no `App.tsx`
  structural change in this package.
- All hard-coded colors and sub-11px sizes replaced by tokens; Console is
  paper-light with monospace ink; Monaco stays on the light `vs` theme.
- Evidence: `npm run rsr:check` green (typecheck, lint, contract parity, 42
  vitest tests, build, asset freshness, headless Chromium smoke); mock
  captures at 1600×1000 and 900×700 and `?mode=vibe`.

### WP2 — component state catalog (complete 2026-08-22)

- `components.css` implements the ten sheet-2 families: default/primary/icon
  buttons (28px minimum, 36px primary), segmented choice, closable stack tabs,
  navigation rows with modified dot, text links, inputs with invalid state,
  menu trigger/panels, resize separators (hover/drag/keyboard-focus states),
  busy spinner that keeps width stable.
- `App.tsx` minimal adaptation: stack tabs gained a close control committing
  the existing `close_surface_placement` edit; Surface chrome `×` is an icon
  button. Regression test: tab close commits the exact edit and keeps the
  sibling instance mounted.
- Evidence: `npm run rsr:check` green (43 tests); mock captures.

### WP3 — workbench frame and default Scene (complete 2026-08-22)

- Top bar rebuilt at 56px: wordmark, project identity, Studio/Vibe segmented,
  Scene select + overflow menu, command field with ⌘K hint and global ⌘K/Ctrl-K
  focus shortcut, workspace health, `Check project` primary action at 36px,
  Compose toggle.
- Fixed 28px status bar: workspace/agent readiness, task count, Diagnostics
  link (opens the Problems Surface), project path. The in-layout `rho.status`
  strip leaves the default Scene but still renders for saved Scenes.
- New first-party Surface `rho.navigator` (Files/Runs/Artifacts tabs + Recent
  outputs): registered in `desktop/src-tauri/src/main.rs`, seeded by
  `ui_profile.rs`, added to the contract fixture and mock, rendered by
  `desktop/ui/src/app/Navigator.tsx`. Files come from `resource_list`
  (`project_file` kind) — no new Tauri command. Opening a file inserts the
  File Source into the center document container (existing `insert_surface`
  edit); Runs/Artifacts/Recent reuse the existing domain-record lanes.
- Default Scene (kernel seed + fixture + preset) is now
  navigator | center (documents + console) | context stack (agent,
  environment); saved user Scenes are untouched (schema unchanged, seed data
  only). Compose inspector is an on-demand overlay.
- Contract fixtures regenerated via
  `scripts/generate-rsr-contract-fixtures.mjs`; parity tests updated where the
  fixture scene shape was asserted.
- Evidence: `npm run rsr:check` green (43 frontend tests including a Navigator
  placement test); `cargo test -p rho-ui-contract --locked` 49 passed;
  `cargo test -p rho-desktop --locked` 321 passed (catalog assertions updated
  to 17 factories); mock captures at 1600×1000 and 1024×680.
- Real-window evidence (`target/debug/rho-desktop`, 2026-08-22): a fresh
  project (`/tmp/rho-fresh-project`) boots into the new three-column Scene and
  the Navigator lists the real `analysis.R`; a previously saved Scene restores
  unchanged; the UI-Profile backup recovery path surfaces its banner; the
  status bar shows truthful live states.
- Observation (not a regression): with one recovered legacy profile a generic
  "Runtime operation failed." toast appeared once from a pre-existing
  `reportError` fallback while its backend log stayed clean; it did not
  reproduce with the fresh profile. Watch item for WP4 runtime-state work.
- Deviations recorded: the Files tab groups nested paths into collapsible
  folders when the registry exposes them, but does not scan the raw
  filesystem beyond registered `project_file` resources; the Compose
  inspector is an overlay rather than a docked rail.

### WP3 stop-point review (2026-08-22)

Reviewed against this contract: frame geometry, default Scene composition,
navigator data lanes, compatibility of saved Scenes, and the verification
matrix are accepted as implemented. **WP4 and WP5 are activated.**

### WP6 — Studio layout direct manipulation (manual acceptance rejected 2026-08-22)

- Drag sources: Stack tabs and the Surface chrome title region; every placed
  pane offers four edge zones (split) and a center zone (stack); Stack tab
  strips stack onto the hovered tab; a live drop indicator previews the zone.
- Commit model: `computeStudioDrop` (`desktop/ui/src/transport/studio-model.ts`)
  computes the next Scene locally (matching-axis insert, axis-mismatch split
  wrap, center stack, same-stack reorder, self/no-op, lone-root wrap) and the
  drop commits one atomic `replace_root` through the revisioned `studio_apply`
  lane. No new contract edit kind, Tauri command, schema, or persistence
  change; undo/redo treat a drop as one ordinary scene mutation.
- Evidence: 7 pure `computeStudioDrop` unit tests; 2 App-level simulated-drag
  tests (stack via pane drop commits `replace_root` and renders the merged
  tabs; self-drop is a no-op); `npm run rsr:check` green (54 tests);
  real-window launch on the debug candidate renders the frame and layout
  engine unchanged. This evidence proved the Scene transform and synthetic
  HTML drag events, but not a complete physical pointer transaction. The owner
  subsequently rejected the manual interaction: active tabs could not detach
  against their own Stack edge, targets appeared only after an implicit hit,
  and tab drops did not expose an exact insertion position.
- NEWS: recorded under the same un-committed `0.4.1-dev.14` candidate.

### WP6-R1 — continuous pointer docking (implemented; owner feel acceptance open)

Problem/invariant:

- Native HTML `draggable` delegates the session to the host WebView and the
  existing synthetic `DragEvent` tests do not cover the user's real
  pointer-down → move → release path. A Studio move must instead remain a
  shell-owned pointer transaction from threshold crossing through commit or
  cancellation.
- Self-drop rejection applies to stacking an instance onto itself, not to
  tearing the active member out of its current Stack at that Stack's edge.
- A tab-strip drop must expose and preserve an exact before/after insertion
  position; it must not silently append to the end.

Authorized behavior:

- Replace native HTML drag events for Studio tabs and Surface titles with one
  pointer session owned at the workbench level. A short movement threshold
  preserves ordinary click/selection. After activation, the session follows
  the pointer across nested containers and resolves the target beneath the
  pointer independent of event bubbling from Surface contents.
- While active, render a compact drag ghost and a five-position docking guide
  over the hovered pane. The selected left/right/top/bottom region previews
  the resulting split half; center previews stacking. Hovering a tab shows a
  before/after insertion marker. Invalid space remains visibly non-committal.
- Pointer release commits at most one existing atomic `replace_root` edit.
  `Escape`, pointer cancellation, window blur, lost source, invalid target,
  and self-stack release commit nothing and restore all transient UI state.
- Pointer events support mouse, pen, and touch-capable WebViews. The existing
  Compose inspector remains the keyboard-complete fallback; this repair adds
  no persistence or authority to the drag layer.

Acceptance gate:

- pure tests cover active-tab tear-out, exact cross-Stack and same-Stack tab
  insertion, structural no-op rejection, and unchanged edge split semantics;
- App interaction tests use pointer down/move/up (not synthetic HTML drag) to
  prove thresholded click preservation, one cross-pane commit, active-tab
  tear-out, exact tab insertion feedback, and Escape/pointer-cancel no-commit;
- drag position updates are animation-frame paced, only target transitions
  update React state, and persistence occurs only on release;
- `npm run rsr:check` and `git diff --check` pass; browser/mock parity remains
  unchanged because no command or durable state is added;
- the work package stops after automated/browser verification. Owner feel
  acceptance on the exact local build remains a separate fact and this
  section must not be marked complete before that walkthrough.

Cross-review: the accepted Surface Runtime design retains Scene grammar,
revision/CAS, focus, and accessibility authority; the RSR construction plan's
frame-paced preview and one-durable-mutation rule remains binding. This
document owns only the trusted shell gesture and visual feedback. No schema,
approval, project identity, persistence, plugin, Runtime, Resource, or domain
ownership overlaps were found.

Version decision: WP6-R1 repairs behavior already advertised by the still
uncommitted `0.4.1-dev.14` candidate, so it does not allocate another version
or R package bump. `NEWS.md` must describe the accepted pointer behavior rather
than the rejected native-drag implementation.

Implementation/evidence (2026-08-22):

- `StudioPointerDrag.tsx` owns one thresholded Pointer Events session, uses
  pointer capture plus window-level move/up/cancel/blur/Escape handling, hit
  tests beneath the pointer with `elementsFromPoint`, frame-paces only the drag
  ghost position, and updates React state only when the resolved target changes.
- Every pane exposes an explicit five-position guide and split preview;
  tab-strip targets expose a before/after insertion marker. Surface titles and
  tabs no longer use native HTML `draggable`/`DragEvent` handlers.
- `computeStudioDrop` now validates node/instance target coherence, supports
  exact `tab-before`/`tab-after` insertion, rejects structural no-ops, and
  permits an active Stack member to tear out against its own Stack edge while
  preserving ordinary self-stack rejection.
- Pure model coverage is 10 tests. App coverage uses actual pointer
  down/move/up events for thresholded click preservation, cross-pane center
  stacking, active-tab tear-out, exact tab insertion feedback/commit, Escape,
  pointer cancellation, and self-center no-op; the complete frontend suite is
  60 tests.
- `npm run rsr:check` passed: strict TypeScript, ESLint, Rust/TypeScript fixture
  parity, 60 Vitest tests, production build, generated asset freshness,
  cutover inventory, and Chromium smoke (large fixture 2,020 ms; one mounted,
  24 released). `git diff --check` passed.
- Real Chrome pointer review against the Vite mock used physical drag paths,
  not dispatched DragEvents: Console tab → editor center produced a two-tab
  Stack; the active Console tab → its own Stack left edge produced two sibling
  panes; Console B → before Console A changed the exact instance order from
  `[console-a, console-b]` to `[console-b, console-a]`. No console errors or
  stuck drag attribute remained.
- Contract review found no Scene schema/edit, revision/CAS, command, mock
  transport, persistence, project, approval, Runtime, Resource, plugin, or
  domain-authority deviation. The remaining gate is the owner's subjective
  feel check on the exact rebuilt local application; it is not claimed here.
- `cargo build -p rho-desktop --locked` rebuilt the local application with
  `assets/index-B03UvBXn.js`; `target/debug/rho-desktop` is 152,224,224 bytes,
  SHA-256
  `41887099f19bf1c46a6b23377e531c36c622f84d1d52f2b2efb9c55937cfa61b`.
  Building the exact app is not the owner's manual feel acceptance.

### WP7 — composable minimal top bar (authorized 2026-08-22)

Problem/invariant:

- WP3 projected project identity, Scene/Page selection, command search, a
  primary project action, Runtime health, and Compose at equal visual weight.
  Together with the fixed status bar this duplicates status and leaves too
  little quiet chrome around the actual workbench.
- Permanent chrome must remain small and spatially stable. Hiding an optional
  projection must not delete its command, project, Runtime, Scene/Page, or
  inspector state; it changes only which existing control is projected into
  the top bar.

Authorized behavior:

- The fixed 56px skeleton is exactly three anchors: a Rho menu at the left,
  the Studio/Vibe switch at the geometric center, and a Customize toolbar
  button at the right. These anchors cannot be removed or reordered.
- Six optional projections are initially off and may be independently shown,
  hidden, and reordered: Project context, Scene/Page selector, Command search,
  Project action, Runtime status, and Compose. Enabled projections retain
  their relative order across the left/right space surrounding the fixed
  center control; narrow layouts keep the fixed anchors while the two optional
  lanes scroll independently, so selected controls remain keyboard/pointer
  reachable without displacing or overlapping the anchors.
- Customize toolbar is a non-modal popover with explicit checkboxes, pointer
  drag handles, Arrow-key reorder, Reset default, Done, outside-click close,
  and Escape close. A pointer reorder previews locally and writes once on
  release; cancel restores the pre-gesture order.
- The Rho menu retains readable project identity and routes to Command search
  and toolbar customization, so the minimal default does not strand project
  context or the global Command Registry. ⌘K/Ctrl+K opens the Command search
  projection temporarily even when that projection is not pinned.

State, persistence, and failure boundary:

- This is a trusted-shell, device-local preference keyed by exact
  `project_id`; it is not scientific project truth and does not enter the
  revisioned Project UI Profile, Scene/Page data, project files, Store, plugin
  state, or any public/Tauri contract. The payload is versioned, bounded to the
  six known IDs, and normalized for uniqueness.
- Missing preference means the minimal fixed skeleton. A malformed or
  unsupported payload recovers to that default. Browser storage read/write
  failure leaves the current session usable, reports that persistence failed,
  and never mutates authoritative state. Switching projects reloads the exact
  project's preference; one project's order/visibility cannot bleed into
  another.

Acceptance gate:

- pure tests cover defaults, reorder, duplicate/unknown rejection,
  malformed-version recovery, bounded storage, and two-project isolation;
- App tests prove the minimal default, show/hide, pointer reorder with one
  persisted write, pointer/Escape cancellation, keyboard reorder, Reset,
  hidden ⌘K/Ctrl+K access, project switch isolation, and write-failure
  session recovery;
- visual review at desktop and narrow widths proves the three fixed anchors do
  not move or overlap and the popover remains reachable;
- `npm run rsr:check`, `git diff --check`, and a rebuilt local debug app pass.
  Owner acceptance of density and ordering feel remains a separate fact.

Cross-review: the accepted Surface Runtime design retains Command Registry,
Project UI Profile, Scene/Page, Runtime, and project identity authority. This
work package owns only trusted-shell projection preference and chrome
interaction. It adds no schema, Tauri command, mock transport command,
revision/CAS, approval, filesystem, Runtime, Resource, plugin, credential, or
domain mutation. The status bar remains the one always-visible status source;
the optional Runtime item is merely a compact duplicate chosen by the user.

Risk/version decision: D2/R1. The interaction is a bounded user workflow with
device-local failure handling but no kernel boundary. It refines the same
uncommitted `0.4.1-dev.14` workbench candidate, so it does not allocate another
version or R package bump; `NEWS.md` must replace the fixed crowded-bar claim
with the composable minimal-bar behavior after implementation is verified.

Implementation/evidence (2026-08-22):

- `toolbar-model.ts` owns one versioned, bounded, exact-project preference with
  strict ID/uniqueness validation, minimal-default recovery, visibility and
  ordering transforms, and explicit storage failure. `ToolbarCustomizer.tsx`
  owns the non-modal panel, checkbox projection, thresholded Pointer Events
  reorder transaction, Escape/cancel rollback, and Arrow-key path.
- `App.tsx` now renders a three-column fixed skeleton. Optional projections are
  split into independently scrolling lanes around (and cannot displace) the
  center mode switch. The Rho menu keeps project identity plus search/
  customization routes, and hidden ⌘K/Ctrl+K search renders as a temporary
  overlay without changing the saved preference.
- Six pure model tests cover default, toggle/reorder, unknown/duplicate/
  incomplete/version rejection, malformed/oversized recovery, two-project
  isolation, and storage failures. Eight App regressions cover minimal chrome,
  show/hide, Reset, pointer preview/single-release write, Escape rollback,
  keyboard reorder, hidden search, write-failure session recovery, and live
  project-identity reload (some assertions share one test). The complete
  frontend suite is 74 tests.
- `npm run rsr:check` passed: strict TypeScript, ESLint, exact Rust/TypeScript
  fixture parity, 74 Vitest tests, production build, asset freshness, cutover,
  and Chromium smoke (large fixture 1,843 ms; one mounted, 24 released).
  `git diff --check` passed.
- Fresh Chrome captures at 1680×960 (minimal and Customize-open) and 900×700
  (minimal and all optional projections enabled) showed stable left/center/
  right anchors, no optional/status duplication by default, a complete
  reachable popover, and contained scroll lanes without narrow-width overlap.
- `cargo build -p rho-desktop --locked` rebuilt the local app. The resulting
  `target/debug/rho-desktop` is 152,224,224 bytes, SHA-256
  `ea156d29cedc808a2d4dcf96908fbc942244f016cbca0fdc6f5c323b42d7fbe1`.
- Contract review found no Project UI Profile/schema, Tauri/mock command,
  Scene/Page, Runtime, Resource, plugin, project-file, approval, credential, or
  domain-authority change. `NEWS.md` now describes the composable top bar under
  the existing `0.4.1-dev.14` candidate. The remaining gate is the owner's
  density and ordering feel check in the exact local app; it is not claimed.

### WP8 — focus-first Surface, Navigator, and file interaction (implemented and verified 2026-08-22)

Problem/invariant:

- The current Surface frame permanently exposes internal IDs, lifecycle
  actions, instance revision/mode/Runtime binding, and a footer on every pane.
  File Source then adds two more metadata/action rows plus a bottom Save row.
  This spends scarce vertical area on implementation truth rather than the
  file or task the user opened.
- Information must remain reachable, but visibility is not the same as
  usability. Frequent actions need direct buttons; advanced or diagnostic
  facts need a deliberate click target and light-dismiss layer. Hiding an
  item may not delete, weaken, or silently change its underlying operation.
- Save is one user intent. If the editor has a local draft that has not blurred
  into the shared Resource document, clicking Save must sequence the existing
  draft update and durable save rather than disable itself and require an
  unexplained blur first.

Authorized behavior:

- Every ordinary Surface uses one compact title row: user-facing title, one
  `More` button, and one direct Close button. Internal `surface_id`, mode,
  Surface revision, Runtime binding, Pause/Resume, and Duplicate move into the
  light-dismiss More panel. Failed/paused/placeholder status remains explicit
  in the body; no lifecycle action or diagnostic identity is removed.
- The default Surface footer is removed. Its facts move into the More panel,
  expressed as labelled values rather than permanent low-contrast text.
- Navigator keeps Files/Runs/Artifacts as primary buttons, adds an on-demand
  file-search button/input, and gives the file tree the remaining height.
  Recent outputs renders nothing when empty and becomes a collapsed count
  button/list when records exist; it does not reserve a permanent empty rail.
- File Source/Preview uses one compact file command bar: resource state and
  file name at the left; stale refresh, Save, Reload/Discard, Info, and More at
  the right as applicable. Info reveals media type and Resource/document
  revisions. More contains View group, Rename/path, and Delete controls.
  Advanced controls are absent from the default visual scan but remain one
  click away and keyboard reachable.
- Save is enabled for either a local editor change or a shared dirty document.
  It performs at most one existing `resource_update_draft`, then one existing
  `resource_save`, using the returned document revision. Failure retains the
  edited value and dirty affordance, reports the error, and permits retry.
  Reload is labelled `Discard & reload` whenever either local or shared dirty
  state would be discarded.

State, ownership, and compatibility:

- This work only changes trusted React projection and sequences already-owned
  Resource mutations. It adds no Tauri/mock command, schema, Store table,
  Project UI Profile field, Scene grammar/edit, permission, filesystem
  authority, plugin capability, Runtime operation, or persistence lane.
- Navigator tab persistence and every existing revision/CAS request remain
  unchanged. Menus, Info, file-search query, and Recent-output disclosure are
  ephemeral view state. Resource Registry/document revisions remain the sole
  mutation authority; the shell never invents or advances them.

Acceptance gate:

- App regressions prove focused default chrome, More/Info light dismissal and
  keyboard access, Pause/Duplicate/Close reachability, no default metadata
  footer, empty/collapsed Recent outputs, file-search filtering, and advanced
  file actions behind More;
- Save tests cover local-draft success sequencing, shared-dirty save, stale or
  rejected draft update, failure preservation, and retry recovery; existing
  Resource store/kernel tests remain the authority for durable mutation CAS;
- desktop and narrow Chrome captures show reclaimed editor/tree area, one
  compact file bar, no clipped menus, and no lost primary action;
- `npm run rsr:check`, `git diff --check`, and a rebuilt local debug app pass.
  Owner focus/interaction acceptance remains a separate fact.

Cross-review: the accepted Surface Runtime design retains lifecycle, instance,
Resource, revision/CAS, focus, and layout authority. The Resource Registry and
broker retain all file read/write/rename/delete authority. This document owns
only action placement, disclosure state, and the exact frontend sequencing of
already-authorized draft/save calls. No competing persistence or mutation
owner was found.

Risk/version decision: D2/R1. The Save path has user-visible failure/recovery
semantics but crosses no new boundary. WP8 refines the same uncommitted
`0.4.1-dev.14` candidate, so no new application or R package version is
allocated; `NEWS.md` is amended only after verified implementation.

Implementation and evidence:

- `MenuPopover.tsx` supplies the shared click/Escape/outside-dismiss layer.
  `SurfaceView` now exposes a compact title, More, and Close without a
  permanent metadata footer; Pause/Resume, Duplicate, component identity,
  mode, revision, and Runtime remain in More.
- `Navigator.tsx` now filters the recursive file tree through an on-demand
  search control. Empty recent output has no DOM/height; non-empty output is a
  collapsed count disclosure. The body owns all remaining panel height.
- File Source/Preview now has one command bar. Save serializes an in-flight
  blur commit, commits a still-local draft once, and saves against the returned
  document revision. Draft rejection retains editor content and dirty state;
  retry completes through the same Resource owner. Info and More retain all
  prior revision, view-group, rename, and delete affordances.
- App regressions cover the focused default, Surface and file menus,
  outside/Escape dismissal, lifecycle/duplicate reachability, absent empty
  recent output, file filtering, shared-draft save, local-draft rejection,
  retained edits, exact revision sequencing, and successful retry. The full
  `npm run rsr:check` gate passed with 77 tests, exact Rust/TypeScript fixture
  parity, generated-asset/cutover checks, and Chrome browser smoke (large
  fixture 1982 ms, one mounted and 24 released renderers).
- Real Chrome captures at 1680×960, 1100×760, and 900×700 verified the default,
  Surface More, file More, Navigator search, and the narrow Navigator menu:
  no missing primary action, permanent empty rail, or clipped popover was
  observed. `git diff --check` passed.
- `cargo build -p rho-desktop --locked` rebuilt the exact local debug app.
  `target/debug/rho-desktop` is 152,224,224 bytes with SHA-256
  `03c9cc7fc257200d532a480963b33a75bb0823380ada05ab7896547f21921e38`.
  `NEWS.md` records WP8 under the existing `0.4.1-dev.14` candidate. Owner
  focus and interaction acceptance in that exact app remains open and is not
  claimed.

### WP8-R1 — narrow Navigator primary-action reachability (implemented; merged-candidate verification passed 2026-08-27)

The STARTUP-INFO-1 exact-app S0 review found a bounded WP8 presentation defect:
when Scene geometry compresses the Navigator to roughly 124 px, the horizontal
tab row can extend behind the Navigator's clipped boundary. `History` is then
partly cut off while `Artifacts` and the Files search trigger can become
pointer-inaccessible. Increasing the default pane width or skipping the S0
gate would conceal rather than repair that state.

This repair restores the common Surface header's grid-shrink contract with
`min-width: 0`; its title already owns bounded ellipsis while More and Close
remain token-sized direct actions. It keeps Files, History, and Artifacts as
direct primary tab buttons. The tab group may wrap onto additional rows when
its allocated inline space is too small, while the on-demand search trigger
remains a non-shrinking sibling. It adds no compact-mode state, overflow menu,
persistence, command, schema, or authority. Existing roving-tab keyboard order
and tab/panel relationships stay unchanged; accepted Surface Runtime focus,
accessibility, and responsive-layout authority remains controlling.
Closing the Files search with Escape restores focus to its still-mounted
trigger instead of dropping keyboard users to the document body.

Acceptance requires an App regression for the unchanged three-tab/search DOM
and keyboard contract plus a real 1024×680 S0 geometry gate at the compressed
Navigator width. That gate must prove the Surface article, common header,
Navigator section, controls, every tab, and the search trigger are contained;
each interactive target remains at least the token minimum, with no clipping,
overlap, or page/control horizontal overflow. The same real-debug path must
exercise Files → ArrowRight/History → End/Artifacts → Home/Files → Tab/search
→ Enter/input → Escape/search recovery and record each focused element's
contained rectangle. The prior clipped frame remains failed evidence.

Closure evidence: the App regressions passed inside the final 133/133 App
suite. The pre-documentation frozen `0.4.1-dev.22` product snapshot, repository
fingerprint
`df64bc7de536667641f7aa96c6fcfa5c99a83713701af999c000dcd1b9311dcb`,
passed the complete stable `rsr:check` (76 Vitest files / 578 tests). Its exact
frozen debug binary had SHA-256
`3fb1693239d2b2f64f1966284dd1dd485fe41afa890b67abf6969a63a8650465`;
the immutable S0/S3/S9 run at
`target/visual-acceptance/dev22-final-df64bc7d-3fb16932-s0-s3-s9/` passed
35/35 deterministic gates and 31/31 reviewed frames. The real 1024x680 S0
Navigator gate proved the Surface article, common header, Navigator section,
tabs, and search controls contained with no horizontal overflow, exercised the
required tab/search/Escape focus path, and its `s0-first-view.png` received a
passing original-resolution review. That new evidence closes WP8-R1 without
reclassifying the earlier clipped frame.

Lifecycle documentation did not change the frozen product sources or frontend
assets. The exact current debug binary has SHA-256
`4c9d9b18920d97c0aaea309b61d1bde6ade603f1d3c268d8e3a395f55d02a1cf`.
Its immutable confirmation run at
`target/visual-acceptance/dev22-final-1f476c14-4c9d9b18-s0-s3-s9-r2/`
also passed 35/35 gates and 31/31 original-resolution frame reviews; its S0
first-view gate reconfirmed WP8-R1 at 1024x680. The `3fb169...` run remains the
historical pre-documentation frozen-product PASS and is not presented as the
current binary.

### WP9 — quick project switching from the Rho menu (implemented and verified 2026-08-22)

Problem/invariant:

- The Rho menu presents the current project as a large read-only card even
  though the broker already owns validated `project_open`, native
  `project_pick_directory`, active-operation blockers, atomic commit, and
  previous-project recovery. The trusted shell therefore explains project
  context but strands the primary project action.
- A quick switch must never approximate project identity or mutate UI stores
  as if a switch succeeded. Only a `ready` broker response may advance the
  visible project. `blocked`, `cancelled`, `failed_restored`, `fatal`,
  unavailable-path, and invocation failure remain distinct user-visible
  outcomes; repeated clicks are suppressed while one switch is pending.

Authorized behavior:

- The Rho menu keeps the current project name/path, adds a direct `Open project
  folder…` action backed by the existing native picker, and lists up to six
  recent project paths below the current project. Selecting a recent path
  calls the existing exact-path `project_open` command. The current path is
  excluded from the recent choices, so every visible recent row changes
  context rather than refreshing the same project.
- A successful response closes the menu and explicitly refreshes the Kernel,
  Surface, Studio, Runtime, Resource, and Project UI Profile projections.
  Cancellation is silent and leaves the menu usable. Blocked/failure/recovery
  results remain in the menu beside the attempted action, preserve the current
  project identity, and permit retry or another choice. Fatal results expose
  the restart requirement rather than presenting recovered readiness.
- Project rows show a derived directory label and a single-line exact path.
  Pending state uses a stable busy label and disables all switch targets. The
  menu retains outside-click dismissal, Escape dismissal with focus returned
  to the Rho trigger, Command search, and Customize toolbar.

State, bounds, ownership, and compatibility:

- Recent paths are a global, device-local convenience index in `localStorage`,
  not scientific/project truth. The versioned payload stores paths only, is
  bounded to six unique entries, rejects control characters and paths longer
  than 4,096 characters, and rejects malformed, unsupported, duplicate, or
  oversized payloads to an empty default. Labels are derived at render time.
  Read/write failure keeps the current session list usable and reports that
  recents will not persist.
- A path is remembered only after the authoritative Kernel snapshot identifies
  it as current; attempted or failed targets never enter history. The existing
  per-project toolbar preference remains keyed by the broker-returned
  `project_id`, so A→B→A does not leak project UI preference.
- This package adds typed frontend transport methods and mock parity for two
  commands already registered in Tauri. It adds no Tauri command, Rust switch
  branch, schema, session/index migration, Project UI Profile field, project
  file mutation, permission, approval, execution, Runtime, Resource, plugin,
  credential, release, or filesystem authority. BH2-B remains the sole owner
  of validation, blocker, commit, rollback, restart-required, and durable
  last-opened-project truth.

Acceptance gate:

- pure tests cover missing/normal history, uniqueness/order/bounds, Unicode and
  space paths, malformed/version/duplicate/oversized rejection, and storage
  read/write failure;
- Tauri transport tests prove exact `project_open { path }` and no-argument
  `project_pick_directory` invocation; mock parity keeps all project-owned
  snapshot IDs aligned and supports A→B→A projection isolation;
- App regressions cover picker success/cancel, recent direct switch, pending
  double-click suppression, blocked result and retry, failed-restored/fatal/
  thrown failure preservation, history admission only after ready truth,
  A→B→A Project UI Profile isolation, and Escape focus return; real-browser
  review covers narrow menu reachability and pointer target geometry;
- existing broker project-switch blocker, failure-injection/recovery, A→B→A,
  Unicode/space-path, and restart tests remain green; `npm run rsr:check`,
  `git diff --check`, real Chrome review, and a rebuilt debug app pass. Owner
  exact-app switching acceptance remains a separate fact.

Cross-review: the accepted BH2-B switch recovery specification retains all
project-transition truth and recovery semantics. The RSR design retains
project identity and per-project UI projection ownership. WP9 owns only the Rho
menu entry, a bounded non-authoritative recent-path convenience, typed access
to existing commands, and truthful projection of their existing result. No
competing persistence, approval, execution, or filesystem owner was found.

Risk/version decision: D2/R3 because an existing safety-critical project
transition becomes directly reachable from the current shell. No backend
boundary changes, but negative/recovery/two-project evidence is mandatory.
WP9 refines the same uncommitted `0.4.1-dev.14` candidate, so no application or
R package version is allocated; `NEWS.md` is amended only after verification.

Implementation/evidence:

- The current-project card is now the native folder-picker action. Up to six
  device-local recent paths render as whole-row exact-path switch targets;
  pending, cancellation, blocked/retry, failed-restored, fatal, invocation
  failure, and storage-unavailable outcomes retain the contract above.
- The frontend transport and browser mock expose only the two existing Tauri
  commands. The mock keeps independent project bundles, and Kernel, Surface,
  Studio, Runtime, and Resource external stores now scope monotonic snapshot
  revision checks to one `project_id` (Project UI Profile already did so). A
  new project's lower initial revision is therefore accepted without weakening
  stale-response rejection inside one project.
- Frontend typecheck/lint and the complete eight-file suite pass with 88 tests;
  exact Rust/TypeScript contract, production build/assets/cutover, and the
  standalone Chrome smoke pass. Eleven broker project-switch blocker,
  isolation, commit, failed-restored, and fatal tests pass; four Unicode/space
  path and two-project isolation tests pass. `cargo build -p rho-desktop
  --locked` rebuilt the checkout debug app successfully.
- Real Chrome review passed at 1100×760 and 560×600. The current-project target
  measured 278×69 px and each recent-project row 278×39 px; long and Unicode
  paths remain reachable, a recent switch closes the menu and updates project
  identity, and Escape restores focus to the Rho trigger. Owner acceptance of
  exact-app switching feel remains open and is not inferred from browser
  evidence.

### WP10 — focus-first interactive Console (implemented and verified 2026-08-22)

Problem/invariant:

- The Console gives permanent height to an output filter and permanent width
  to idle Interrupt/Restart buttons. Its runtime option repeats the same state
  as the adjacent status badge, output entries expose internal Runtime and
  Surface instance IDs on every execution, and the empty state explains no
  interaction. The result reads like a diagnostic fixture instead of the
  shortest path from code to output.
- Explicit Runtime binding, per-Console draft/history/filter/scroll/output,
  exact execution origin, broker-owned busy/restart state, interruption, and
  restart recovery remain binding. Presentation must not create, stop, attach,
  detach, interrupt, restart, or clear another instance implicitly, and must
  never move focus into the Console merely because it mounts.

Authorized behavior:

- Keep one compact Runtime row: the selector shows the human Runtime label,
  the adjacent badge owns status, and the single composer action changes from
  Run to Stop while this Console or its bound Runtime is busy. Restart moves to
  the existing Surface More menu. Because the default Console sits near the
  bottom edge, that menu uses viewport collision placement and opens above its
  trigger when the actions would otherwise be clipped; outside-click, Escape,
  and trigger-focus return remain unchanged. Runtime selection and the `Attach
  runtime…` choice retain the existing exact attach/detach commands and
  capability filtering.
- Output search becomes an on-demand button. Opening it focuses one search
  row with result count; Escape or Close clears the hidden filter so output is
  never filtered invisibly. No-match state names the query and offers a direct
  reset. `Clear this Console` lives in More, clears only this instance's local
  output/filter/scroll projection, and does not alter history, draft, Runtime,
  Runs, or sibling Consoles.
- The empty output state explains the next action. Completed entries display a
  human Runtime label and compact ordinal while preserving exact IDs in the
  stored record/accessible metadata. Successful execution keeps the newest
  entry visible and persists that instance's resulting scroll position without
  moving keyboard focus. The composer uses a prompt gutter, a one-row
  auto-growing multiline input, a single Run/Stop action, and a concise
  accessible/hover keyboard hint that does not permanently consume an output
  row. Enter submits, Shift+Enter inserts a line break, and Up/Down traverse
  history only at the text boundary so multiline cursor movement remains
  available. Failed execution retains the draft and reports the existing
  truthful error.

Ownership, compatibility, and risk:

- This is a D2/R1 frontend interaction package over existing Surface and
  Runtime contracts. It changes no Tauri command, Rust branch, schema,
  Project UI Profile shape, view-state bounds, Runtime policy, execution lane,
  permission, approval, credential, filesystem, project, release, or plugin
  authority. The accepted native Surface design remains owner of explicit
  binding, multi-instance isolation, output origin, and restart semantics.
- Viewport collision positioning is opt-in for the Console's existing trusted
  Surface More menu; it changes no menu action or authority and does not alter
  plugin-rendered content.
- Existing persisted Console view state remains readable without migration.
  New transient disclosure state is not persisted. WP10 refines the same
  uncommitted `0.4.1-dev.14` candidate; no application or R package version is
  allocated, and NEWS is amended only after verification.

Acceptance gate:

- App regressions cover focused empty/unbound states, no idle Interrupt/Restart
  row actions, on-demand filter open/result/reset/Escape behavior, Enter versus
  Shift+Enter, boundary-aware history, success/failure draft truth, busy Stop,
  viewport-reachable Restart, outside/Escape dismissal, and instance-local
  Clear with two Consoles;
- existing shared/split Runtime, exact origin, independent state, attach/
  detach, restart/rebind, recovery, and project-isolation tests remain green;
- typecheck/lint, complete `npm run rsr:check`, `git diff --check`, desktop and
  narrow real-Chrome review, and a rebuilt debug app pass. Exact-app Console
  feel acceptance remains a separate owner gate.

Cross-review: WP10 changes only trusted-shell presentation and instance-local
Console view-state mutations already authorized by the accepted native Surface
design. Runtime Registry remains the sole owner of attachment, status,
execution, interrupt, restart, generation, and recovery truth. No competing
state, persistence, approval, or execution owner was found.

Implementation/evidence:

- The idle Console now renders one compact human-labelled Runtime selector,
  one truthful state badge, the output area, and a prompt-led auto-growing
  composer. Idle Interrupt/Restart and the permanent filter row are gone.
  Search replaces the Runtime row only while explicitly open; Escape/Close
  clears it, and no-match state has a direct reset.
- Run changes to the sole Stop action while the bound execution lane is busy.
  Restart and instance-local Clear live in Surface More. The Console opts that
  existing trusted menu into viewport collision placement: at 1100×760 its
  242 px menu opened upward from y=321 through y=563 above the trigger at
  y=567, so every action and fact remained reachable.
- Output entries show the human Runtime label and ordinal while exact execution,
  Runtime, and Console IDs remain in accessible metadata. New output scrolls
  to the bottom synchronously without focusing the output. Clear preserves
  draft/history and sibling Console output. Runtime detach disables composer
  and Run without losing the instance.
- Three new App regressions plus the extended two-Console regression pass; the
  complete frontend gate is green with 91 tests, exact contract parity,
  production assets/cutover, and Chrome smoke (large fixture 1923 ms, one
  mounted and 24 released renderers). Six Runtime Registry plus thirteen
  Surface/plugin-Surface focused Rust tests pass; `git diff --check` is clean.
- Real Chrome interaction passed at 1100×760 and 900×700. In a 335 px-tall
  Console, Runtime chrome measured 37 px, composer 35 px, and output received
  208 px; a three-line draft grew to 68 px only while needed. Five consecutive
  runs ended exactly at the latest output without focus theft. The compact
  143 px state retained a 16 px non-scrolling output line and had no horizontal
  overflow. The rebuilt `target/debug/rho-desktop` is 152,240,736 bytes with
  SHA-256 `783cda212a902492f6843373379cf752aded2777bd266c9fc05c5742dfd9ee9f`.
  Owner exact-app Console feel acceptance remains open.

### WP11 — Source-to-Console execution continuity (implemented and verified 2026-08-22)

Problem and invariant:

- The RSR Source editor currently edits and saves a shared Resource but exposes
  no Run action and registers no editor execution shortcut. This regresses the
  implemented WP2 contract: a selection or current physical line can no longer
  be sent to Workspace R from the editor, despite the Console and exact Runtime
  execution lane remaining available.
- The restored action must enter one exact, visible Console instance so code,
  output, history, Runtime generation, and accessible origin remain together.
  The Source editor must never pass its own Surface ID as a Console origin or
  bypass Runtime Registry admission.

Authorized behavior:

- Add one visible `Run` action to the Source command bar. It and Monaco's
  `Ctrl+Enter` / macOS `Command+Return` action share one path; the degraded
  textarea owns the equivalent shortcut. The accessible label and tooltip name
  selection/current-line behavior and the shortcut.
- A non-empty executable selection is sent literally and retains its selection.
  With no selection, only the cursor's physical line is sent. An empty or
  whitespace-only line is rejected visibly and never falls back to the whole
  document. Once a line request is synchronously admitted, the cursor advances
  exactly once to the next line (or document end), persists through the
  existing Source view-state lane, and editor focus is retained even if later
  Runtime execution fails.
- The target is the last explicitly interacted visible Console when it remains
  mounted; otherwise the sole visible Console is used. With no visible Console,
  execution is rejected with an instruction to open/activate one. If multiple
  Consoles are visible and none was explicitly chosen, execution is rejected
  with an instruction to choose one; Rho does not guess across independent
  Console instances. Selecting a Console Stack tab naturally changes the sole
  mounted target.
- A source-origin request appends to the chosen Console's existing instance-
  local history and output, leaves its draft unchanged, uses its exact attached
  Runtime/generation and Surface revision, and never focuses its composer.
  Unbound, busy, recovering, stale, or unavailable targets reject truthfully;
  failed execution resets transient busy state so a later request can recover.

Ownership, compatibility, and risk:

- Implemented WP2 remains authoritative for selection/current-line semantics;
  `active-2026-08-10-run-current-line-advance-repair-spec.md` retains cursor
  advance/focus ownership; UX-KEYS-1 retains shortcut admission. WP11 only
  restores those behaviors in the current RSR Source adapter and resolves the
  new multi-Console target explicitly.
- Runtime Registry remains the sole execution/status/generation authority, and
  the accepted native Surface design remains the owner of explicit Console
  binding, per-instance view state, active Stack mounting, and output origin.
  No Tauri command, Rust branch, contract/schema, project identity, approval,
  filesystem, credential, plugin, or release authority changes.
- This is D2/R2 because a trusted Source action crosses the existing
  Source/Console/Runtime UI boundary. WP11 refines the same uncommitted
  `0.4.1-dev.14` candidate; no application or R package version is allocated,
  and NEWS changes only after verification.

Acceptance gate:

- Pure tests cover LF/CRLF selection and line extraction, whitespace rejection,
  next-line offsets, and final-line clamping. App regressions cover toolbar and
  shortcut parity, exact Console/Runtime origin, selection retention, immediate
  line advance/focus, empty/no-target/ambiguous/busy rejection, later execution
  failure and retry, Console-draft preservation, and two-Console isolation.
- Existing Runtime Registry success/stale/failure/recovery and project
  isolation tests remain green. Run typecheck/lint, complete
  `npm run rsr:check`, `git diff --check`, desktop/narrow browser review, and a
  rebuilt debug app. Installed/exact-app owner acceptance remains separate.

Mandatory stop: stop after this continuity package, verification, contract
review, NEWS/evidence reconciliation, and rebuilt local-app handoff. Smart
statement/chunk execution, whole-file Source, execution provenance expansion,
and persisted preferred-Console selection require separate authorization.

Implementation and evidence:

- Source now exposes one compact `Run` command. Its imperative toolbar path,
  Monaco command/action, and degraded textarea shortcut share the same pure
  selection/current-line extractor. Accepted line requests persist and reveal
  the exact next LF/CRLF-safe cursor offset; selection and rejection paths do
  not move. Monaco initialization now reads the latest Resource value and view
  state after its asynchronous runtime import, closing the observed empty-model
  hydration race.
- Mounted Consoles register transient execution endpoints with the trusted
  shell. The sole visible endpoint is the default; explicit Console interaction
  selects among multiple visible endpoints, and that preference resets at
  project identity change. Source requests use the chosen Console's exact
  Runtime and Surface revision, preserve its draft, append only its history and
  output, and keep editor focus. Empty, no-target, ambiguous, unbound, busy,
  recovering, and later Runtime-failure/retry paths remain truthful. Console
  output-scroll persistence now waits for the output view-state revision before
  its follow-up write, preventing a same-instance stale write discovered during
  real-browser review.
- Six pure scope tests and eight App regressions pass. The complete frontend
  gate passes with 105 tests, exact Rust/TypeScript fixture parity, production
  build/assets/cutover, and Chrome smoke (large fixture 1928 ms, one mounted and
  24 released renderers). Six Runtime Registry and thirteen Surface/plugin-
  Surface tests pass; `git diff --check` is clean.
- Real Monaco review loaded all three lines after the asynchronous Resource
  read, ran `library(ggplot2)` from the toolbar, advanced and ran
  `plot(mtcars$wt, mtcars$mpg)` with Command+Return, rejected the trailing empty
  line without a third execution, retained Source as the active textbox, and
  produced no stale error. Browser automation could not deterministically
  create a Monaco-native mouse selection, so exact-app selection feel remains
  an explicit owner acceptance item rather than a claimed pass.
- The rebuilt `target/debug/rho-desktop` is 152,240,736 bytes with SHA-256
  `714f358a85d66fdc853e5641bae3636f2ba43282fcf28f7bc8c133e7bd6a03b6`.
  Review found no contract deviation, new dependency, backend/schema/policy/
  project authority change, or cross-project preference persistence. WP11 is
  included in the existing uncommitted `0.4.1-dev.14` NEWS candidate; no new
  application or R package version, release, installer, or commit is created.

### WP12 — user-triggered component auto-emergence (implemented and verified 2026-08-22)

Problem and invariant:

- WP11 knows that Source Run requires an executable Console, but when the
  user has closed or hidden every Console placement it reports an error and
  makes the user reconstruct the layout before the original action can
  continue. The shell already owns Surface catalog, Scene placement, Runtime
  binding, and active Stack truth, so it can resolve that requirement without
  inventing a second component or layout authority.
- Emergence is a consequence of one explicit user action, never an ambient
  startup, project-load, polling, Runtime-status, or background suggestion.
  It must preserve an intentionally paused/failed component, exact project and
  Runtime identity, revision/CAS admission, user Scene ownership, and the
  Source cursor/focus contract.

Authorized behavior:

- Source Run first keeps the WP11 visible-target rule: use the last explicitly
  interacted mounted Console, otherwise the sole mounted Console, and retain
  explicit disambiguation when more than one Console is mounted. Only the
  zero-mounted-Console path asks the trusted shell to satisfy a `rho.console`
  requirement for the invoking Source instance. Contextual emergence is Studio-
  only; Vibe does not mutate a hidden Studio Scene.
- Resolution order is deterministic and bounded: activate a compatible
  inactive Console tab already in the current Scene; otherwise reuse a
  compatible active/hidden Console instance from the same project and place it;
  otherwise attach one same-project unbound active/hidden Console to the
  already-registered primary scientific Runtime; only then create one new
  `rho.console` instance bound to that Runtime through the existing Surface
  open lane. A suspended, failed, or placeholder Console is not automatically
  resumed, rebound, or replaced. A Console bound to another Runtime is not
  silently rebound.
- An inactive Console tab in another pane can be activated in place. A Console
  tab that shares the invoking Source's own Stack is not activated because that
  would hide or remount the editor during its action; the resolver instead uses
  another compatible instance or creates the bounded support instance.
- A reused or created Console is placed immediately below the invoking Source
  pane. The existing pane becomes the approximately 70% work area and Console
  the approximately 30% support area, while a matching vertical parent is
  reused and an axis mismatch wraps only the Source pane. The placement is one
  ordinary, undoable `replace_root` Scene edit; an inactive Stack is revealed
  by one ordinary `set_stack_active` edit. No new Scene edit or placement
  persistence exists.
- Surface creation and Scene placement remain two existing revisioned
  mutations. If creation succeeds but placement fails, the instance remains
  safely unplaced and is reused on retry; no code is admitted and no cursor is
  moved. After a successful Scene edit the shell waits only for that exact
  Console renderer to register, then submits the original literal code through
  its exact Runtime/generation endpoint. Concurrent repeated Run gestures from
  one Source share one in-flight preparation and cannot create or execute
  duplicates.
- The Run control exposes a bounded preparing state. Cursor advance happens
  only after the emerged Console synchronously admits the code. If the user
  edits the document, changes the selection, or moves focus while preparation
  is pending, the requested code may still run after admission but the shell
  does not overwrite the user's newer cursor or focus.

Ownership, compatibility, and risk:

- The accepted Surface Runtime design retains factory/instance, lifecycle,
  exact Runtime attachment, Scene grammar, revision/CAS, undo/redo, project
  identity, and Project UI Profile authority. WP12 is a trusted React-shell
  requirement resolver over those existing commands; Console attachment does
  not create a Runtime, and Runtime Registry remains execution truth.
- WP11 and the run-current-line repair retain literal execution, target
  ambiguity, cursor, focus, and failure semantics. WP12 changes only WP11's
  zero-visible-target recovery. There is no Tauri/Rust branch, public contract,
  schema, permission, filesystem, credential, approval, plugin activation, or
  release authority change. This remains D2/R2 and refines the same uncommitted
  `0.4.1-dev.14` candidate.

Acceptance gate:

- Pure layout tests cover unplaced insertion below Source, matching-axis reuse,
  mismatch wrapping, root wrapping, an already-placed move, exact 7:3 sizing,
  and missing/self target rejection. Pure placement lookup covers active and
  inactive Stack membership.
- App regressions cover hidden-tab activation without creation, unplaced reuse
  and exact primary-R binding, last-resort creation, successful original-code
  replay and one cursor advance, rapid-repeat deduplication, suspended/no-
  Runtime/placement-failure rejection, retry recovery, and ordinary undo of the
  emerged placement. Existing visible/busy/recovering/ambiguous/two-Console and
  project-isolation coverage remains green.
- Run the complete frontend gate, focused Runtime and Surface Rust tests,
  `git diff --check`, real Monaco browser review, and rebuild the local debug
  app. Installed/exact-app feel acceptance remains separate.

Mandatory stop: stop after the Source→Console emergence slice, verification,
contract review, NEWS/evidence reconciliation, and rebuilt local-app handoff.
General command-declared requirements, plugin-defined emergence, persisted
affinity, automatic replacement of paused/failed components, floating windows,
and background recommendations require separate authorization.

Implementation and evidence:

- The trusted shell now resolves the zero-mounted-Console requirement in the
  specified order using exact project, primary-Runtime generation, lifecycle,
  and current-Scene placement. It activates an inactive tab in another pane,
  attaches one safe unbound Console, or opens a new Console only when reuse is
  unavailable. Same-Stack candidates never replace the invoking Source. One
  in-flight requirement exists per Source, and project changes cancel pending
  renderer waits.
- The pure Studio helper locates active/inactive/utility placements and computes
  an ordinary `replace_root` result for an unplaced or existing component. It
  reuses a vertical parent, wraps only the invoking pane across an axis mismatch
  or root, and assigns the Source/Console pair exact 7:3 bases. The Source
  adapter exposes `Preparing…`, admits the captured code only after the exact
  endpoint registers, and advances only when document and selection are still
  current; rapid repeats share the first preparation.
- Five pure emergence tests and six App regressions cover hidden activation,
  unplaced bound/unbound reuse, exact primary-R attachment, last-resort creation,
  same-Stack focus preservation, rapid-repeat deduplication, pending-cursor
  preservation, missing Runtime, paused lifecycle, injected placement failure,
  retry, execution replay, and ordinary Scene undo. The complete frontend gate
  passes with 116 tests, exact Rust/TypeScript contract parity, production
  assets/cutover, and Chrome smoke (large fixture 1918 ms, one mounted and 24
  released renderers). Six Runtime Registry and thirteen Surface/plugin-Surface
  focused Rust tests pass; `git diff --check` is clean.
- Real Chrome review closed both Console placements, focused Monaco's first
  line, and invoked Run. `instance:console-a` appeared immediately below Source
  at the intended approximately 70/30 ratio, executed `library(ggplot2)`, moved
  to line two, retained editor focus, and showed no recovery error. The exact
  rebuilt `target/debug/rho-desktop` is 152,240,736 bytes with SHA-256
  `6e3512eeb0742bdf477d7fa91d2642a825876b7b022368492abfbe9d8929e36c`.
- Review found no contract deviation, new dependency, backend/schema/policy,
  Runtime creation, project authority, or cross-project affinity. WP12 is
  included in the existing uncommitted `0.4.1-dev.14` NEWS candidate; no new
  application or R package version, release, installer, commit, or public
  distribution is created. Owner exact-app emergence feel acceptance remains
  open and separate.

### WP13 — residual-space resizing and Console result projection (implemented and verified 2026-08-22)

Problem and invariant:

- A container whose visible children were persisted as fixed bases can be wider
  than the sum of those bases after a window enlargement or rearrangement. The
  current renderer leaves the difference as a dead trailing canvas. Because a
  separator only exchanges the measured extents of its two adjacent children,
  that free area is unreachable by pointer or keyboard resizing even though it
  visibly belongs to the workbench.
- Primary Workspace R execution returns a deliberately rich broker envelope:
  execution/workspace/artifact identifiers, raw kernel events, bridge code and
  the user result. Console currently stringifies each event payload, leaking
  internal protocol state and burying stdout, value, messages, warnings and R
  errors. Logs remains the operational diagnostics owner; Console must remain a
  user command/result transcript.

Authorized behavior:

- In each adaptive container, the last visible resizable child whose basis is
  not intrinsic is the residual-space recipient. Its declared basis remains the
  sizing preference and all declared minimum/maximum constraints still apply,
  but it may grow to consume otherwise unclaimed space on that axis. Collapsed
  children and intrinsic strips never receive it. This is a renderer rule only:
  Scene data, revision/CAS, undo/redo and `resize_boundary` stay unchanged.
- Once the residual space is part of a measured child, the existing separator
  preview and commit naturally operate across the full available work area.
  Pointer release still creates exactly one ordinary revisioned edit; keyboard
  resize exposes the same measured range; a failed/stale edit restores the
  persisted layout on the next render.
- Console projects `workspace_result` into an ordered transcript of stdout,
  returned value, messages, warnings and R error. It projects supported
  auxiliary kernel stream/display/error events and bounded text-bearing mock or
  future events through the same view model. Empty successful execution shows a
  quiet `Completed` outcome; cancellation and malformed/unrecognized events are
  explicit without falling back to raw JSON.
- Execution ids, instance ids, workspace identity, artifact ids, parent ids,
  timestamps, bridge `execute_input` code, calls and raw event envelopes are not
  shown in the default transcript or used by Console filtering. The submitted
  user code, ordinal, attached Runtime display label and semantic result blocks
  remain visible. Text is normalized and bounded before rendering; no HTML from
  Runtime payloads is admitted.

Ownership, compatibility, and risk:

- The accepted Surface Runtime retains LayoutBasis, Scene persistence, edit,
  revision, collapse and focus authority. `fixed`, `fraction`, `minmax`, `auto`
  and `intrinsic` remain valid stored meanings; WP13 adds no migration or silent
  Scene rewrite. The human-facing information projection and Console/Logs
  separation specs own the friendly/default disclosure boundary, while Runtime
  Registry remains payload, execution status, cancellation and binding truth.
- This is D2/R2 because one repair spans visible Scene geometry and existing
  Runtime-output projection, but all code is frontend-only. No backend/mock
  contract shape, filesystem, project identity, credential, approval, plugin,
  artifact, release or distribution authority changes. It refines the same
  uncommitted `0.4.1-dev.14` candidate; no application or R package version is
  allocated, and NEWS changes only after verification.

Acceptance gate:

- Layout regressions cover a fixed-basis container with excess width, verify
  that exactly the eligible final work child receives growth, and exclude
  collapsed and intrinsic children. Existing pointer/keyboard one-edit resize,
  collapse and arbitrary-asymmetry tests remain green.
- Pure projection tests cover representative Workspace success/value/stdout,
  message/warning/error, empty success, cancellation, supported kernel events,
  malformed/unknown payload and output bounds. App regressions prove the
  transcript and filter contain user code/result while excluding bridge code,
  execution/workspace/parent/instance ids and raw JSON keys; two Console
  instances remain isolated.
- Run focused tests while iterating, then typecheck/lint, complete
  `npm run rsr:check`, focused Runtime and Surface Rust tests,
  `git diff --check`, desktop/wide/narrow browser review and a rebuilt debug
  application. Installed/exact-app resizing and Console-readability acceptance
  remains separate.

Mandatory stop: stop after this repair slice, verification, contract review,
NEWS/evidence reconciliation and rebuilt local-app handoff. Dragging an outer
window edge, floating panes, resizing non-adjacent regions, rich plots/tables,
ANSI terminal emulation, clickable artifacts and backend payload changes need
separate authorization.

Implementation and evidence:

- The adaptive renderer now identifies the final visible, resizable,
  non-intrinsic child as the residual-space recipient. A fixed basis retains
  its pixel preference but receives flex growth for otherwise unused space;
  intrinsic, collapsed and non-resizable regions are excluded. No Scene value
  is rewritten. The existing separator therefore measures the full available
  pair, previews continuously and commits its same one `resize_boundary` edit.
- Console now projects persisted and new Runtime events through a pure bounded
  view model. Workspace results show stdout, value, messages, warnings, R error
  and quiet completion; supported kernel streams/displays/errors and cancellation
  receive semantic blocks. Unknown payloads are truthful and bounded without
  raw JSON fallback. Default labels and filtering omit execution, Runtime/
  Console instance, workspace, artifact and parent ids plus bridge code.
- Eight pure regressions and two App regressions cover residual allocation,
  intrinsic/collapsed/non-resizable exclusion, Workspace success/error/empty,
  supported kernel and cancellation events, malformed/unknown and 32,000-
  character bounds, human transcript rendering, internal-detail exclusion and
  filter behavior. The complete frontend gate passes with 126 tests, exact
  Rust/TypeScript fixture parity, production build/assets/cutover, and Chrome
  smoke (large fixture 2066 ms, one mounted and 24 released renderers). Six
  Runtime Registry and thirteen Surface/plugin-Surface focused Rust tests pass;
  `git diff --check` is clean.
- Wide Chrome review produced and resized a Console transcript without blank
  canvas; 125% zoom retained the projected entry and composer without raw-JSON
  horizontal overflow (the intentionally short Console still offers only a
  compact scroll viewport at higher zoom). Exact-app review then opened the
  owner's persisted `test_rho` Scene:
  its previously fixed Navigator/Source/Console row filled the complete window,
  two historical `library(ggplot2)` envelopes rendered only their R vectors,
  and the Source/Console pointer separator changed the measured boundary before
  being restored to the owner's original visual proportion.
- The exact rebuilt `target/debug/rho-desktop` is 152,142,000 bytes with SHA-256
  `90908787a8536912a7f9102b47f00e21e56535bc7d46188b12b05c4c2fa0dabd`
  and embeds `assets/index-CiEVCKBl.js`. A local debug `.app` was produced for
  exact-window review; its unrequested updater archive signing step reported
  the expected absent private key, so no signed updater, installer, release or
  publication is claimed.
- Contract review found no deviation, new dependency, Scene/backend/schema/
  policy/project authority change, or raw payload persistence change. WP13 is
  included in the existing uncommitted `0.4.1-dev.14` NEWS candidate; no new
  application or R package version, commit or public distribution is created.
  Owner resizing and Console-readability feel acceptance remains open.

### WP14 — remaining component focus-first optimization (program authorized 2026-08-22)

Problem and design evidence:

- Navigator, file views and Console now have purpose-built interaction models,
  but most remaining first-party Surfaces still use a construction-era generic
  card: summary count, permanently visible filter, Refresh, status token and a
  raw JSON Details disclosure. That proves transport reachability, but it makes
  Environment, Runs, Plots, Problems, Logs, Evidence, Git, Render jobs and Help
  behave as the same component despite different user jobs.
- Agent is purpose-built but its narrow default context pane still exposes
  completed-turn status/model metadata, a disabled Auto-approve control outside
  Act mode, and equally weighted low/high-frequency actions. Check result is
  substantially purpose-built and needs refinement rather than replacement.
- AnySearch review of the current VS Code workbench guidance and Positron layout
  documentation reinforces three applicable patterns: each region has a stable
  task role; secondary tools can be moved or maximized without changing their
  content contract; and low-frequency toolbar actions move into More while the
  default view retains only contextual primary actions. Positron additionally
  separates code, Console and session/output understanding while offering
  workflow presets rather than one dense universal pane. These are design
  references, not copied component structures:
  `https://code.visualstudio.com/docs/configure/custom-layout` and
  `https://positron.posit.co/layout.html`.

Component audit and target:

| Component family | Current default debt | Target default job |
| --- | --- | --- |
| Agent | model/status chrome competes with the answer; Act-only approval is always shown | conversation first; compact conversation switch; mode-aware composer; exceptional state/actions only |
| Environment | Packages and operation requests collapse into generic records and raw details | health summary, package search on demand, attention-first packages, distinct Requests mode |
| Runs / Render jobs | generic records obscure code/source/outcome and retry affordance | chronological execution rows with outcome, source and contextual recovery |
| Artifacts / Plots | filenames are cards without useful preview/open hierarchy | output-first gallery/list projection with provenance on demand |
| Problems / Logs | strip and full modes share generic cards | compact scan line in strips; actionable grouped details only when expanded |
| Evidence / Git | raw record dump hides claim/source and working-tree tasks | source-linked claims; changes/history tasks with contextual actions |
| Help | build identity and commands are generic records | contextual help/search; support/build facts in secondary disclosure |
| Check result | strong custom base but summary and finding actions remain dense at narrow sizes | result-first summary, progressive evidence/remediation disclosure |
| Lifecycle / empty / loading / failure | wording and geometry vary by implementation | one accessible, action-oriented state grammar across every Surface |
| Surface Playground / plugin documents | engineering labels leak into normal component discovery; plugin blocks lack shared task-state polish | clearly scoped developer preview; inherited host states and content hierarchy |

Program invariants:

- A Surface default view contains the information and controls needed for its
  next likely user action. Counts, ids, revisions, provider/model names, paths,
  raw JSON and diagnostic payloads do not occupy primary space unless they are
  the task itself. Search/filter is shown on demand unless continuous filtering
  is the Surface's defining job.
- Meaningful rows are keyboard-focusable actions or disclosures, not decorative
  cards that merely look clickable. Destructive, environment-mutating,
  approval, retry and filesystem actions continue through their existing owner
  commands and retain disabled/busy/failure/recovery truth.
- Compact/narrow rendering changes density and disclosure, never silently
  removes the sole path to an action. Empty, loading, success, attention,
  failure and no-match states state the outcome and next available action.
- Domain transport payloads remain bounded and project-owned. Frontend
  projection may whitelist fields and hide raw details, but never fabricates
  missing provenance, success, installed versions or operation capability.

Work packages and checkpoints:

- **WP14-A — Agent and Environment context stack (implemented and verified
  2026-08-22):** focus completed
  Agent turns on prompt/answer, move model and completed state to optional
  metadata, make the composer mode-aware, and redesign Environment as a
  purpose-built package/request Surface with attention summary and on-demand
  filtering. Frontend-only D2/R1; existing Agent and Environment commands/data
  remain authoritative.
- **WP14-B — scientific history and review Surfaces (implemented and verified
  2026-08-22):** purpose-built
  projections for Runs, Render jobs, Artifacts, Plots, Problems, Logs,
  Evidence, Git, Help and Check result over existing transport owners. Activate
  only after WP14-A review; any missing action requires a contract amendment.
- **WP14-C — shared state grammar and extension alignment (implemented and
  verified 2026-08-22):** unify
  loading/empty/error/no-match/lifecycle states, normal component discovery,
  Surface Playground scoping and plugin-document inheritance. Activate only
  after WP14-B review.

WP14-A acceptance gate:

- Agent regressions cover healthy/degraded/loading/empty/running/completed/
  failed turns, conversation switching, mode-aware composer, Send/Stop,
  file-proposal approval and two-instance composer isolation. Completed default
  turns omit model and redundant status while optional metadata retains them.
- Environment regressions cover package and request modes, attention/current/
  empty/loading/error/no-match states, search disclosure and persistence, raw
  detail exclusion, Refresh, narrow layout and two-project isolation through
  existing transport snapshots. No package/environment mutation is introduced.
- Run focused tests, then the full frontend gate, `git diff --check`, wide and
  narrow browser review and a rebuilt exact debug application. Update NEWS and
  evidence only after those facts are true. Stop at the WP14-A checkpoint;
  WP14-B activation is the next continuation, not part of the same code slice.

WP14-A evidence and checkpoint review (2026-08-22):

- Completed Agent turns now keep mode, prompt and answer primary while model
  and redundant completed state live in a small optional Details disclosure.
  Ask/Plan no longer reserve space for Act authorization; switching away from
  Act also clears the hidden auto-approve value, and execution admission still
  submits it only for Act. Existing conversation, running/Stop, retry,
  proposal/approval and instance-local composer lanes are unchanged.
- Environment now projects the existing package/request records into distinct
  modes. Packages show a health summary and attention-first rows; Requests show
  operation activity; search is opened deliberately; JSON details are parsed
  through an allowlist and do not expose project roots, internal request ids or
  arbitrary broker payloads. Refresh and failure recovery retain the existing
  transport owner and no mutation command was added.
- Three presentation tests and five new App-level interaction/recovery tests
  join the existing Agent/Surface coverage. The complete frontend gate passes
  with 133 tests across 12 files, exact Rust/TypeScript fixture parity,
  production build/assets/cutover, and Chrome browser smoke. `git diff --check`
  is clean.
- Real Chrome review at a roughly 280 px context width verified package
  attention, status/version legibility, focused search/filtering and Act-only
  authorization disclosure. The first incremental-binary check exposed stale
  app-bundle content despite a matching asset-entry name; after a full Tauri
  app rebuild, the exact macOS window rendered the new semantic Environment
  empty state and on-demand Search/Refresh controls. This distinction is
  retained as evidence rather than treating the filename-only check as visual
  acceptance.
- The rebuilt exact `target/debug/rho-desktop` is 152,142,000 bytes with
  SHA-256 `d7e464720c1ce532fb649d3d50b1926f52f7ea73af03bc918029d5a806265b94`
  and embeds `assets/index-B9CofnDV.js`. The debug `.app` was produced and
  visually reviewed; updater-archive signing stopped at the expected absent
  private key, so no signed updater, release or distribution is claimed.
- Contract review found no schema, Tauri command, Rust behavior, project data,
  filesystem, execution, approval or mutation-authority change. WP14-A reaches
  its integration checkpoint; WP14-B is now the only active implementation
  slice. Owner feel acceptance remains open.

WP14-B accepted implementation slice and gate:

- Replace the remaining generic domain-card renderer with one shared semantic
  host whose presentation is selected by Surface job: chronological activity
  for Runs/Render jobs; output gallery/list for Artifacts/Plots; scan stream for
  Problems/Logs; claim/source rows for Evidence; working-tree/history rows for
  Git; and contextual command/build rows for Help. Shared code is permitted,
  but every default label, summary, empty state and visible fact must describe
  the Surface's job rather than a generic record count.
- Parse current bounded detail payloads only to project a per-Surface allowlist.
  Project roots, workspace ids, internal request/run ids, revision plumbing and
  arbitrary JSON remain absent from the default view. Logs may intentionally
  disclose bounded diagnostic text; Help may disclose current build identity;
  both use explicit secondary disclosures because that technical content is
  their task rather than a generic escape hatch.
- Preserve the existing `retryRun` action only for failed/cancelled Runs.
  Outputs without an existing open/preview command remain informative and must
  not look clickable. No Git, Evidence, Artifact, Plot, Help, log or render
  mutation is invented in this slice.
- Refine Check result so the outcome and primary remediation/evidence action
  lead at narrow widths while immutable revision/rule facts remain available
  secondarily. Preserve the typed Check transport and immutable evidence-open
  path.
- Tests cover each Surface-family projection, raw/internal-field exclusion,
  mode filtering, search/no-match/error/refresh, run retry admission, compact
  strips and Check-result regression. Run the focused suite, complete frontend
  gate, `git diff --check`, wide/narrow Chrome review and rebuilt exact app
  before declaring the checkpoint. Stop and amend this contract if useful
  interaction would require a command that does not already exist.

WP14-B evidence and checkpoint review (2026-08-22):

- The generic domain card is replaced by task projections: Runs and Render jobs
  use chronological rows; Artifacts and Plots use non-clickable output grids;
  Problems and Logs scan compactly; Evidence exposes claim/source facts; Git
  separates working-tree and commit modes; Help keeps commands/build identity
  contextual. Search and Refresh are deliberate icon actions instead of a
  permanently visible filter and every Surface has task-specific summary,
  empty, no-match and recovery language.
- Bounded transport details are parsed through per-Surface allowlists. Tests
  prove project roots, workspace ids, payload JSON and executable paths stay
  out of primary projection. Only Logs diagnostic text and Help build identity
  receive named secondary disclosures. Failed/cancelled Runs retain the sole
  pre-existing retry action; output rows receive no fabricated open/mutation
  affordance.
- Check result now leads with pass/review outcome and next step. Snapshot id,
  coverage counts, rule provider/id/version and immutable capture facts remain
  reachable through Result details and Rule details instead of occupying the
  narrow default header.
- Focused projection/App tests cover each family, Git mode separation, system
  probe exclusion, raw-field exclusion, search/no-match, Refresh, error/retry,
  run retry admission and Check hierarchy. The complete frontend gate passes
  with 140 tests across 13 files, exact contract parity, production assets,
  cutover and Chrome smoke; `git diff --check` is clean.
- Wide and narrow Chrome review verified Runs at roughly 170 px and an Artifact
  output tile without false click affordance. Exact-app review initially found
  100 Environment/package inspection probes in Runs. Read-only inspection of
  the authoritative run store established that these were `origin=system`,
  `operation_class=probe`; the projection now excludes only that explicit
  class while preserving user/Agent/plugin scientific work. Rebuilt exact-app
  review then showed three real user Console commands with code and compact
  timestamps and no `workspace.list_installed_packages` rows.
- The exact rebuilt binary is 152,142,000 bytes with SHA-256
  `daf62c0427b10ba6a385efd4d2d3512cc8bc3b0e9fd9a9ca7c90767042b1bcf1`
  and embeds `assets/index-DCyqlIOd.js`. The unsigned debug `.app` was the
  visually reviewed artifact; expected updater signing remains unavailable and
  no release/distribution is claimed.
- Contract review found no new command, schema, project query, retry policy,
  mutation or authority owner. WP14-B reaches its checkpoint; WP14-C is now the
  only active slice. Owner feel acceptance remains open.

WP14-C accepted implementation slice and gate:

- Introduce one host-owned task-state component and tokens for loading, empty,
  no-match, paused, provider-unavailable and failed states. Migrate the domain,
  Environment, Check, plugin-document and Surface lifecycle paths without
  changing lifecycle commands or durable placement semantics. Loading is
  visibly busy; error states name the existing recovery action; states without
  an action do not fabricate one.
- Keep adaptive-collapse recovery usable and human-readable: a hidden region
  is restored by its component label, never by a layout-node id. The recovery
  rail remains compact and does not change collapse priorities, Scene state or
  persistence semantics.
- Rename normal discovery language from engineering “Surface catalog” to
  “Components”, use human labels consistently in chrome and Stack tabs, and
  move the project-owned Surface Playground into a collapsed Developer tools
  group with explicit preview-only copy. Workspace plugin factories remain
  discoverable as project components and retain registry origin/permissions.
- Plugin documents inherit host loading/error/busy/empty hierarchy. Revision,
  provider and technical document identity move to secondary details while the
  document title and first task block lead. Declarative blocks, command events,
  approvals, permissions and dispatch owners remain unchanged.
- Tests cover each shared state tone/action, discovery grouping, human labels,
  adaptive-collapse recovery, plugin loading/failure/document metadata and
  lifecycle pause/placeholder recovery. Run focused/full frontend gates,
  wide/narrow Chrome and rebuilt exact-app review. Update version/NEWS and
  final evidence only after all facts are true.

WP14-C evidence and program checkpoint review (2026-08-22):

- One host task-state component now presents loading, empty/no-match, paused,
  provider-unavailable and failed states for Environment, domain, Check,
  lifecycle and workspace-plugin document paths. Loading is visibly busy;
  recovery and Close controls appear only where their existing owners permit
  them. Pause/Resume, lifecycle placement and plugin dispatch semantics are
  unchanged.
- Normal discovery is now titled Components and uses human labels. Workspace
  plugin factories carry a Project component origin badge, while Component
  playground is a collapsed Developer tools preview with its instance-local
  scope and identifiers secondary. Plugin documents lead with their title;
  revision/provider facts live in Document details and declarative blocks and
  commands retain their existing trusted renderer/dispatch owner.
- Exact-app review exposed an additional focus defect: adaptive collapse used
  a floating `layout-*` node id as its recovery label. The accepted slice was
  amended before repair. The compact Hidden components rail now says, for
  example, `Show Navigator`, and restoring it may truthfully collapse the next
  eligible region without changing priorities or persisted Scene state.
- Focused regression coverage includes state tones and recovery, project-plugin
  loading/failure/metadata, lifecycle pause, discovery grouping, developer
  preview scoping and human-labelled adaptive recovery. The full frontend gate
  passes with 143 tests across 13 files, exact Rust/TypeScript fixture parity,
  production build/assets/cutover and Chrome browser smoke; `git diff --check`
  is clean.
- Real Chrome inspection verified 18 normal components, no direct playground,
  a closed Developer tools group, the Project component badge and closed
  plugin/preview details. The rebuilt exact macOS app verified the semantic
  Environment empty state, user-only Runs history, complete-width layout and
  the compact `Show Navigator` recovery control.
- The exact rebuilt `target/debug/rho-desktop` is 152,142,000 bytes with
  SHA-256 `f7ad2c55a26e961b38a79dd27b6907c1dd7a10bb4a1acd8e53d29e89d7acfec3`
  and embeds `assets/index-DMyQ4ab6.js`. The debug `.app` was produced and
  visually reviewed; updater signing stopped only at the expected absent
  private key. No release, signed updater or distribution is claimed.
- WP14 remains part of the same uncommitted `0.4.1-dev.14` distributable
  candidate rather than allocating one version per exploratory work package;
  `NEWS.md` now records the verified behavior. No R package changed. Contract
  review found no command, schema, project, persistence, permission, approval,
  filesystem, execution or mutation-authority deviation. WP14 reaches its
  integration checkpoint; only owner feel acceptance remains open.

### WP15 — complete R expression execution and History truth (active 2026-08-23)

Problem and reproduction:

- With no selection, Source currently submits only the cursor's physical line.
  On line 15 of the demonstrated `df <- do.call(rbind, lapply(... function(g)
  {` expression, Command+Enter therefore sends an incomplete prefix, Workspace
  R correctly reports `unexpected end of input`, and the incomplete fragment
  becomes a durable failed run.
- Source execution is admitted through an exact Console instance, but the
  current `RuntimeExecuteRequestV1` contains only `code`. The primary Runtime
  therefore persists `<console>` provenance even when Source initiated the
  request. The history UI then truthfully reads the wrong stored provenance and
  labels the entry Console command.
- The Surface is a chronological record of completed/active/failed executions,
  not an action named Run. User-visible chrome, Navigator, commands, summaries,
  empty states and recovery wording should therefore say History. The durable
  `rho.runs` Surface id, run store, Run History extension capability and Tauri
  command names remain stable compatibility identifiers.

Authorized behavior and boundaries:

- A non-empty selection remains literal and is never expanded. With no
  selection, a deterministic frontend R lexical resolver selects the smallest
  complete top-level expression containing the cursor line. It understands
  strings, backticks, escapes, comments, balanced `()[]{}`, trailing R/custom
  infix operators, commas and `else` continuation. It is not an R semantic
  parser and does not infer functions, chunks or arbitrary neighboring code.
- A complete single-line expression behaves as before. A multi-line expression
  is submitted once and advances the cursor once to the following physical
  line after the expression. A truly incomplete/unbalanced expression is
  rejected before Runtime admission and creates no history entry. A scope made
  only of comments or whitespace is likewise non-executable and rejected.
  Later R runtime/semantic failure remains a truthful failed execution and does not
  roll the admitted cursor transition back.
- Extend the existing versioned Runtime execute request with one optional,
  bounded Source context: normalized project-relative Resource path, execution
  mode (`selection` or `expression`), positive document revision when known,
  and exact one-based UTF-16 source range matching the submitted code. Missing
  context preserves direct Console behavior. Contract and app validators reject
  empty/absolute/virtual paths, invalid modes, out-of-bounds or code-mismatched
  ranges before Runtime state changes; the existing project-path resolver
  remains authoritative.
- History projects the existing durable records with code as the primary scan
  fact, human source (`Source editor`, `R Console`, `Agent` or project
  component), timestamp and outcome. Failures keep both submitted code and the
  bounded error. Pure comment/whitespace probes and existing system probes do
  not occupy the default view. Failed/cancelled eligible executions retain the
  existing broker retry lane, labelled `Run again`; no retry eligibility or
  mutation behavior changes.

Ownership and cross-review:

- `plans/active-2026-08-10-run-current-line-advance-repair-spec.md` is amended
  in the same slice: it retains cursor/focus ownership while WP15 supersedes
  only its physical-line and no-smart-expansion constraints. Literal selection,
  immediate post-admission advance, no focus theft and no rollback after later
  Runtime failure remain binding.
- Runtime Registry still owns target/generation/busy/stale admission and
  execution. Workspace broker/store remain the execution and durable history
  authorities. Resource Registry remains the path/document owner. The optional
  provenance field neither bypasses Console targeting nor reads/writes files.
- Run History extension, `list_runs`, `retry_run`, `rho.runs`, database schema,
  retention and project isolation remain unchanged. History is a user-facing
  name and projection correction, not a new store or lifecycle.

Acceptance gate and stop point:

- Pure resolver tests cover single-line, cursor-in-any-line multiline calls,
  nested braces, ggplot/operator chains, strings/comments/backticks, custom
  infix operators, CRLF, literal selections, incomplete/comment-only rejection and exact
  UTF-16 ranges/cursor advancement. App tests cover toolbar/Command+Enter
  parity, one exact Runtime request, Source provenance, Console provenance,
  no-history-on-rejection, Runtime failure/recovery and two-Console isolation.
- Rust contract/Runtime tests cover absent-context compatibility, valid Source
  context, malformed path/mode/range/code mismatch, stale Console/Runtime and
  project isolation. History tests cover naming, source/code/error projection,
  comment/system filtering, search, empty state and `Run again` admission.
- Run focused suites, the complete frontend gate and affected Rust matrix,
  `cargo fmt --check`, `git diff --check`, browser/mock review and the current
  debug executable. Packaging `.app`, signing, release and distribution are
  explicitly out of scope during rapid iteration.
- WP15 remains in the same uncommitted `0.4.1-dev.14` candidate; update NEWS and
  evidence only after verification. Stop after this correction and review.

WP15 evidence and checkpoint review (2026-08-23):

- The deterministic resolver now submits one complete nested R expression from
  every cursor line, preserves literal selections, rejects incomplete,
  structurally invalid and comment-only scopes, and reports exact one-based
  UTF-16 ranges. The Source adapter commits a current shared-document revision
  before admission and sends its normalized Resource path, mode, revision and
  range through the existing optional Runtime field. Direct Console requests
  omit that field and retain `<console>` ownership.
- `RuntimeExecuteRequestV1` accepts missing context for compatibility and
  rejects virtual/absolute/traversing paths, unknown modes, zero revisions and
  code/range mismatch. The desktop validates project containment under the
  project-transition gate before Runtime status changes, then dispatches the
  same broker-owned `workspace.execute` request and durable Run path.
- The user-facing Surface, Navigator mode and command are now History while
  `rho.runs`, broker/store/Tauri names, retry admission, retention and schema
  remain unchanged. History shows submitted code, human source, outcome,
  bounded error and time; comment-only/system probes stay out of its default
  projection and eligible failures say `Run again`. Existing immutable records
  that were previously stored as `<console>` remain labelled R Console rather
  than guessing historical Source ownership.
- Focused Source/History/App verification passed 87 tests; the complete RSR
  gate passed 152 tests plus typecheck, lint, Rust/TypeScript fixture parity,
  Vite build, asset/cutover checks and Chrome smoke. Seven Runtime contract
  tests, two desktop source-range tests, `cargo check -p rho-desktop`,
  `cargo fmt --check` and `git diff --check` passed. The rebuilt 145 MB
  `target/debug/rho-desktop` launched successfully and exact-app review
  confirmed the History name, code/error hierarchy and `Run again` action.
- Contract review found no new command, schema, table, retry/retention rule,
  project authority, filesystem mutation or execution owner. NEWS remains in
  the existing uncommitted `0.4.1-dev.14` candidate; no `.app`, signing,
  installer, release or distribution operation was performed. WP15 reaches
  its implementation checkpoint; owner shortcut feel acceptance remains open.

### WP15-R1 — executable-gap navigation and truthful Runtime rejection (implemented 2026-08-23)

- After an admitted expression, cursor advancement skips blank and
  comment-only physical lines and lands on the first line of the next
  executable expression. Command+Enter invoked directly on such a gap performs
  navigation only: it creates no Runtime request, Console entry, History record
  or error toast. A trailing gap at end of file is a quiet no-op. Literal
  selections and incomplete expressions containing executable text retain
  their WP15 rejection behavior.
- Tauri may reject an invocation with a bounded string rather than a JavaScript
  `Error`; the shell must preserve that string instead of replacing it with
  `Runtime operation failed`. Console output/view-state persistence after a
  successful execution must settle through the existing exact Surface update
  before the Console accepts another request, preventing a rapid sequential
  run from targeting the just-superseded Console revision.
- Existing Workspace R semantics remain authoritative: an ordinary R error is
  a failed durable execution while a live primary Runtime returns to Ready;
  genuine session, kernel, broker or persistence failure may still mark the
  Runtime Failed. R1 adds regression evidence around this distinction but does
  not introduce automatic restart or reinterpret existing durable records.
- History listens to the existing `rho://runtime-registry-changed`
  invalidation so the final Ready/Failed transition reloads the durable
  projection after each execution. Browser/mock parity uses its existing
  invalidation callback; no new Tauri event, command, table or polling loop is
  added.
- Acceptance requires pure LF/CRLF gap tests, toolbar/Command+Enter navigation
  and rapid sequential execution tests, raw-string rejection projection,
  History reload evidence, the complete frontend gate, affected Rust tests,
  browser smoke and rebuilt debug-app review. The prior WP15 automated evidence
  remains implementation evidence but not owner interaction acceptance.

WP15-R1 evidence and checkpoint review (2026-08-23):

- The Source resolver now advances past blank/comment-only gaps, preserves
  continued expressions across an intervening blank line, and exposes a
  navigation-only gap result. Toolbar and Command+Enter share that result;
  terminal gaps stay silent and no gap path reaches Runtime, Console, History
  or the global error surface.
- Console execution retains its busy guard until the exact post-result Surface
  update settles. A delayed-persistence regression proves a second Source
  request is rejected locally while that revision is pending and succeeds
  after settlement. Raw Tauri strings and bounded object/Error messages now
  retain their actual reason instead of collapsing to the generic fallback.
- The existing `rho://runtime-registry-changed` event now participates in the
  common invalidation subscription; mock execution emits the same callback.
  App verification proves an already-open History Surface reloads after a
  Source execution without adding a command, event, schema or polling loop.
- Focused Source/App/transport/domain verification passed 108 tests. The
  complete RSR gate passed 158 tests plus typecheck, lint, contract parity,
  Vite build, generated-asset/cutover validation and Chrome smoke. Seven
  Runtime contract tests, two desktop source-range tests, `cargo check`,
  `cargo fmt --check` and `git diff --check` passed.
- The 145 MB `target/debug/rho-desktop` was rebuilt and a new 03:07 debug
  process launched without closing older windows that may contain unsaved
  work. Automated implementation acceptance is complete; exact-window owner
  interaction acceptance remains open. The repair remains in the existing
  uncommitted `0.4.1-dev.14` candidate, with no `.app`, installer, signing or
  distribution operation.

## WP16 — Whole-workbench reliability and every-component optimization

Change class: D3. Risk: R3 because exact project/revision sequencing, Runtime
admission, Surface/Studio/Profile coordination, error truth, debug identity,
and evidence quality meet in the frontend host. Pure presentation sub-slices
may be R1/R2, but the program keeps the higher umbrella gate.

### Problem and audited evidence

- The accepted RSR construction plan specifies `commands/`, `context/`,
  `layout/`, `runtime/`, `studio/`, `surfaces/`, and `vibe/` frontend
  boundaries. The current tree has only `app/`, `contracts/`, `styles/`, and
  `transport/`; `App.tsx` is 4,385 lines and directly coordinates multiple
  revisioned stores, renderer readiness, user errors, and component
  placement.
- `App.test.tsx` contains most interaction evidence in one 2,756-line jsdom
  suite; `mock.ts` is a 2,157-line hand-maintained second host. The complete
  frontend gate is fast, but its browser stage dumps static DOM rather than
  exercising pointer, keyboard, resize, focus, async sequencing, or visual
  geometry.
- `accept-rsr-exact-app.mjs` verifies embedded assets and binary identity but
  performs no workflow. Multiple processes from the same overwritten debug
  binary can remain open under the same `org.yulab.rho` window identity and
  make an older in-memory frontend appear current.
- Tauri error strings, command mappings, invalidation event arrays, mock
  notifications, and component fallback copy are independently maintained.
  The observed blank-gap, stale Console revision, generic Runtime failure,
  History refresh, resize, and continuous-pointer defects are different
  projections of this missing orchestration/evidence layer.

### Program invariants

- Preserve Rust as the authority for project identity, revision/CAS,
  Runtime/Resource/Surface/Profile truth, permission and scientific state.
- React Surfaces render state and emit typed intent. They do not own new
  multi-store workflows, interpret arbitrary transport errors, or hand-build
  invalidation subscriptions.
- Cross-boundary workflows use an explicit controller/state machine with one
  operation identity, serialized per-target mutation admission, named failure
  and recovery states, and deterministic tests. Work that requires atomic
  broker truth stops for a bounded Rust orchestration contract rather than
  simulating atomicity in JSX.
- Every user-visible defect receives the lowest-level deterministic regression
  plus one real interaction scenario when DOM geometry, focus, pointer,
  keyboard, background refresh, or async ordering contributed to the defect.
- Evidence labels are literal: jsdom is component evidence, browser automation
  is browser-interaction evidence, binary hash is build-identity evidence,
  exact desktop workflow is exact-app evidence, and owner feel acceptance is
  never inferred from another level.
- Existing user changes in the dirty worktree remain preserved. WP16 stays in
  the uncommitted `0.4.1-dev.14` development candidate until a later explicit
  integration/version decision; no `.app`, installer, signing, publication or
  release authority is created.

### Component coverage contract

The re-optimization inventory is closed for this program: trusted shell and
status bar; Rho/project menu; Studio/Vibe and Scene/Page controls; command
search; toolbar customization; Compose/catalog; Studio Container, Stack,
drag/drop, resize, adaptive collapse and recovery; Navigator; Source editor;
File preview; R Console; Agent; Environment; History; Artifacts; Plots;
Problems; Logs; Render jobs; Evidence; Git; Help; Check result; Runtime status;
Component playground/developer disclosure; Vibe editor and embedded Surface
blocks; trusted workspace-plugin documents; loading, empty, no-match, busy,
failed, recovering, stale, suspended, placeholder, narrow, keyboard and 200%
zoom states. No listed component reaches completion from a catalog presence
check alone; each requires its task-specific interaction and information-
hierarchy matrix.

### Work packages and sequencing

1. **WP16-A — development identity and real-interaction harness (implemented;
   automated acceptance complete, exact live-window acceptance open).**
   Add a deterministic content-derived frontend build ID, truthful binary
   identity check, single debug launcher, same-binary process rejection, a
   local-system-Chromium interaction runner, reusable preview assertions, and
   deterministic failure/delay hooks that remain mock/debug only. Initial
   scenarios cover Source keyboard continuity, Console/History refresh,
   Studio pointer/resize geometry, and narrow layout. No product protocol or
   backend command changes.
2. **WP16-B — typed failure, operation trace, and invalidation contract
   (B1 complete; cross-process B2 not activated).**
   Introduce one bounded error envelope and frontend normalizer, distinguish R
   execution failure from Runtime infrastructure failure, add redacted
   operation IDs/flight-recorder diagnostics, and generate command/topic/mock
   invalidation parity from one reviewed contract. This package requires its
   own schema/compatibility review before activation.
3. **WP16-C — orchestration boundaries.** Extract Source→Console, Console
   execution/persistence, component requirement emergence, Studio interaction,
   project switching and common versioned-store behavior into typed
   controllers. Evaluate one trusted Rust transaction for workflows that
  cannot truthfully recover across independent Surface/Runtime/Studio
  mutations. `App.tsx` becomes shell composition rather than workflow owner.
4. **WP16-D — every-component re-optimization.** Traverse the closed inventory
   in vertical task slices. Each Surface defines default focus, primary task,
   action budget, information hierarchy, area use, keyboard/pointer behavior,
   all task states, responsive behavior, accessibility name/order, and a real
   interaction/visual scenario before the next slice.
5. **WP16-E — integrated acceptance.** Run focused/property/fault tests,
   generated parity, the complete frontend/Rust matrix, real Chromium workflows
   at wide/minimum/200% zoom, exact raw-debug desktop workflows, performance
   budgets, post-implementation contract review, NEWS/version decision and
   owner acceptance. Package/release operations remain separately authorized.

### WP16-B activation review (2026-08-23)

WP16-B is split so the first slice does not guess a public error schema or
silently broaden Runtime authority:

1. **WP16-B1 (active)** introduces a frontend-internal `WorkbenchFailure`
   taxonomy and normalizer over existing thrown values, an ephemeral bounded
   operation trace, and one reviewed frontend invalidation manifest used for
   parity validation. It changes no Rust struct, Tauri command/event payload,
   database, persistence, retry policy, admission rule, permission, project
   root or execution authority. Raw strings remain compatible inputs; UI copy
   is bounded and redacted before presentation or diagnostics.
2. **WP16-B2 (not active)** may add a cross-process structured error envelope
   only after a separate Rust/TypeScript schema and backward-compatibility
   review. B1 must not manufacture stable backend error codes from text or let
   frontend classification redefine Runtime truth.

`WorkbenchFailure.kind` is closed to `user_input`, `admission`, `conflict`,
`runtime_execution`, `runtime_infrastructure`, `transport`, and `unknown`.
It carries a bounded human message, an optional safe operation identifier,
retryability and presentation scope; it never carries a stack, project path,
source code, credential, raw payload or durable retry decision. The trace is
memory-only, capped at 64 entries, reset by reload/project switch, and records
only operation name, stage, safe failure kind, elapsed time and redacted ID.
R evaluation errors remain Console/History execution outcomes; inability to
admit or contact the Runtime is infrastructure/transport failure and must not
be rendered as R output.

WP16-B1 acceptance requires focused normalization/redaction/ring-buffer tests,
success/rejection/failure/recovery operation coverage, invalidation-manifest
parity for Tauri and mock transports, existing raw-rejection regression,
project-switch reset/isolation, the complete RSR gate and post-implementation
review. Any need for backend error codes, persisted traces or automatic retry
stops this package for B2 review.

### WP16-B1 implementation evidence and checkpoint (2026-08-23)

- `workbench-failure.ts` accepts existing strings, `Error` objects and message
  records, then emits the closed failure taxonomy with bounded copy, safe
  operation IDs, retryability and presentation scope. Local absolute paths and
  control characters are removed; stack/payload/source content is never copied.
  Explicit R evaluation outcomes retain `runtime_execution` instead of being
  mislabeled as Runtime infrastructure.
- `operation-trace.ts` records only operation name, generated local ID, stage,
  elapsed milliseconds and failure kind. The ring is capped at 64, clears when
  the accepted project identity changes, preserves failed-attempt truth across
  a later successful retry, and is available only through the explicit Copy
  session diagnostics action in the Rho menu.
- Studio edits, project switching and Runtime admission use the trace boundary;
  user-facing catches use the shared normalizer. A resolved R execution failure
  remains a Console/History result, while a thrown Runtime/transport failure is
  classified at the infrastructure boundary.
- `invalidation-contract.ts` is the single reviewed nine-topic manifest for
  kernel, Surface, plugin-Surface, Check, Studio, Profile, Runtime, Resource and
  Agent subscriptions. Tauri subscriptions consume it directly; mock scenario
  perturbation exports exact topic parity and routes named notifications through
  the same vocabulary.
- Focused success/rejection/failure/recovery, redaction, ring-cap, project-reset
  and parity tests pass. `npm run rsr:check` passed with 16 files / 170 tests,
  typecheck/lint, contract, deterministic assets, cutover, Chrome smoke and
  real interactions. No backend schema, durable trace, automatic retry or new
  authority was needed, so WP16-B2 remains inactive.

### WP16-C1 activation review (2026-08-23)

The first orchestration extraction is the Source-to-Console execution router.
It moves endpoint registration, preferred-Console selection, renderer-ready
waiting, rapid-preparation deduplication, project reset, ambiguity handling and
admission reporting from `App.tsx` into a typed controller. The controller is
frontend/session-only and receives the existing requirement resolver as a
callback; it does not create Surfaces, choose a Runtime, edit a Scene, persist
state or invoke Tauri itself. Those existing owners and revision checks remain
unchanged.

Acceptance requires focused tests for sole/preferred/ambiguous endpoints,
wait/register/timeout, deduplicated preparation, admission rejection, rapid
requests, project reset and disposal; existing Source/Console/History and real
browser scenarios must remain green. The slice must reduce orchestration state
owned directly by `App.tsx` without changing public contracts. Further Console
persistence and Studio controllers are not active until their checkpoint.

### WP16-C1 implementation evidence and WP16-C2 activation (2026-08-23)

- `ConsoleExecutionRouter` now owns endpoint registration/unregistration,
  renderer-ready wait/timeout, preferred target, multiple-visible rejection,
  per-Source preparation deduplication, admission reporting, project reset and
  disposal. It has no transport/store/Layout mutation capability; the existing
  resolver retains all Runtime, Surface and Studio CAS decisions.
- Focused tests cover sole/preferred/ambiguous targets, register/wait/timeout,
  concurrent preparation, admission rejection, project reset and disposal.
  Existing 72 App tests and the Source/Console/History browser workflow remain
  green. `App.tsx` no longer owns the four endpoint/waiter/preparation/preference
  registries. `npm run rsr:check` passed with 17 files / 177 tests.
- **WP16-C2 (active)** extracts the project-switch transaction controller:
  duplicate-click suppression, response-state mapping, restored-project
  refresh, accepted-project refresh/commit, bounded failure reporting and
  final cleanup. It may call only the existing broker operation and injected
  projection refresh callback. It cannot normalize/guess a project root,
  bypass blockers, persist last-opened state, discard drafts, or mutate a
  project directly. Acceptance covers cancelled, blocked, unavailable,
  failed-restored, fatal, thrown, accepted and rapid duplicate paths plus the
  existing A→B→A UI tests.

### WP16-C2 implementation evidence and WP16-C3 activation (2026-08-23)

- `ProjectSwitchController` now owns duplicate admission, the closed broker
  response-state mapping, accepted/restored projection refresh sequencing,
  bounded failure normalization and unconditional final cleanup. The App
  injects only the existing broker operation, refresh callbacks and UI-state
  lifecycle; broker validation, blockers, root normalization and rollback
  remain authoritative.
- Focused tests cover ready, cancelled, blocked, unavailable, failed-restored,
  fatal, thrown and rapid-duplicate paths, including path redaction and release
  of the in-flight lock after failure. The complete gate passes with 18 files /
  182 tests, exact contract/assets/cutover, Chrome smoke and real Source,
  Console, History, docking, resize and narrow-layout interactions.
- **WP16-C3 (active)** extracts Console execution admission and result/view-
  state persistence from the Surface renderer into one instance-scoped
  controller. It owns only frontend busy admission, draft/history/output
  projection, bounded history/output retention and serialized persistence of
  the existing Console view state. Runtime Registry remains the sole execution
  and generation authority; Surface Runtime remains the revisioned view-state
  owner. The controller cannot select a Runtime, create/rebind a Console,
  synthesize Runtime outcomes or retry execution. Acceptance covers blank,
  unattached, busy, recovering, failed, ready success, thrown execution,
  persistence rejection/recovery, source draft preservation, composer draft
  clearing and rapid duplicate submission.

### WP16-C3 implementation evidence and WP16-C4 activation (2026-08-23)

- `ConsoleInstanceController` now owns instance-local Runtime-state admission,
  one in-flight execution, composer-versus-Source draft semantics, bounded
  history/output projection, serialized view-state persistence and recovery
  after a rejected persistence write. Rendering subscribes to its immutable
  snapshot and no longer coordinates asynchronous execution through React
  state refs.
- Focused tests cover blank/unattached/busy/recovering/failed/ready states,
  duplicate suppression, thrown execution and retry, source draft retention,
  composer clearing, 100-entry bounds, and rejected-write serialization. The
  complete gate passes with 19 files / 189 tests plus contract/assets/cutover,
  Chrome smoke and the real Source/Console/History interaction suite.
- **WP16-C4 (active)** extracts the existing user-triggered Console requirement
  resolver into a typed controller. It may rank same-project eligible Console
  instances, attach one unbound instance to the already-authoritative primary
  Runtime, open one existing Console factory as the last resort, apply the
  existing activation/`replace_root` Scene edits, and wait for the exact
  renderer. It must re-read and validate project/Source placement before the
  Scene mutation. It cannot create a Runtime, resume failed/suspended Surfaces,
  pick across projects, run in Vibe, or add a command/schema. Acceptance covers
  not-ready/mode/project/runtime rejection, eligible reuse ordering, paused/
  failed refusal, attach, create, inactive-Stack activation, placement,
  renderer wait and project/layout race rejection.

### WP16-C4 implementation evidence and WP16-C5 activation (2026-08-23)

- `ConsoleRequirementController` now owns the bounded same-project resolver
  over injected Surface/Studio/Runtime/Profile snapshots and existing mutation
  ports. It ranks eligible instances, refuses suspended/failed recovery,
  attaches or opens only through existing commands, applies ordinary Scene
  edits, revalidates project and Source placement after asynchronous work, then
  waits for and prefers the exact renderer.
- Focused tests cover readiness, mode, project and Runtime rejection; inactive-
  Stack ordering; paused/failed refusal; unbound attachment; last-resort open/
  placement; renderer selection; and Source-removal race rejection. Existing
  App emergence cases remain green. The complete gate passes with 20 files /
  195 tests plus real Source/Console/History, resize, docking and narrow-layout
  interactions.
- **WP16-C5 (active)** extracts ordinary Studio Scene mutation admission into a
  serialized controller. Focus/close/resize/drop and undo/redo must construct
  their requests from the latest ready Studio snapshot when their queue entry
  starts, not from a render-time closure. Drop computation remains the pure
  accepted model and creates one `replace_root`; errors use the shared bounded
  operation trace and never leave the queue blocked. It adds no Scene grammar,
  persistence or backend authority. Acceptance covers ordering, latest-
  revision use, not-ready/no-op drop, apply rejection/recovery, drop semantics,
  and undo/redo admission.

### WP16-C5 implementation evidence and WP16-C6 activation (2026-08-23)

- `StudioMutationController` serializes ordinary Scene edits, drop model
  computation and undo/redo. Every queued operation reads the latest installed
  Studio snapshot before constructing its request; valid drops emit one
  ordinary `replace_root`, while self/invalid drops remain no-ops. Rejections
  use the shared trace/failure boundary and do not poison the queue.
- Focused tests prove queue ordering and next-revision use, valid/self drop,
  unready refusal, failed-apply recovery and undo/redo admission. The complete
  gate passes with 21 files / 200 tests, and actual pointer docking and boundary
  resizing remain green in Chromium.
- **WP16-C6 (active)** introduces the common per-Surface versioned mutation
  boundary for lifecycle and view-state/binding writes. Each instance queue
  captures the admitted project, re-resolves the exact current instance and
  revision when work starts, and rejects rather than crossing a project switch.
  Console, File, Navigator, Agent, Environment/domain and generic view-state
  persistence must use this boundary instead of render-time Surface snapshots.
  Surface Runtime remains the mutation/revision authority. Acceptance covers
  rapid serialization, latest revision, missing/unready/project-changed
  rejection, failed-write recovery, two-instance isolation, suspend and resume.

### WP16-C6 implementation evidence and WP16-C checkpoint (2026-08-23)

- `SurfaceInstanceMutationController` now provides independent per-instance
  queues for view-state, binding and lifecycle mutations. It captures the
  admitted project, re-resolves the latest exact instance/revision when an
  entry starts, recovers after rejection, and refuses missing/unready or
  cross-project work. Console, File, Agent and generic component view-state,
  Resource binding, view groups, pause and resume use this common boundary.
- Focused tests cover latest-revision serialization, two-instance independence,
  failed-write recovery, unready/missing/project-changed rejection and current-
  revision suspend/resume. The complete frontend gate passes with 22 files /
  205 tests, generated contract/assets/cutover, Chrome smoke and all real
  interaction scenarios. `App.tsx` is reduced from the audited 4,385 lines to
  3,987 lines while Rust/project/Runtime/Surface authorities remain unchanged.
- WP16-C is complete: Source routing, Console instance execution, component
  requirements, project switching, Studio mutations and common Surface
  mutation admission now have explicit tested owners. No workflow required a
  new Rust transaction, public schema or backend authority, so no such contract
  is activated.

### WP16-D1 activation review (2026-08-23)

The first every-component slice covers the task spine visible in the default
workbench: trusted shell/top and status bars; Rho/project menu; Studio/Vibe,
Scene/Page and command controls; Navigator; Source/File preview; R Console; and
their loading/empty/busy/error/recovery/narrow states. It audits actual wide,
760px and 200%-equivalent geometry for default focus, action priority,
duplicated labels, unused area, clipping, keyboard order and accessible names.
Changes are presentation and existing-intent wiring only; no new command,
mutation, persistence, schema or backend behavior is authorized. Acceptance
requires a checked component matrix, focused DOM/a11y regressions, real pointer
and keyboard workflows at wide/narrow geometry, and token-only CSS changes.

### WP16-D1/D2 implementation evidence and WP16-D3 activation (2026-08-23)

- `surface-ux.ts` closes the first-party inventory with a human label, primary
  task/action, default focus, action budget, area role, narrow behavior and
  empty-state instruction for all 18 factories. Unknown plugin identifiers are
  humanized at the trusted boundary instead of leaking technical IDs into
  visible chrome.
- Navigator and trusted plugin documents now expose keyboard-roving tabs with
  explicit tab/panel relationships. Navigator's empty Recent outputs region
  offers the existing Artifacts view as its next action. The mock plugin uses
  meaningful Summary and Configure modes, so the browser path verifies actual
  interaction instead of decorative tab text.
- The common Surface menu exposes every factory-declared mode through the
  existing latest-revision view-state mutation boundary. Environment
  Packages/Requests and other multi-mode components can therefore be reached
  without adding a contract or renderer-specific mutation path. File,
  Environment and domain load failures use bounded safe copy; Agent empty state
  names its next action. The complete gate passed with 23 files / 210 tests,
  typecheck, lint, contract/assets/cutover validation, Chrome smoke and real
  Navigator, plugin-tab, Surface-mode, Source/Console/History, docking, resize
  and narrow-layout interactions.
- **WP16-D3 (active)** covers Vibe Page editing and the remaining secondary
  shell surfaces: Compose/catalog, status bar and developer disclosure. The
  Vibe default must read as a focused document, not an always-expanded internal
  builder: document actions remain visible, text formatting is compact, block
  layout/removal controls appear only for a selected block, add actions have
  human labels, Save truth remains adjacent to the page identity, and embedded
  empty Surfaces do not reserve a viewport-sized blank region. At narrow and
  200% zoom the page and control groups reflow without document-level
  horizontal overflow or inaccessible actions. Compose/developer/status
  changes may reprioritize and disclose existing information only; no Page,
  Profile, Surface, Studio, Runtime, plugin or persistence contract changes are
  authorized. Acceptance requires focused DOM/keyboard tests, real Vibe edit
  and 200%-zoom browser scenarios, token-only CSS, complete affected gates and
  a post-implementation ownership review.

### WP16-D3 implementation evidence and WP16-E activation (2026-08-23)

- Vibe no longer renders persisted block focus as if the user had made a live
  selection. Its visible controls are grouped into text, edit history, add and
  document actions; block ordering, width, section layout and removal appear
  only after pointer selection. The Page revision leaves default chrome, Save
  truth sits beside the Page title, and component choices use human Surface
  labels.
- Embedded Vibe Surfaces derive a bounded content height from their component
  area role. Empty Check result/context views no longer reserve 62% of the
  viewport, while primary editors retain a usable document area. The toolbar
  wraps at narrow geometry rather than becoming a horizontal control strip.
- Compose now explains its direct-manipulation task, leads with compact human-
  task component rows, and keeps the layout tree, Resource registry, Runtime
  controls and developer previews behind explicit disclosures. Its own Done
  action closes the panel without duplicating Done in the optional top-bar
  projection. The status bar omits idle task copy and retains only live health,
  operations, Diagnostics and project context.
- Focused typecheck, lint and 74 App interaction tests pass. Real Chromium
  proves pointer block selection, keyboard Add text/Save, bounded embedded
  component height and zero horizontal overflow at a 720px viewport representing
  200% zoom on a 1440px display, alongside all previous navigation, mode,
  Source/Console/History, resize, docking, rejection and narrow scenarios.
- **WP16-E (active)** is integration and handoff only. It may run complete
  frontend/Rust checks, deterministic asset and raw-debug builds, inspect
  ownership/version/document evidence and report measured residuals. It may
  not add behavior, package an `.app`/installer, sign, publish, close another
  Rho process or infer owner feel acceptance. A behavioral defect stops and
  reopens the owning D slice. Completion requires the complete frontend gate,
  affected Rust tests/check/fmt, whitespace review, current raw-debug build,
  synchronized NEWS/version decision, post-implementation contract review and
  an explicit separation of automated, exact-window, owner and release facts.

### WP16-E integration evidence and checkpoint (2026-08-23)

- `npm run rsr:check` passed end to end: typecheck, lint, deterministic build
  and process identity, Rust/TypeScript fixture parity, 23 frontend files / 210
  tests, production Vite build, generated-asset and cutover validation, Chrome
  smoke, and the complete real-interaction suite. The large browser fixture
  became ready in 1,895 ms with one heavy projection mounted and 24 released.
- Real Chrome interaction covers build identity, pointer and keyboard resize,
  Navigator/project-component tabs, component modes, rapid Source/Console/
  History continuity, injected rejection recovery, docking, narrow recovery,
  plus Vibe pointer selection and keyboard editing at 720px/200%-equivalent
  geometry with zero document or toolbar horizontal overflow.
- `cargo fmt --all -- --check`, `cargo test -p rho-ui-contract -p rho-desktop`,
  `cargo check -p rho-desktop`, and `git diff --check` passed. Desktop reported
  321 passed / 1 explicitly ignored opt-in Keychain smoke; the UI contract
  reported 51 passed. No R package files changed, so the independent R package
  suites and the unrelated full Rust workspace were intentionally not claimed.
- A separate post-verification review found no blocking contract drift: project,
  Runtime, Surface, Studio and Vibe revisions remain with their accepted Rust
  owners; view modes use the common latest-revision controller; UI profiles own
  only presentation; mock/Tauri invalidation parity remains generated; D3 adds
  no network, credential, filesystem or execution authority. `playwright-core`
  is a development-only Apache-2.0 dependency, launches an already-installed
  system browser, and downloads no browser binary. New visual values remain in
  the design-token suite.
- Application authorities remain synchronized at `0.4.1-dev.14`; this work
  completes the already-uncommitted candidate instead of minting another
  exploratory version. `NEWS.md` records the implemented behavior. R package
  versions are unchanged. No `.app`, installer, signature, publication or
  release action occurred; public release remains NO-GO.
- Exact raw-debug acceptance is truthfully open. `desktop/dist` now identifies
  frontend build `450e160ac852`, while the 11:43 `target/debug/rho-desktop` does
  not embed its generated `index-DaoPphhD.js`. PIDs 92207 and 92459 are running
  that checkout binary; the safe development launcher refuses to overwrite or
  launch beside them, and this work did not close either potentially stateful
  window. After they are quit, `cd desktop && npm run rsr:dev:desktop` performs
  the exact build/identity check and starts one current raw-debug window.
- Residual non-blocking engineering findings are the existing lazy Monaco chunk
  warning (3.63 MB / 924 KB gzip, kept out of initial render until Source mounts)
  and the still-large 4,139-line shell renderer. Cross-store workflow ownership
  has moved to tested controllers, but further presentation-component extraction
  remains maintainability work rather than an acceptance or authority defect.
  Owner interaction/feel acceptance is not inferred from automated evidence, so
  this contract remains `active-`.

### WP16-R1 one-command debug restart activation (2026-08-24)

The development launcher becomes the owner of one invocation's exact debug
process replacement. Before any build it partitions detected `rho-desktop`
processes by resolved executable path. Foreign-path processes fail closed and
receive no signal. Exact current-checkout processes receive the platform's
non-force termination request (`SIGTERM` on POSIX and `taskkill` without `/F`
on Windows); the launcher polls the same exact-path inventory for at most a
bounded interval and continues only after every target has disappeared. Signal
rejection or timeout is a visible failure and never escalates to `SIGKILL`,
`taskkill /F`, or another forced termination. An
explicit `--no-restart` escape hatch retains inspection-only refusal semantics;
launcher flags are not forwarded to the product process.

Acceptance requires deterministic no-process, successful multi-process,
already-exited race, foreign-process refusal, signal-failure and timeout tests;
the process-identity gate and complete frontend gate must remain green. Manual
evidence must show the two currently running exact debug processes are replaced
by one current binary through the single npm command. No `.app`, installer,
versioned release or product shutdown command is in scope.

### WP16-R1 implementation evidence and checkpoint (2026-08-24)

- `stopExactDebugProcesses` partitions exact and foreign executables, rechecks
  each PID immediately before signalling, tolerates an already-exited race,
  requests only non-force platform termination, polls for bounded confirmed
  exit, and reports signal failure or timeout without escalation. Default npm
  startup uses it automatically; `--no-restart` retains the prior refusal path
  and is removed from arguments forwarded to the product.
- Deterministic Node evidence covers no existing process, two-process success,
  exit-before-signal, foreign-path refusal without any signal, signal failure,
  and timeout with exactly zero force-kill attempts. Syntax checks, the process-
  identity gate and `git diff --check` pass.
- Real one-command evidence passed. A first invocation built and launched exact
  frontend `450e160ac852`. A second invocation found exact same-checkout PIDs
  34939 and 35171, stopped both through the bounded path, rebuilt, verified
  `assets/index-DaoPphhD.js` inside the 152,338,080-byte debug binary, then
  opened the current development window from launcher PID 35618. The verified
  binary SHA-256 was
  `ce8ca4903b1382f168d973f73bfeada28b7d13166cd5556ebfb1003bc8795e88`.
- The complete frontend gate remains green with 23 files / 210 tests, generated
  contract/assets/cutover checks, Chrome smoke (large fixture 1,860 ms) and all
  real interactions. This repair remains in the existing uncommitted
  `0.4.1-dev.14` candidate; NEWS is amended, no R/package/backend version changes
  are required, and no `.app`, installer, signing or release action occurred.
- WP16-E's earlier exact-window blocker is closed by this later repair. Owner
  visual/feel acceptance and public-release gates remain separate and open, so
  the governing document stays `active-`.

### WP16-R2 Console transcript ownership and Agent context budgeting activation (2026-08-24)

The owner explicitly authorized construction after a Console execution tried
to persist a 281,246-byte `update_surface.view_state` value through the existing
65,536-byte Surface metadata boundary. Repository inspection found that
`ConsoleViewState.outputs` retained complete `RuntimeExecutionResult.events`
and serialized the growing transcript after every execution. The item-count
cap therefore did not bound bytes and made successful scientific output fail a
presentation-state mutation. The same inspection found independently bounded
Agent history, editor, project-Skill and plugin context fragments without one
aggregate attachment budget or an explicit omission manifest.

WP16-R2 is a D2/R2 corrective package. It owns one compatible vertical slice:

- Console live state retains the composer, in-session command history and a
  byte-bounded normalized transcript cache. Raw Runtime events are projected
  once for display and are never copied into Surface `view_state`.
- persisted Console view state is versioned lightweight presentation metadata
  only. Legacy `draft`, `history` and `outputs` may be recovered into the
  current renderer once, but the next automatic write compacts them out. The
  64 KiB Surface boundary remains a defense for generic component metadata,
  not an execution-output quota.
- byte retention preserves the newest complete Console entry, reports released
  older entries in the UI, and never changes the success/failure of the Runtime
  operation. Workspace R Run Store/History remains the durable scientific
  authority. Auxiliary Runtime output remains session-only under this package.
- Agent prompt construction applies one aggregate character budget to the
  already-authorized exact-Conversation history, explicit editor/problem
  context, project Skills and workspace-plugin context. The current user
  request remains outside that attachment budget and authoritative. Every
  shortened or omitted section is declared in a context manifest.
- no Console transcript, recent Run output or other new project data is
  automatically added to Agent Provider context. Full editor context remains
  durable for exact proposal validation while only its bounded projection is
  sent to the model. Conversation ownership remains exact and at most four
  prior terminal turns are considered.

This slice adds no database migration, Tauri command/event, Runtime response
schema, Provider credential, approval, filesystem, execution or project
authority. A generalized append-only `runtime_output_chunks` journal, streamed
execution events, cursor paging and rich-output references require a separate
D3/R3 package with schema backup/recovery, failure injection, mock parity and
two-project migration evidence; WP16-R2 must not partially introduce them.

Acceptance requires regression coverage for the observed oversized legacy
state, exact encoded persisted-state bounds, Unicode byte-shaped transcript
eviction, newest-entry preservation, visible release disclosure, rejected
write recovery and sibling-Console isolation. Agent coverage must prove the
aggregate budget and omission manifest, exact-Conversation/four-turn history,
bounded oversized editor/Skill/plugin inputs, unchanged current request, no
automatic Console/Run-output attachment and existing instruction-precedence
guards. The complete frontend gate, affected `rho-server` tests, formatting,
`git diff --check`, NEWS/version review and post-implementation contract review
are mandatory. Stop at this checkpoint before any output-journal schema or
streaming protocol work.

### WP16-R2 implementation evidence and checkpoint (2026-08-24)

- Console persistence now emits only `schema_version: 2`, bounded filter text,
  and finite scroll position. Legacy draft/history/raw-event state is recovered
  into the current session once and compacted automatically; no Runtime payload
  is sent through `update_surface.view_state` after execution.
- Raw Runtime events are projected once at the execution boundary. A per-project
  session cache keeps each Console instance's draft, command history and
  transcript across Stack renderer release, clears on project switch, retains
  at most 100 records and 8 MiB of encoded output, and always preserves the
  newest bounded projection. A visible notice links released Workspace R
  entries to History.
- Agent prompt construction now gives explicit editor/problem context first
  budget priority, exact-Conversation history next, then project Skills and
  workspace-plugin context within one 64K-character attachment ceiling. Unused
  shares are redistributed, every section has an original/included count and
  status manifest, and the current user request is appended unchanged outside
  the ceiling. No Console or Run source was added to prompt collection.
- Regression coverage includes legacy recovery/compaction, encoded metadata
  size, Unicode filters, byte-shaped transcript release, newest-entry
  preservation, rejected-write recovery, large App-level Runtime output,
  sibling Console isolation, aggregate Agent budgeting, unchanged current
  request and instruction precedence. `npm run rsr:check` passed with 23 files /
  214 tests plus typecheck, lint, contract/asset/cutover checks, Chrome smoke and
  real interactions. `cargo test -p rho-server` passed 104 library tests and one
  binary test.
- Version impact stays inside the uncommitted `0.4.1-dev.14` candidate and is
  recorded in `NEWS.md`; no R package version changed. No package, `.app`,
  installer, signing, commit or release was produced. The D3/R3 durable output
  journal, streaming/cursor protocol and installed-app feel acceptance remain
  separate open work.

### WP16-A acceptance gate

- The frontend build ID is deterministic for identical source inputs, changes
  when a shipped frontend input changes, is present in preview evidence, and
  visibly distinguishes the running debug UI without exposing private paths.
- The exact binary checker fails when another process from either a foreign or
  the same checkout binary can make desktop identity ambiguous. Before WP16-R1
  the debug launcher refused all live windows; WP16-R1 supersedes that launcher-
  only behavior for exact same-checkout debug processes through bounded non-
  force termination, while foreign windows and force-kill remain prohibited.
- Browser interaction uses the locally installed Chrome/Edge channel through
  a test-only dependency and downloads no browser. It performs actual
  keyboard, pointer and resize actions, asserts user-visible outcomes, captures
  bounded failure artifacts, and always closes its isolated context/process.
- A deterministic scenario transport can delay or reject named operations and
  reorder/duplicate/drop named invalidations without production behavior.
  Initial regressions prove rapid sequential Source execution, History refresh,
  pointer docking, residual-space resize, narrow recovery and raw rejection
  projection.
- Focused tests, typecheck/lint, the complete RSR gate, generated-asset
  determinism, `git diff --check`, and exact debug build identity pass. Manual
  owner feel acceptance remains a separate WP16-E fact.

### WP16-A implementation evidence and checkpoint (2026-08-23)

- `scripts/rsr-build-identity.mjs` hashes a sorted, bounded inventory of shipped
  frontend inputs. Vite injects the 12-hex identity into the app, emits
  `build-identity.json`, exposes it in preview evidence, and the Rho menu shows
  a quiet copyable Development build row. Repeated inputs and changed-input
  behavior have a direct Node regression.
- `scripts/run-rsr-debug.mjs` is the single raw-debug launcher behind
  `npm run rsr:dev:desktop`. Its original checkpoint refused any already-
  running same/foreign `rho-desktop`; WP16-R1 supersedes only the same-checkout
  behavior after the owner rejected manual process maintenance.
- `playwright-core@1.61.0` uses installed Chrome/Edge only. The interaction
  gate performs real Source shortcut/gap navigation, rapid Console→Source
  execution, live History refresh, injected rejection/no-false-History,
  separator resize, cross-pane docking, build identity and 760px narrow-layout
  recovery. Failure HTML/screenshot artifacts are bounded and retained only on
  failure; isolated browser state is always closed.
- Mock/debug scenarios now deterministically delay/reject Runtime execution and
  drop, duplicate, delay or reorder named invalidations. Focused tests prove
  rejection leaves Runtime and History unchanged, delayed mutation stays
  pending until its gate, and invalidation perturbation does not alter source
  snapshots.
- `npm run rsr:check` passed with 13 files / 161 tests plus typecheck, lint,
  contract parity, deterministic assets, cutover, Chrome smoke and real
  interactions. `cargo build -p rho-desktop` and `git diff --check` passed.
  The rebuilt binary contains the current generated frontend entry.
- Exact live-window verification correctly stopped because PIDs 92207 and
  92459 were already running the same checkout binary. They were not killed;
  therefore raw-window/manual owner acceptance is explicitly open, not
  reported as passed. No package, `.app`, installer or release was produced.

### WP4 — runtime status language (complete 2026-08-22)

- Console Busy: indeterminate progress bar in the Console and the composer
  action becomes a reachable Stop (runtime interrupt); reduced-motion keeps a
  static bar.
- Agent Running: status row with elapsed time from `started_at` and a Stop
  control wired to the existing turn-cancellation lane.
- Workspace R Recovering: when the attached Runtime reports
  `restarting`/`starting`, the Console is covered by a recovery card with
  Cancel restart (maps to the existing interrupt primitive; a dedicated
  restart-cancellation command would be a separate kernel gate) and Open
  diagnostics (opens the Logs Surface through the factory lane).
- Agent Dependency Failure: the degraded banner, copy-ready diagnostics, and
  Retry remain, now on design-language styling.
- Plugin Surface Unavailable: failed plugin documents and placeholder
  lifecycles offer Retry and Close Surface.
- Evidence: two new regression tests (Console Stop reaches interrupt; Agent
  running row reaches cancellation); `npm run rsr:check` green (45 tests).

### WP5 — Vibe and plugin alignment (complete 2026-08-22)

- Vibe page, toolbar, callouts, and export tray now run on tokens; the
  document body keeps `--rho-font-doc`; the section layout toggle reports the
  current layout ("Layout: Flow/Grid") instead of an ambiguous "Flow / Grid".
- All `.rho-plugin-*` block styles consume tokens, so workspace-plugin
  Surfaces inherit the language automatically.
- Evidence: `npm run rsr:check` green (45 tests); `?mode=vibe` and
  `?plugin=surface` captures.

### Integration and version decision (2026-08-22)

- Application version bumped `0.4.1-dev.13` → `0.4.1-dev.14` in
  `Cargo.toml`, `desktop/src-tauri/tauri.conf.json`, `desktop/package.json`,
  and `desktop/package-lock.json` (plus the workspace-only entries in
  `Cargo.lock`); `NEWS.md` records the shipped behavior under `0.4.1-dev.14`.
- No R package bump (no R change); no release authority exercised.
- Final validation: `cargo fmt --all -- --check` clean;
  `cargo test --workspace --locked` green (all crates);
  `npm run rsr:check` green (45 frontend tests, contract parity, cutover,
  browser smoke); `git diff --check` clean.
- Incident note: during real-window verification the debug app process
  outlived its wrapper kill and stayed interactive for several minutes; the
  `workspace-plugin-minimal` profile's saved Scene arrangement changed during
  that window (layout only — instances, conversations, files, and runs are
  intact; the arrangement is user-rebuildable or one-click resettable via
  Scene ▸ Reset to Rho Studio). Saved-scene restore itself rendered
  correctly, and the fresh-project walkthrough was unaffected.
