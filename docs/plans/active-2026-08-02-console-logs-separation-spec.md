# Console And Logs Separation Specification

Status: active implementation contract
Authorization: explicitly requested by the user on 2026-08-02
Change class: D2 bounded user workflow
Risk: R1 local frontend behavior
Work package: CL1, one reviewable frontend slice

## Purpose

Make the execution dock's Console behave as one continuous Workspace R
terminal surface. Commands entered in the Console and the corresponding R
output remain together in that surface. Runtime and product diagnostics move
to a separate Logs tab so they do not interrupt the R transcript.

## Ownership And Boundaries

This specification owns only frontend presentation and routing in the existing
execution dock. It does not change:

- Workspace R as the sole authority for live scientific objects and execution;
- the `execute_r` command, execution response schema, run persistence, project
  or workspace revisions, cancellation, or restart behavior;
- Problems, which continue to derive from structured run data rather than
  Console or Logs text;
- Agent R separation from Workspace R;
- plot or artifact behavior.

"Terminal" in this contract means an integrated transcript and prompt over the
existing broker-backed Workspace R execution path. It does not authorize
xterm, a shell, terminal emulation, a second R session, raw Ark transport, or
parsing terminal text as scientific or diagnostic truth.

## Display Contract

### Console

1. The Console panel is one dark, scrollable terminal surface containing both
   the transcript and the active prompt. The prompt is not a separately framed
   footer.
2. Every Workspace R request initiated from Console, Source, or another direct
   Workspace execution surface writes its submitted R code and returned
   stdout, messages, warnings, values, stream events, and execution errors to
   the Console transcript in execution order.
3. Submitted code is rendered with an R prompt marker. Output is rendered
   without origin badges so the transcript reads as an R session rather than a
   mixed system feed.
4. The active prompt remains visible after success or failure, accepts focus
   anywhere within the empty terminal area, and is disabled while the existing
   global execution busy state is active.
5. Enter submits a non-empty expression through the existing `execute_r` path.
   Empty submissions do nothing.
6. The Console input keeps a bounded in-session history of submitted non-empty
   expressions. Up/Down browse older/newer entries; editing a recalled entry
   exits browsing, and Down past the newest entry restores the draft that was
   present before browsing. Consecutive duplicate commands are stored once.

### Logs

1. A Logs tab is added beside Console, Plots, and Problems.
2. Logs receives application and runtime status including project saves,
   Workspace R startup/status, interrupt and restart status, render completion,
   Agent R `run_r` output, and failures to hydrate those records.
3. Log rows retain an origin label and warning/error tone so their producer is
   clear.
4. Moving text to Logs changes presentation only. Durable Runs, Problems,
   Agent history, and broker diagnostics remain the sources of truth.

### Failure Routing

- A failed direct Workspace R invocation appears in Console because it is the
  response to the visible R command, and it continues to create the existing
  Problem record and toast.
- A startup failure or non-execution operational failure appears in Logs and
  continues to use its existing Problem/toast behavior where applicable.
- No failure is hidden merely because the active tab is different.

## Cross-Review

- `implemented-2026-07-16-wp2-monaco-editor-source-execution-design.md` keeps
  Workspace R authoritative and excludes an xterm-based Console. CL1 preserves
  both decisions.
- `implemented-2026-07-16-wp3-structured-runs-problems-recovery-design.md`
  owns Runs and Problems truth. CL1 changes only the projection of existing
  execution and operational text.
- `proposed-2026-07-20-human-agent-workbench-posture-design.md` may later own a
  broader information architecture. CL1 adds one dock tab and does not activate
  or implement that proposal.
- `proposed-2026-07-26-interface-modernization-plan.md` owns broader visual
  modernization. CL1 uses current dock tokens and layout and does not claim a
  modernization phase.
- No schema, policy, approval, persistence, project ownership, credential,
  filesystem, or sequencing conflict was found.

## Implementation Slice CL1

1. Add the Logs tab and panel to `desktop/dist/index.html`.
2. Restyle Console as an integrated transcript/prompt surface and style Logs
   as the existing labeled diagnostic feed in `desktop/dist/styles.css`.
3. Split frontend append helpers and route existing call sites according to
   this contract in `desktop/dist/app.js`.
4. Add a deterministic browser/mock preview hook for Console and Logs review.
5. Add focused static contract checks for markup, routing, tab switching, and
   syntax.

Stop after CL1. Do not add history persistence, multiline continuation parsing,
terminal escape handling, a clear-log retention policy, or backend changes in
this package.

## Acceptance Gate

Automated acceptance requires:

- `node --check desktop/dist/app.js`;
- the focused Console/Logs UI contract test passes;
- deterministic preview evidence reports separate Console and Logs panels,
  the expected active tab, and no Console prompt/transcript overlap;
