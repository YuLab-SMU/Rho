# Rho 0.4.0-dev.27 Cross-Platform Candidate Checklist

Status: active replacement-candidate contract; CONV-3-R1 selected Conversation
recovery, complete affected automated verification, version synchronization,
and independent R3 review pass; upstream integration, exact-commit two-platform
candidate construction, installed acceptance, MAC5, and publication remain open

Date: 2026-08-10
Last updated: 2026-08-10

Change class: D3 project-scoped session recovery plus the required D4
single-use development identity

Risk: R3 for persisted project selection, restart recovery, project switching,
and cross-project isolation; R4 for hosted candidate, signing/notarization,
Release, update site, or publication action

Owning documents: the active Agent Conversation concurrency specification owns
Issue #5 behavior and CONV-3-R1 acceptance. The active macOS arm64
specification owns packaging and trust gates. This checklist alone owns the
exact `0.4.0-dev.27` identity, candidate evidence, installed-acceptance ledger,
and GO/NO-GO decision.

Authorization: the project owner's 2026-08-09 end-to-end Issue #5 authorization
and 2026-08-10 instruction to continue automatically admit the bounded repair,
tests, review, version synchronization, commit, push, upstream integration,
protected candidate workflow, local installation, and representative
acceptance. They do not convert unrun checks into evidence or authorize a
public Release before its distinct publication gate.

`0.4.0-dev.24` is the immutable published predecessor. `dev.25` and `dev.26`
are immutable rejected attempts. Draft Release `367596197`, its seven `dev.26`
assets, hashes, notarization receipt, and partial installed results remain
historical and cannot be relabelled, replaced, or composed into this candidate.

## Exact Identity

| Field | Required value | Current evidence |
| --- | --- | --- |
| Application version | `0.4.0-dev.27` | source metadata, workflow defaults, cache identity, release contracts, and `NEWS.md` synchronized |
| `rho.bridge` version | `0.1.13` | unchanged; no exported package contract is planned |
| `rho.agent` version | `0.1.5` | unchanged; no exported package contract is planned |
| Store schema | `12` | unchanged; project-session JSON is additive and defaults historical snapshots |
| Release tag | `v0.4.0-dev.27` | reserved by this contract; no tag or Release exists |
| Release name | `Rho 0.4.0-dev.27` | reserved by this contract |
| Source repository | `YuLab-SMU/Rho` | authoritative-candidate restriction unchanged |
| Authoritative source commit | reviewed upstream default-branch SHA | pending |
| Windows platform | `windows_x86_64` | pending exact candidate run |
| macOS platform | `macos_aarch64` | pending signed/notarized candidate run |
| Minimum macOS | 14.0 | unchanged |
| Release decision | `NO-GO` | implementation and every downstream gate remain open |

The identity is single-use. Any artifact-producing failed run or later
user-visible source change consumes it and requires another version. No asset,
receipt, hash, acceptance record, or Draft may be overwritten or relabelled.

## Included Recovery Behavior

- project-session JSON additively stores nullable
  `selected_agent_conversation_id` and historical snapshots default to no
  selection;
- selecting or creating a Conversation schedules the normalized project's
  session save;
- hydration restores a saved identifier only provisionally, then validates it
  against the current project's authoritative Conversation list before loading
  detail, output, approvals, or actions;
- malformed, missing, deleted, and foreign-project identifiers fall back to a
  truthful current-project selection and persist the repaired snapshot;
- all CONV-1 through CONV-3 concurrency, cancellation, conflict, retry,
  deletion, recovery, and project-transition behavior remains unchanged.

No SQLite schema, R package, Workspace R, Agent approval, model credential,
filesystem, environment, or execution authority change is included.

## Source Verification Gate

Required evidence is the focused Rust project-session round-trip,
legacy/default/malformed recovery, and two-project isolation matrix; frontend
save/restore/membership/fallback contract; JavaScript syntax and Rust format;
all affected Rust workspace, R package, frontend, browser/mock, release, and
metadata checks; and an independent R3 implementation-to-contract review.

Source verification passes and is recorded in
`docs/verification/agent-conversation-concurrency/dev27-selected-conversation-recovery.md`.
Focused Rust and production-function regressions pass; all 49 frontend/release
contracts, complete Rust workspace check/tests, both R package suites,
JavaScript syntax, Rust format, and `git diff --check` pass. Desktop reports 168
passed with one existing opt-in Keychain smoke ignored; Server reports 58 and
Store 108 passed. Independent R3 review found no unresolved P0/P1 issue. The
local browser-control instance was unavailable, so no visual mock capture is
claimed; exact installed-app restart acceptance remains mandatory.

## Exact Candidate Gate

One protected combined candidate workflow must bind both Windows and
signed/notarized/stapled macOS artifacts to one reviewed commit already present
on upstream `main`. It must create a new unpublished `dev.27` Draft with fresh
run-scoped evidence. Review-only fork artifacts and every `dev.26` artifact are
ineligible.

Candidate run, commit, hashes, trust checks, and Draft: pending.

## Installed Acceptance Gate

Against the exact installed `dev.27` candidate, the owner workflow must:

1. run two unrelated Conversations concurrently;
2. prove bounded rejection and exact-turn cancellation isolation;
3. prove different-file progress and same-file stale conflict handling;
4. select a non-first Conversation, quit normally, reopen, and recover that
   exact selection plus output, retry lineage, and mutation state;
5. Retry a terminal Turn without rewriting the original;
6. delete only one confirmed inactive selected Conversation;
7. block project switching during an admitted Turn/file operation without
   changing project or file truth.

The checked-in ledger must bind the exact version, commit, candidate-evidence
digest, artifact digests, acceptance date, all seven results, and deviations.
Only an aggregate pass permits generation of the bounded public schema-v1
`rho-0.4.0-dev.27-acceptance.json` asset. Installed results: pending.

## Issue Closure And Publication

Issue #5 remains open until the active specification's eight closure
conditions are true and a final Issue comment links exact source, CI, and
installed evidence. Closing the Issue does not by itself publish this release.
Public Release and update-site mutation require their distinct GO gate.

## Current Decision

`NO-GO`. Source implementation, automated verification, version
synchronization, and independent R3 review pass. Upstream integration, hosted
candidate, installed acceptance, acceptance asset, MAC5, public Release, and
update-site evidence do not yet exist.
