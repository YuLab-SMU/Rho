# File Proposal Completion State

Status: active; FILE-PROPOSAL-COMPLETION-1 implementation and acceptance pass; FILE-PROPOSAL-VALIDITY-R1 implementation, focused regression, and exact local persisted-proposal UI acceptance passed 2026-08-19

Date: 2026-08-07
Authorization: user requested implementation of GitHub Issue #7
Change class: D1 bounded file-proposal presentation and stale-state repair
Risk: R1 local UI state with asynchronous file verification
Work package: FILE-PROPOSAL-COMPLETION-1

## Problem And Invariants

After a file proposal is accepted, the full Before/After diff must not remain
expanded by default. The compact summary must retain operation, path, status,
and audit-relevant state. Undo is visible only when the current target file is
verified to equal the accepted result and the in-memory undo record is current.

## Scope

- Keep the existing native file-proposal disclosure and proposal decision
  persistence.
- Collapse the panel after a successful Accept, including automatic Act apply.
- Verify the target content asynchronously before showing Undo.
- Invalidate Undo when the active buffer changes, the target file changes, the
  project changes, or verification fails.
- Do not change proposal generation, file mutation, approval policy, or undo
  semantics.

## Failure And Recovery

While verification is pending, Undo remains hidden. A content mismatch or read
failure clears the undo record and leaves the applied file unchanged. Selecting
a new proposal still opens it for review; rerendering the same proposal keeps
the user's disclosure state.

## Verification

The frontend contract covers accepted auto-collapse, same-proposal disclosure
preservation, verified-only Undo, stale invalidation, rejected and undone states,
and project reset. JavaScript syntax, affected UI contracts, Rust tests, and
version/NEWS checks are required. Installed-app acceptance remains separate.

## Implementation Evidence

Implemented 2026-08-07. Successful Accept now closes the native proposal
disclosure. Undo is hidden until the target content is asynchronously verified
against the accepted result, and is invalidated by buffer edits, project
switches, content mismatches, or verification failure. Same-proposal rerenders
retain disclosure state and new proposals still open automatically.

Verified with JavaScript syntax, file-proposal collapse, scientific Agent
surface, Agent-first, Problems/Lint, Outputs, and human-facing UI contracts;
`rho-server` format and all 47 tests also pass.

Replacement `0.4.0-dev.31` Chromium interaction generated an append proposal
through the normal composer against a clean active file. Accept collapsed the
native disclosure, hid Accept/Reject, and exposed Undo only after verification.
Expanding the summary and invoking Undo restored the prior source and rendered
the proposal as `Undone`.

Computer Use against the exact installed signed `0.4.0-dev.31` bundle repeated
the state transition with a live DeepSeek repair proposal: the file remained
unchanged before review; Accept fixed it and collapsed the disclosure; Undo was
absent until verification, then appeared; and Undo restored the original
malformed fixture with state `Undone`. Candidate `dev.31` was later rejected by
the separately owned References/Rename envelope defect, not by this behavior;
the passing slice cannot be relabelled as `dev.32` candidate evidence.

## FILE-PROPOSAL-VALIDITY-R1

The project owner's local `0.4.1-dev.1` test reproduced a proposal that was
invalid when created:

```text
operation: replace_selection
selection_start: 527
selection_end: 527
selection_text: ""
```

The Agent ignored the existing non-empty-selection instruction. The UI rendered
a plausible Before/After disclosure and enabled Accept while the parent turn
still showed `1 running`. `calculateProposedFileEdit()` then rejected the empty
selection before invoking Tauri, but the generic error projector collapsed the
specific reason into "The underlying information changed." No file mutation
event or disk write occurred.

`FILE-PROPOSAL-VALIDITY-R1` is an explicitly authorized D1/R3 rejection repair:

- structural preflight classifies `replace_selection` with an empty range or
  empty captured selection as `invalid`, not `stale`;
- `replace_selection` and `insert_at_cursor` require the proposal target to
  equal the captured active path and require valid integer range shape;
- Accept and automatic Act apply are unavailable while the owning turn is
  queued, running, or waiting; a terminal completed/failed turn may retain its
  reviewable proposal;
- invalid proposals remain visible for audit, but show their exact controlled
  reason, hide Accept, and allow Reject/dismissal;
- automatic Act apply does not consume its one attempt until the proposal is
  structurally valid and the parent turn is terminal;
- `acceptFileEditProposal()` repeats both gates immediately before snapshot and
  invocation; frontend state cannot bypass them;
- the Rust host independently rejects an active parent turn before registering
  a file-mutation claim or reading/writing the target;
- a true disk digest/anchor mismatch remains `AGENT_FILE_RESOURCE_STALE` and
  receives distinct "file changed" copy;
- invalid, active-turn, stale, missing target, duplicate decision, failure,
  recovery, Undo, project containment, atomic write, and session authorization
  semantics remain separate; and
- no fuzzy relocation, whole-file replacement, automatic selection inference,
  new operation, schema, persistence, or filesystem authority is added.

Regression evidence must use the exact empty-selection shape above, a running
parent turn, a terminal valid proposal, a true disk stale proposal, and an
automatic Act proposal. It must prove the invalid/running paths invoke no Tauri
mutation, produce no `file_edit.mutation_started`, and preserve disk content.
Owner local acceptance must see a disabled/honest invalid panel instead of a
clickable Accept plus generic toast. No automated Provider request is part of
this repair.

### FILE-PROPOSAL-VALIDITY-R1 evidence

Implemented and verified on 2026-08-19:

```text
node --check desktop/dist/app.js
node scripts/test-file-proposal-collapse-ui.mjs
node scripts/test-act-file-apply-generated-outputs.mjs
node scripts/test-human-facing-information-ui.mjs
  passed
cargo fmt --all -- --check
cargo test -p rho-desktop --bin rho-desktop file_proposal_ --locked
  passed: 2 focused validity/terminal-gate tests
git diff --check
  passed
```

The frontend pure fixture uses the exact reproduced `527..527` empty selection
and returns `invalid/empty_selection`. A running terminal fixture returns
`waiting`; a valid terminal proposal remains ready. Static order checks prove
auto-apply waits before consuming its attempt, and the Rust host checks parent
turn terminal state before registering a mutation claim and validates proposal
structure before `file_edit.mutation_started`.

The unsigned local `0.4.1-dev.1` App executable SHA-256 is
`9aad157ece429ee77657b066e839bc2c387097477e983832b43bc4f360aafdba`.
Computer Use opened the exact persisted `Make it nature style` proposal without
calling a Provider. The panel rendered `Replace selection · Invalid · select
source`, displayed the exact no-selection explanation, hid Accept, retained
Reject, and left the project file unchanged. This closes the reported local
defect; broader full-suite/CI work remains intentionally deferred by owner
direction.
