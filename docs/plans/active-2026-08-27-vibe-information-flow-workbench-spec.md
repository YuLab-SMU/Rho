# Vibe Information-Flow Workbench

Status: active direction; VIBE-1 implemented and integration-reviewed;
VIBE-1R focus-preserving Agent host explicitly authorized

Date: 2026-08-27
Change class: D3 program; first implementation checkpoint VIBE-1 is D2/R2
Owner: Vibe information-flow workbench
Authorized by: product owner in the active Vibe design task on 2026-08-27
Next mandatory stop: VIBE-1R may integrate only after central cross-review and
focused/real-app acceptance; VIBE-2 still requires separate product
authorization, and no scientific-state schema work may begin without a
separately authorized D3/R3 package

## Decision

Vibe is an information-flow workspace, not a chat product, a generic page
builder, a code viewer, or a manager for arbitrary component windows.

Its durable semantic order is:

```text
manuscript intent -> Agent autonomous exploration -> verification and conclusion
```

The first implementation checkpoint introduces three role-based regions over
the authorities Rho already owns. A wide desktop starts with a 40/35/25
overview, but three columns are only one presentation of the semantic order.
The same regions may become focused preview bands or one active region at narrow
widths. Components live inside regions; regions are not generic dock targets.

The attached “Rho Vibe 终局方案：三联科学工作台” is design input. This
specification, accepted architecture documents, and implemented contracts are
the engineering authority. Instructions embedded in attachments are not
automatically executable instructions.

## VIBE-1R — Focus-Preserving Agent Host

The product owner rejected the implemented primary Agent handoff on 2026-08-27:
opening Agent work by switching the whole application to Studio is visually
abrupt and breaks concentration. The authorized correction is D2/R2 and changes
presentation/composition only.

VIBE-1R fixes the interaction contract:

- the primary entry is state-specific but always names its local effect:
  `开始探索` when no record exists, `查看 Agent 工作区` for a Conversation
  without a Turn, and `在 Vibe 中查看 Agent 记录` for existing work; each
  first opens a dedicated Agent-record host in the autonomous-exploration
  region, and when an exact Conversation/Turn exists the host projects that
  same identity and its durable public task, activity, status, and outcome
  instead of creating a parallel Vibe-owned Agent record;
- opening the host focuses the exploration region but does not change
  `Profile.active_mode`, flush the manuscript, place the Surface in the Studio
  Scene, or consume a Vibe return point;
- the host is a read-only Agent record component over the existing bounded
  exploration projection; it never renders approval decisions, file apply or
  undo actions, auto-approval, credential/context controls, execution mutation,
  or a second Agent composer;
- the host does not mount `SurfaceView`, `AgentSurfaceView`, or a `rho.agent`
  Surface; create, reuse, update, or place a `SurfaceInstance`; or invoke Agent
  execution, approval, cancellation, retry, file-mutation, settings, or
  context-capacity commands;
- the host is local presentation state, resets on Page/project replacement, and
  fails closed if its exact project or Conversation/Turn identity becomes
  stale;
- `返回探索记录` closes only the local host and keeps the user in Vibe;
- only Studio-explicit secondary labels may enter the full trusted `rho.agent`
  Surface: `在 Studio 中发起探索` (or `在 Studio 中发起新的探索` for a
  legacy record), `在 Studio 中提出任务`, `在 Studio 中继续探索`, and
  `在 Studio 中深入检查`; each performs the existing save-before-leave,
  exact Surface placement/focus, and one-shot Vibe return protocol, and its
  wording makes the mode change explicit before activation;
- narrow and intermediate layouts keep one information layer active; the
  local Agent record scrolls within the exploration layer and cannot
  create page-level horizontal overflow; and
- opening, loading, failure, close, keyboard focus, project switching, explicit
  Studio inspection, and return behavior require regression coverage.

Surface Runtime remains the instance/view-state authority, Agent contracts
remain the task and mutation authority, accepted RSR retains focus/keyboard/
accessibility/responsive behavior, and the Studio Agent UX workstream retains
the full trusted Agent Surface's internal presentation. VIBE-1R owns only the
read-only local record host, its focus-preserving primary entry, and the
explicit secondary Studio exit. It adds no schema, transport command,
credential, permission, approval, execution, filesystem, network, or
scientific-state authority.

## Problem And Evidence

