# Rust MSRV And Dual-Toolchain Build Contract

Status: active integrated build contract; Issue #28 authorized `MSRV-1` on
2026-08-10; source implementation, exact local validation, final hosted
four-leg PR acceptance, upstream integration, and exact-merge main validation
complete; Issue #28 closed; CI-FAST1 Draft-feedback amendment authorized
2026-08-18

Date: 2026-08-10
Issue: https://github.com/YuLab-SMU/Rho/issues/28
Change class: D3 shared build and toolchain policy
Risk: R3 cross-platform build and release-validation foundation
Authorized work package: `MSRV-1`
Next mandatory stop: enforce the Rust 1.88 floor continuously through fast
Draft feedback and the full dual-toolchain matrix at non-Draft integration
boundaries; any dependency, target, runner, packaging, or MSRV change requires
a separately reviewed contract

## Problem And Reproduction

Rho pins a default development compiler in `rust-toolchain.toml`, but the
workspace does not declare a Minimum Supported Rust Version (MSRV). The virtual
workspace uses Cargo resolver 2, all nine workspace packages omit
`package.rust-version`, and current release validation exercises only its
selected current toolchain.

This leaves three independent failure paths:

1. a lockfile refresh can select a dependency whose declared MSRV is newer than
   Rho's intended floor while current-stable validation remains green;
2. a dependency without accurate MSRV metadata can compile on current Rust but
   use language or standard-library behavior unavailable at the floor;
3. a CI step that merely changes the rustup default can still run the repository
   toolchain because `rust-toolchain.toml` has higher selection priority.

The current locked graph has a declared dependency floor of Rust 1.88. During
pre-implementation feasibility work on the existing local development branch,
explicitly selecting rustc 1.88.0 on macOS arm64 passed both:

- `cargo check --workspace --all-targets --locked`;
- `cargo test --workspace --locked --no-fail-fast` with 361 passed, zero
  failed, and one opt-in Keychain test ignored.

Windows GNU Rust 1.88 remains unaccepted until the hosted native matrix leg
passes.

## Goals

- Declare Rust 1.88 as one workspace-owned minimum compiler contract.
- Make every Rho workspace package inherit and publish that contract.
- Make dependency resolution prefer versions compatible with the declared
  floor.
- Exercise current stable and the exact 1.88.0 compiler on all supported native
  Rust targets at integration boundaries, with one current-stable Linux signal
  during Draft iteration.
- Prevent the repository toolchain override from silently invalidating a CI
  matrix leg.
- Keep the committed lockfile authoritative during compatibility and candidate
  Rust validation.
- Detect omitted member inheritance, resolver regression, matrix loss, unlocked
  validation, and toolchain-selection regression deterministically.

## Non-Goals

- Do not change `rust-toolchain.toml` or redefine the recommended development
  and release compiler.
- Do not build, sign, notarize, install, upload, publish, or update an installer
  in the compatibility workflow.
- Do not change Rust dependencies or introduce lockfile churn.
- Do not change application behavior, public protocol, persistence, project
  identity, credentials, execution, R packages, Ark, or Tauri CLI versions.
- Do not claim an application candidate, installed-app acceptance, or release
  decision from compatibility evidence.
- Do not run formatting with the MSRV compiler; formatting remains a current
  stable contract.

## Authority And Compatibility Boundaries

This document owns only:

- workspace Rust MSRV metadata;
- Cargo resolver selection for MSRV-aware dependency fallback;
- the non-packaging Rust compatibility workflow;
- locked Rust validation in the candidate source-validation steps;
- deterministic checks for those contracts.

`rust-toolchain.toml` remains the default interactive development-toolchain
authority. `Cargo.lock` remains the exact dependency-version authority. The
Windows build-environment document retains Rtools and GNU linker authority.
The macOS arm64 specification retains native runner, packaging, signing, and
notarization authority. Candidate checklists retain exact artifact and release
GO/NO-GO authority.

Cargo resolver 3 changes incompatible-Rust-version handling from `allow` to
`fallback`. It does not prove compatibility for dependencies with missing or
incorrect metadata, so the exact Rust 1.88 execution leg remains mandatory.

