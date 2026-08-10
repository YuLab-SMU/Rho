# Rho 0.4.0-dev.26 Cross-Platform Candidate Checklist

Status: historical rejected candidate record; Issue #5 CONV-1 through CONV-3
source implementation, automated/browser verification, independent R3 review,
upstream integration, exact `dev.26` two-platform candidate CI, and immutable
Draft assembly passed, but owner-installed acceptance rejected this identity
because selected Conversation recovery failed

Date: 2026-08-09
Last updated: 2026-08-10

Change class: D3 project-scoped Agent Conversation persistence, bounded
execution admission, cancellation/approval isolation, resource scheduling,
recovery, Retry/Delete, and UI behavior, plus the required D4 single-use
development identity

Risk: R3 for schema, concurrency, project switching, file mutation and
recovery; R4 for any hosted candidate, signing/notarization, Release, update
site, or publication action

Owning documents: the active Agent Conversation concurrency specification owns
Issue #5 behavior and replacement acceptance. The active macOS arm64
specification owns packaging and trust gates. This historical checklist alone
owns the immutable `0.4.0-dev.26` identity, candidate evidence, installed
rejection ledger, and REJECTED/NO-GO decision.

Authorization: on 2026-08-09 the project owner explicitly authorized Issue #5
implementation through the point where the Issue can be closed. That admits
source implementation, review, version synchronization, tests, commit, push,
upstream integration, required CI, installed-app acceptance preparation, and
Issue evidence. It does not silently turn incomplete source evidence into
MAC5 acceptance, nor permit an artifact, tag, draft, update-site mutation, or
public Release to be reported as complete before its own exact facts exist.

`0.4.0-dev.24` is an immutable published predecessor. `0.4.0-dev.25` is an
immutable rejected candidate attempt whose macOS artifact and notarization
receipt remain run-scoped historical evidence. Neither predecessor's source,
artifact, receipt, hash, acceptance, Release, nor update manifest can satisfy
this checklist.

## Exact Identity

| Field | Required value | Current evidence |
| --- | --- | --- |
| Application version | `0.4.0-dev.26` | source metadata and `NEWS.md` synchronized for the replacement candidate |
| `rho.bridge` version | `0.1.13` | unchanged; no exported package contract changed |
| `rho.agent` version | `0.1.5` | unchanged; no exported package contract changed |
| Store schema | `12` | Conversation migration, reopen, failure injection, and recovery matrix pass |
| Release tag | `v0.4.0-dev.26` | reserved by Draft Release `367596197`; Git tag ref remains absent before publication |
| Release name | `Rho 0.4.0-dev.26` | one unpublished Draft prerelease exists |
| Release channel | development prerelease | fixed by SemVer |
| Source repository | `YuLab-SMU/Rho` | authoritative-candidate restriction unchanged |
| Reviewed behavior source commit | one exact 40-character SHA | `a06d234bdd18ab46177f1d3be312ef81c99accbc` |
| Reviewed replacement repair commit | one exact 40-character SHA | `b243fdb07578e7f05b5150fdcf939492c02cfaa5` |
| Authoritative source commit | reviewed upstream default-branch SHA | `a5fc4a153bb420968155984bf8e980973c775015` |
| Windows platform | `windows_x86_64` | candidate evidence passed in run `31337666426` |
| macOS platform | `macos_aarch64` | signed/notarized/stapled candidate evidence passed in run `31337666426` |
| Minimum macOS | 14.0 | configuration unchanged |
| Release decision | `REJECTED / NO-GO` | installed restart recovery failed; this identity cannot be repaired or published |

The version and any eventual tag are single-use. A rejected artifact or later
user-visible source change advances to another version; no artifact, tag,
draft, hash, receipt, or evidence file may be overwritten or relabelled. This
rule consumed `dev.25` when run `31336769848` produced a signed/notarized macOS
artifact but failed Windows validation before draft assembly.

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
separate R3 contract review pass with no unresolved P0/P1 finding. The reviewed
application source commit is
`a06d234bdd18ab46177f1d3be312ef81c99accbc`; this following evidence-only
commit does not change the compiled application source.