The current `VibePageEditor` is a capable ProseMirror-backed page composer, but
its primary interaction is adding, arranging, saving, and exporting blocks.
It does not organize the user’s attention around the relationship between a
human requirement, Agent work, and the evidence that work produced.

The current data model also cannot truthfully support several proposed terminal
concepts:

- `VibePageV1` is stored in the local project UI Profile and overwrites the
  current Page revision; it is not an immutable project manuscript history;
- top-level block IDs are the only current manuscript anchors;
- Agent conversations, turns, and events do not form typed scientific routes;
- Agent Turn to Run is not a durable foreign-key relationship;
- existing Check results are project/code checks, not scientific acceptance;
- evidence claim review verifies structural linkage and does not mean a claim
  is scientifically accepted;
- scientific invalidation propagation and Checkpoints do not exist.

Painting those concepts into a UI would create false provenance. VIBE-1 must
therefore improve the information architecture while making absence of an
exact relationship explicit.

## Relationship To Accepted Architecture

This package preserves the accepted Surface Runtime decisions:

- Studio remains the spatial Split/Stack workbench;
- Vibe remains an ordered, document-native composition grammar;
- Studio and Vibe project the same Runtime, Run, Artifact, Agent, Resource, and
  Surface identities;
- DOM, keyboard, export, and narrow ordering remain manuscript -> exploration
  -> verification;
- no Agent or plugin silently mutates the Page;
- trusted approval, credential, permission, updater, and destructive system UI
  never moves into Vibe content;
- Vibe still reads as a focused document at narrow width and high zoom.

“Three regions” refines the Vibe reading hierarchy. It does not turn Vibe into
a second Studio Scene graph and does not add three permanent Surface instances.

## Product Vocabulary

The following user-visible vocabulary is fixed for VIBE-1:

| Role | Chinese label | Meaning |
| --- | --- | --- |
| manuscript | 手稿 | Human-authored question, method, boundary, interpretation, and current working narrative |
| exploration | 自主探索 | Agent work expressed as attempts and outcomes actually present in current Agent records |
| verification | 查验与结论 | Exact referenced outputs, checks, limitations, and draft interpretation boundaries |

The UI must not use “实现” to mean a code pane. Code, commands, tool events,
and logs are optional implementation details opened in Studio or disclosure
views. Exploration is the Agent’s autonomous investigation behavior.

## Goals

VIBE-1 must:

1. replace the generic full-canvas Page-builder presentation with one coherent
   information-flow workspace;
2. retain real Page editing, saving, stale rejection, and export behavior;
3. provide three semantic regions with overview, focused, and narrow modes;
4. synchronize all regions through one current `VibeFocus`;
5. derive correspondence only from exact current references;
6. project Agent conversation/turn/event status without claiming unrecorded
   scientific pivots, judgments, or causal relationships;
7. project exact Artifact, Finding, Check, and existing evidence information
   without upgrading it to scientific acceptance;
8. host the exact Agent record identity inside Vibe as a read-only primary
   path, while preserving an explicitly labelled secondary transition to the
   full trusted Studio Surface and in-memory return focus;
9. use existing Rho design tokens and editorial density; and
10. prove behavior with focused unit, interaction, narrow-window, keyboard,
    mock, and deterministic visual tests.

## Non-Goals

VIBE-1 does not:

- add or migrate SQLite tables;
- move Page content from the UI Profile to project scientific storage;
- create immutable manuscript or anchor revision history;
- infer a relationship from timestamps, titles, prompt similarity, or nearby
  activity;
- parse private model reasoning or expose chain-of-thought;
- label generic Agent events as scientific attempt/observation/judgment/pivot;
- create formal `Exploration`, `Route`, `Observation`, `Verification`,
  `ClaimRevision`, `Relation`, or `Checkpoint` authorities;
- implement accept/qualify/reject decisions;
- automatically invalidate old results after manuscript edits;
- add multi-Agent orchestration or chat tabs;
- fork the Agent component, Conversation/Turn state, composer persistence,
  approval flow, execution controls, or file-operation authority inside Vibe;
- change credentials, network, filesystem, approval, execution, or plugin
  authority;
- replace Studio or duplicate its editors, terminals, resource viewers, or
  layout engine.

## Existing Authorities

