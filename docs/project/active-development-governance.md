# Rho Development Governance

Status: active engineering governance

Date: 2026-07-26
Scope: required lifecycle for proposals, specifications, implementation,
testing, review, versioning, documentation, commits, and release handoff

## Purpose

Rho combines a Windows desktop application, Rust broker and persistence,
authoritative Workspace R, Agent R, R packages, browser/mock review, scientific
evidence, and release tooling. A change that looks local can affect execution,
project isolation, recovery, approval, reproducibility, or installation.

This governance keeps development incremental and evidence-driven. It turns the
current practice of writing proposals before implementation into a repeatable
contract with explicit entry and exit gates.

The governing principle is:

> Define the behavior, authorize one bounded slice, implement it, prove it,
> review it against the contract, then update version and documentation state.

Passing tests does not by itself authorize a design, accept a milestone, or
make a release public-ready.

## Authority

This document governs the development process. Product behavior remains owned
by accepted ADRs, the active roadmap, active milestone/release contracts, and
authorized feature specifications in the authority order defined by
`active-document-cross-review.md`.

When this process conflicts with a release-specific gate, apply the stricter
requirement. Do not weaken a release checklist, security boundary, migration
rule, or manual acceptance requirement to satisfy a generic workflow step.

## Change Classes

Every task is classified before files are edited.

| Class | Typical work | Required design artifact |
| --- | --- | --- |
| D0 | typo, link, wording, evidence transcription | existing owning document; no new proposal unless meaning changes |
| D1 | narrow defect or isolated behavior correction | bug analysis or active spec amendment plus regression contract |
| D2 | bounded feature or user workflow | testable proposal/spec and one authorized work package |
| D3 | shared architecture, schema, protocol, policy, security, or cross-module behavior | cross-reviewed proposal, migration/compatibility contract, explicit authorization, staged stop points |
| D4 | release candidate, installer, publication, update channel, or destructive production operation | active release contract and exact-candidate checklist |

Documentation-only does not automatically mean low risk. Changing an accepted
contract, lifecycle status, acceptance result, or release claim uses the risk
of the fact being changed.

## Risk Levels And Test Depth

Risk is assessed independently of change class.

### R0: Documentation And Presentation Only

Examples: non-contract prose, link repair, spelling, formatting.

Minimum evidence:

- local link/path validation where relevant;
- `git diff --check`;
- review that no lifecycle or behavior claim changed accidentally.

### R1: Local Behavior

Examples: isolated formatter, label, bounded pure helper, local UI state with no
durable or execution effect.

Minimum evidence:

- focused unit or interaction test;
- adjacent regression tests;
- empty, normal, and error states when user-visible;
- syntax/format checks for affected languages;
- browser/mock parity when visible desktop state changes.

### R2: Cross-Boundary Workflow

Examples: Tauri command, broker/store query, Agent event, Workspace R bridge,
Viewer, Artifact projection, recovery workflow.

Minimum evidence:

- unit tests on each changed ownership boundary;
- integration or contract test across the boundary;
- success, validation rejection, stale/conflict, failure, cancellation where
  applicable, and restart/recovery behavior;
- two-project isolation for project-owned data;
- byte/shape bounds for transported data;
- deterministic browser/mock scenario and manual UI review when visible;
- complete affected Rust/R/frontend suite before handoff.

### R3: Safety-Critical Foundation

Examples: SQLite migration, project identity/switching, approval/policy,
execution admission, credentials, public protocol/MCP, destructive deletion,
startup/shutdown, update/release logic.

Minimum evidence includes all R2 evidence plus:

- negative tests written from the threat/failure model;
- failure injection at persistence and transition boundaries;
- idempotency, concurrency/race, crash/reopen, and rollback or recoverable backup
  tests where applicable;
- foreign-project, malformed historical data, and legacy/unscoped tests;
- credential/redaction and authority-broadening review where applicable;
- historical schema or compatibility fixtures;
- an independent review pass focused on safety and contract compliance;
- representative installed-app/manual acceptance when user or runtime behavior
  changes.

### R4: Release And Publication

Includes all affected R3 evidence plus the active release specification,
candidate-specific installer/hash evidence, clean-install/manual P0 record, and
explicit GO/NO-GO decision. Automation cannot substitute for human release
acceptance.

When uncertain, choose the higher risk level. Reducing the risk level requires
a written reason in the implementation handoff.

## Lifecycle