## Manifest Contract

The virtual root workspace must set:

```toml
[workspace]
resolver = "3"

[workspace.package]
rust-version = "1.88"
```

Every workspace member must set:

```toml
rust-version.workspace = true
```

Cargo metadata is the verification authority for effective member values. A
root declaration without member inheritance is a failure.

## CI Contract

The dedicated compatibility workflow runs its matrix for affected pushes to
`main` and affected non-Draft pull requests targeting `main`. A Draft PR event
may instantiate a skipped job but must not consume matrix runners. The separate
`Rust Fast` workflow supplies affected Draft PR feedback. Both workflows have
read-only repository permission, no credentials, no release environment, and
no write authority.

Its required matrix contains exactly these compatibility identities:

| Runner | Matrix version | Explicit rustup toolchain |
| --- | --- | --- |
| `macos-26` | `stable` | `stable-aarch64-apple-darwin` |
| `macos-26` | `1.88.0` | `1.88.0-aarch64-apple-darwin` |
| `windows-latest` | `stable` | `stable-x86_64-pc-windows-gnu` |
| `windows-latest` | `1.88.0` | `1.88.0-x86_64-pc-windows-gnu` |
| `ubuntu-22.04` | `stable` | `stable-x86_64-unknown-linux-gnu` |
| `ubuntu-22.04` | `1.88.0` | `1.88.0-x86_64-unknown-linux-gnu` |

Every leg must:

1. install the exact named toolchain;
2. select it through `RUSTUP_TOOLCHAIN`, which outranks the repository file;
3. verify the active host and, for the MSRV legs, exact rustc version 1.88.0;
4. run the deterministic MSRV repository contract;
5. run `cargo check --workspace --all-targets --locked`;
6. run `cargo test --workspace --locked --no-fail-fast`.

Windows legs prepend the documented Rtools45 GNU directory before any Cargo
command. Stable legs also install rustfmt and run `cargo fmt --all -- --check`.
macOS legs stage the existing checksum-pinned Ark sidecar because Tauri's macOS
build configuration requires that ignored resource at compile time; this is
build input preparation, not an Ark runtime or smoke-test acceptance claim.
The matrix uses `fail-fast: false` and no allowed-failure leg, so one platform
failure remains visible without cancelling the other evidence.

The compatibility workflow may use path filters to avoid running for changes
that cannot affect Rust source, manifests, lock state, the toolchain contract,
or the workflow itself. It must run when any workspace manifest, `Cargo.lock`,
`rust-toolchain.toml`, Rust source tree, or its own contract test changes.

### CI-FAST1 Draft feedback amendment

The user authorized CI-FAST1 on 2026-08-18 after PR #75 demonstrated that six
cold native jobs on every long-lived Draft push delayed early construction.
`docs/plans/active-2026-08-18-rust-fast-development-ci-spec.md` owns the bounded
implementation and acceptance details.

The durable policy is:

- affected Draft PRs run one Ubuntu stable fast job with formatting, contract
  checks, locked all-target workspace check, and locked workspace tests;
- affected non-Draft PRs and `main` pushes run the complete six-leg matrix;
- the compatibility workflow remains triggered for PR lifecycle events but its
  matrix job admits only `pull_request.draft == false`;
- a `ready_for_review` event triggers the full integration boundary;
- Cargo cache entries are isolated by cache schema, OS, explicit toolchain, and
  lockfile hash and never count as evidence; and
- candidate workflows retain their independent locked native validation.

For the long-lived Draft PR #75, P1-0 through P1-3 consume fast feedback only.
P1-4 completes the whole Phase 1 implementation before the PR becomes Ready
and the exact-head six-leg matrix becomes mandatory. This is a timing change,
not removal of native/MSRV acceptance.

## Candidate Validation Contract

The existing Windows, macOS, and Linux candidate source-validation steps must execute
workspace Rust tests with `--locked`. The macOS setup step must also export its
installed stable toolchain through `RUSTUP_TOOLCHAIN`; changing the rustup
default is insufficient because the repository file has higher priority. These
changes tighten dependency and toolchain determinism but do not duplicate the
compatibility matrix or change installer construction.

