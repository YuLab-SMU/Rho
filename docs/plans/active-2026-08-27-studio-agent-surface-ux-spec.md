# Studio Agent Surface UX

Status: active implementation contract; amended 2026-08-27 for round 3
(lane `studio-agent-ux-3`)

Date: 2026-08-27
Authorization: the user explicitly authorized "优化 Studio 模式中的 Agent 组件
（rho.agent Surface）" on 2026-08-27 with the bounded work-package brief pasted
into the `codex/studio-agent-ux` feature worktree session. Round 2 was
explicitly authorized by the product owner on 2026-08-27 after reviewing the
round-1 result against mature agent-chat references (see the Round 2
Amendment section).
Change class: D2 bounded user workflow (presentation only)
Risk class: R1 frontend presentation and local UI state; no durable, execution,
approval, schema, or transport effect
Work package: studio-agent-ux (lane `studio-agent-ux`,
base `560dff98cf69662cea9672194a6593f09c2d1a6f`);
round 2: lane `studio-agent-ux-2`, base `63914e14a1dd`;
round 3: lane `studio-agent-ux-3`, base `c39924f0290c`
Mandatory stop: after the restructured Agent Surface, focused tests,
typecheck/lint, wide/medium/narrow mock preview, and contract review

## Problem

The current Studio Agent Surface stacks every engineering control at one
visual level: conversation switcher, New, Context capacity, Ask/Plan/Act,
auto-approve, timeline, running state, context preview, tool events, approval,
file-edit proposal, and composer. The hierarchy is flat, density has no
gradient, and the surface reads as an internal debug console rather than a
mature agent workbench.

Evidence: `desktop/ui/src/app/AgentSurfaceView.tsx` at the lane base renders
all controls above in one flow; turn cards give approval, file proposals,
errors, and plain answers near-identical structure; the running/Stop control
sits at the top of the surface, far from the composer the user is working in.

## Goals

1. The default view highlights only: the current conversation, the
   conversation/task timeline, the composer, the current run state, and one
   clear primary action (Send / Review before send).
2. Conversation switching, New, and secondary operations use a compact toolbar
   or progressive disclosure and do not occupy primary visual area.
3. Ask / Plan / Act keep their exact existing semantics as a clear, compact
   mode selector. No new execution authority is created.
4. Context capacity is demoted from a prominent toolbar-level control to an
   explicit secondary disclosure. The capability itself is unchanged and does
   not depend on unmerged Settings work.
5. Conversation content is organized in task reading order: user goal, agent
   result, current run/wait state, decisions the user must handle, then
   technical detail.
6. Tool events, model id, request/revision, and context evidence remain
   collapsed by default and stay viewable.
7. Approval, file-edit proposal, error, and ordinary answer have visibly
   different structure; they must not all render as the same card.
8. The composer stays in a stable, easy-to-reach position; during long
   conversations the primary input and Stop remain reachable.
9. Empty, loading, running, waiting, failed, cancelled, and completed states
   each carry real copy, never color alone.
10. The Rho "quiet, precise scientific workbench" style is preserved: no
    blue/purple gradients, no large shadows, no oversized radii, card grids, or
    padding; existing design tokens only; task-dependent density; monospace
    technical values; structure follows content and action order.
11. Narrow surfaces are supported. Wide, medium, and narrow widths are
    verified with no horizontal overflow; composer and Stop stay reachable.

## Non-goals And Hard Boundaries

- No backend, schema, Provider, model-selection, credential, approval,
  file-mutation, or execution-semantics change.
- No edit to `WorkbenchApp.tsx`, `SurfaceView.tsx`, `App.test.tsx`, `mock.ts`,
  `types.ts`, `foundation.css`, `surfaces.css`, `NEWS.md`, Cargo files, or
  `docs/project/active-document-cross-review.md` (several are owned by the
  parallel `vibe-integration` lane).
- No new transport/backend command; the `UiKernelTransport` surface used by
  the component is unchanged.
- Durable conversation state, Ask/Plan/Act, auto-approve, context preview,
  cancel, and file proposal accept/reject/undo keep their real semantics;
  every button invokes exactly its existing handler.
- No model capability or Provider configuration moves into the Agent main
  view.
- The real Tauri app is not run or restarted from this feature worktree; only
  focused tests and the worktree's own Vite/mock preview are used.
- The component's props contract with `SurfaceView.tsx` is unchanged.

## Current Behavior And Compatibility Constraints

`AgentSurfaceView.tsx` currently owns all Agent Surface behavior. The
redesign keeps:

- the exported `AgentSurfaceViewState`, `AgentFileProposal`, and
  `AgentFileUndoState` contracts consumed by `SurfaceView.tsx`;
- the persisted view state shape (`conversation_id`, `mode`, `composer`,
  `auto_approve`, `file_decisions`);
- all transport calls and their arguments (`runAgent`, `previewAgentContext`,
  `cancelAgentTurn`, `retryAgentTurn`, `respondAgentApproval`,
  `loadAgentLlmSettings`, `setAgentContextCapacity`, `retryAgentRuntime`,
  conversation/turn listing and detail);
- the display-mode contract: `conversation` shows timeline plus composer,
  `activity` hides the composer, `composer` hides the timeline;
