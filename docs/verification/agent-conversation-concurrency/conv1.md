# Agent Conversation Concurrency — CONV-1 Verification

Date: 2026-08-09
Work package: CONV-1 durable Conversation identity and switching
Issue: GitHub #5
Source identity: development work after immutable `0.4.0-dev.24`

## Implemented Boundary

- Schema v12 adds project-scoped `agent_conversations` and the authoritative
  one-to-one `agent_conversation_turns` mapping without rebuilding the existing
  Turn/event/approval graph.
- A v11 migration creates one read-only `Legacy project history` Conversation
  per project. It does not infer historical thread boundaries.
- Conversation creation plus first-Turn creation is atomic. Exact-Conversation
  history, summaries, detail, terminal reason, deletion primitives, limits,
  normalization, and two-project ownership are enforced in the store.
- Tauri and browser/mock commands list and create Conversations, list only the
  selected Conversation's Turns, and bind a new Turn to the selected durable
  Conversation. An omitted Conversation remains a compatibility request to
  create one atomically.
- Task Rail rows now represent Conversations. Switching to an empty
  Conversation does not borrow another Conversation's Turn, approval, output,
  or proposal. Legacy history starts a new Conversation when the user submits
  a new Prompt.
- Project hydration clears Agent selection and owned projections before the new
  project's data loads. Async Agent-history responses are guarded by both
  project identity and request sequence.
- `interrupted/user_cancelled` is presented as `Cancelled`; other interruption
  reasons remain `Interrupted`.

CONV-1 intentionally retains the existing global one-running-Turn admission
rule. Parallel execution, per-Turn cancellation/waiter ownership, resource
scheduling, Retry, and Conversation Delete UI are not claimed here.

## Automated Evidence

The following commands passed against the final CONV-1 source on 2026-08-09:

- `cargo check --workspace --all-targets`: PASS; only the 13 pre-existing
  unused Git-helper warnings were emitted.
- `cargo test --workspace --all-targets`: PASS. Notable counts are Desktop 151
  passed plus one opt-in Keychain smoke ignored, Server 53 passed, Store 107
  passed, and all remaining workspace targets passed.
- `Rscript -e "testthat::test_local('r/rho.bridge', reporter='summary')"`:
  PASS.
- `Rscript -e "testthat::test_local('r/rho.agent', reporter='summary')"`:
  PASS.
- `node --check desktop/dist/app.js`: PASS.
- All 47 `scripts/test-*.mjs` frontend/platform/release contracts: PASS.
- `git diff --check`: PASS.

Focused Store coverage proves empty v12 bootstrap and reopen; v7/v8/v9/v10/v11
upgrade paths; one synthetic legacy Conversation per project; exact-thread
context; one active Turn per Conversation; two-project isolation; atomic
Conversation/first-Turn rollback; terminal-only Conversation deletion and
cascades; Windows-root normalization; malformed-v11 rejection with preserved
backup; injected migration rollback and recovery; and current-schema rejection
of a cross-project Conversation mapping.

## Deterministic Browser Review

Fixture:

```text
http://127.0.0.1:4175/?preview=agent-first-direct&state=conversation-switch&platform=macos-aarch64
```

Google Chrome headless screenshots and computed DOM evidence were reviewed at
1440 x 900 and 900 x 800 window sizes.

| State | Evidence |
| --- | --- |
| Wide | two Conversation rows; selected empty Conversation has no Turn/mode/approval/proposal; the other row is independently Running/Plan; New conversation enabled; global composer disabled by the retained CONV-1 admission rule; 195 px rail; no list or document overflow; no overlap |
| Narrow | existing breakpoint hides Task Rail; Agent flow fills the 900 px viewport; selected empty Conversation remains isolated; no document overflow or panel overlap |

The wide row labels were `Empty conversation: New conversation` and
`Plan mode, Running status: Plan a long-running analysis in the first
conversation.` Mode remained a neutral shape, status retained the existing
color authority, the long title ellipsized, and `aria-current` identified only
the selected Conversation.

## Independent R3 Contract Review

The implementation was re-read separately from the implementation pass against
the active specification's ownership, migration, project-switch, error,
recovery, UI, and compatibility boundaries.

Resolved findings:

- blocker: Conversation and first Turn could otherwise separate on persistence
  failure; one Store transaction plus a rollback regression now prevents the
  orphan.
- blocker: project switching and overlapping refreshes could project stale
  Agent/approval data; hydration clearing, project/request guards, exact mock
  filtering, and contract assertions now prevent it.
- blocker: malformed v11 ownership and a corrupted cross-project v12 mapping
  needed fail-closed outcomes; both now have stable rejection reasons and
  negative tests.
- major: failure to persist the initial user event could leave a durable
  `running` Turn without a task; the command path now records that Turn failed
  before returning the error.
- major: read-only legacy history and `user_cancelled` presentation were not
  truthful in the initial UI slice; new input now creates a non-legacy thread
  and cancellation uses the terminal reason.

No unresolved P0/P1 ownership, migration, rollback, recovery, project-isolation,
or CONV-1 UI finding remains. There is no dependency, credential, network,
Workspace R authority, or R package API change in this package.

## Version And Release Decision

No application or R package version was changed at this checkpoint. CONV-1 is
not distributable and must not be released under the already published
`0.4.0-dev.24` identity. Application version metadata and `NEWS.md` remain an
integration gate after CONV-3.

Installed-app acceptance was not run because this package deliberately cannot
satisfy Issue #5's concurrency acceptance yet. Release status remains NO-GO,
Issue #5 remains open, and CONV-2/CONV-3 remain inactive until their respective
checkpoint activation and review.

Review disposition: **accept CONV-1 source checkpoint only**.
