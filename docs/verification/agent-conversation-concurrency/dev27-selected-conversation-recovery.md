# CONV-3-R1 `dev.27` Selected Conversation Recovery Evidence

Date: 2026-08-10

Status: source implementation, complete affected automated matrix, independent
R3 review, upstream integration, exact hosted candidate, seven-workflow
owner-installed acceptance, acceptance asset, and MAC5 GO pass; final Issue #5
comment/closure and distinct public publication remain open

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

## Exact Candidate Evidence

PR #21 integrated CONV-3-R1 into upstream `main`; protected candidate run
[`31391411316`](https://github.com/YuLab-SMU/Rho/actions/runs/31391411316)
passed against authoritative commit
`aff83f01d2db8c241fe794fe5e5e4c80d2baf2a0`. It produced both platform
artifacts and an unpublished Draft prerelease `367934137`. Aggregate candidate
evidence is 1,477 bytes with SHA-256
`79d60b6bea760cce4a0ff03202683236c67789742c71274c8d6830b8a4926880`.

The macOS DMG is 21,113,282 bytes with SHA-256
`345217b4943dd9708e0ee54b36129a3c1017bd0cacfce713cffc5967127adafb`.
It independently passed checksum, DMG verification, arm64, embedded-commit,
Developer ID, notarization, staple, and Gatekeeper inspection. The exact
installed app reported `0.4.0-dev.27`, main-binary SHA-256
`502a8ff0df93da536c9a4afa2ca67e34331695a38b4043c37172ad5fe9c74eb8`,
schema 12, the expected embedded commit, and Workspace R ready.

## Exact Installed Acceptance

All seven workflows passed on 2026-08-10 against the exact installed candidate:

1. Conversations B and C ran concurrently with overlapping execution intervals
   and independently persisted terminal output.
2. While D and G were running, a third attempt created an empty Conversation
   but no Turn and showed the two-Turn admission bound. Exact cancellation made
   only G's original Turn `interrupted`/`user_cancelled`; D remained running and
   completed.
3. Alpha and Beta mutations on different files applied independently. Two
   overlapping exact-selection proposals for `shared.R` admitted one applied
   replacement; the second apply was rejected stale with no mutation event and
   the file remained at the accepted content.
4. Non-first G Conversation
   `agent_conversation_40bc1a59-6d52-4c06-8722-a709d02d21ac` was selected and
   persisted. A normal application quit/reopen restored that exact selection,
   its output, original/Retry lineage, and persisted mutation state.
5. Retry Turn `agent_turn_c8e90369-5d3d-46f3-8a9b-b40e9824e7e9` completed with
   29,844 output characters while the original
   `agent_turn_53648611-3e5e-4d9b-a533-668dd66b632e` remained terminal and
   unchanged.
6. After the owner explicitly confirmed the final destructive dialog,
   Conversation `agent_conversation_f044ecc6-d944-4266-a55e-de63846561b1`
   and its mapping were absent. Unrelated G and its two Turn mappings remained,
   and selection fell back to another project-owned Conversation.
7. A project-B chooser attempt during G Retry produced durable
   `project_switch_blocked` evidence with message “Stop the active Agent turn
   before switching projects.” Project A remained active and file truth did not
   change.

The Alpha fixture had no final newline, so the requested append concatenated
with its existing last line. The evidence therefore makes no formatting claim;
it proves independent path admission and mutation identity. During the normal
quit/reopen, no shutdown-log row was emitted, but the original process exited,
a different PID opened, the schema reopened current, and the exact session
selection recovered. These bounded observations do not weaken any acceptance
invariant.

The schema-v1 acceptance asset was generated only after the aggregate pass and
validated against the repository publish contract. Draft asset
`rho-0.4.0-dev.27-acceptance.json` is 1,598 bytes with SHA-256
`4ae9aec04105951d7cedda004444bfd9ab5972bd8ff20905897b2a70c505b151`.
It binds the exact commit, candidate-evidence digest, and both platform records.
The Draft now has exactly eight unique assets, remains `draft=true` and
`prerelease=true`, and has not created a public Release or Git tag.

## Decision And Remaining Gates

CONV-3-R1 and the complete Issue #5 installed behavior are accepted with
`MAC5 GO` for this exact candidate. Final evidence integration and the required
Issue comment/closure remain; public Release and update-site mutation are a
separate unexercised gate. No `dev.26` artifact, receipt, hash, Draft asset, or
partial result was composed into `dev.27`.