### 1. Discover

Before proposing or editing:

1. inspect `git status` and preserve unrelated work;
2. locate the owning ADR, roadmap milestone, active contract, Proposal, tests,
   and implementation boundary;
3. inspect current behavior rather than relying on document claims alone;
4. identify affected Rust crates, R packages, desktop commands, mock handlers,
   store tables, schemas, documentation, version metadata, and release gates;
5. classify the change and risk;
6. list assumptions, known unknowns, and required user decisions.

Do not create a competing specification when an existing owner can be amended.

### 2. Specify

A D1-D4 contract must be testable. It includes, as applicable:

- problem and evidence;
- goals and non-goals;
- authority and ownership boundaries;
- current behavior and compatibility constraints;
- public/user-visible behavior;
- typed request, response, state, and persistence semantics;
- project identity and path rules;
- authorization and mutation lane;
- bounds, redaction, and privacy rules;
- failure, cancellation, restart, rollback, and recovery behavior;
- migration/backfill policy that does not guess historical facts;
- work packages with independent stop points;
- automated and manual verification matrix;
- entry conditions, acceptance gate, Definition of Done, and open decisions;
- version, NEWS, document status, and release impact.

For a defect, record the reproduction and the invariant that the regression test
will protect. For an interface change, define loading, empty, success, warning,
failure, stale, unavailable, narrow-window, keyboard, and accessibility states
in proportion to the change.

### 3. Cross-Review

Before authorization:

1. add the document to `active-document-cross-review.md` when it creates an
   unfinished implementation stream;
2. identify its owner and what it explicitly does not own;
3. compare schemas, persistence, approval, state, terminology, sequence, and
   acceptance with every overlapping active/proposed document;
4. resolve conflicts in both directions so either document reveals the
   dependency;
5. close decisions that materially change product behavior, security, data
   ownership, or long-term architecture with the user;
6. record safe engineering defaults for decisions that do not need product
   authority;
7. verify that only one work package is authorized to modify a shared contract
   at a time.

Cross-review complete means conflicts are resolved or explicitly blocked. It
does not mean implementation is authorized.

### 4. Authorize And Activate

Product-code work begins only after explicit authorization for a bounded work
package.

At authorization:

- record the authorized work package and date;
- verify its entry conditions;
- rename its lifecycle prefix from `proposed-` to `active-`, or create an active
  implementation handoff that points to the still-proposed broader direction;
- update the document `Status:` field and cross-review matrix in the same
  documentation change;
- identify the next mandatory stop/review point;
- do not activate later phases implicitly.

Emergency correction is limited to an immediate safety, data-loss, startup, or
release-blocking defect. It still requires a short written reproduction,
invariant, scope, and regression plan before or alongside the first code edit,
followed by normal review and documentation reconciliation.

### 5. Plan The Slice

An implementation slice should:

- deliver one coherent behavior or contract transition;
- be reviewable without unrelated refactoring;
- preserve a runnable/testable baseline at its boundary;
- include tests, mock parity, documentation, and migration work in the same
  slice when they are part of the behavior;
- state what is deliberately deferred;
- avoid making a database schema, protocol, or UI state partially authoritative
  across commits unless a compatibility bridge is explicitly specified.

Large work packages are split vertically by usable behavior, not only by layer.
Avoid a sequence where schema, backend, frontend, and tests remain disconnected
for long periods.

### 6. Implement With Continuous Evidence

During implementation:

1. write or update the focused failing test before or with the behavior;
2. implement the smallest contract-complete change;
3. run focused tests after each meaningful transition;
4. add negative and recovery cases before expanding scope;
5. keep real Tauri commands and browser/mock behavior aligned;
6. keep Workspace R/Agent R/Rust broker authority unchanged unless the active
   contract explicitly changes it;
7. keep project identity, revision, bounds, serialization, and approval checks
   at the authoritative boundary, not only in UI filtering;
8. make persistence/serialization failure visible and never report false
   completion;
9. update the active spec immediately if an accepted implementation detail must
   change; stop for review if behavior, authority, schema, security, or scope
   changes;
10. preserve unrelated dirty-worktree changes.

Do not postpone all tests, docs, and review until the end of a multi-day package.

### 7. Verify By Layer And Workflow

Run tests in this order:

1. focused unit/regression tests;
2. affected package/crate checks;
3. boundary/integration/contract tests;
4. affected frontend/mock and deterministic preview tests;
5. complete affected repository validation;
6. representative manual workflow;
7. installed-candidate acceptance when required.

