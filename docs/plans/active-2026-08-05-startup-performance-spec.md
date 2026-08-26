# Rho Startup Performance And Progress

Status: active; STARTUP-PERF WP1/WP2 implemented, STARTUP-INFO-1 authorized
Owner: desktop startup/runtime and workbench initialization
Date: 2026-08-05; STARTUP-INFO-1 amendment 2026-08-26
Authorization: the owner requested a new task to replace the information-poor
startup component on 2026-08-26. This authorizes the bounded STARTUP-INFO-1
program and its feature/integration slices below.
Change class: D2 bounded user workflow
Risk: R3 because startup admission, retry, project restoration, and truthful
failure recovery remain safety-critical even though this amendment adds no new
backend authority or persistence.

## Problem And Evidence

Rho originally performed several R subprocess probes on every fresh desktop
process, waited for Workspace R before revealing the workbench, and performed
non-critical project/Agent/environment queries before startup was considered
complete. STARTUP-PERF WP1/WP2 introduced validated runtime caching, bounded
timing telemetry, and deferred non-critical work.

The current React startup shell still collapses three authoritative operations
into one opaque `preparing` Promise:

1. bootstrap and validate the local R runtime;
2. start Workspace R and its project-scoped services;
3. restore the last opened project.

It renders one spinner and the static sentence “Starting Workspace R,
restoring the project, and reconciling its Surfaces…”. The frontend therefore
cannot say which operation is active, which facts are already established, or
where a failure occurred. “Reconciling its Surfaces” is inaccurate because the
Workbench projection and Surface loading begin only after this shell exits.
The mark also renders as `RRho`: the JSX still references deleted
`.rho-mark`/`.rho-mark-glyph` styles. Existing mock, component, and visual
acceptance coverage does not hold or capture the startup shell.

## Authority And Cross-Review

- This document owns startup sequencing, performance, and the additive
  STARTUP-INFO-1 progress projection.
- `implemented-2026-08-21-rsr-full-construction-plan.md` owns the current RSR
  cutover baseline. Its newer admission rule resolves an obsolete sentence in
  this document: R bootstrap, Workspace R start, and a broker-returned `ready`
  project restoration complete before `WorkbenchApp` mounts. Only
  non-critical Workbench queries run after first paint.
- `implemented-2026-08-26-startup-unavailable-project-recovery-repair-spec.md`
  owns recovery truth. Runtime preparation failure offers `Choose Rscript`;
  healthy Workspace R with an unavailable project offers `Choose project`;
  only a `ready` project transition admits the Workbench.
- `implemented-windows-startup-diagnostics-and-recovery-design.md` remains
  historical design evidence for stable phases, codes, diagnostics, and
  privacy. Where it allows a disconnected Workbench after Workspace start
  failure, the newer RSR baseline above governs current behavior.
- `active-2026-08-22-studio-design-language-and-ux-overhaul-design.md` owns
  visual tokens, status presentation, focus-treatment appearance, target
  geometry, and reduced-motion styling.
- `accepted-2026-08-21-plugin-native-surface-runtime-design.md` retains focus
  authority, keyboard/document order, accessible roles and behavior, and
  responsive reflow. STARTUP-INFO-1 follows those rules without creating a
  second focus or accessibility authority.
- `AM-W3-11` keeps `App.tsx` as the startup/recovery shell and top-level
  Workbench transition. STARTUP-INFO-1 does not move Workbench composition back
  into that file.
- Project identity, last-opened-project persistence, Workspace R, Surface,
  Runtime, Agent, credential, approval, and execution authorities do not move.

No schema, command, Tauri event, filesystem, network, credential, approval,
execution, or public protocol is added. The progress projection is derived
only from the existing ordered await boundaries. The coordination matrix entry
is an integration-lane write because another active integration lane currently
owns `docs/project/active-document-cross-review.md`; product code must not be
wired into `App.tsx` until that entry is present.

## Existing Performance Contract

1. Runtime discovery remains authoritative. A cached runtime configuration may
   be used only when its Rscript path, Rscript file metadata, Ark resource
   metadata, and user startup-file metadata still match the cache key.
2. A stale, corrupt, or incompatible cache is ignored and the existing probe
   and recovery/error behavior is used.
