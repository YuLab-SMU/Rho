# Rho 0.4.0-dev.25 Cross-Platform Candidate Checklist

Status: active source-candidate record; Issue #5 CONV-1 through CONV-3 source
implementation, automated/browser verification, and independent R3 review
pass; exact integration commit, hosted artifacts, installed acceptance, MAC5,
and publication are not yet established

Date: 2026-08-09
Last updated: 2026-08-09

Change class: D3 project-scoped Agent Conversation persistence, bounded
execution admission, cancellation/approval isolation, resource scheduling,
recovery, Retry/Delete, and UI behavior, plus the required D4 single-use
development identity

Risk: R3 for schema, concurrency, project switching, file mutation and
recovery; R4 for any hosted candidate, signing/notarization, Release, update
site, or publication action

Owning documents: the active Agent Conversation concurrency specification owns
Issue #5 behavior and acceptance. The active macOS arm64 specification owns
packaging and trust gates. This checklist alone owns the exact
`0.4.0-dev.25` identity, candidate evidence, installed-acceptance ledger, and
GO/NO-GO decision.

Authorization: on 2026-08-09 the project owner explicitly authorized Issue #5
implementation through the point where the Issue can be closed. That admits
source implementation, review, version synchronization, tests, commit, push,
upstream integration, required CI, installed-app acceptance preparation, and
Issue evidence. It does not silently turn incomplete source evidence into
MAC5 acceptance, nor permit an artifact, tag, draft, update-site mutation, or
public Release to be reported as complete before its own exact facts exist.

`0.4.0-dev.24` is an immutable published predecessor. Its source commit,
artifacts, notarization receipt, hashes, owner acceptance, MAC5 record, Release,
and update manifest remain historical and cannot satisfy this checklist.

## Exact Identity

| Field | Required value | Current evidence |
| --- | --- | --- |
| Application version | `0.4.0-dev.25` | source metadata and `NEWS.md` synchronized; exact commit pending |
| `rho.bridge` version | `0.1.13` | unchanged; no exported package contract changed |
| `rho.agent` version | `0.1.5` | unchanged; no exported package contract changed |
| Store schema | `12` | Conversation migration, reopen, failure injection, and recovery matrix pass |
| Release tag | `v0.4.0-dev.25` | workflow default only; tag not created |
| Release name | `Rho 0.4.0-dev.25` | workflow default only; Release/draft not created |
| Release channel | development prerelease | fixed by SemVer |
| Source repository | `YuLab-SMU/Rho` | authoritative-candidate restriction unchanged |
| Reviewed source commit | one exact 40-character SHA | pending final CONV-3 commit |
| Authoritative source commit | reviewed upstream default-branch SHA | pending integration |
| macOS platform | `macos_aarch64` | exact candidate artifact not built |
| Minimum macOS | 14.0 | configuration unchanged |
| Release decision | `NO-GO` | installed acceptance and release gates remain open |

The version and any eventual tag are single-use. A rejected artifact or later
user-visible source change advances to another version; no artifact, tag,
draft, hash, receipt, or evidence file may be overwritten or relabelled.

## Included Behavior

- schema v12 adds one project-scoped Conversation identity and exact Turn
  mapping, with one visibly labelled legacy thread per project during v11
  migration and no guessed historical separation;
- Task Rail rows represent Conversations, preserve independent selection and
  output, and keep the selected composer usable while one unrelated Turn runs;
- at most two distinct Conversations may have a Turn in flight; one
  Conversation remains single-turn, and a third Turn fails closed;
- each Turn owns its model process, credential injection, cancellation,
  approvals, event stream, retry lineage, and terminal reason;
- Workspace R remains a single serialized authority; exact-turn authorization
  and revision checks are repeated after broker lane admission;
- file Apply/Undo uses a normalized project-and-path lane, validates the exact
  durable proposal and disk digest after admission, permits different-file
  progress, and marks same-file conflicts stale;
- a durable mutation ledger reconciles interrupted writes after restart as
  applied, not applied, or outcome uncertain without inventing success;