The replacement work package adds no application behavior. It normalizes CRLF
and lone-CR input to LF at the deterministic Conversation contract-test read
boundary, includes a direct line-ending regression assertion, advances the
single-use application/release defaults to `dev.26`, and must pass a new
exact-commit two-platform candidate run. Evidence from failed run
`31336769848` cannot be composed with that replacement run.

Replacement source verification passes and is recorded in
`docs/verification/agent-conversation-concurrency/dev26-windows-ci-portability.md`:
the focused regression and release/notary contracts pass; all 48 deterministic
scripts pass; JavaScript syntax, Rust formatting, `cargo check` and the complete
Rust workspace tests pass with the unchanged 167/58/108 Desktop/Server/Store
counts; both R package suites and `git diff --check` pass. Independent R4
contract review found no unresolved P0/P1 finding. The exact replacement commit
is `b243fdb07578e7f05b5150fdcf939492c02cfaa5`; PR #12 was rebase-integrated as
authoritative upstream commit
`a5fc4a153bb420968155984bf8e980973c775015`.

## Exact Candidate Evidence

Protected candidate run `31337666426` passed against that authoritative SHA.
Its Windows lane passed the complete candidate validation, including the exact
CRLF regression, then built and smoke-tested the x64 installer. Its macOS lane
passed complete validation, Developer ID signing, single exact-DMG submission,
Apple notarization, staple, Gatekeeper assessment, read-only mount, and real
Workspace smoke. The aggregate job validated both platform records and created
one unpublished Draft prerelease, ID `367596197`, with exactly seven
pre-acceptance assets. The acceptance asset is intentionally absent until the
owner-installed workflow is complete.

| Evidence | Exact value |
| --- | --- |
| Candidate workflow | `31337666426` — PASS |
| Candidate commit | `a5fc4a153bb420968155984bf8e980973c775015` |
| Candidate evidence SHA-256 | `566b1b765412e91580494e47e6c13a296a551c80b273ef223e5afaa35e3ef483` |
| macOS DMG | `Rho_0.4.0-dev.26_aarch64.dmg` |
| macOS size | `21120068` bytes |
| macOS SHA-256 | `6fdfd492e07cfc5c0aa70e77fbc781206f43d87dd81063e3ef85170c2fdfd540` |
| Windows installer | `Rho_0.4.0-dev.26_x64-setup.exe` |
| Windows size | `18271087` bytes |
| Windows SHA-256 | `883302ad2fd684d9f1140eb6971f0c768c76fd3a4ef7917a120ad56330d41bb8` |

The downloaded DMG independently matched its checksum and Draft digest.
`hdiutil verify`, `xcrun stapler validate`, and local Gatekeeper open assessment
all passed; Gatekeeper reported `Notarized Developer ID` and origin
`Developer ID Application: Yonghe Xia (GAAY6Z9874)`. These automated and local
trust checks do not substitute for the seven owner-installed workflows below.

## Installed Launch Preflight Evidence

The 2026-08-10 owner-installed preflight initially displayed `R unavailable`
and rejected a project switch while three same-name installer volumes were
mounted. Read-only inspection established that `/Volumes/Rho` contained
`dev.21`, `/Volumes/Rho 1` contained `dev.22`, and only `/Volumes/Rho 2` plus
`/Applications/Rho.app` contained the exact `dev.26` candidate. The first
startup therefore exercised an older mounted application: it rejected existing
schema 11 without changing the store. This is launch-path ambiguity evidence,
not a `dev.26` migration failure or an accepted Issue #5 workflow.

All three read-only installer volumes were ejected without deleting their DMG
files. The owner then launched `/Applications/Rho.app`, whose installed
identity was `0.4.0-dev.26`, embedded commit
`a5fc4a153bb420968155984bf8e980973c775015`, main-executable SHA-256
`614e1b8b626cba6bce7268247c37f27a6cfd4a751152c36756e80830c1c9005b`,
and valid notarized Developer ID signature. Startup evidence records an atomic
schema 11-to-12 migration with a `schema-v11.bak` backup, Workspace R ready in
1915 ms, and successful switches to the disposable `project-a` and `project-b`
roots. The live store reports schema 12 and both Conversation tables. The owner
confirmed this recovery as working on 2026-08-10.

