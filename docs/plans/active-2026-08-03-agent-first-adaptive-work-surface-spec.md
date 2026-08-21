# Agent-first Adaptive Work Surface

Status: active implementation contract

Date: 2026-08-03
Authorization: user explicitly approved the discussed Agent-first upgrade
Change class: D2 bounded user workflow
Risk class: R1 frontend presentation and local selection state
Work package: UX4-AWS1
Mandatory stop: after the simple default Task surface, explicit file/audit/run
review opening, responsive browser evidence, and contract review

## Problem

The current Agent-first posture still renders the transition-era three-column
shell: task rail, Agent flow, and a permanently visible editor/workspace plus
execution dock. This makes Agent-first read as an IDE with a larger chat panel.
It gives source editing persistent priority even when the user is only defining
a task, reading an answer, reviewing a decision, or checking audit findings.

The broader posture design already says that Agent-first code is normally
reached through the task, artifact, problem, decision, or finding being
reviewed. Its Review surface gives the selected review object the largest work
area and reduces the Agent flow. UX4-AWS1 implements that information priority
using current frontend entities only.

## User Workflow

### Simple default

- Entering Agent-first opens a quiet Task surface centered on objective,
  conversation, typed activity, approvals, file-edit proposals, findings, and
  the `Ask Rho` composer.
- The Monaco editor, document tabs, and execution dock are not permanently
  visible in this default state.
- The task rail appears only when existing turns make task navigation useful;
  an empty state uses one focused Agent surface without an empty permanent rail.
- Project identity, Agent state, pending-decision attention, interrupt/restart,
  posture, Task/Runs/Review, and Audit remain reachable.

### Contextual work surface

- A work surface opens only after an explicit object action.
- Opening a text/source file shows the existing editor and document tabs. It
  does not create a second editor or discard unsaved content.
- Opening a run or Artifact switches to Review and shows its structured detail;
  an associated source/file action may then open the editor.
- Opening Audit switches to Review and shows the deterministic audit report as
  the primary review object. Agent explanation remains optional and cannot
  replace audit facts.
- Clicking audit evidence with a project-relative source path opens that file
  in the editor while preserving the audit report as review context.
- Closing the contextual surface returns to the simple Task surface without
  clearing the selected task, Agent draft, active document, or audit result.

## Presentation Model

Frontend-local state:

```text
AgentWorkSurface = none | file | run | artifact | audit
```

This state controls presentation only. Durable identity continues to come from
the existing document, run, Artifact, Agent turn, and audit records. It is
cleared on project switch and validated whenever the referenced entity changes.

At wide widths:

- `none`: optional compact task rail plus one dominant Agent interaction area;
- `file`: compact Agent/task context beside a larger editor surface;
- `run`, `artifact`, or `audit`: review canvas is largest; Agent interaction is
  compact and remains available for follow-up.

At narrow widths, the task rail hides first. The contextual work surface stacks
or replaces the secondary Agent detail without page-level horizontal overflow.

## States And Acceptance

The installed-candidate workflow for these states is consolidated in
`test/acceptance-project/MANUAL-ACCEPTANCE.md` (sections 3 and 8A) and its
candidate result template. The checklist is queued and currently NOT RUN;
browser/mock evidence does not close it.

| State | Required behavior |
|---|---|
| Empty/default | no persistent editor or execution dock; composer is the primary action |
| Existing tasks | compact task navigation remains available without dominating width |
| File selected | editor opens with exact existing document and a visible close/back action |
| Run/Artifact selected | Review opens with structured current detail and source action when available |
| Audit loading | review canvas shows bounded loading state; Agent answer does not stand in for it |
| Audit findings | grouped findings and evidence are primary; path evidence can open the exact file |
| Audit failure/incomplete | truthful status and limitations remain visible; returning to Task preserves context |
| Close work surface | returns to Task without losing document, draft, selected turn, or audit result |
| Posture switch | Human-first remains unchanged and restores its active document/editor |
| Project switch | contextual selection clears before the new project renders |
| 900 x 700 | no overlap or page-level horizontal overflow; primary action remains usable |
| Keyboard | surface actions, close/back, task tabs, evidence links, and composer are focusable and labelled |

## Authority And Compatibility

- Workspace R, Agent R, Rust broker, approvals, revisions, project identity,
  runs, Artifacts, audit rules, and file mutation contracts do not change.
