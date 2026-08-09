# Agent Conversation Concurrency — CONV-3 Verification

Date: 2026-08-09
Work package: CONV-3 mutation scheduling, Retry, and selected Conversation deletion
Issue: GitHub #5
Application identity: `0.4.0-dev.25`
Source checkpoint commit: recorded by the following documentation-only commit

## Implemented Boundary

- Two distinct Conversations may now run bounded Act Turns concurrently. Each
  Turn still owns its process, credential, approvals, events, cancellation, and
  output; Workspace R remains one serialized broker authority.
- File Apply and Undo use a normalized project-and-path lane. Same-file work is
  serialized and digest-rechecked, while different files can reach disk
  independently without waiting for the global Workspace context lock.
- Every admitted file mutation records a durable start ledger before disk I/O.
  Restart reconciliation records exact intended-after content as recovered,
  exact expected-before content as not applied, and every other observation as
  outcome uncertain. Mutation controls remain unavailable for uncertain state.
- Apply is single-decision: replay, stale, in-flight, undone, and uncertain
  proposal states fail closed. Undo requires a durable successful Apply ledger,
  the exact applied digest, and the exact pre-Apply editor snapshot. Disk
  recovery and editor restoration use separate digests so a proposal applied
  over a legitimate unsaved draft can still be undone precisely.
- Conversation creation, Turn/file admission, cancellation, selected deletion,
  history clearing, and project switching share one transition gate. An
  admitted claim cannot appear in the gap after project-switch preflight.
- Retry creates a new immutable Turn in the same non-legacy Conversation and
  records `retry_of_turn_id`; it does not rewrite the original. Selected Delete
  confirms the exact Turn count, rejects active/file-busy state, cascades only
  that Conversation, and preserves other projects and Conversations.
- The Task Rail, selected-thread timeline, file-state warnings, Retry/Delete
  controls, browser mock commands, and Tauri commands project the same durable
  state. Recovered/not-applied/uncertain file outcomes do not depend on local
  browser storage.

No second Workspace R, cross-project history, new credential authority,
unrestricted filesystem operation, direct-environment approval reuse, or R
package API is introduced.

## Automated Evidence

The following commands passed against the final CONV-3 application source on
2026-08-09:

- `cargo check --workspace --all-targets`: PASS; only the 13 pre-existing
  unused Git-helper warnings were emitted.
- `cargo test --workspace --all-targets`: PASS. Notable counts are Desktop 167
  passed plus one opt-in Keychain smoke ignored, Server 58 passed, Store 108
  passed, and every remaining workspace target passed.
- `Rscript -e "testthat::test_local('r/rho.bridge', reporter='summary')"`:
  PASS.
- `Rscript -e "testthat::test_local('r/rho.agent', reporter='summary')"`:
  PASS.
- `node --check desktop/dist/app.js`: PASS.
- All 48 `scripts/test-*.mjs` frontend/platform/release contracts: PASS.
- `cargo fmt --all -- --check` and `git diff --check`: PASS.

Focused regressions additionally prove:

- two Act Turns are admitted only in distinct Conversations and a third or
  same-Conversation Turn is rejected;
- Workspace R claims remain serialized and queued cancellation performs no
  Workspace mutation;
- different-file writes progress independently, same-file proposals produce
  one exact result plus one stale result, and queued file cancellation leaves
  disk unchanged;
- create/edit absence, UTF-16 ranges, changed content, write failure,
  post-write persistence failure, safe recovery, uncertain recovery, replay,
  forged/unapplied/repeated Undo, and unsaved-editor-snapshot Undo all fail or
  recover truthfully;
- file admission ordered before project switching blocks that switch, then
  cancellation releases the exact claim without changing the file;
- Retry source and lineage are exact, legacy/cross-project sources fail closed,
  and selected deletion preserves an unrelated same-project Conversation plus
  an identically shaped other-project Conversation.

## Deterministic Browser Review

The local deterministic desktop preview was reviewed in the connected external
browser using:

```text
http://127.0.0.1:4175/?preview=agent-first-direct&state=file-proposal-uncertain
http://127.0.0.1:4175/?preview=agent-first-direct&state=retry-delete
```

At 1440 x 900, the uncertain mutation state remained visible in the selected
Conversation with a warning that the result could not be proved; Accept,
Reject, and Undo were all withheld, Task Rail remained visible, and there was
no document overflow. At 900 x 800, the existing below-minimum-width breakpoint
hid Task Rail while preserving the selected state, warning, and withheld
actions without document overflow. The supported Tauri minimum width remains
1024 px; 900 px is a resilience check.

In the Retry/Delete fixture, Retry created `agent_turn_3` with visible
`Retry of agent_turn_2` lineage while the original `agent_turn_2` remained in
the timeline. Delete confirmation named the selected Conversation and its two
Turns. After confirmation, the unrelated Conversation remained selected and
keyboard focus returned to its Task Rail row. No page error was observed.

The later safety correction added only the separate persisted/mock digest for
an unsaved editor snapshot; it did not change these reviewed layouts or
interactions. The final mock/source contract suite was rerun afterward.

## Independent R3 Contract Review

The final implementation was re-read separately against the active contract's
file authority, mutation sequencing, cancellation, project switching,
recovery, Retry/Delete, project isolation, mock parity, accessibility, and
release boundaries.

Resolved findings across CONV-3:

- blocker: file mutation initially held the global Workspace context lock,
  accidentally serializing different files. Disk mutation now uses independent
  path lanes and updates Workspace identity only after the write.
- major: frontend-local decision state could hide or misstate recovered file
  outcomes. Durable mutation events now own applied, undone, stale, recovered,
  not-applied, and uncertain projections.
- major: the mock path did not initially enforce the same mutation lifecycle or
  selected-deletion race rules. It now follows the Tauri state machine.
- major: uncertain recovery lacked a durable warning presentation and safe
  action withholding. The selected panel now exposes the warning as status and
  removes every mutation action.
- blocker: project switching could pass preflight between project lookup and
  file-claim registration. One transition gate now orders project switching
  with every relevant admission and destructive operation; deterministic race
  coverage proves the switch is blocked.
- blocker: a caller could replay Apply or request Undo without a durable Apply
  predecessor, including a forged `before_content`. A persisted proposal state
  machine and exact Apply ledger now authorize one Apply and one matching Undo.
- major: the first exact-Undo ledger conflated the old disk digest with the
  unsaved editor snapshot. Separate recovery and restoration digests now retain
  existing unsaved-draft behavior without weakening crash recovery.

No unresolved P0/P1 concurrency, mutation, recovery, project-transition,
Retry/Delete, project-isolation, credential, Workspace-authority, or UI/mock
finding remains at the source checkpoint.

## Version And Remaining Gates

Application metadata, workflow defaults, cache-busting resources, and
`NEWS.md` are synchronized at `0.4.0-dev.25`. Store schema remains v12.
`rho.bridge` remains `0.1.13` and `rho.agent` remains `0.1.5` because neither
exported package contract changed.

This evidence accepts the CONV-3 **source checkpoint only**. Upstream merge and
required CI, an exact signed/notarized candidate, owner-installed macOS
acceptance, MAC5, publication, update-site mutation, final Issue evidence, and
Issue closure remain separate factual gates. Release decision remains NO-GO.