This preflight proves exact installed identity, migration recovery, Workspace R
startup, and ordinary idle project switching only. Subsequent installed
acceptance exercised the Issue #5 workflows and rejected this candidate as
recorded below.

## Exact Candidate And Installed Acceptance Gate

The combined workflow binds Windows and
signed/notarized macOS artifacts to one reviewed upstream default-branch
commit, validate all existing immutable evidence contracts, and create at most
one draft prerelease. Run `31337666426` satisfies this automated candidate
portion. Review-only fork artifacts cannot satisfy this gate.

The owner-installed macOS application workflow was evaluated against that
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

Acceptance uses two deliberately separate records. This checked-in ledger must
record the exact version, commit, candidate-evidence digest, macOS artifact
digest, acceptance date, owner-reported result for all seven workflows, and any
deviations. The bounded Draft asset
`rho-0.4.0-dev.26-acceptance.json` retains the existing public schema v1 exact
key set: its version, tag, commit, candidate-evidence digest, and exact
aggregate `platforms` map bind both artifact digests without publishing owner
identity or free-form workflow notes. It may be derived and uploaded only after
the checked-in ledger records a real owner-reported pass. Only then may that
minimal asset carry `status: passed` and `decision: GO`; neither record alone
may admit publication.

### Installed acceptance ledger — rejected 2026-08-10

| # | Owner-observed result | Evidence and deviation |
| --- | --- | --- |
| 1 | PASS | two independent project-scoped Ask Conversations were admitted concurrently and retained separate output/context |
| 2 | PASS | a third Turn was visibly rejected at the bound; cancelling one exact Turn left the other running to completion |
| 3 | PASS with bounded setup deviation | independent-file proposals applied independently; two exact-selection proposals for one file produced one applied result and one visible stale rejection without overwrite. Initial replace-selection attempts without a non-empty selection correctly rejected and were rerun with valid append/selection context |
| 4 | FAIL | after explicitly selecting a non-first Conversation, waiting for session persistence, quitting normally, and reopening `/Applications/Rho.app`, Rho selected the first Conversation. The failure repeated. Output, retry lineage, mutation ledger, project root, and schema 12 otherwise recovered |
| 5 | PARTIAL | Retry created a new immutable Turn linked by `retry_of_turn_id` and left the original cancelled Turn unchanged; provider completion was slow, so the linked attempt was cancelled exactly and remained terminal |
| 6 | NOT RUN | destructive deletion was not exercised after the release-blocking restart failure |
| 7 | NOT RUN | active-turn project-switch blocking was not rerun after the release-blocking restart failure |

Relevant installed evidence includes the exact application identity and hashes
above, startup schema/recovery JSONL, durable store rows, and screenshots
captured before and after the normal restart. No
`rho-0.4.0-dev.26-acceptance.json` was created or uploaded because the aggregate
workflow did not pass.

## Issue Closure Gate

GitHub Issue #5 may close only after the active specification's eight closure
conditions are true: reviewed CONV-1 through CONV-3 implementation, complete
automated and installed evidence, synchronized version/NEWS, exact commit and
upstream integration, required CI, and a final Issue comment linking the PR,
commit, checks, and installed evidence.

## Current Decision

`REJECTED / NO-GO` for publication. The behavior source, Windows portability
repair, upstream integration, two-platform candidate, and unpublished Draft
passed, but installed workflow 4 failed exact selected-Conversation restart
recovery. Draft Release `367596197` and its seven assets remain immutable and
unpublished; no acceptance asset, MAC5 GO, public Release, or update-site entry
may be added for this identity. The authorized replacement is
`0.4.0-dev.27` under the active candidate checklist.