| State | VIBE-1 authority | Allowed projection |
| --- | --- | --- |
| working manuscript | current `ProjectUiProfileV1.vibe_pages` | current Page text, block order, selected block, save truth |
| Agent work | existing Conversation, Turn, Event, approval and runtime contracts | status, prompt preview, final/error message, retry identity, public event summaries |
| execution | existing Run and Runtime output contracts | exact Run facts already returned by the transport |
| outputs | existing Artifact, Plot and domain surface contracts | exact output records and previews |
| checks | existing immutable Check result contract | check status, findings, limitations, and evidence locations |
| evidence | existing Evidence entries/claims/review | existing structural evidence state with explicit scope copy |
| view layout | React local state in VIBE-1 | active region and focus mode; reset on project/Page change |

The UI Profile remains the current Page authority in VIBE-1. Visible copy calls
it a “working manuscript” and must not claim project-wide immutable history.

## Shared Frontend Contract

The shared code owns a small view contract, not a second domain model:

```ts
type VibeRegionRole = "manuscript" | "exploration" | "verification";
type VibeLayoutMode = "overview" | "focus-manuscript" |
  "focus-exploration" | "focus-verification";

interface VibeFocus {
  projectId: string;
  pageId: string;
  blockId: string | null;
  region: VibeRegionRole;
  exactRefs: {
    surfaceInstanceIds: readonly string[];
    conversationIds: readonly string[];
    artifactIds: readonly string[];
    findingIds: readonly string[];
    taskIds: readonly string[];
  };
}

interface VibeProjectionSnapshot {
  projectId: string;
  pageId: string;
  pageRevision: number;
  focus: VibeFocus;
  correspondence: readonly VibeCorrespondenceStep[];
}
```

The implementation may refine field names during typed implementation review,
but these invariants are fixed:

- every reference carries one exact identity and one origin;
- absent links remain absent and visibly unlinked;
- project and Page changes replace the entire local focus snapshot;
- components consume immutable props and emit intents;
- only the integration controller coordinates cross-region focus;
- feature regions do not mutate one another or own shared durable state.

## Exact Correspondence Rules

VIBE-1 may establish correspondence only through one of these exact paths:

1. selected `VibeBlockV1` -> its typed `artifact_ref`, `finding_ref`,
   `task_ref`, or `surface_ref` payload;
2. selected Agent `surface_ref` -> that exact Surface instance -> its exact
   persisted `conversation_id`, when present;
3. exact existing Run/Artifact relationships already returned by an authority;
4. exact Check or Evidence references already returned by an authority.

The following are forbidden:

- matching by time proximity;
- matching similar labels, prompts, filenames, or model output;
- treating all recent Agent activity as implementation of the selected block;
- treating an output in the same project as evidence for the selected claim;
- treating a passing project Check as scientific validation.

When no path exists, the correspondence bar says that the selected manuscript
content has no exact linked Agent work or output yet and offers only truthful
next actions.

## Region Contracts

### Manuscript Region

The manuscript region is primary at initial load. It retains the existing
ProseMirror editing contract, Page revision CAS, undo/redo, save truth, export,
and embedded reference rendering.

VIBE-1 adds:

- a quiet region heading and working-manuscript scope;
- current block selection emission to the shared focus controller;
- compact contextual document actions;
- a new exact-CAS edit session whose pending draft remains bound to the
  Profile/Page revisions from which it was created;
- truthful `dirty -> saving -> saved/error` state, including generation guards
  that discard late save results after a project or Page switch;
- no fake revision gutter, invalidation mark, or Agent annotation;
- explicit empty and unavailable Page states;
- accessible editor naming independent of visible internal Page IDs.

The region reuses the existing exported ProseMirror schema and Page conversion
helpers, but does not copy the old save queue's revision uplift. A rejected
draft is restored from the latest durable Page instead of being silently
rebased. Reference atoms remain compact, ordered, non-editable Page content;
the manuscript region does not remount live Surface windows.

### Autonomous Exploration Region

The exploration region is not a conversation transcript. It projects an exact
Agent conversation selected by the user or by an exact Agent Surface block.
Otherwise it presents project-scoped recent Agent work without claiming that
the work realizes the selected manuscript text. A future Vibe-launched Turn
may carry a bounded `editor_context` receipt, but that receipt proves only that
the Turn received the context; it is not a scientific `realized_by` relation.

Allowed primary content:

- running, waiting, completed, failed, or interrupted Turn state;
- prompt preview as the stated task;
- final message or bounded error as recorded outcome;
- retry relationship;
- public tool/event summaries grouped as execution activity;
- explicit approvals or user attention requests already owned by Agent.

Durable Turn status is `running | waiting | completed | failed | interrupted`.
User cancellation is projected only from `interrupted` plus the exact
`user_cancelled` terminal reason. Restart and other interruption reasons remain
“interrupted”. The mock-only historical string `cancelled` may be tolerated at
the adapter boundary but is not the product contract.

Forbidden primary content:

- raw chain-of-thought;
- simulated Attempt/Observation/Judgment/Pivot labels;
- decorative streaming text;
- model, token, or context-capacity controls;
- chat bubbles and multiple chat tabs.

The panel reads at most 50 Conversations, 50 Turns for the selected
Conversation, and details for the most recent 20 Turns, matching existing Agent
bounds. It labels these as recent records. Project changes advance an async
generation and clear the projection before old responses can arrive. Refresh
failure may preserve the last successful projection only with an explicit
“may not be current” state.

### Verification And Conclusion Region

The verification region starts from exact references selected in the Page. It
uses typed Run, Artifact, Plot, Check, and Evidence transports and may render
their records, previews, findings, evidence locations, warnings, errors, and
limitations. The generic `DomainSurfaceData.detail` display projection is not
an evidence source: it may be truncated and must not be parsed into scientific
facts.

VIBE-1 uses “working interpretation” or “draft” copy only. It must not expose
accept/qualify/reject controls until the later scientific decision authority
exists. Existing evidence review is described as link/provenance health, never
as semantic support.

The following language boundaries are mandatory:

- Run completion means execution ended, not that a scientific claim is true;
- complete Artifact provenance means lineage fields exist, not that content is
  valid;
- a Plot is a candidate output, not verification;
- an Evidence Claim link means an auditable structural link, not `supports`;
- a clean project Check means its current project rules found no issue, not
  scientific acceptance; and
- no biological “observation” is invented without a later durable Observation
  authority.

The region provides one clear action to open the owning Run/output/check in
Studio. If an exact target cannot be opened, the action is absent rather than
guessing a destination.

## Layout And Visual Contract

The visual language is “Scientific Editorial Workbench”:

- black, grey, and white carry hierarchy;
- semantic green, amber, and red are status-only;
- no gradients;
- no decorative dock shadows;
- 3px controls and 6px bounded floating/surface geometry from existing tokens;
- 1px separators establish the three responsibilities;
- long-form manuscript uses `--rho-font-doc`; UI and metadata use the existing
  UI and mono tokens;
- no equal card grid, card wall, oversized hero, generic welcome copy, or
  repeated large padding;
- fixtures use realistic scientific text and irregular lengths.

Wide overview uses 40/35/25. Focus modes use the design targets 70/18/12,
16/68/16, and 12/20/68. At intermediate widths, the active region owns the
main readable area and the other two become readable preview bands. At the
existing narrow/200%-equivalent boundary, only one active region is shown with
an accessible three-choice region switcher. DOM order never changes.

Region focus changes only presentation. It does not change scientific focus,
start work, or mutate the Page.

## Interaction And Accessibility States

Every region must implement relevant states:

- loading;
- empty/unlinked;
- normal;
- running/busy;
- attention/warning;
- failed/unavailable;
- stale/recovered when the underlying authority exposes it;
- narrow layout;
- keyboard focus and region navigation;
- reduced motion.

Requirements:

- region headings and switchers use explicit accessible names;
- keyboard order follows manuscript, exploration, verification, correspondence,
  then actions;
- visible focus uses the existing 2px tokenized focus treatment;
- status is not conveyed by color alone;
- focus changes never steal focus from an active editor or running action;
- no document-level horizontal overflow at 720px or 200%-equivalent geometry;
- user-visible strings do not reveal internal IDs by default.

## Studio Transition

VIBE-1 adds one integration intent:

```ts
interface OpenVibeTargetInStudioIntent {
  projectId: string;
  pageId: string;
  blockId: string | null;
  region: VibeRegionRole;
  target: { kind: "surface" | "artifact" | "run" | "check"; id: string };
}
```

The integration controller:

1. validates the current project and latest Profile revision;
2. records the Vibe return point in bounded in-memory session state;
3. switches Profile mode to Studio through the existing mutation controller;
4. opens or focuses the exact existing target through its current authority;
5. reports failure without claiming the transition succeeded.