3. Agent `aisdk` availability is not required to show the editor or start
   Workspace R. It may be refreshed after the blocking sequence; Agent
   surfaces continue to show unavailable state truthfully.
4. Startup telemetry records phase names and elapsed milliseconds without
   recording credentials, source contents, or arbitrary environment values.
5. R runtime, Workspace R, and the minimum project/session state required for
   a broker-returned `ready` project complete before the Workbench is shown.
   Run history, environment refresh, update checks, and Agent availability may
   run after first paint.
6. Existing startup failure, retry, selected-Rscript, project isolation, and
   shutdown behavior remain unchanged.

## STARTUP-INFO-1 Goals And Non-Goals

Goals:

- replace the opaque spinner card with a restrained three-stage startup ledger
  for `R runtime`, `Workspace R`, and `Project`;
- drive every transition from an existing command boundary, never a timer;
- retain completed facts when a later stage needs attention;
- show useful bounded facts already returned by the transport, such as the R
  version and normalized ready project root;
- make long-running startup visibly alive with truthful elapsed wall time;
- preserve contextual recovery and technical details without putting internal
  error codes in the primary hierarchy;
- cover loading, long-running, runtime failure, Workspace failure, unavailable
  project, retry, stale completion, narrow window, keyboard, screen-reader,
  reduced-motion, and browser/mock states.

Non-goals:

- percentages, predicted completion time, artificial stage rotation, or a
  minimum splash duration;
- cancellation, new diagnostics commands, backend sub-probe events, log
  streaming, or exposing arbitrary startup logs;
- changing startup admission, retry, project restoration, Agent fault
  isolation, or Workbench projection semantics;
- showing environment values, credentials, source content, or unbounded paths;
- changing Rust, R packages, schemas, generated command bindings, the visual
  acceptance bridge, installer, signing, or release authority.

## Typed Progress Contract

`UiKernelTransport.prepareWorkspace` has this additive signature:

```ts
prepareWorkspace(
  chooseRscript?: boolean,
  onProgress?: WorkspacePreparationProgressListener,
): Promise<WorkspacePreparation>;
```

`WorkspacePreparationProgressListener` is a synchronous observer of one
immutable `WorkspacePreparationProgress` snapshot with:

- `stage`: `runtime | workspace | project`;
- `state`: `active | complete`;
- optional bounded stage facts: `r_version`, `workspace_pid`, or
  `project_root`.

Text facts are normalized to well-formed Unicode and projected as valid UTF-8
at a maximum of 512 bytes each, truncating on a Unicode scalar boundary and
including the truncation marker
inside that budget. `workspace_pid` is present only for a positive safe integer.
Each stage accepts only its own fact (`runtime/r_version`,
`workspace/workspace_pid`, `project/project_root`); unexpected facts are
omitted rather than re-labelled. An observer exception is caught at the
aggregate transport boundary and cannot reject or reorder the underlying
startup commands.

The Tauri aggregate transport emits these snapshots immediately around its
existing ordered awaits:

```text
runtime active
startup_bootstrap / startup_choose_rscript
runtime complete (R version)
workspace active
workspace_start
workspace complete (optional PID)
project active
project_restore_session
project complete (normalized ready root)
```

It emits no `complete` snapshot for a rejected stage and never emits a later
stage after an earlier failure. The fire-and-forget Agent retry remains absent
because it is not an admission stage. The callback is presentation telemetry,
not readiness authority; only the final `WorkspacePreparation` result changes
application state.

Mock transport emits the same success sequence. Deterministic component tests
may supply deferred custom transports for every stage/failure. No timer may
advance the ledger.

## Presentation And Accessibility Contract

- The shell uses the current ink-on-paper tokens and one `Rho` wordmark. It has
  no decorative shadow, fake logo glyph, or marketing splash content.
- The heading is “Opening your workspace”. The active-stage sentence describes
  only the command currently running.
- All three ledger rows remain visible. Their states are `Waiting`,
  `In progress`, `Complete`, or `Needs attention`, encoded by text and shape;
  functional color is never the sole signal.
- The active row uses `aria-current="step"`. A polite status region announces
  stage changes, not every elapsed-second update. Attention becomes one alert.
- After eight seconds the footer shows truthful elapsed time and a “Still
  working” label. It makes no ETA claim. Fast startup is never delayed so that
  users can see the ledger finish.