- Human-first keeps the current editor, files, context panels, and execution
  dock behavior.
- Active document and unsaved buffers remain mounted/preserved when hidden.
- The earlier UX4-P2 rule that the editor stays visible in Agent-first is
  superseded only for presentation. Its context preservation requirement
  remains authoritative.
- Current audit scope remains project/run/Artifact. Arbitrary file-scoped audit
  execution is not authorized; this package only navigates from existing audit
  evidence to a file.

## Non-goals

- No durable Task/branch schema, Artifact versioning, annotation system, new
  audit scope, Agent tool, backend command, store migration, or permission
  change.
- No rewrite of Monaco, Console/Logs, Git review, Environment, or Human-first.
- No automatic execution, audit repair, file mutation, or surface navigation
  caused only by model text.
- No installed-candidate or release-readiness claim.

## Cross-review

- The proposed posture design owns the broader Human/Agent and
  Direct/Monitor/Review information architecture. UX4-AWS1 implements only the
  authorized adaptive presentation slice over existing entities.
- The intuitive-interaction design owns single-entry intent, typed decisions,
  progressive disclosure, and recovery language. Those controls remain
  visible according to their existing safety contract.
- The reproducibility-audit design owns deterministic findings and evidence.
  This package changes only where that existing result renders and how evidence
  navigates to current source.
- The active Agent polish specifications remain compatibility contracts for
  composer, activity disclosure, posture, labels, and responsive behavior.
- Human-first, Git, Environment, execution, approval, persistence, and release
  documents retain their current authority.
- The proposed Plugin-Native Surface Runtime may later host this Task/context
  behavior inside registered Surfaces, Studio Scenes, and ordered Vibe task
  blocks. The new construction plan freezes this old frontend and retires its
  layout state at one cutover instead of creating compatibility Scenes. It
  cannot take focus authority or discard durable drafts/documents/reviews;
  those preservation invariants remain mandatory in the new shell.

No schema, persistence, approval, execution, credential, project identity, or
release conflict was found. The only intentional presentation correction is
removing the permanently visible Agent-first editor required by the earlier
transition implementation.

## Verification Matrix

- extend `scripts/test-agent-first-ui.mjs` for default-hidden editor/dock,
  contextual state, explicit close, audit-first Review, and project reset;
- `node --check desktop/dist/app.js`;
- retain Console/Logs and Git review frontend regressions;
- deterministic browser previews for default, file-open, audit, and failure;
- browser interaction for file open/close, Audit open/evidence navigation,
  Task return, posture preservation, and draft preservation;
- visual/layout review at 1440 x 900 and 900 x 700;
- `git diff --check`.

## Version, NEWS, And Lifecycle

- This is user-visible desktop behavior and requires a `NEWS.md` entry after
  verification.
- Application version remains `0.4.0-dev.0` in this slice; it must advance
  before a different distributable candidate is produced.
- R package versions are unchanged.
- Keep this document active while installed-app acceptance remains open.

## Definition Of Done

UX4-AWS1 reaches its stop point when the default Agent-first page is interaction
first, contextual file/audit/run review works without state loss, Human-first
is unchanged, deterministic frontend/browser evidence passes, NEWS and document
status reflect the result, and residual installed-app acceptance remains
explicit.

## Implementation And Evidence

Implementation and automated/browser verification completed on 2026-08-03.

- Frontend-local `agentWorkSurface` implements `none`, `file`, `run`,
  `artifact`, and `audit` without adding persistence or backend authority.
- The default Task surface hides the editor and execution dock. Existing tasks
  add a compact rail only above the narrow breakpoint; the empty state is one
  centered interaction surface.
- File and audit evidence navigation reuse the mounted editor. Closing the
  work surface preserves the active document, Agent draft, and audit result.
- Runs open from the Runs list into the Review canvas. The existing Artifact
  selection is projected into the same canvas without changing provenance.
- Project hydration clears contextual work state and re-renders Task before the
  new project is presented.
- Human-first retains its editor, Files panel, and execution dock.

Focused evidence and repeatable preview URLs are recorded in
`docs/verification/agent-first-adaptive-work-surface/verification.md`.

No application or R package version was changed. `NEWS.md` was updated because
the behavior is user-visible within the existing `0.4.0-dev.0` development
candidate. Real Tauri and installed-app acceptance remain open, so this
contract stays active and no release-readiness decision is attached.