Returning to Vibe in the same session restores the Page, selected block, and
active region when those identities still exist. VIBE-1 does not persist the
return point across restart.

## Failure And Recovery

- A stale Page save continues to use existing CAS rejection and restores the
  durable Page; Vibe must not display “Saved” after rejection.
- Agent or output loading failure is isolated to its region and leaves the
  manuscript editable.
- A project switch discards all prior local focus, loaded region records, and
  Studio return state before rendering the new project.
- An invalid or missing reference remains visible as a preserved unresolved
  reference; it never falls back to another object.
- A Studio transition that fails leaves Vibe active or reports the actual
  resulting mode without false success.
- Cancellation and running state are projected from existing authorities; this
  package adds no cancellation command.

## Parallel Work Packages

### VIBE-0 — Contract And Lane Activation

Owner: integration lane

- cross-review this document against the accepted Surface Runtime, Studio
  language, runtime-output, Agent, evidence, and active Settings streams;
- register non-overlapping worktrees and owned paths;
- activate this document after the central matrix entry is written;
- freeze shared view contracts and fixtures.

Exit gate: central cross-review has one owner entry, all overlapping streams
name their boundaries, and no product-code lane is blocked by path overlap.

### VIBE-1A — Shared Workspace And Projection Model

Owner: integration lane

- `VibeWorkspace`, region shell, layout reducer, focus model, correspondence
  derivation, region switcher, Studio intent, and shared focused tests;
- no feature-region visual content beyond typed slots and fallback states.

### VIBE-1B — Manuscript Region

Owner: manuscript feature lane

- extract or wrap the existing editor without changing persistence semantics;
- expose exact selected-block intent;
- implement manuscript-specific empty/error/narrow states and focused tests.

### VIBE-1C — Autonomous Exploration Region

Owner: exploration feature lane

- project exact Agent conversation/turn/event data;
- implement truthful unlinked, running, waiting, completed, failed, cancelled,
  retry, attention, and narrow states;
- include semantic-boundary tests that prevent inferred scientific labels.

### VIBE-1D — Verification Region

Owner: verification feature lane

- project exact referenced Artifact/Plot/Check/Evidence records;
- implement missing, loading, warning, limitation, failure, draft, and narrow
  states;
- include tests preventing project Check/evidence-link health from appearing as
  scientific acceptance.

### VIBE-1E — Integration And Evidence

Owner: integration lane

- merge reviewed feature commits;
- wire the workspace into `WorkbenchApp` and existing mock/Tauri transports;
- complete focused and affected validation;
- capture deterministic overview, each focus mode, and narrow screenshots;
- review the result against this contract and record deviations;
- decide version/NEWS impact after behavior is proven.

Stop after VIBE-1E. A later VIBE-2 may introduce the minimum exact
manuscript-block -> Vibe-launched Agent conversation -> Run -> Artifact spine.
Formal manuscript revisions, invalidation, decisions, and Checkpoints remain a
separate D3/R3 package with migration and recovery evidence.

## Verification Matrix

### Pure And Component Tests

- overview and all three focus ratios choose the correct active/preview roles;
- project/Page change resets focus and prevents cross-project data retention;
- selected block derives only exact typed references;
- missing or malformed references produce unresolved states;
- correspondence copy never claims a link absent from exact refs;
- each region covers loading, empty, normal, busy, warning, and error states;
- Agent projection preserves actual status and never invents route semantics;
- user-cancelled and non-user interrupted Agent Turns remain distinct;
- verification copy distinguishes output, check, provenance health, and draft
  interpretation;
- typed verification adapters reject ID or media-type mismatch, isolate partial
  source failure, and discard late results after project/revision changes;
- keyboard region selection and editor focus are stable;
- reduced-motion behavior has no animated displacement.

### Workbench Integration Tests

- Vibe mode renders one workspace with all three semantic regions;
- the existing Page can still be edited, saved, rejected as stale, recovered,
  and exported;
- selecting a typed reference updates correspondence and only the related
  regions;
- no exact relation produces an honest unlinked state;
- exact Studio action switches mode and opens the intended existing target;
- returning in-session restores Page/block/region or safely falls back if the
  identity vanished;
- Agent/output region failure does not disable manuscript editing;
- a second project never sees the first project’s focus or records.

### Browser And Visual Evidence