- Runtime failure marks the runtime row as attention. Workspace failure keeps
  runtime complete and marks Workspace R as attention. Project restore failure
  keeps the first two complete and marks Project as attention.
- The primary action is contextual: `Choose project` for a healthy Workspace
  with project recovery, `Choose Rscript` for runtime recovery. A Workspace R
  start failure exposes `Retry` only; it is the primary action and the first
  normal tab stop because changing Rscript is not a Workspace recovery action.
  When a contextual chooser is present, `Retry` remains the secondary action.
  Technical code/detail stays in a disclosure.
- At narrow width or 200% zoom the shell becomes a scrollable single column;
  bounded long paths wrap. Reduced-motion and forced-colors modes retain a
  visible textual active state without relying on animation.

## Failure, Concurrency, And Recovery

- Existing generation guards remain authoritative. Progress and final results
  from an obsolete retry or unmounted shell cannot update the current view.
- Picker cancellation restores the prior project-attention state. Picker
  rejection/failure never fabricates readiness.
- While `Choose project` is in flight, the ledger keeps R runtime and Workspace
  R complete and marks only Project active; it must not imply that the runtime
  is being probed again. Cancellation restores both that ledger and focus to
  the contextual project action.
- A callback exception must not abort preparation; progress listeners are UI
  observers and cannot control command execution.
- Unexpected transport rejection is bounded to 2,048 characters and marks the
  best-known active stage as attention.
- React development StrictMode must not turn an already-running backend
  bootstrap into a false terminal failure. Any correction to backend busy
  re-entry requires its own deterministic regression inside this work package
  or a separately recorded startup repair.
- Ordinary progress transitions never move keyboard focus. A terminal
  attention transition focuses the issue heading once; its contextual primary
  action is the first normal tab stop and Retry is next. For Workspace-only
  recovery, Retry is the first normal tab stop. The native-picker cancellation
  rule above restores the originating chooser action.

## Work Packages And Stop Points

### WP1: Runtime cache and timing — implemented

- Added the versioned bounded runtime cache, validation/invalidation, atomic
  fallback, and startup timing records.

### WP2: First-paint scheduling — implemented

- Deferred non-critical Agent and Workbench queries while preserving the
  current RSR admission sequence defined above.

### STARTUP-INFO-1A: Feature lane — authorized

- Add the typed progress observer to Tauri and mock transports.
- Add a pure startup presentation model, the ledger view, token-only
  `workbench.css` styling, and focused deterministic tests.
- Keep the checked-in application behavior unchanged: no `App.tsx` write is
  permitted from a feature lane.
- Mandatory stop: focused type/lint/tests, feature-lane ownership check, diff
  review, and integration handoff.

Implementation evidence recorded 2026-08-26:

- The Tauri and browser/mock aggregate transports now emit the specified frozen
  observer snapshots with failure short-circuiting, listener isolation,
  well-formed bounded facts, and no Agent-retry admission stage.
- The pure ledger and startup view implement strict ordered projection,
  retained established facts, semantic stage/status text, contextual recovery,
  one-time attention focus, delayed truthful elapsed time, and token-only
  responsive/reduced-motion/forced-colors styling. The checked-in `App.tsx`
  behavior remains unchanged at this feature-lane stop.
- Final focused Vitest passed 3 files / 25 tests; full frontend Vitest passed 54
  files / 354 tests. `npm run rsr:typecheck --prefix desktop`,
  `npm run rsr:lint --prefix desktop`, and `npm run rsr:build --prefix desktop`
  passed; the build reported only the pre-existing large-chunk advisory.
- Independent review found and the slice corrected one live-region issue by
  scoping `aria-busy` to the ledger instead of its containing status region;
  the regression is included in the final counts. No 1A product-code blocker
  remains.
- `node scripts/dev-lanes.mjs check --id startup-progress --changed-auto` and
  `git diff --check` passed after removing the temporary dependency symlink.
  Application version metadata and `NEWS.md` remain intentionally unchanged.

### STARTUP-INFO-1B: Integration lane — authorized after entry checks

Entry conditions: the current integration lane releases `App.tsx`, the
cross-review matrix, version files, and `NEWS.md`; 1A is reviewed and its tests
pass; no new sequencing/authority conflict appears.

- Add the cross-review matrix entry, wire the controller/view through
  `App.tsx`, preserve recovery generation guards, and add App-level regressions.