- desktop and narrow viewport screenshots show no overlap, clipped tab labels,
  or prompt displacement;
- `git diff --check` passes.

Manual installed-app acceptance remains open until a candidate demonstrates:

1. typed Console code, the submitted command, and its R result are visible in
   one continuous terminal surface;
2. Source execution output remains visible in Console;
3. startup, Agent, interrupt/restart, and render status appear in Logs;
4. Workspace R errors remain visible in Console and Problems;
5. switching among Console, Logs, Plots, and Problems does not lose state.

The executable candidate workflow and evidence fields are consolidated in
`test/acceptance-project/MANUAL-ACCEPTANCE.md` (sections 1 and 8A) and its
candidate result template. These items remain NOT RUN until the user records
evidence against one exact installed candidate.

## Version, NEWS, And Lifecycle

- Application version: defer a bump until the next named integration
  candidate; the current `0.4.0-dev.0` candidate has not been published from
  this worktree.
- R package versions: unchanged because no R package contract changes.
- `NEWS.md`: update after CL1 behavior is implemented and verified.
- Document lifecycle: keep this document `active-` until automated evidence is
  recorded and installed-app/manual acceptance is either completed or
  explicitly handed off. Implementation presence alone does not make it an
  accepted release capability.

## Definition Of Done

CL1 is done when the display contract is implemented, the automated acceptance
matrix passes, the implementation is reviewed against this contract, NEWS and
the version decision are recorded, unrelated worktree changes remain intact,
and remaining manual/installed acceptance is reported separately.

## Implementation Evidence

CL1 implementation and automated/browser verification completed on 2026-08-02.
Evidence is recorded in
`docs/verification/console-logs/verification.md`. No contract deviation was
found. Installed-app/manual acceptance remains open, so this document remains
`active-` and makes no release-readiness claim.

The user authorized the bounded R1 command-history extension on 2026-08-04.
It is frontend session state only: at most 100 non-empty Console submissions,
with consecutive duplicate suppression, Up/Down browsing, draft restoration,
and edit-to-exit behavior. Syntax, focused contract, and browser interaction
checks passed; backend execution, persistence, project identity, and Console/
Logs routing are unchanged. Installed-app confirmation remains open.

## 2026-08-27 Console And Workspace Reliability Program

Authorization: the project owner directed the team on 2026-08-27 to create a
global plan and begin construction after reviewing real Workspace R output.
This section coordinates the resulting packages without moving their existing
authorities into this frontend specification. Only CL2 below is activated by
this amendment; every later package keeps its named owner, risk gate, and
independent rollback point.

### Real-workflow findings and package order

The review used two newly created projects and one real Workspace R session to
exercise a wide `data.frame`, an R error, a Plot, a long submitted expression,
`print(seq_len(5000))`, two simultaneous Console instances, and an A-to-B
project switch. It established the following ordered program:

1. **PROJECT-WORKSPACE-ISOLATION-1 (D3/R3, release-blocking):** different
   normalized project roots must not observe the same mutable live R state.
   This belongs to a separately activated project-transition contract because
   it changes Workspace lifecycle and failure recovery. The minimum safe
   direction is a fresh target Ark session prepared and committed inside the
   BH2 transition gate, not `rm(list = ...)`; retained concurrent project
   sessions remain a non-goal until separately chosen.
2. **PLOT-REFERENCE-2 (D2/R2):** exact Plot selection, PNG and safe SVG
   preview, typed missing/pruned/unsupported recovery, and a metadata-only IPC
   list contract. Raw payload JSON must not enter ordinary frontend state.
3. **CONSOLE-DENSITY-1 (D2/R1):** show the runtime binding once per Console,
   repeat origin only when it changes or is ambiguous, preserve record status
   at narrow widths, and provide visible keyboard focus and a stronger error
   callout. It is sequenced after the current integration owner releases the
   shared Surface and style files.
4. **OUTPUT-DISCLOSURE-1 (D2/R1):** line/character-aware collapse and expand,
   complete copy, stable focus/scroll, and separate wrapping rules for fixed-
   width stdout/value versus messages and errors in Console and History.
5. **OUTPUT-CAPTURE-1 (D2/R2):** replace the R bridge's unstructured
   16,000-character semantic truncation with complete journal/sidecar capture
   or truthful structured completeness metadata. A literal `[truncated]`
   suffix without recoverable content or omitted-byte facts is not sufficient.
6. **TYPED-TABLE-1 (D2/R2):** add a bounded typed `data.frame`/matrix snapshot
   or reference with a compact preview and exact text fallback. React must not
   infer table structure by parsing printed R text.
7. **MULTI-WORKSPACE-2 (D3/R3, deferred product choice):** retained,
   concurrently addressable per-project Workspace sessions require an explicit
   root-to-session ownership, memory/eviction, crash/restart, device, package,
   and UI identity contract. PROJECT-WORKSPACE-ISOLATION-1 must not imply that
   larger behavior accidentally.