- deterministic mock scenario with irregular real scientific content;
- wide overview at representative desktop geometry;
- intermediate overview with one complete active layer, two responsibility
  previews, complete runtime labels, and no duplicate-path compression;
- manuscript, exploration, and verification focus states;
- 720px/200%-equivalent single-region behavior;
- zero document-level horizontal overflow;
- keyboard-only region switch, Page edit, save, Studio transition, and return;
- no gradient, decorative shadow, generic hero, card grid, chat bubble, raw
  thought stream, or visible internal-ID wall;
- every screenshot receives an explicit visual verdict before the gate passes.

### Development Commands

Feature lanes run their focused Vitest files plus typecheck/lint for affected
files. Integration runs the shortest deterministic gate while iterating, then:

```bash
npm --prefix desktop run rsr:quick -- \
  --ui-test ui/src/app/App.test.tsx \
  --ui-test ui/src/app/DomainSurfaceView.test.tsx \
  --ui-test ui/src/app/RuntimeHistory.test.tsx \
  --ui-test ui/src/app/VibeWorkspace.test.tsx \
  --ui-test ui/src/app/vibe/core/VibeWorkspaceSurface.test.tsx \
  --ui-test ui/src/app/vibe/core/vibe-failure.test.ts \
  --ui-test ui/src/app/vibe/core/vibe-studio-target.test.ts \
  --ui-test ui/src/app/vibe/core/vibe-verification-focus.test.ts \
  --ui-test ui/src/app/vibe/core/vibe-verification-read-port.test.ts \
  --ui-test ui/src/app/vibe/core/vibe-verification-transport.test.ts \
  --ui-test ui/src/app/vibe/core/vibe-workspace-model.test.ts \
  --ui-test ui/src/app/vibe/exploration/VibeExplorationPanel.test.tsx \
  --ui-test ui/src/app/vibe/exploration/exploration-model.test.ts \
  --ui-test ui/src/app/vibe/manuscript/VibeManuscriptLane.test.tsx \
  --ui-test ui/src/app/vibe/manuscript/manuscript-page-session.test.ts \
  --ui-test ui/src/app/vibe/manuscript/manuscript-prosemirror.test.ts \
  --ui-test ui/src/app/vibe/verification/VerificationPane.test.tsx \
  --ui-test ui/src/app/vibe/verification/verification-adapter.test.ts \
  --ui-test ui/src/app/vibe/verification/verification-model.test.ts
npm --prefix desktop run rsr:check:resume:stable
npm --prefix desktop run rsr:build
cargo build -p rho-desktop
npm --prefix desktop run rsr:accept:visual -- --scenarios s9
```

Commands are evidence only when actually run. The integration handoff lists
passed, failed, skipped, and unavailable checks separately.

## Cross-Review Targets

Before activation, the central review records these conclusions:

- accepted plugin-native Surface Runtime retains composition and authority;
- active Studio design language retains visual tokens and focused-document
  accessibility requirements;
- active runtime-output work retains Run/output and Agent context authority;
- Agent contracts retain conversation, Turn, event, approval, and execution
  authority;
- Check/evidence contracts retain their current structural scope;
- Settings/credential streams do not overlap product state but currently own
  shared files that must be released before integration;
- no schema, migration, credential, permission, network, filesystem, approval,
  release, or public-protocol authority changes in VIBE-1.

## Entry Conditions

- [x] product owner explicitly authorized parallel construction;
- [x] current repository, design owners, implementation, dirty worktree, and
  active lane registry inspected;
- [x] separate integration/manuscript/exploration/verification worktrees and
  lanes created from exact base `560dff98cf69`;
- [x] central cross-review entry written without overwriting Settings changes;
- [x] this document renamed to `active-` in the same documentation checkpoint;
- [x] shared VIBE-1 TypeScript contract and truthful state boundaries reviewed
  by all three feature lanes.

Product code must not begin until all unchecked entry conditions are true.

## Acceptance And Definition Of Done

VIBE-1 is complete only when:

1. all VIBE-1A through VIBE-1E behaviors are implemented without authority
   drift;
2. the existing Page editing and project-isolation invariants remain green;
3. exact correspondence and honest absence are both demonstrated;
4. wide, intermediate, focused, narrow, keyboard, error, and recovery states
   pass;