- project switching is serialized with Agent-turn/file-claim admission and is
  blocked while an admitted resource operation is in flight;
- Retry creates a new linked Turn from immutable prompt/mode/editor context,
  while selected Delete transactionally removes only one inactive Conversation
  and its exact Turns; migrated legacy history remains deletable but cannot be
  continued or retried.

No second Workspace R, cross-project history, unrestricted filesystem or
environment authority, credential sharing, automatic file overwrite, or
unreviewed retry/delete behavior is introduced.

## Source Verification Gate

The final reviewed source must record, with exact commands and counts:

- complete Rust workspace tests and `cargo check --workspace --all-targets`;
- both R package suites;
- every fail-fast `scripts/test-*.mjs` frontend/release contract;
- JavaScript syntax, Rust formatting, and `git diff --check`;
- migration/reopen/failure injection and two-project isolation;
- two-Turn admission, same-Conversation/third-Turn rejection, cancellation and
  approval isolation, serialized Workspace R, same/different-file behavior,
  mutation recovery, project-transition ordering, Retry, and selected Delete;
- deterministic desktop and narrow-browser review, accessibility, command/mock
  parity, and a separate R3 implementation-to-contract review.

Passing source checks does not establish installed or hosted evidence.

Source verification completed on 2026-08-09 and is recorded in
`docs/verification/agent-conversation-concurrency/conv1.md`, `conv2.md`, and
`conv3.md`. Final CONV-3 results are: `cargo check --workspace --all-targets`
PASS; `cargo test --workspace --all-targets` PASS with Desktop 167 passed and
one opt-in Keychain smoke ignored, Server 58 passed, Store 108 passed, and all
other targets passed; both complete R package suites PASS; all 48
`scripts/test-*.mjs` contracts PASS; JavaScript syntax, Rust formatting, and
`git diff --check` PASS. Deterministic wide/narrow browser review and the
separate R3 contract review pass with no unresolved P0/P1 finding. The exact
reviewed commit is recorded after the source checkpoint commit is created.

## Exact Candidate And Installed Acceptance Gate

If a candidate is authorized, the combined workflow must bind Windows and
signed/notarized macOS artifacts to one reviewed upstream default-branch
commit, validate all existing immutable evidence contracts, and create at most
one draft prerelease. Review-only fork artifacts cannot satisfy this gate.

The owner-installed macOS application workflow must demonstrate, against that
exact candidate:

1. create two project-scoped Conversations and start unrelated Ask/Plan work
   without cancelling or borrowing context from the other;
2. observe the bounded third/same-Conversation rejection and truthful aggregate
   state, then cancel one exact Turn without changing the other;
3. exercise two Act/file proposals: different files make independent progress,
   while two proposals for one file yield one exact result and one visible
   stale/conflict state rather than overwrite;
4. restart after representative completed/failed history and confirm selected
   Conversation, output, retry lineage, and recovered mutation state persist;
5. Retry one terminal Turn and verify the original remains unchanged;
6. delete one selected inactive Conversation after confirmation and verify an
   unrelated Conversation and its history remain;
7. attempt project switching during an admitted Turn/file operation and verify
   the switch is blocked without project or file ambiguity.

The acceptance record must bind exact version, commit, candidate evidence
digest, artifact digest, date, owner result, and any deviations. Only a real
owner-reported pass may set `decision: GO` or admit publication.

## Issue Closure Gate

GitHub Issue #5 may close only after the active specification's eight closure
conditions are true: reviewed CONV-1 through CONV-3 implementation, complete
automated and installed evidence, synchronized version/NEWS, exact commit and
upstream integration, required CI, and a final Issue comment linking the PR,
commit, checks, and installed evidence.

## Current Decision

`NO-GO` for artifact promotion or publication. The source checkpoint passes,
but no integrated upstream commit, `dev.25` tag, draft, artifact, installed
acceptance, MAC5 record, public Release, or update-site entry exists yet.