The compatibility workflow is not candidate evidence. A passing matrix cannot
authorize draft assembly, MAC5, publication, update-site mutation, or release.

## Failure And Recovery Semantics

- Missing or mismatched member MSRV metadata fails before workspace compile.
- Resolver 2 or another resolver value fails the deterministic contract.
- Missing stable/MSRV or native-platform matrix identities fail the contract.
- A toolchain that is installed but not explicitly selected fails active
  toolchain verification.
- An unlocked compatibility or candidate workspace-test command fails the
  contract.
- Dependency or source incompatibility fails the affected native matrix leg;
  it is repaired by pinning/selecting compatible dependencies or intentionally
  advancing this contract in a separately reviewed change, never by
  `--ignore-rust-version`.
- CI cancellation or infrastructure failure is not compatibility acceptance;
  rerun the exact commit after infrastructure recovery.

No persistent application state, credential, user file, or release object is
mutated, so runtime rollback and migration do not apply. A source rollback is a
normal commit revert that restores the previous build contract.

## Automated Verification

Focused deterministic checks must cover:

- valid resolver, member metadata, native matrix, explicit selection, and
  locked commands;
- a missing member MSRV;
- a mismatched member MSRV;
- resolver regression;
- missing matrix identity;
- missing explicit rustup selection;
- missing `--locked` from compatibility or candidate validation.

Affected verification is:

```text
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-mac4-release-contract.mjs
cargo +1.88.0-aarch64-apple-darwin check --workspace --all-targets --locked
cargo +1.88.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
cargo +1.97.0-aarch64-apple-darwin fmt --all -- --check
cargo +1.97.0-aarch64-apple-darwin check --workspace --all-targets --locked
cargo +1.97.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
git diff --check
```

During Draft development, hosted acceptance requires exact-head Rust Fast plus
the owning package's local evidence. Native compatibility acceptance requires
all six matrix identities on the exact non-Draft PR commit or `main` commit;
local macOS evidence does not substitute for hosted Windows GNU or Linux
evidence.

## Implementation And Local Evidence

The reviewed `MSRV-1` source slice now:

- declares Resolver 3 and workspace Rust 1.88 metadata inherited by all nine
  members;
- adds a read-only four-leg native compatibility workflow with explicit
  `RUSTUP_TOOLCHAIN` selection, Rtools45 GNU setup, stable-only formatting,
  checksum-pinned macOS Ark staging, and locked check/test commands;
- makes both candidate workspace-test commands locked and makes the candidate
  macOS stable selection explicit;
- adds positive and failure-injection contract tests for manifest, matrix,
  selection, and lockfile invariants; and
- leaves `Cargo.lock`, application version metadata, `NEWS.md`, packaging,
  credentials, and release authority unchanged.

Local verification on the clean upstream `main` worktree passed:

```text
node --check scripts/test-rust-msrv-contract.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-mac4-release-contract.mjs
cargo +1.88.0-aarch64-apple-darwin check --workspace --all-targets --locked
cargo +1.88.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
  355 passed; 0 failed; 1 opt-in Keychain test ignored
cargo +1.97.0-aarch64-apple-darwin fmt --all -- --check
cargo +1.97.0-aarch64-apple-darwin check --workspace --all-targets --locked
cargo +1.97.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
  355 passed; 0 failed; 1 opt-in Keychain test ignored
Ruby Psych parse of every checked-in GitHub Actions workflow
Actionlint 1.7.7, excluding only its stale unknown-label diagnostic for
  the already-supported macos-26 runner
git diff --check
```

The macOS all-target check requires the ignored Ark sidecar named by Tauri's
bundle configuration. It was staged locally through
`scripts/bootstrap-ark-macos.sh`; the workflow performs the same
checksum-pinned preparation. No generated runtime file is committed.

The first hosted matrix completed successfully on implementation commit
`94ca28fe430cce1dd83e0a82bb4021df68a8ca2d` in GitHub Actions run
`31448825609`:

| Matrix identity | Result | Duration |
| --- | --- | --- |
| `macos-26 / Rust stable` | pass | 4m12s |
| `macos-26 / Rust 1.88.0` | pass | 4m56s |
| `windows-latest / Rust stable` | pass | 9m30s |
| `windows-latest / Rust 1.88.0` | pass | 10m09s |

GitHub emitted non-blocking Node.js 20 deprecation annotations for the existing
`actions/checkout@v4` and `actions/setup-node@v4` action runtimes while forcing
them to Node.js 24. Those annotations do not weaken Rust compatibility
evidence. Updating third-party Action majors is outside `MSRV-1` and requires a
separate dependency/workflow review before GitHub changes runner enforcement.

The evidence-reconciliation commit must receive the same four required checks
on its PR HEAD. GitHub evaluates pull-request path filters with the cumulative
three-dot diff against the base, so the Rust changes continue to trigger this
matrix after a documentation-only evidence commit.

On 2026-08-11, after PR #24 and its integration-evidence PR #35 entered
`main`, the implementation branch merged upstream `main` at `0111dd9` into
merge tree `3fefd37`. The synchronized tree passed the complete affected local
matrix:

```text
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-mac4-release-contract.mjs
all 53 scripts/test-*.mjs contracts
node --check desktop/dist/app.js
cargo +1.88.0-aarch64-apple-darwin check --workspace --all-targets --locked
cargo +1.88.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
  364 passed; 0 failed; 1 opt-in Keychain test ignored
cargo +1.97.0-aarch64-apple-darwin fmt --all -- --check
cargo +1.97.0-aarch64-apple-darwin check --workspace --all-targets --locked
cargo +1.97.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
  364 passed; 0 failed; 1 opt-in Keychain test ignored
testthat::test_local('r/rho.bridge', reporter='summary')
testthat::test_local('r/rho.agent', reporter='summary')
git diff --check
```

This refresh did not reuse the earlier hosted run as final acceptance. The four
hosted identities remained mandatory on the pushed, evidence-reconciled PR HEAD
before draft removal or merge.

Final source integration completed on 2026-08-11. PR #29 head
`f022d2c60808dd335ffae6945fa95a2032ac7acd` passed all four required jobs in
GitHub Actions run `31509554882`, PR #29 merged to upstream `main` as
`9e0b36b0d96c5389e7b36a30fa310751bffd0b47`, and the exact merge then passed
the same four macOS/Windows stable/MSRV jobs in main-push run `31510716448`.
Issue #28 was closed only after that integration evidence was available. These
checks establish the build contract; they do not create candidate, artifact,
installed-acceptance, MAC5, or release evidence.

## Work Package And Stop Point

`MSRV-1` is the only authorized package. It includes the manifest declaration,
resolver transition, compatibility workflow, locked candidate validation,
deterministic tests, and documentation reconciliation as one bisectable build
contract.

`MSRV-1` stopped after the reviewed source was integrated and the exact merge
passed the four hosted matrix identities. Any dependency pin, target change,
runner change, packaging change, or MSRV advance is outside this completed
package and requires contract review.

## Version, NEWS, And Release Impact

No application or R package version bump is required because the package does
not change shipped runtime behavior or an R package contract. `NEWS.md` is not
changed because this is internal build compatibility enforcement.

No existing candidate or release evidence is amended or reused. A future
candidate consumes the stricter locked source validation only after this change
is merged.

## Definition Of Done

- Issue #28 and the implementation refer to each other.
- All workspace packages report Rust 1.88 through Cargo metadata.
- Resolver 3 is active and `Cargo.lock` has no unrelated churn.
- The four native compatibility identities are present and explicitly selected.
- Deterministic positive and negative contract tests pass.
- Local macOS 1.88 and current development-toolchain checks/tests pass.
- Hosted macOS stable/MSRV and Windows GNU stable/MSRV jobs pass for the exact PR
  commit.
- Post-verification review finds no release-authority, credential, dependency,
  or unrelated-worktree expansion.
- Documentation records exact evidence and remaining integration state without
  claiming candidate or release readiness.
- CI-FAST1 preserves those integrated historical facts while requiring fast
  exact-head Draft feedback and deferring the unchanged six-leg matrix to a
  non-Draft integration boundary.
