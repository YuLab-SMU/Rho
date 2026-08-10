# CONV-3-R1 `dev.27` Selected Conversation Recovery Evidence

Date: 2026-08-10

Status: source implementation, complete affected automated matrix, version
synchronization, and independent R3 contract review pass; upstream integration,
exact hosted candidate, installed acceptance, and Issue #5 closure remain open

Change class: D3 project-scoped recovery and compatibility correction

Risk class: R3 persisted project state, restart, project switching, and
cross-project isolation; D4/R4 gates remain separate for candidate artifacts

## Reproduction And Invariant

Exact installed `0.4.0-dev.26` preserved schema 12, the normalized project,
Conversation/Turn rows, output, retry lineage, and mutation events across a
normal quit/reopen, but replaced an explicitly selected non-first Conversation
with the first list item. Repeating the normal restart produced the same result.

Inspection showed that `hydrateProject()` reset `selectedConversationId`,
`ProjectSessionSnapshot` did not serialize it, and selection/creation did not
schedule a session save. The accepted invariant is that the selected
Conversation is project-scoped session state: restore the exact identifier only
when it exists in the authoritative current-project list; otherwise choose a
truthful current-project fallback and persist the repair.

## Implemented Boundary

- `ProjectSessionSnapshot` additively carries nullable
  `selected_agent_conversation_id`; serde defaults historical snapshots to
  `None`, so SQLite schema remains 12.
- The project-session store rejects empty, surrounding-whitespace, control-byte,
  or greater-than-256-byte identifiers when saving. Loading historical or
  locally malformed JSON clears only this optional field and preserves the
  remaining valid session state.
- The frontend uses the same UTF-8 byte bound, includes the field in both the
  broker and emergency snapshots, restores it provisionally during project
  hydration, and validates membership against the current project's bounded
  Conversation list before requesting Turn detail.
- Explicit selection, new Conversation creation, Retry selection changes, and
  load-time fallback schedule the existing project-session save. Existing
  request-sequence plus normalized-project checks still reject asynchronous
  responses from an earlier project.
- A deterministic browser/mock scenario covers exact non-first restore and
  foreign-project fallback/repair. The source contract also executes the same
  production normalization and selection functions directly for normal,
  malformed, deleted, and foreign-project cases.

No Conversation/Turn table, migration, approval, model credential, Workspace R,
file mutation, environment-operation, or R package contract changed.

## Focused Regression Evidence

- `node --check desktop/dist/app.js`: PASS.
- `node scripts/test-agent-conversation-ui.mjs`: PASS. This executes the
  production selection and normalization functions and checks save, hydrate,
  repair, preview, and broker-session wiring.
- `node scripts/test-agent-conversation-concurrency.mjs`: PASS.
- `cargo test -p rho-desktop project_session -- --nocapture`: PASS, 2 tests.
- `cargo test -p rho-desktop
  selected_agent_conversation_session_is_compatible_and_project_scoped --
  --nocapture`: PASS, 1 test.
- `node scripts/test-mac4-release-contract.mjs`: PASS.
- `node scripts/test-macos-notary.mjs`: PASS.

The Rust regression proves exact round trip, separate project A/B session
files, historical snapshots without the field, save rejection, and malformed
load recovery without discarding other valid fields. The frontend regression
proves a project-A identifier cannot be selected from project B's list and that
the repaired project-B selection is the only value eligible for persistence.

## Complete Affected Matrix

- `cargo check --workspace --all-targets`: PASS.
- `cargo test --workspace --all-targets`: PASS.
  - Desktop: 168 passed, 0 failed, 1 existing opt-in macOS Keychain smoke
    ignored.
  - Server: 58 passed, 0 failed.
  - Store: 108 passed, 0 failed.
  - All remaining workspace targets passed.
- `Rscript -e "testthat::test_local('r/rho.bridge', reporter='summary')"`:
  PASS.
- `Rscript -e "testthat::test_local('r/rho.agent', reporter='summary')"`:
  PASS.
- all `scripts/test-*.mjs`: PASS, 49 scripts.
- `cargo fmt --all -- --check`: PASS.
- `node --check desktop/dist/app.js`: PASS.
- `git diff --check`: PASS.

The current environment exposed no connected browser-control instance, so the
new deterministic preview URL could not be visually captured during this local
source checkpoint. This is recorded as an unclaimed manual check, not a pass.
There is no new geometry or control; the production functions and mock state
transition are automated above. The stronger exact installed-app restart
workflow remains mandatory under the active `dev.27` checklist before Issue
closure or any release GO.

## Independent R3 Contract Review

A separate implementation-to-contract pass found no unresolved P0/P1 issue:

- ownership remains project-session JSON plus authoritative project-filtered
  Conversation membership; no frontend ID becomes store authority;
- project A and B use stable root-keyed session files, and a foreign ID cannot
  reach Turn detail, approval, output, Retry, or Delete projection;
- historical snapshots are additive and require no guessed migration;
- malformed persisted input fails closed for the new field without destroying
  valid document/panel recovery;
- selection save failures retain the pre-existing emergency snapshot recovery
  path and surface the existing truthful save error;
- deletion and absent history converge to a persisted null/current-project
  fallback rather than recreating deleted ownership;
- application metadata and `NEWS.md` are synchronized at `0.4.0-dev.27`;
  `rho.bridge` remains 0.1.13, `rho.agent` remains 0.1.5, and schema remains 12.

## Decision And Remaining Gates

The CONV-3-R1 source checkpoint is accepted for upstream integration. Release
decision remains `NO-GO`. A fresh upstream-main commit must pass the protected
two-platform `dev.27` candidate workflow, produce a new immutable unpublished
Draft, then pass all seven installed Issue #5 workflows. No `dev.26` artifact,
receipt, hash, Draft asset, or partial installed result is composable.