5. mock and real transport surfaces remain contract-compatible;
6. automated visual evidence is reviewed frame by frame;
7. an implementation review records every deviation or confirms none;
8. version and `NEWS.md` are synchronized if this becomes a development
   candidate;
9. only reviewed in-scope files are committed on feature and integration
   branches; and
10. release remains NO-GO unless a separate release contract says otherwise.

## VIBE-1 Integration Review — 2026-08-27

VIBE-1 is implemented and reviewed. The active document remains `active-`
because the broader VIBE-2 direction is not authorized by this checkpoint.

The accepted implementation:

- replaces the generic full-canvas Page-builder presentation with one ordered
  manuscript -> Agent exploration -> verification workspace, using 40/35/25 as
  the wide preset and local-only overview/focus/narrow view state;
- reuses the existing ProseMirror Page/CAS path and requires a successful
  manuscript flush before mode changes, exact Studio navigation, or project
  switches;
- projects durable Agent conversation, Turn, activity, outcome, failure, and
  attention truth without exposing raw reasoning or adding Vibe-owned cancel,
  retry, approval, or execution mutations;
- reads exact Run, Artifact, Plot, Check, and Evidence records through typed,
  project-scoped adapters with independent loading/failure and stale-result
  rejection; and
- opens exact Studio targets only after revalidating the latest active Page,
  block references, and Surface catalog, then restores the Page/block/region
  once in-session when those identities still exist.

Integration review resolved the following defects before acceptance:

- Studio/Vibe mode changes, Page changes, and project switching now share the
  manuscript flush and single-flight gate, including the reverse
  Studio-to-Vibe project-switch race;
- the manuscript becomes read-only while a transition is pending, and exact
  Studio/Agent handoffs lock locally before preflight flush so edits cannot
  cross the committed navigation boundary;
- same-block target replacement fails closed against the latest exact refs;
- a Vibe instance being left cannot consume its own future return token;
- return state is consumed once and resets after Page/project navigation;
- unresolved exact Agent selections retain a real roving keyboard tab stop
  without being mislabeled as the current semantic selection;
- the manuscript toolbar maintains a live roving tab stop when Undo or Save
  becomes unavailable, and the ordered Turn list implements Arrow/Home/End
  navigation;
- Vibe-facing failures centrally redact project paths, internal identifiers,
  UUIDs, and internal tokens before rendering or durable Agent projection;
- unknown Run status fails closed as a generic unknown state instead of
  exposing a raw vendor status; and
- focused preview bands expose their region title and responsibility, while
  the intermediate preset keeps one complete active lane plus two preview
  bands and preserves the full runtime labels in the application status bar;
  browser scale evidence now verifies large multilingual manuscripts in Vibe
  without mounting Studio Surface instances or carrying forward the retired
  Page-builder's released-renderer budget.

No implementation deviation from the authority contract remains. VIBE-1 adds
no schema, migration, durable scientific decision, manuscript revision graph,
invalidation, Checkpoint, credential, permission, filesystem, network,
approval, public protocol, or release authority.

Recorded evidence for the reviewed candidate:

- focused checkpoint: `rsr:quick` passed typecheck, lint, diff-check, 19 test
  files, and 196 tests;
- browser interaction: `rsr:test:interactions` passed realistic irregular
  scientific content, keyboard region switching/edit/save, exact Artifact
  Studio transition/return, intermediate preview-band and status-bar
  preservation, narrow overflow, and existing Studio contracts;
- build: `rsr:build` and `cargo build -p rho-desktop` passed for
  `0.4.1-dev.21`;
- visual harness self-test passed; and
- final real-debug-app S9 evidence at
  `target/visual-acceptance/2026-08-26T23-13-38.823Z` passed 6/6 deterministic
  gates and 6/6 frame reviews with no pending verdict.

The evidence is intentionally split: the real debug app frames verify the
durable new-Page/unlinked empty states and wide/intermediate/focused/narrow
visual system; the browser mock scenario verifies high-density scientific
content and exact typed links. Neither source is reported as proving the
other's facts. The unchanged-source final handoff separately reports the
complete resumable RSR checkpoint.

## Version And Release Decision

The reviewed integration mints synchronized desktop candidate
`0.4.1-dev.21`; `NEWS.md`, Cargo workspace packages, desktop package metadata,
and Tauri configuration carry that version. R package versions are unaffected.
This work does not package, sign, publish, install, or release an application.
Release remains NO-GO.