The current common validation baseline is:

```powershell
$env:PATH="C:\rtools45\x86_64-w64-mingw32.static.posix\bin;$env:PATH"
cargo +stable-x86_64-pc-windows-gnu fmt --all -- --check
cargo +stable-x86_64-pc-windows-gnu test --workspace --locked
npm --prefix desktop run rsr:check
Rscript -e "testthat::test_local('r/rho.bridge')"
Rscript -e "testthat::test_local('r/rho.agent')"
git diff --check
```

Use repository release scripts for release candidates. Commands may be narrowed
for an intermediate slice, but the handoff records exactly what ran, what did
not run, and why. A skipped check is not a pass.

Tests should be deterministic, isolated, bounded, and safe for a dirty worktree.
Use temporary projects/directories and fixtures. Do not depend on developer
credentials, live model providers, network access, clock timing, test order, or
the current working directory unless the test is explicitly an integration
probe with recorded prerequisites.

### 8. Review After Verification

Verification passing is followed by a separate review pass:

- compare every deliverable and non-goal with the active contract;
- review data ownership, authorization, project isolation, revisions, bounds,
  error truthfulness, cancellation, restart, and recovery;
- inspect migrations for transactionality, backfill proof, backup/reopen, and
  historical fixtures;
- inspect user interaction for one clear next action, exact consequence,
  progressive disclosure, accessibility, and no ambiguous destructive action;
- inspect browser/mock and real command parity;
- inspect added dependencies, licenses, build impact, credentials, and network
  surface;
- review diff scope and ensure no user changes were reverted;
- record findings by severity and resolve blocking findings before completion.

R2-R4 changes require a review perspective independent of the implementation
pass. This may be a second human reviewer or a deliberately separate review
session/agent using the accepted spec and diff. The reviewer must not infer
correctness from the author's summary.

### 9. Version And Changelog

Versioning occurs after the behavior and affected verification pass, before the
final integration commit/candidate handoff.

#### Application version

Update the application development version when a reviewed user-visible or
public contract change enters a new distributable development candidate.
Synchronize all application version authorities, including at minimum:

- workspace package version in `Cargo.toml`;
- Tauri version in `desktop/src-tauri/tauri.conf.json`;
- any update/release manifest input required by the active release contract;
- candidate name/tag when a release workflow is in scope.

Do not bump once per exploratory commit. One reviewed candidate has one version.
Do not reuse a published or previously distributed candidate version for
different behavior.

#### R package versions

`rho.bridge` and `rho.agent` versions are independent. Bump the affected package
when its exported behavior, serialized contract, runtime compatibility, or
package contents change for distribution. A desktop-only change does not force
an R package bump. Record coordinated compatibility when desktop and package
changes must ship together.

#### NEWS

`NEWS.md` records implemented user-visible behavior, not plans. Add concise
Added/Improved/Fixed entries only after implementation evidence exists. Do not
list proposed features as shipped. Internal-only refactoring normally belongs
in the implementation handoff, not NEWS.

Every work package records one of:

- application version bump required and completed;
- R package version bump required and completed;
- no version bump, with reason;
- version deferred until a named integration candidate, with no distribution
  permitted before that step.

### 10. Reconcile Documentation State

After implementation and review:

- update the active contract with actual behavior, tests, deviations, commit or
  evidence references, and remaining manual gates;
- update roadmap progress without claiming milestone acceptance prematurely;
- update cross-review status and dependencies;
- update affected product/architecture/implementation documentation;
- update NEWS when appropriate;
- rename `active-` to `implemented-` only when every in-scope implementation and
  verification gate is complete;
- keep the document `active-` when implementation landed but integration,
  manual, installed-app, milestone, or release acceptance remains open;
- use `historical-` for a completed snapshot no longer governing current work;
- use `accepted-` only for adopted durable architecture decisions, not merely
  completed features.

Status truth table:

| Fact | Permitted statement |
| --- | --- |
| code exists | implementation present |
| focused tests pass | focused verification passed |
| full affected suite passes | automated integration evidence passed |
| representative workflow reviewed | manual workflow accepted for named build |
| exact installer passes checklist | installed candidate accepted |
| release checklist and decision complete | release GO for exact candidate |

Do not collapse these facts into “done” or “ready”.

### 11. Commit And Handoff

Before commit:

- inspect final `git status` and diff;
- stage only scoped reviewed files;
- ensure generated/version/NEWS/document status files are intentionally included;
- ensure no secrets, local paths, temporary evidence, or build artifacts are
  staged unintentionally;
- use a commit message naming the behavior or governance result;
- do not mix unrelated worktree changes into the commit.

The handoff reports separately:

1. implemented behavior;
2. contract/document changes;
3. version and NEWS outcome;
4. automated tests with exact commands/results;
5. manual and installed-app acceptance performed or still open;
6. migrations/compatibility evidence;
7. unresolved findings and residual risks;
8. intentionally unrun checks;
9. worktree and commit state;
10. milestone/release decision.

### 12. Release

Release is a new gate, not the automatic consequence of merging implementation.

- select an exact clean source commit and versioned candidate;
- run the active release checks and generate machine-readable evidence;
- build the exact installer/artifacts once for acceptance and distribution;
- record hashes and bind manual evidence to them;
- complete clean-install, SmartScreen/signing, core workflow/recovery, update
  behavior where applicable, and uninstall acceptance;
- record known limitations and distribution audience;
- make an explicit GO, conditional-GO, or NO-GO decision;
- never describe an internal or unsigned candidate as public-ready without the
  required decision and evidence.

## Required Test Patterns

### Defect Regression

Every defect fix includes a test that fails for the reproduced cause, not only
for a convenient symptom. Where the exact platform failure cannot run in unit
tests, add the closest deterministic contract test plus a named manual probe.

### State Mutation

Test:

- accepted success;
- invalid input;
- authorization rejection;
- stale revision/state;
- persistence/serialization failure;
- cancellation/interruption;
- restart/recovery;
- idempotency or duplicate request when relevant;
- visible outcome does not claim more than durable state.

### Project-Owned Data

Use projects A and B in the same store/runtime test. Prove list, detail, history,
model context, retry/continue, event, clear/delete, and mutation paths cannot
cross boundaries. Include identical filenames and rapid switching.

### Bounded Data

Test normal payload, boundary payload, just-over-limit payload, malformed data,
and truncation metadata. Exercise byte budgets with representative shapes, not
pathological item counts.

### Migration

Use fixtures for every supported historical schema. Test successful migration,
idempotent reopen, foreign keys/indexes, unprovable legacy data, injected
failure, rollback/recoverable backup, and no premature version advance.

### UI And Mock Parity

For visible state, test deterministic empty/loading/success/warning/error/stale/
unavailable scenarios. Keep mock commands aligned with Tauri commands. Inspect
desktop and narrow supported viewports, long Unicode paths, keyboard/focus, and
text overflow. Screenshots support visual review but do not prove behavior.

### Approval And Policy

Bind approval to exact principal, project, operation class, arguments/code
digest, revisions, expiry, and single use. Test changed arguments, reuse,
foreign project/client, cancellation, disconnect, and recovery. Do not infer
authorization from UI mode, natural-language intent, or external tool presence.

## Flake, Performance, And Test Maintenance

- A flaky test is a defect. Do not normalize rerunning until green.
- Quarantine requires an owner, issue/reason, expiry, and replacement gate; a
  quarantined safety/release test blocks the affected release.
- Tests have bounded timeouts and payload sizes. Investigate material runtime
  growth before expanding suites further.
- Prefer contract fixtures and fake providers over live services. Live provider
  smoke is separate, credential-aware evidence.
- Keep test helpers simpler than the behavior they verify; avoid reproducing
  production logic in expected-value code.
- Preserve failure output needed for diagnosis while redacting credentials and
  sensitive project content.

## Mainline Health And Integration Discipline

- Every integration boundary must compile and pass its declared focused checks.
- Do not land a schema that no current code can use safely, commands without
  their mock/test contract, or UI that relies on a later backend change.
- Prefer vertical, contract-complete commits. When a multi-commit migration is
  unavoidable, use an explicit compatibility bridge and keep old behavior
  functional until the new path is accepted.
- Feature flags are not a substitute for safety. A dormant path must still
  compile, migrate safely, avoid changing default authority, and have tests.
- Keep commits bisectable enough to identify the first behavioral regression.
  Mechanical movement and behavior change should be separated when practical.
- Do not merge with known failing required checks. A documented external
  infrastructure outage may defer a check, but the affected work remains
  unaccepted and cannot enter a release candidate.