The packages are prioritized by scientific truth and project isolation, then
exact rich-output navigation, then local information density. Lane ownership
may allow a lower-risk package to complete while a higher-risk owner is
blocked, but no such scheduling change lowers the higher-risk acceptance gate.

### Shared program invariants

- Console and Source continue to dispatch only through the selected registered
  Runtime; creating or labeling another Console never creates a Runtime.
- A Console instance label identifies a UI instance, not a project, Runtime,
  Workspace, kernel, or authority boundary.
- Project-owned records, live state, output references, and selections always
  retain exact normalized-project ownership at their authoritative boundary.
- Ordinary UI excludes opaque identifiers, raw JSON, and unbounded payloads;
  typed identities remain available internally for exact commands.
- Bounded presentation never silently destroys the only recoverable execution
  result. Any omitted content has explicit completeness and recovery truth.
- Each package keeps Tauri/mock parity where it changes a transport-visible
  state, uses design tokens for visual work, and stops after its own focused
  and affected verification matrix.

## CL2 Repeated Console Instance Identity

Status: active bounded implementation slice

Authorization date: 2026-08-27

Change class and risk: D1/R1. CL2 changes only the transient Dockview title
projection for repeated, currently placed `rho.console` Surface instances. It
does not mutate the Scene, Surface instance, Runtime binding, Project UI
Profile, Store, broker, workspace, or transport.

### Problem and behavior contract

The current Dockview adapter derives every Console panel title solely from the
Surface type, so two simultaneously placed Console instances are both titled
`R Console`. At a narrow width the panes are difficult to distinguish and the
duplicate title suggests neither a stable UI identity nor whether the two
views share a Runtime.

CL2 applies one deterministic scene-wide projection:

- one placed Console remains `R Console`;
- two or more placed Consoles are labeled `R Console · 1`, `R Console · 2`,
  and so on in authoritative Scene traversal order;
- the title is supplied to Dockview's panel/tab model and therefore remains
  the visible and accessible tab name;
- missing instances retain their current explicit unavailable identity;
- non-Console Surface labels are unchanged; and
- moving a Console may change its positional ordinal, but never changes its
  Surface instance ID, Runtime binding, view state, or persistence.

Scene traversal order is used deliberately: the ordinal describes the visible
composition, is deterministic for one Scene snapshot, and avoids exposing or
deriving meaning from opaque instance IDs. This slice does not add a custom
name field or durable naming schema.

### Cross-review and non-goals

- The accepted Surface Runtime architecture owns multi-instance Surface and
  exact Runtime-binding semantics. CL2 only projects existing placed instances
  and preserves the rule that a Console attachment never creates a Runtime.
- The human-facing projection contract permits a controlled human label while
  excluding the opaque Surface instance ID.
- The active Studio design retains tab styling, tokens, focus, responsive
  geometry, and Surface chrome. CL2 changes no CSS or design token.
- Runtime Output retains execution entry, output, origin, persistence, search,
  Plot/Artifact reference, and Agent-context authority.
- BH2 and the future PROJECT-WORKSPACE-ISOLATION-1 retain all project-switch
  and live R-state semantics. A Console ordinal must never be presented as a
  workspace-isolation claim.

CL2 does not suppress per-record `Workspace R`, change panel headers, repair
narrow-pane hidden status, add Runtime labels, render tables or Plots, alter
long output, or introduce simultaneous project sessions. Those behaviors stay
with the packages above.

The existing central cross-review row already registers this active Console
presentation owner. CL2 creates no new schema, policy, persistence, approval,
project, sequencing, credential, filesystem, network, execution, or release
owner, so no competing matrix row is introduced.

### Acceptance gate and stop point

Focused tests must prove:

- one Console retains the unsuffixed label;
- repeated Consoles in separate panes receive distinct traversal-order labels;
- repeated Consoles inside and outside stacks use one scene-wide ordinal
  sequence;
- non-Console labels and missing-instance fallback remain unchanged; and
- conversion remains pure and round-trips the original Scene unchanged.

Then run TypeScript typecheck, frontend lint, the adjacent Dockview/layout
suite, complete affected `rsr:check`, lane validation, and `git diff --check`.
Browser/mock visual evidence must show distinct repeated Console tabs at a
normal and narrow viewport without claiming real-runtime acceptance. The real
Tauri visual run remains exclusive to the integration/main checkout and is an
integration-candidate gate.

Application version and `NEWS.md` are deferred to the named integration
candidate because this feature lane cannot write their single-writer
authorities. R package versions remain unchanged. Release stays `NO-GO`.

Stop after CL2 implementation, verification, contract review, lane check, and
one scoped commit. No later package is activated by CL2 completion.