- the DOM hooks the automated visual-acceptance gate `scripts/visual-
  acceptance/s3-agent.mjs` queries: `.rho-agent-mode button` (Ask/Plan/Act
  with `aria-pressed`), `.rho-agent-mode-hint`, `.rho-agent-composer
  textarea`, `.rho-agent-context-controls button:first-child`,
  `.rho-agent-context-controls .rho-primary-action`,
  `.rho-agent-context-preview`, `.rho-agent-turn` with
  `rho-agent-turn-<status>`, `.rho-agent-answer`, `.rho-agent-approval`,
  `.rho-agent-file-proposal`.

## Design

### Information architecture

1. Compact toolbar: conversation selector (primary width), quiet New action,
   quiet Context disclosure toggle (`aria-expanded`). No other engineering
   controls at this level.
2. Context capacity form renders only inside that disclosure, unchanged in
   fields, validation, revision check, and save semantics.
3. Timeline in task reading order per turn:
   - turn header: mode label, textual status chip for non-completed states,
     and a quiet Details disclosure (status, model);
   - user goal (prompt);
   - agent result (final answer) as the primary body text;
   - failure/cancellation as a distinct status block with explicit copy;
   - decision blocks that need the user: waiting approvals ("Approval
     required") and file-edit proposals ("File change"), each with its own
     structure, kind label, consequence text, and decision actions;
   - technical disclosures collapsed by default: tool/code events and context
     used;
   - quiet footer actions: Pin to Vibe, Retry where the existing contract
     offers it.
4. Composer dock pinned to the bottom of the surface:
   - run/wait status row with elapsed time and Stop sits directly above the
     input, so Stop is always next to the primary action;
   - compact Ask/Plan/Act segmented selector plus its hint;
   - runtime-output context chip (unchanged semantics);
   - textarea (unchanged persistence and Enter behavior);
   - auto-approve row only in Act mode (unchanged semantics);
   - controls row: Review context (first) and the primary Send / Review
     before send action (`.rho-primary-action`);
   - context preview panel (unchanged content and digest behavior).

### States and copy

| State | Required presentation |
|---|---|
| loading | bounded "Loading conversation…" text in the timeline |
| empty | named empty state: no turns yet, how to start (mode + composer) |
| running | status row "Agent running · mm:ss" with Stop; turn keeps running chip |
| waiting | status row names the wait (decision/provider) with Stop available |
| failed | distinct failure block "Turn failed" plus the error message; Retry in footer |
| cancelled | distinct "Turn cancelled" note; Retry in footer |
| completed | ordinary answer; no status chip |
| degraded runtime | existing banner, retry, and dependency diagnostics disclosure |
| narrow width | toolbar and composer wrap without horizontal overflow; composer and Stop reachable |

### Styling

A new `desktop/ui/src/styles/agent-surface.css` contributes all Agent-specific
rules inside `@layer surfaces { … }` and is imported directly by
`AgentSurfaceView.tsx`. All values come from existing tokens in
`desktop/ui/src/styles/tokens.css`. `surfaces.css` is not edited; its existing
Agent rules remain as the base and are refined only by equally-specific,
later-in-order rules in the new layer contribution. No gradients, no large
shadows, no new colors, monospace for technical values.

If repository validation rejects this direct-import loading mechanism, this
package stops and reports instead of claiming `surfaces.css`.

### Tests

A new `desktop/ui/src/app/AgentSurfaceView.test.tsx` uses
`createMockUiKernelTransport` read-only (mock.ts is not edited) and covers:

- populated timeline renders goal before answer; technical disclosures
  collapsed by default;
- empty state copy for a conversation without turns;
- Ask/Plan/Act switching persists mode and resets auto-approve outside Act;
- Context capacity is hidden behind its disclosure and keeps its validation;
- running and waiting turns show the status row with Stop next to the
  composer, and Stop calls the existing cancel path;
- failed and cancelled turns show their distinct copy;
- a waiting approval and a file proposal render as structurally distinct
  decision blocks; reject persists `file_decisions`;
- submit through the composer calls `runAgent` with unchanged arguments and
  clears the composer;
- degraded health renders the banner and dependency diagnostics disclosure.

## Cross-review

Reviewed against the overlapping active contracts:

- `plans/active-2026-08-03-agent-first-adaptive-work-surface-spec.md` owns the
  Agent-first posture and adaptive work surface. This package does not change
  posture, surface navigation, editor visibility, or task entities; it only
  restructures the inside of the existing rho.agent Surface.
- `plans/active-2026-08-04-interface-modernization-scientific-agent-surfaces-spec.md`
  owns the shared operational state language, compact Agent activity, and
  distinct review surfaces. This package follows that state language and
  keeps its presentation-only mapping; backend values are not rewritten.
- `design/accepted-2026-08-21-plugin-native-surface-runtime-design.md` keeps
  Agent as a Surface with Ask/Plan/Act as broker policy inside the Surface.
  This package does not turn mode into a layout concept or add authority.

No schema, persistence, approval, execution, credential, project identity, or
release conflict was found.

Owned by the parallel `vibe-integration` lane and therefore NOT edited here;
recorded as integration follow-ups below:

- `docs/project/active-document-cross-review.md` needs this document's
  cross-review row.
- `docs/README.md` needs this document's index entry.
- `NEWS.md` needs the user-visible entry after integration verification.

## Verification Matrix

- `npm --prefix desktop run rsr:typecheck`;
- `npm --prefix desktop run rsr:lint`;
- focused `vitest run src/app/AgentSurfaceView.test.tsx`;
- `git diff --check`;
- Vite/mock preview in this feature worktree at wide, medium, and narrow
  widths checking hierarchy, disclosures, state copy, no horizontal overflow,
  and composer/Stop reachability;
- the full `rsr:check` matrix and the s3 visual-acceptance gate are deferred
  to the integration lane, which owns the shared entry files and the real
  debug application.

## Version, NEWS, And Lifecycle

- This is user-visible desktop behavior inside the unreleased development
  line. `NEWS.md` is owned by the integration lane; the NEWS entry is a
  recorded integration follow-up, not skipped.
- No application or R package version change in this lane; version metadata
  is integration-lane authority and advances only for a named candidate.
- Keep this document active while the integration follow-ups and the s3
  visual-acceptance gate remain open.

## Definition Of Done

This package reaches its stop point when the restructured Agent Surface keeps
every existing behavior contract, focused tests and the listed checks pass,
wide/medium/narrow preview evidence is recorded, the diff is scoped to the
four lane-owned files, and the integration follow-ups are explicit.

## Integration Follow-ups

1. Add the cross-review row for this document to
   `docs/project/active-document-cross-review.md` (integration lane).
2. Add the index entry for this document to `docs/README.md` (integration
   lane).
3. Add the `NEWS.md` entry after integration verification (integration lane).
4. Run the complete `rsr:check` matrix and the s3 visual-acceptance gate
   against the merged result; this lane verified focused tests, typecheck,
   lint, and mock preview only.
5. Decide application version impact at the next named integration candidate;
   no distribution before synchronized metadata.

## Implementation And Evidence

Implementation completed in the `studio-agent-ux` feature lane on 2026-08-27.

- `AgentSurfaceView.tsx` restructures the surface into a compact toolbar
  (conversation, quiet New/Context), a timeline in task reading order (mode
  and status chip, Goal, answer, distinct failure/cancellation blocks,
  approval and file-change decision blocks, collapsed technical evidence,
  quiet footer actions), and a bottom composer dock that now carries the
  run/wait status row with Stop next to the input. All transport calls,
  persisted view state, display modes, props, and the s3 visual-acceptance
  DOM hooks are unchanged.
- `styles/agent-surface.css` contributes all Agent-specific rules in
  `@layer surfaces` and is imported by the component. Because the bundler
  orders component CSS before `foundation.css`, every selector is scoped
  under `section.rho-agent-surface` so the refinement is order-independent.
  Values come from `tokens.css` only; narrow adaptations reuse the existing
  `@container` pattern on `.rho-surface`.
- `AgentSurfaceView.test.tsx` adds 11 focused tests using the mock transport
  read-only.

Deviation recorded during preview verification: at ~170px surface width the
degraded-runtime banner's retry button crushed its text column to zero width
(1,644px-tall banner, composer unreachable). This pre-existing
`surfaces.css` flex layout weakness defeated the "composer and Stop stay
reachable" goal, so it is repaired inside this lane's own stylesheet
(`.rho-agent-degraded-row` wraps, text column gets a flex basis) without
editing `surfaces.css`.

Automated evidence passed 2026-08-27:

- `npm --prefix desktop run rsr:typecheck`;
- `npm --prefix desktop run rsr:lint`;
- `npx vitest run --config ui/vitest.config.mts src/app/AgentSurfaceView.test.tsx`:
  11 of 11 passed;
- full UI suite `npx vitest run --config ui/vitest.config.mts`: 52 files,
  340 tests passed;
- `npm run rsr:build --prefix desktop` (proves the direct CSS import in the
  real Vite build);
- `git diff --check`.

Browser/mock preview evidence (headless Chromium against the built bundle,
`preview=bootstrap` mock) is recorded under
`target/studio-agent-ux-preview/`:

- `surface-wide.png` (~600px surface): hierarchy, quiet toolbar, distinct
  decision blocks, full-width composer; no overflow; composer and Send
  visible;
- `surface-medium.png` (~260px surface): same contract with wrapped toolbar
  and single-column composer;
- `surface-narrow.png` (~167px surface): degraded banner stays compact,
  decision block wraps without character-breaking, composer and Send remain
  reachable, no horizontal overflow;
- `capacity-disclosure.png`: Context capacity stays behind its disclosure
  and renders without overflow at ~260px.

The mock preview always reports the Agent runtime as degraded (fixture
fact), so preview screenshots show the truthful degraded state; running,
waiting, failed, and cancelled states are covered by the focused tests.
The complete `rsr:check` matrix, the s3 visual-acceptance gate, NEWS,
cross-review/index entries, and version decisions remain with the
integration lane as listed above.

## Round 2 Amendment: Composer-Centric Density And In-Surface Model Switching

Authorization: after reviewing the round-1 result against mature agent-chat
references (Alma/Codex-style composer-centric design), the product owner
directed on 2026-08-27 that:

- the chat model selector moves into the Agent surface so the user can
  switch at any time ("把模型能力或 Provider 配置塞进 Agent 主界面，方便用户
  随时切换");
- file-change presentation must scale to many proposals ("Agent 的更改可能
  是海量的"), learning from the summary-plus-review pattern instead of one
  large card per proposal;
- the round-1 product boundaries (no model controls in the surface, explicit
  full-card proposals) are relaxed to references where relaxing them
  improves usability ("之前的边界……不是硬边界，只是参考").

What this amendment authorizes (still presentation-only, D2/R1):

1. A compact chat-model chip in the composer control row. It reads the
   existing `loadAgentLlmSettings`, lists enabled language models, and
   switches through the existing revision-checked `selectAgentChatModel`
   transport. Provider configuration, credentials, and capability-route
   management remain in Settings; the chip only switches the existing
   agent.chat route's model. Switching clears any reviewed context preview.
2. A single composer container: the run/wait status row with Stop stays at
   its top, then the textarea, then one control row holding Review context
   (first), the compact Ask/Plan/Act selector with its caption hint, the
   model chip, and the primary Send/Review action. Every s3
   visual-acceptance DOM hook from round 1 remains present.
3. The empty state offers suggestion chips that fill (never send) the
   composer.
4. Per-turn tool/code events and context evidence collapse into one inline
   activity summary line ("N tool events · M context sources") that expands;
   file-edit proposal events are excluded because they render as decision
   rows.
5. File-change proposals become compact one-line decision rows (kind,
   operation, path, outcome, explicit Apply/Reject/Undo) with the proposed
   content behind a per-row disclosure, so many proposals stay scannable.
   Apply/Reject visibility and semantics are unchanged; approval blocks keep
   their distinct warning treatment with bounded code height.

Still not authorized: backend, schema, or transport changes; credential or
Provider editing in the surface; auto-send from suggestion chips; any change
to approval or file-mutation semantics; editing files owned by other lanes.

Round 2 verification adds: model listing and switching through the
revision-checked path with preview invalidation, suggestion-chip fill,
collapsed-by-default proposal content and activity summary, plus the full
round-1 matrix (focused tests, typecheck, lint, build, three-width preview).

Round 2 evidence passed 2026-08-27 (lane `studio-agent-ux-2`, implemented in
the same four lane files):

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 12 of 12 passed, including the new
  revision-checked model-switch test with preview invalidation, the
  suggestion-chip fill, the collapsed-by-default proposal content, and the
  inline activity summary;
- full UI suite: 341 tests passed;
- `npm run rsr:build --prefix desktop`;
- `git diff --check`;
- mock preview under `target/studio-agent-ux-preview/r2/`: `surface-wide.png`
  (~600px), `surface-medium.png` (~260px), `surface-narrow.png` (~167px) show
  the single composer container with the model chip, compact proposal rows,
  and no horizontal overflow; `composer-wide.png` is the composer close-up;
  `model-menu.png` shows the upward-opening model popover inside the
  viewport; `empty-suggestions.png` shows the suggestion chips, and the
  preview probe verified a chip fills (never sends) the composer. Review
  context remains the first control and every s3 DOM hook is present.

## Round 3 Amendment: Reference-Product Chat Patterns

Authorization: on 2026-08-27 the product owner reviewed the round-2 result
against two mature agent-chat products (a ChatGPT agent conversation view and
the Alma chat composer/model picker, supplied as annotated screenshots) and
directed: "just copy the model of these product for a agent chat module. this
is the way". Round 3 adopts the recognizable interaction patterns from those
references inside the same presentation-only boundary.

What this amendment authorizes (still presentation-only, D2/R1, same four
lane files):

1. Chat-model popover upgrade (Alma pattern). The composer model chip's menu
   gains: a search filter shown when the switchable list is long (more than
   six models), provider group headers, a checkmark on the active row, and a
   per-row metadata line with the monospace `model_id`, a compact context
   size, and the existing selector status. Switching still goes through the
   revision-checked `selectAgentChatModel` transport, still clears any
   reviewed context preview, and still closes the menu on choice. Provider
   configuration and credentials stay in Settings.
2. Timeline activity as visible one-line narration rows (ChatGPT agent
   pattern). Tool-event titles render as terse one-line rows so a running or
   finished turn reads as a narration ("Run summary statistics") instead of a
   collapsed blob. Technical payloads stay collapsed by default at the
   payload level: executed code remains behind its per-row
   `.rho-agent-code-review` disclosure and context-source byte evidence
   remains behind the `.rho-agent-context-used` disclosure. Round-1 goal 6 is
   refined accordingly: title-level narration is ordinary reading content;
   code, model ids, revisions, and byte evidence are the technical detail
   that stays collapsed.
3. Empty state as a centered greeting block (Alma pattern) with the existing
   truthful copy ("No conversation yet" / "Ready for the first turn" plus the
   how-to-start line) and the fill-only suggestion chips.
4. Composer control row polish: secondary actions (Review context first, the
   visible segmented Ask/Plan/Act with its hint, the model chip) get a quiet
   ghost treatment; the primary Send stays right-aligned. Every s3
   visual-acceptance DOM hook from round 1 remains present and visible.

Explicitly not adopted from the references, with reasons:

- The Alma reasoning-effort popup pattern (mode hidden behind a chip) is not
  applied to Ask/Plan/Act: the s3 visual-acceptance gate requires the three
  mode buttons visible with `aria-pressed` and clicks them directly. The
  segmented control stays visible.
- Suggestion chips still fill and never send; the references' auto-send
  behavior is not authorized.
- No backend, schema, transport, credential, approval, or file-mutation
  change; no files owned by other lanes are edited.

Round 3 verification keeps the full round-2 matrix (focused tests, typecheck,
lint, build, `git diff --check`, three-width mock preview under
`target/studio-agent-ux-preview/r3/`) and adds focused tests for the model
search/grouping/metadata rows and the visible activity narration rows.

Round 3 evidence passed 2026-08-27 (lane `studio-agent-ux-3`, same four lane
files):

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 13 of 13 passed, adding the long-menu
  search/group/metadata test (provider group headers, checkmark on the active
  row, mono `model_id`, "33k context · ready" metadata, query reset on
  reopen) and the visible activity narration rows with code and context byte
  evidence still collapsed;
- full UI suite on the final snapshot: 52 files, 342 tests passed;
- `npm run rsr:build --prefix desktop`;
- `git diff --check`;
- mock preview under `target/studio-agent-ux-preview/r3/` (headless Chrome
  against the built bundle; capture script and `capture-probes.json` beside
  the screenshots): `surface-wide.png` (~479px) and `composer-wide.png` show
  the populated turn hierarchy and the single composer container with ghost
  Review context, visible segmented Ask/Plan/Act with hint, model chip, and
  primary Send; `model-menu.png` shows the Alma-style popover with provider
  group header, active-row checkmark, mono model id, and context metadata,
  probed `popoverInView: true` after right-anchoring; `empty-suggestions.png`
  shows the centered greeting state and the probe verified a suggestion chip
  fills and never sends; `capacity-disclosure.png` keeps Context capacity
  behind its disclosure; `surface-medium.png` (~231px) and
  `surface-narrow.png` (~171px, via the real dockview resize sash) probe
  `surfaceOverflow: false`, `pageOverflow: false`, and the composer visible.

Deviation recorded during round-3 preview: the model popover originally
opened left-anchored and clipped out of the viewport when the surface was
docked at the right edge; it is now right-anchored in the lane stylesheet so
it opens leftward and stays in view. No s3 visual-acceptance DOM hook moved;
the complete `rsr:check` matrix and the s3 gate remain with the integration
lane as listed in the follow-ups above.

## Round 4 Amendment: Chat-Native Agent Component

Authorization: on 2026-08-27 the product owner reviewed the round-3 result
against the collected reference screenshots (ChatGPT agent conversation with
the file-change entry and its expanded Review/diff panel; the Alma chat
composer, empty state, and model/reasoning/projects popovers) and directed a
full rebuild of the Agent component in that image: "不仅仅是这里重构。整个
Agent 组件，按照我给你收集的这么多作品的截图，重构" and, for file changes,
"在合适的地方展示入口，点击入口展开 diff 面板".

Governance exception (recorded per the governance exceptions clause): the
lane registry rejected a `studio-agent-ux-4` registration because the
`startup-info-integration` lane took ownership of this package's four files
when it cherry-picked rounds 1-3 to its integration HEAD. The product owner
nevertheless ordered this round with the collision on the record. Rule
bypassed: lane-ownership hard reject for the four lane files on the
`codex/studio-agent-ux` branch only. Reason: direct owner directive; the
integration lane runs acceptance on its own cherry-picked snapshot in its own
worktree, so new commits on the source branch cannot corrupt its in-flight
evidence. Risk and compensation: the integrated result must be re-picked and
the s3 visual-acceptance gate re-run after this round; that follow-up is
recorded below. Expiration: this exception covers only this round's four-file
diff on this branch.

What this amendment authorizes (still presentation-only, D2/R1, same four
files, all transport semantics and s3 DOM hooks unchanged):

1. Chat-native timeline. Turn cards lose their box chrome (border,
   background, padding card) and become a narrative flow: a compact muted
   caption line (mode, textual run state, tiny Details disclosure), the user
   goal as a chat-style user row (quiet filled block, no "GOAL" label), the
   agent answer as plain prose, terse activity narration rows, and distinct
   left-accent callouts for failure/cancellation. Per-turn secondary actions
   (Pin to Vibe, Retry) become quiet ghost text buttons. Status is always
   carried by words, never color alone.
2. File changes as an in-flow entry with an expandable review panel. Each
   turn with file-edit proposals shows one compact entry row ("N files
   changed · first path") that expands inline into a review panel listing
   every `.rho-agent-file-proposal` row (operation, path, outcome,
   Apply/Reject/Undo) with the proposed content behind its per-row
   disclosure. This mirrors the reference "entry → diff panel" interaction
   inside the lane boundary: a dockview-level right rail would require
   workbench files owned by other lanes and is not introduced. A real
   line-diff is not fabricated: the proposal payload carries proposed
   content, not the file's before-content, so the panel reviews the proposed
   content exactly as the apply path would write it.
3. Approval blocks keep their interruptive warning structure (kind, tool,
   bounded code, Approve/Reject); they are the deliberate flow-breaking
   decision and must not look like ordinary narration or file changes.
4. The composer, toolbar, empty state, and model menu keep the round-2/3
   reference patterns; only cohesion fixes are allowed.

Round 4 verification: focused tests updated for the files entry/panel and the
narrative order; typecheck, lint, full UI suite, build, `git diff --check`,
and mock preview at solo-full width plus wide/medium/narrow, including the
expanded review panel and the waiting-approval state.

Round 4 evidence passed 2026-08-27 (same four lane files, on branch
`codex/studio-agent-ux` under the recorded governance exception):

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 13 of 13 passed, including the files
  entry collapsed by default, its expansion into the inline review panel with
  the proposal row, actions, and consequence hint, and the goal-before-answer
  narrative order;
- full UI suite on the final snapshot: 52 files, 342 tests passed;
- `npm run rsr:build --prefix desktop`;
- `git diff --check`;
- mock preview under `target/studio-agent-ux-preview/r3/r4/` (headless Chrome
  against the built bundle; `capture-probes.json` beside the screenshots):
  `solo-narrative.png` (~2486px solo surface) shows the unboxed narrative
  flow — caption line, filled user-goal row, approval callout, activity rows,
  ghost footer actions — with every waiting-turn section probed visible;
  `files-panel.png` shows the "1 file changed · analysis.R" entry expanded
  into the inline review panel; `surface-wide.png` (~479px),
  `surface-medium.png` (~231px), and `surface-narrow.png` (~171px) probe no
  horizontal overflow with the composer reachable.

Deviation/fix recorded during round-4 preview: the built bundle dropped
foundation.css's bare `@layer reset, tokens, …;` order statement during CSS
minification, so first-mention order made `surfaces` the weakest layer and
component-layer button chrome (`:where(button)`) defeated every layered
ghost-button refinement (visible borders on New/Context, Review context, and
turn footer actions in all rounds). `agent-surface.css` now re-declares the
intended layer order before its `@layer surfaces` block; the minifier
canonicalizes the bundle to that order (verified: surfaces layer last; ghost
footer computes `border-color: transparent`). Integration follow-up: the
systemic fix (preserve the explicit layer-order declaration through
minification, or order component-imported CSS after foundation.css) belongs
to the integration lane, which owns foundation.css.

Also on record: the owner-reported "empty waiting turn card" at full width
could not be reproduced headlessly at 485px, 560px, 2526px, or 2486px solo —
every section of the waiting turn probed visible in round 4. If it recurs in
a real browser, the exact browser and steps are needed; the round-4 markup
rewrite replaces the affected structure regardless.

Integration follow-ups from this round: re-pick this branch's new commit and
re-run the complete `rsr:check` matrix plus the s3 visual-acceptance gate
(this round landed under the recorded exception while the integration lane
held the files); evaluate the foundation.css layer-order systemic fix above;
the standing follow-ups (cross-review row, docs index, NEWS entry, version
decision) remain as listed earlier in this document.

## Round 4 Polish Passes (visual-render iterations)

Authorization: the product owner directed on 2026-08-27 that the result must
go through visual rendering and be polished over multiple render–review
rounds ("还要经过视觉渲染，根据渲染结果多打磨几轮").

Two review rounds against fresh headless-Chrome renders (detail crops plus
solo/wide/medium/narrow surfaces) produced these presentation-only fixes,
all inside `agent-surface.css`:

1. Readable measure: toolbar, timeline, capacity form, and composer cap at
   56rem and center on very wide surfaces (flex `width` + `max-width` +
   `align-self`; auto inline margins were avoided because they disable flex
   stretch and shrink the boxes to their content — caught by a layout probe
   showing a 510px timeline beside an 896px composer).
2. `Context used` disclosure quieted to match the neighbouring narration
   rows (no box, caption-weight summary).
3. Approval block tightened (code block margins) and its mono code scrolls
   horizontally instead of breaking mid-token on narrow surfaces.
4. File-proposal rows lay out as a real flex row so Apply/Reject stay
   inline-right at any width.
5. Narrow model popover no longer clips out of the surface (its wide-screen
   `min-width` defeated the container-query cap; dropped under 300px).
6. Narrow composer: the ghost Review-context action hugs the left instead of
   stretching into a centered pseudo-solid button.

Polish evidence (same matrix as round 4, re-run on the final snapshot):
typecheck, lint, focused 13/13, full UI suite 342/342, build,
`git diff --check`; probes and screenshots under
`target/studio-agent-ux-preview/r3/r4/` and `…/r3/polish/` record 896px
centered-and-aligned timeline/composer at 2486px solo, the quiet uniform
activity rows, the inline proposal row, the contained narrow model popover,
and the horizontal-scroll approval code at 171px.

## Round 5 Amendment: Review Surface With Batch Decisions

Authorization: on 2026-08-27 the product owner directed, after reviewing the
round-4 result: "不要把 diff 放到对话里，而且改个文件不要 Approve Reject
啥的，万一项目里有一百个呢？你可以搜索一下主流的 Agent 是怎么处理的".
Mainstream references checked for this direction: Cursor Composer's unified
pre-write review of all changed files with per-file accept/reject plus
Accept All / Reject All; ChatGPT Codex's "Review" panel (changed-files list,
diff view, commit-level action); Snowflake Cortex Code's per-turn "N files
changed" entry with bulk accept/reject actions on the Agent surface.

What this amendment authorizes (still presentation-only, D2/R1, same four
files, no new transport command):

1. No diff content and no per-file decision buttons render inside the
   conversation timeline. A turn that produced file-edit proposals shows one
   compact entry ("N files changed · first path · Review"). Clicking it
   opens a review view that replaces the timeline area inside the Agent
   surface (a dockview-level side rail would require files owned by other
   lanes and stays out of scope).
2. The review view is scoped to the whole conversation: one header (back to
   conversation, total count, consequence hint), then every
   `.rho-agent-file-proposal` row with its existing per-file Apply / Reject /
   Undo semantics and proposed-content disclosure, then per-file outcome
   states exactly as the existing paths report them.
3. Batch decisions for scale (the owner's hundred-file case). A batch bar
   offers Apply all (N) / Reject all over the pending proposals (no outcome,
   not already rejected, and not produced by a running/waiting turn — the
   same eligibility rule the per-row Apply button enforces). Batch means
   sequential invocation of the existing per-file handlers: each
   `applyFileProposal` call keeps its own stale/failure behaviour (per-file
   errors are reported and the batch continues; outcomes refresh at the
   end), and Reject all persists the existing `file_decisions` entries per
   proposal key. No new execution authority, no semantic change to any
   single proposal, no line-diff fabrication: the panel reviews proposed
   content exactly as the apply path would write it. The existing single-slot
   undo state is unchanged: after a batch apply, Undo is offered for the
   last successfully applied proposal only, exactly as the current
   `AgentFileUndoState` contract models.
4. The s3 visual-acceptance DOM hooks are preserved:
   `.rho-agent-file-proposal` rows exist (inside the review view) and remain
   countable; every other hook from round 1 is untouched.

Round 5 verification adds focused tests for: the timeline shows the entry
and no inline proposal/diff; the review view opens with all conversation
proposals and their actions; per-file reject still persists through the
existing path; Apply all invokes the existing handler once per pending
proposal and Reject all persists every pending key; plus the full round-4
matrix and refreshed preview captures (entry in chat, review view, batch
outcomes) at solo/wide/medium/narrow.

Round 5 evidence passed 2026-08-27 (same four lane files):

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 14 of 14 passed, adding the
  entry-only timeline assertions (no inline proposal rows or Apply buttons),
  the review-surface swap with back navigation, and the batch test proving
  Apply all invokes the existing handler once per pending proposal and
  Reject all persists every pending key;
- full UI suite on the final snapshot: 52 files, 343 tests passed;
- `npm run rsr:build --prefix desktop`;
- `git diff --check`;
- mock preview under `target/studio-agent-ux-preview/r3/r5/` (seeded with
  five proposals across two turns): `conversation-entries.png` shows the
  chat flow carrying only "N files changed · path · Review" entries
  (probe: zero inline proposal rows, zero inline Apply buttons);
  `review-surface.png` shows the conversation-scoped review surface (title,
  consequence hint with batch scope, five rows, Apply all (5) / Reject all);
  `review-after-apply-all.png` shows the post-batch state with Undo
  available on the last applied row; `review-medium.png` (~231px) probes no
  horizontal overflow.

Compatibility bridge recorded during round 5: `App.test.tsx` (owned by the
integration lane) verifies the broker file-mutation path by querying
`.rho-agent-file-proposal` in the document. The review surface and the
timeline therefore both stay mounted and toggle through the `hidden`
attribute instead of mount/unmount; the DOM contract is unchanged while the
conversation shows no diff content or decision buttons.

Mock fidelity note: the mock transport does not synthesize `file_edit.*`
outcome events after an apply, so preview rows keep their pending look after
Apply all (with the real broker the existing outcome events appear exactly
as the per-file path reports them). This is a fixture fact, not a component
change.

Integration follow-ups from this round: re-pick this branch's new commits
and re-run the complete `rsr:check` matrix plus the s3 visual-acceptance
gate; the standing follow-ups (cross-review row, docs index, NEWS entry,
version decision, foundation.css layer-order systemic fix) remain as listed
earlier in this document.

## Round 6 Amendment: Reference-Faithful Composer And Decision Strip

Authorization: on 2026-08-27 the product owner, after supplying annotated
reference sets (ChatGPT agent conversation with the files-changed entry and
its Review panel; the Alma composer, model/reasoning/projects/tools
popovers, and suggestion pills) and marking the approval card, the visible
Ask/Plan/Act segmented control, and the text Review-context button as
"都没用", directed: "先描述我给你的每一个图，然后再做我们自己的". The
round-6 description of every reference image and the element-by-element
synthesis were reviewed with the owner before implementation.

What this amendment authorizes (still presentation-only, D2/R1, same four
files, all transport semantics and persisted state unchanged):

1. Approval becomes a compact decision strip (Alma/ChatGPT density): one
   header row — "Approval required" kind, tool name, Approve/Reject actions
   — with the code under review behind a default-collapsed disclosure. The
   decision stays one click away and state is carried by words, not the old
   full-height warning card with always-visible code.
2. Ask/Plan/Act follows the Alma Reasoning pattern: one mode chip showing
   the current mode opens a popover with the three options and their
   one-line explanations (the existing hint copy). The Act-only
   auto-approve checkbox moves into that popover (Projects-popover toggle
   pattern) with its persisted semantics unchanged. The
   `.rho-agent-mode button[aria-pressed]` elements and the
   `.rho-agent-mode-hint` element remain in the DOM.
3. Review context becomes an icon button (Alma eye pattern) with the
   unchanged aria-label; it stays the composer control row's first child,
   so the s3 hook position is unchanged.
4. Explicitly not built: Alma's tools picker and projects picker popovers —
   Rho's Agent has no per-tool toggles or per-surface project selection;
   that engineering configuration stays in Settings.

Recorded integration follow-up (s3): with the three mode buttons inside a
closed popover they are no longer "均可见" per the s3 frame criteria, and an
s3 flow that starts from a persisted non-Ask mode would click a hidden
button. The integration lane must either open the mode popover inside the
s3 script or update that criterion; every other s3 DOM hook
(`.rho-agent-mode button`, `.rho-agent-mode-hint`,
`.rho-agent-context-controls button:first-child`, `.rho-primary-action`,
`.rho-agent-context-preview`, turn/answer/approval/proposal classes) is
unchanged in the DOM.

Round 6 verification: focused tests for the mode popover (switching,
auto-approve only in Act, hint element), the icon Review-context position,
and the approval strip with collapsed code; full round-5 matrix; refreshed
preview captures (composer icon row, mode popover open, approval strip) at
solo/wide/medium/narrow.

## Round 7 Amendment: Architectural Rebuild Of The Agent Surface Module

Authorization: on 2026-08-27 the product owner rejected the presentation-layer
rounds as insufficient — "你这个改法还是换汤不换药，我要的是重构整个
Agent 模块，而不是看起来像之类的。重构，重新设计，不只是外表的" — and
ordered a structural rebuild of the Agent surface module.

Governance exception (extension of the round-4 record): the lane registry
rejected `studio-agent-ux-7` because `startup-info-integration` owns the
package's existing four files. The same recorded exception applies, extended
to the new module paths below on the `codex/studio-agent-ux` branch only;
integration re-pick plus acceptance rerun remains the recorded follow-up.

What this amendment authorizes (D2 bounded rework; R1 — no behavior change
by construction):

1. Decompose the ~900-line `AgentSurfaceView.tsx` monolith into a
   view-model hook plus single-responsibility presentation components under
   `desktop/ui/src/app/agent/`:
   - `proposals.ts` — pure file-proposal parsing/outcome helpers and types;
   - `view-state.ts` — persisted view-state shape, initial-state, copy
     constants, small pure formatters;
   - `useAgentSurface.ts` — the view-model: data loading, subscriptions,
     refresh, composer/mode/model/capacity/context-preview actions,
     approval response, file proposal apply/undo/reject and the batch lane;
   - `AgentToolbar.tsx`, `AgentTimeline.tsx`, `AgentTurn.tsx`,
     `AgentFilesReview.tsx`, `AgentComposer.tsx` — presentation regions with
     explicit, typed props.
2. `desktop/ui/src/app/AgentSurfaceView.tsx` remains the public composition
   root with an unchanged module contract: the `AgentSurfaceView` component
   with the same props, and the `AgentSurfaceViewState`,
   `AgentFileProposal`, and `AgentFileUndoState` exports consumed by
   `SurfaceView.tsx` (which is not edited).
3. Invariants that prove "no behavior change": every transport call and its
   arguments, the persisted view-state shape, all DOM hooks used by the s3
   visual-acceptance gate and the shared App-level tests, the hidden-DOM
   compatibility bridges, and the complete focused + full UI test suites
   pass unchanged. CSS class names and `styles/agent-surface.css` are
   untouched by this round.
4. Out of scope (unchanged from the original brief): backend, schema,
   Provider, credentials, approval/execution semantics, transport commands,
   and files owned by other lanes.

Round 7 verification: the full round-6 matrix (focused 14, full suite,
typecheck, lint, build, `git diff --check`) with zero test edits beyond
path/import adjustments if any; a preview smoke capture confirming the
rendered surface is pixel-equivalent to the round-6 result.

Round 6 evidence passed 2026-08-27 (same four lane files):

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- focused `AgentSurfaceView.test.tsx`: 14 of 14 passed, adding the mode-chip
  popover assertions (closed chip shows the current mode, options carry
  one-line hints, Act-only auto-approve inside the popover), the icon
  Review-context first-child contract, and the approval strip with collapsed
  code;
- full UI suite on the final snapshot: 52 files, 343 tests passed —
  including the two App-level context-review flows, kept green through the
  visually-hidden "Review context" label inside the icon button (same
  DOM-contract bridge pattern as the hidden review surface);
- `npm run rsr:build --prefix desktop`;
- `git diff --check`;
- mock preview under `target/studio-agent-ux-preview/r3/r6/`:
  `approval-strip.png` (header row with inline actions, code collapsed, 80px
  vs the old full-height card), `composer-icon-row.png` (icon Review context,
  mode chip, hint, model chip, Send), `mode-popover.png` /
  `mode-popover-act.png` (options with hints and check; Act reveals the
  auto-approve toggle; popover probed in view), `surface-medium.png` (~231px
  no overflow).

Round 7 evidence passed 2026-08-27 (the rebuild round; files: the
`desktop/ui/src/app/agent/` module plus the composition root
`AgentSurfaceView.tsx`, the spec; CSS and the focused test file untouched):

- `npm --prefix desktop run rsr:typecheck` and `rsr:lint`;
- full UI suite on the final snapshot: 52 files, 343 tests passed with zero
  test edits — the public contract (component props, exported types, DOM
  hooks, hidden-DOM bridges) is unchanged by construction;
- `npm run rsr:build --prefix desktop`;
- `git diff --check`;
- preview smoke on the seeded build: the round-5 and round-6 capture probes
  re-ran with identical results (entry-only conversation, review surface
  with five rows and the batch bar, approval strip 80px, composer icon row,
  mode popover with hints and the Act auto-approve toggle, 231px no
  overflow), confirming pixel/behavior equivalence after the rebuild.

Structure after the rebuild: `AgentSurfaceView.tsx` is a 27-line composition
root; `agent/proposals.ts` (pure proposal helpers), `agent/view-state.ts`
(persisted state + copy), `agent/useAgentSurface.ts` (the view-model hook),
and the presentation regions `AgentToolbar.tsx` (+ degraded banner,
capacity form), `AgentTimeline.tsx`, `AgentTurn.tsx` (+ approval strip,
activity rows), `AgentFilesReview.tsx` (+ batch bar, proposal rows),
`AgentComposer.tsx` (+ running row, mode menu, model menu, context
preview).

Integration follow-ups from this round: re-pick this branch's new commits
(including the new `agent/` module) and re-run the complete `rsr:check`
matrix plus the s3 visual-acceptance gate; the standing follow-ups
(cross-review row, docs index, NEWS entry, version decision, foundation.css
layer-order systemic fix, s3 "modes visible" criterion update from round 6)
remain as listed earlier in this document.
