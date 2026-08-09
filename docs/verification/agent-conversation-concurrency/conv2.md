# Agent Conversation Concurrency — CONV-2 Verification

Date: 2026-08-09
Work package: CONV-2 bounded read-only parallel Turns
Issue: GitHub #5
Source identity: development work after immutable `0.4.0-dev.24`

## Implemented Boundary

- The desktop broker admits at most two nonterminal Ask/Plan Turns, requires
  distinct Conversations, and returns stable rejection codes for a busy
  Conversation, a third Turn, or any attempted concurrency beside Act.
- Every accepted Turn retains its own Agent R process, model route, credential
  override, transport token, task handle, events, output, and durable
  Conversation context. Admission and task registration are atomic under the
  task-registry lock.
- Pending approval and Agent environment-operation waiters carry their owning
  Turn identity. Responses validate that identity, and Cancel interrupts only
  the exact Turn's in-memory waiters and durable request records.
- Agent Workspace R requests enter one FIFO mutex lane. Contention writes a
  bounded, Turn-scoped `resource.waiting` event. Each admitted dispatch has a
  unique run identity for exact cancellation.
- Workspace admission and cancellation share one synchronous state lock. A
  queued Turn marked cancelled cannot cross into Workspace R, while an active
  Turn exposes only its own run identity for the existing run-cancel and Ark
  interrupt contract. The marker is released only after its task has stopped.
- Restart and shutdown drain every tracked Turn, persist the exact global
  terminal reason once, and reconcile only those Turns' Agent approvals and
  environment operations. Project switching reports the total active Agent
  Turn count plus one representative opaque Turn ID.
- Task Rail and the Agent header derive aggregate active counts, while the
  composer and Cancel action remain scoped to the selected Conversation. An
  empty second Conversation stays usable while one unrelated Ask/Plan Turn is
  running; model and mode choices continue to configure the next Turn.
- Browser/mock admission, aggregate state, selected cancellation, and command
  outcomes match the Tauri contract.

CONV-2 deliberately rejects concurrent Act Turns. File mutation scheduling,
Retry, Conversation Delete, versioning, release, and installed-application
acceptance remain owned by inactive CONV-3.

## Automated Evidence

The following commands passed against the final CONV-2 source on 2026-08-09:

- `cargo check --workspace --all-targets`: PASS; only the 13 pre-existing
  unused Git-helper warnings were emitted.
- `cargo test --workspace --all-targets`: PASS. Notable counts are Desktop 155
  passed plus one opt-in Keychain smoke ignored, Server 58 passed, Store 108
  passed, and every remaining workspace target passed.
- `Rscript -e "testthat::test_local('r/rho.bridge', reporter='summary')"`:
  PASS.
- `Rscript -e "testthat::test_local('r/rho.agent', reporter='summary')"`:
  PASS.
- `node --check desktop/dist/app.js`: PASS.
- All 48 `scripts/test-*.mjs` frontend/platform/release contracts: PASS.
- `cargo fmt --all --check` and `git diff --check`: PASS.

Focused regression coverage proves atomic two-Turn admission and third-Turn
rejection; same-Conversation and Act rejection; wrong-owner approval-response
rejection; exact waiter cancellation; exact Agent environment-operation
interruption without touching direct operations; two completed serialized
Workspace claims with maximum concurrency one; queued cancellation before any
Workspace operation; active-run ownership; visible contention events; Cancel A
preserving B's task, waiter, durable Turn, and approval; two-Turn shutdown
reconciliation exactly once; and project-switch blocker count/projection.

## Deterministic Browser Review

Fixtures:

```text
http://127.0.0.1:4175/?preview=agent-first-direct&state=conversation-switch&platform=macos-aarch64
http://127.0.0.1:4175/?preview=agent-first-direct&state=parallel-turns&platform=macos-aarch64
```

Google Chrome headless screenshots and computed DOM evidence were reviewed at
1440 x 900 and 900 x 800 window sizes.

| State | Evidence |
| --- | --- |
| One running, empty selected | two Conversation rows; one unrelated Plan Turn running; empty selected Conversation; composer and New conversation enabled; header `1 running`; no selected Cancel; 195 px Task Rail; no overflow or overlap |
| Two running | two Conversation rows with independent Ask and Plan modes; selected Plan Turn running; composer disabled only by selected/capacity state; New conversation enabled; header `2 running`; selected Cancel visible; no overflow or overlap |
| Narrow | existing below-minimum-width breakpoint hides Task Rail; selected state, aggregate header, composer/cancel state, and content remain coherent with no document overflow |

The supported Tauri minimum width is 1024 px; the additional 900 px review is
a resilience check below that minimum. Frontend source did not change after
this browser evidence was captured.

## Independent R3 Contract Review

The implementation was re-read separately from the implementation pass against
the active specification's admission, process isolation, Workspace authority,
approval ownership, cancellation, restart, project switching, credentials,
mock parity, and CONV-3 exclusion boundaries.

Resolved findings:

- blocker: a queued Turn could observe no active run, acquire the Workspace
  lane immediately afterward, and reach Ark while the cancellation path only
  aborted its future. Cancellation and execution admission now use one locked
  lane state; the queued Turn is rejected before dispatch, and deterministic
  race coverage protects the invariant.
- major: approval response delivery previously depended only on request ID.
  Waiters now retain Turn identity and wrong-owner delivery fails closed
  without consuming the legitimate waiter.
- major: restart/shutdown and per-Turn cancellation could otherwise share
  indistinguishable terminal outcomes. Exact Turn cancellation records
  `user_cancelled`; global reconciliation records `desktop_restart` or
  `desktop_shutdown` once per still-active Turn.
- major: a single global frontend busy projection still disabled unrelated
  work. Aggregate project state and selected-Conversation state are now
  separate, and browser/mock evidence covers both one- and two-Turn states.

No unresolved P0/P1 concurrency, cancellation, approval, Workspace authority,
project-isolation, credential, recovery, or CONV-2 UI finding remains. No new
dependency, network authority, credential exposure, R package API, schema, or
file-mutation behavior was introduced in this package.

## Version And Release Decision

No application or R package version changed at this checkpoint. CONV-2 is not
independently distributable and must not be released under the already
published immutable `0.4.0-dev.24` identity. Application metadata and
`NEWS.md` remain a single integration gate after CONV-3.

Installed-app acceptance was not run because concurrent Act/file scheduling,
Retry, and Conversation Delete are intentionally absent. Release status remains
NO-GO, Issue #5 remains open, and CONV-3 remains inactive until separately
activated.

Review disposition: **accept CONV-2 source checkpoint only**.
