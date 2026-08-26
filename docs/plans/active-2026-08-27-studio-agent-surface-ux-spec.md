# Studio Agent Surface UX

Status: active implementation contract

Date: 2026-08-27
Authorization: the user explicitly authorized "优化 Studio 模式中的 Agent 组件
（rho.agent Surface）" on 2026-08-27 with the bounded work-package brief pasted
into the `codex/studio-agent-ux` feature worktree session.
Change class: D2 bounded user workflow (presentation only)
Risk class: R1 frontend presentation and local UI state; no durable, execution,
approval, schema, or transport effect
Work package: studio-agent-ux (lane `studio-agent-ux`,
base `560dff98cf69662cea9672194a6593f09c2d1a6f`)
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
