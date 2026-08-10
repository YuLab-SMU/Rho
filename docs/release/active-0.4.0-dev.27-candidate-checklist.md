# Rho 0.4.0-dev.27 Cross-Platform Candidate Checklist

Status: active accepted-candidate record; CONV-3-R1 source, complete affected
automation, independent R3 review, upstream integration, exact-commit
two-platform construction, owner-installed seven-workflow acceptance, bounded
acceptance asset, and MAC5 GO pass; final Issue #5 comment/closure and the
distinct public-publication gate remain open

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
| Release tag | `v0.4.0-dev.27` | unpublished Draft release identity; no Git tag or public Release exists |
| Release name | `Rho 0.4.0-dev.27` | unpublished Draft `367934137` |
| Source repository | `YuLab-SMU/Rho` | authoritative-candidate restriction unchanged |
| Authoritative source commit | reviewed upstream default-branch SHA | `aff83f01d2db8c241fe794fe5e5e4c80d2baf2a0` from PR #21 |
| Windows platform | `windows_x86_64` | exact installer and platform evidence passed in run `31391411316` |
| macOS platform | `macos_aarch64` | exact signed/notarized/stapled DMG and platform evidence passed in run `31391411316` |
| Minimum macOS | 14.0 | unchanged |
| Release decision | `MAC5 GO` | exact candidate accepted; public Release/update publication remains a distinct unexercised gate |

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

Protected [candidate run `31391411316`](https://github.com/YuLab-SMU/Rho/actions/runs/31391411316)
passed against authoritative upstream commit
`aff83f01d2db8c241fe794fe5e5e4c80d2baf2a0`. It created unpublished Draft
prerelease `367934137` targeting that exact commit. The Draft remains
`draft=true` and `prerelease=true`; no Git tag or public Release exists.

| Record | Size | SHA-256 |
| --- | ---: | --- |
| aggregate candidate evidence | 1,477 bytes | `79d60b6bea760cce4a0ff03202683236c67789742c71274c8d6830b8a4926880` |
| macOS arm64 DMG | 21,113,282 bytes | `345217b4943dd9708e0ee54b36129a3c1017bd0cacfce713cffc5967127adafb` |
| macOS checksum file | 95 bytes | `1b3449832fb29803f7d7555e6cb1967a195ab2b468096b1985e42b51dba8edd3` |
| macOS platform evidence | 1,358 bytes | `8047b80ccce2c67b3a2b4892ade8543271b22c1a592165ffc3aba1cb2420911d` |
| Windows x86_64 installer | 18,275,475 bytes | `5becb11e4477a5db0533f08537ea0970083b0e42bb6de071c9692da9941dfb45` |
| Windows checksum file | 97 bytes | `958631c5c52b81ac6470e53bde381edbce13bb32700dd00eff6ef15384385edd` |
| Windows platform evidence | 904 bytes | `ebb4bc40474f14b52977f76a63bfd239f40fcd8245cfc39facd41baf007e94e6` |

The downloaded DMG independently passed its published checksum, `hdiutil
verify`, stapler validation, Gatekeeper assessment, arm64 inspection, embedded
commit inspection, and Developer ID/notarization checks. The exact installed
`/Applications/Rho.app` reported version/build `0.4.0-dev.27`, main-binary
SHA-256 `502a8ff0df93da536c9a4afa2ca67e34331695a38b4043c37172ad5fe9c74eb8`,
embedded commit `aff83f01d2db8c241fe794fe5e5e4c80d2baf2a0`, and Workspace R ready.

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
`rho-0.4.0-dev.27-acceptance.json` asset.

Owner-installed acceptance against the exact macOS candidate passed on
2026-08-10:

| # | Workflow | Result | Deterministic evidence |
| ---: | --- | --- | --- |
| 1 | two unrelated Conversations concurrently | PASS | B and C execution intervals overlapped for about 18 seconds; both completed with independently persisted output |
| 2 | third-admission bound and exact cancellation | PASS | the third attempt created no Turn; cancelling G produced only `user_cancelled` for its exact Turn while D continued and completed |
| 3 | different-file progress and same-file conflict | PASS | two different-file mutations applied independently; one same-file exact replacement applied and the stale proposal was rejected without a second mutation |
| 4 | non-first selection normal restart recovery | PASS | selected G (`agent_conversation_40bc1a59-6d52-4c06-8722-a709d02d21ac`) persisted in the project session and recovered after normal quit/reopen with output, Retry lineage, and mutation state |
| 5 | Retry terminal Turn | PASS | Retry Turn `agent_turn_c8e90369-5d3d-46f3-8a9b-b40e9824e7e9` completed while its original remained `interrupted`/`user_cancelled` |
| 6 | confirmed inactive Conversation deletion | PASS | after explicit owner confirmation, only `agent_conversation_f044ecc6-d944-4266-a55e-de63846561b1` and its mapping were removed; unrelated G and both G Turns remained |
| 7 | project switch during active Turn | PASS | switch to project B was blocked with `project_switch_blocked`; project A and file truth remained active and unchanged |

The different-file fixture for Alpha lacked a final newline, so its requested
append produced a concatenated line. This is recorded as a fixture-shape
deviation, not a successful formatting claim; independent path admission,
mutation identity, and same-file stale rejection remained directly proven.
The normal application quit did not emit a shutdown-log line, but the process
terminated, a different PID reopened, schema 12 reopened current, and the exact
saved selection and project state recovered. No visual/mock claim is substituted
for the exact installed workflow.

The aggregate acceptance record passed `validatePublishRecord` before upload.
It was then appended once as the eighth and only new Draft asset:

- name: `rho-0.4.0-dev.27-acceptance.json`;
- size: 1,598 bytes;
- SHA-256:
  `4ae9aec04105951d7cedda004444bfd9ab5972bd8ff20905897b2a70c505b151`;
- schema/status/decision: `rho_candidate_acceptance`, `passed`, `GO`;
- binding: exact commit, candidate-evidence digest, and both platform records.

The other seven Draft assets are unchanged. The Draft still has exactly eight
unique assets and remains unpublished.

## Issue Closure And Publication

The first six closure conditions and exact installed evidence are complete.
At this checked-in checkpoint, the final Issue comment and completed closure
remain the only Issue #5 steps. Closing the Issue does not by itself publish
this release. Public Release and update-site mutation require their distinct
GO gate.

## Current Decision

`MAC5 GO` for the exact `dev.27` candidate and Issue #5 behavior. Source,
automation, review, upstream integration, hosted two-platform candidate,
installed acceptance, and the immutable acceptance asset pass. The final Issue
comment/closure is pending this evidence integration. The Draft is intentionally
unpublished; no public Release, Git tag, Pages/update mutation, or publication
claim is made.