- Reverts and forward fixes follow the same evidence discipline. Prefer the
  smallest recoverable correction and preserve data/schema compatibility.

## Policy As Code

Human review remains necessary, but deterministic governance rules should be
automated. Repository validation should progressively enforce:

- application-version agreement across authoritative files;
- document filename prefix matching the `Status:` lifecycle claim;
- local Markdown links and required documentation index entries;
- Tauri command and browser/mock command inventory parity;
- schema version/migration fixture coverage;
- public protocol schema and compatibility fixtures when WB1 exists;
- no skipped required R/Rust/frontend suite because dependencies are absent;
- no bare user-facing destructive `Clear` after the owning UX package migrates
  that surface;
- release candidate, tag, commit, evidence, installer, and checksum agreement;
- absence of credentials, machine-local paths, temporary outputs, and oversized
  generated files from staged release inputs.

An automated governance check is introduced only when its rule and failure
message are deterministic. Do not add brittle text scanning that encourages
workarounds or produces noisy false failures. Until automated, the handoff
records the equivalent manual check.

## Diagnostics And Observability

Runtime and recovery changes must be diagnosable without exposing sensitive
content:

- use stable operation/error codes plus bounded human-readable messages;
- correlate request, run, project, and recovery events with opaque identifiers;
- record state transitions needed to explain failure, cancellation, restart,
  and recovery;
- never log credentials, tokens, environment-variable values, complete private
  prompts, unbounded source/output, or hidden policy;
- distinguish failure before dispatch, uncertain execution, failed persistence,
  and successful durable completion;
- add a support-facing bounded diagnostic path for new R2-R4 failure classes;
- test that redaction and size bounds survive error paths, not only success;
- define retention for new diagnostics under BH4 rather than accumulating logs
  indefinitely.

## Dependency And Toolchain Discipline

- Prefer existing repository libraries and APIs.
- A new dependency requires a demonstrated need, maintenance/license/security
  review, platform/build impact, and focused tests.
- Lockfile churn belongs only to the dependency change that caused it.
- Workspace packages inherit one declared Rust MSRV. The native compatibility
  workflow verifies the exact floor and current stable with the committed
  lockfile; advancing the floor requires an active, reviewed build contract.
- CI must select matrix toolchains explicitly. Changing the rustup default does
  not override a repository `rust-toolchain.toml` and is not MSRV evidence.
- Do not introduce a frontend framework, second store, second runtime, or
  public transport as incidental implementation detail.
- Toolchain or generated-file changes must be reproducible from documented
  commands.
- Windows Rust tests use the documented Rtools GNU toolchain unless an active
  contract explicitly changes the target.

## Governance Exceptions

An exception is explicit, narrow, and temporary. Record:

- rule being bypassed;
- reason and risk;
- approving owner;
- affected scope/build;
- compensating evidence;
- expiration or follow-up work.

Exceptions cannot authorize silent data loss, cross-project exposure,
credential leakage, false completion, fabricated evidence, or a public release
without required human acceptance.

## Definition Of Ready

A work package is ready to implement when:

- owner and authority are clear;
- entry conditions and user decisions are closed;
- current behavior is verified;
- scope and non-goals are bounded;
- state/persistence/policy/project identity contracts are unambiguous;
- failure and recovery behavior is specified;
- risk level and test matrix are agreed;
- version/document/release impact is identified;
- cross-review has no unresolved collision;
- implementation is explicitly authorized and active.

## Definition Of Done

A work package is done when:

- accepted scope is implemented without silent contract drift;
- required positive, negative, boundary, isolation, and recovery tests pass;
- full affected validation is recorded;
- independent review has no unresolved blocking finding;
- manual/installed acceptance is recorded or the document truthfully remains
  active with that gate open;
- version and NEWS decisions are complete;
- docs, roadmap, cross-review, and lifecycle status reflect actual facts;
- diff and commit are scoped and reviewable;
- residual risks and unrun checks are explicit;
- no release-readiness claim exceeds exact evidence.

## Per-Package Handoff Template

```text
Work package:
Owning contract:
Authorization/date:
Change/risk class:

Implemented:
Deferred/non-goals:
Contract deviations:

Version decision:
NEWS decision:
Document lifecycle updates:

Automated evidence:
Manual evidence:
Installed-candidate evidence:
Unrun checks:

Review findings resolved:
Residual risks:
Worktree/commit state:
Milestone/release decision:
Next authorized stop point:
```