- Add deterministic browser/mock captures for runtime-active, Workspace-active,
  project-active, and project-attention at the repository-standard 1920×1080,
  1024×680, and 900×700 geometries, plus a 720×450 CSS viewport representing
  200% zoom of the default desktop window. Repeat the active frame with reduced
  motion and forced colors. Do not claim the current post-ready S0 frame covers
  this shell.
- Add one deterministic **real debug-app pre-ready** gate without widening the
  bridge or frontend automation vocabulary. The harness launches the exact
  debug executable against its existing isolated acceptance app-data with
  `RHO_RSCRIPT` bound to the harness's non-R executable fixture, waits for the
  bounded `Runtime bootstrap failed` record in
  `<acceptance-output>/app-data/logs/startup.jsonl`, then uses the bridge's
  existing `/window` and `/screenshot` endpoints (which do not require
  `window.__rhoAutomation`) to capture the runtime-attention ledger. After the
  requested window geometry is acknowledged, the harness polls bounded probe
  screenshots until two consecutive PNG hashes match while the same terminal
  startup-log record remains present; that stable-frame condition is the exact
  frontend-settled criterion, and timeout is a gate failure. The fixture process
  is terminated before the ordinary ready-path acceptance launch. The gate
  records its deterministic assertion and per-frame visual verdict in the
  normal evidence/manifest files.
- Run the complete affected frontend gate and one exact debug-app cold/warm
  startup walkthrough at the native 1440×900 and 1024×680 window geometries.
  The real launch is behavior evidence, not a deterministic startup-frame
  visual verdict; deterministic active-stage review comes from the held mock
  states, while the exact-app attention frame proves the production wiring.
- Review the result against this contract, synchronize the next unoccupied
  application development candidate and `NEWS.md`, then reconcile lifecycle
  evidence. This is the mandatory program stop.

## Verification Matrix

STARTUP-INFO-1A:

- pure model: waiting/active/complete/attention projection at each boundary;
- Tauri transport: strict callback/command order, bounded returned facts,
  failure short-circuit, and Agent retry remaining non-blocking;
- mock parity: identical successful stage order;
- component: semantic ledger, one wordmark, no false Surface/percentage/ETA
  text, delayed elapsed label, alert/status behavior, long path, and contextual
  actions;
- focused Vitest plus frontend typecheck/lint/build as affected;
- `node scripts/dev-lanes.mjs check --id startup-progress --changed-auto` and
  `git diff --check`.

STARTUP-INFO-1B:

- App: deferred Promise stage progression, Workbench mount only after final
  ready, runtime/Workspace/project failure, retry, picker cancel/failure, stale
  completion, unmount, and development StrictMode behavior; the Workspace
  failure regression asserts that Retry is the sole primary action and no
  Rscript chooser is offered;
- production/mock parity and the exact deterministic wide/narrow,
  reduced-motion, and forced-colors captures specified above;
- exact debug-app pre-ready runtime-attention gate using isolated app-data,
  bounded startup-log readiness, and existing bridge screenshot/window
  endpoints only;
- `npm run rsr:check --prefix desktop` for the frozen integration snapshot;
- rebuild the checkout debug app and record cold/warm real-window startup;
- `git diff --check` and integration lane check.

The obsolete `node --check desktop/dist/app.js` gate is removed: RSR Wave 12
deleted the hand-edited legacy file. The React/Vite checks above are the current
frontend authority. Rust tests are required only if implementation crosses the
existing TypeScript aggregate transport into Rust/generated bindings.

## Version, Documentation, And Release Impact

- 1A does not change shipped behavior and does not bump versions or `NEWS.md`.
- The reviewed user-visible 1B integration enters the next unoccupied
  application development candidate. The integration lane synchronizes every
  application version authority and adds a concise `NEWS.md` Improved entry.
- R package versions do not change because their exports, serialized
  contracts, compatibility, and contents are unaffected.
- Add this owner to `docs/README.md` and the active cross-review matrix. Record
  actual commands and evidence only after they run.
- Rename this file to `implemented-` only when all in-scope 1B implementation,
  affected automated verification, exact debug-app walkthrough, review,
  version, NEWS, and documentation gates are complete.
- Installer construction, signing, publication, and release GO/NO-GO remain
  out of scope.
