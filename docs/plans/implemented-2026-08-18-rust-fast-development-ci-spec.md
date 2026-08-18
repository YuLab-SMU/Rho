# Rust Fast Development CI Specification

Status: implemented; CI-FAST1 local, exact-head Draft, cache, Draft/Ready
admission, and deferred six-leg integration evidence complete 2026-08-18

Date: 2026-08-18
Authorization: the user explicitly authorized development-CI optimization and
directed that the complete native compatibility matrix be deferred until the
whole P1 stream is complete

Owning durable contract:
[`active-2026-08-10-rust-msrv-build-contract.md`](active-2026-08-10-rust-msrv-build-contract.md)
Consumer:
[`implemented-2026-08-18-p1-0-extension-runtime-contracts-spec.md`](implemented-2026-08-18-p1-0-extension-runtime-contracts-spec.md)
PR: [#75](https://github.com/YuLab-SMU/Rho/pull/75)

Change class: D3 shared build and CI policy
Risk: R3 cross-platform compatibility and merge-gate enforcement
Authorized work package: `CI-FAST1`
Mandatory stop: exact-head fast CI passes on the Draft PR; the six-leg matrix
remains deferred and P1-1 remains separately unauthorized

## Problem And Evidence

The current Rust Compatibility workflow runs six cold native jobs for every
Rust-affecting push to a Draft PR:

```text
macOS stable + Rust 1.88
Windows GNU stable + Rust 1.88
Linux stable + Rust 1.88
```

Each job performs a complete locked workspace check and test. On PR #75 run
`32107811887`, a macOS leg took about five minutes and Windows/Linux cold jobs
continued longer. Local test execution after compilation takes only seconds;
the dominant cost is repeated native dependency and Tauri compilation.

This evidence is appropriate at an integration gate, not on every commit of a
long-lived Draft construction branch. Running it at every P1 package also makes
documentation-only evidence pushes repeat the same six cold builds because PR
path filtering uses the cumulative diff.

## Decision

Create two distinct feedback levels.

### Draft development feedback

Every Rust-affecting Draft PR update runs one read-only Ubuntu 22.04 current
stable job named `Rust Fast`.

It must:

1. check out the exact PR source without persisted credentials;
2. install Node 22 and the existing Linux desktop build prerequisites;
3. explicitly install/select `stable-x86_64-unknown-linux-gnu` and verify the
   host;
4. restore an OS/toolchain/lockfile-scoped Cargo cache;
5. stage the checksum-pinned Linux Ark resources required by Tauri compile;
6. run stable formatting;
7. run MSRV and AGPL contract self-tests plus repository validation;
8. run `cargo check --workspace --all-targets --locked`; and
9. run `cargo test --workspace --locked --no-fail-fast`.

The fast job is one complete Linux-stable workspace signal, not cross-platform
or MSRV acceptance. Its concurrency group cancels an obsolete in-progress fast
run when a newer commit reaches the same PR.

### Integration compatibility evidence

The existing six-leg Rust Compatibility matrix remains unchanged in identities,
toolchain selection, commands, failure visibility, permissions, and main-push
behavior. It runs only when:

- affected source is pushed to `main`; or
- an affected PR is not Draft, including the `ready_for_review` transition and
  later updates to that Ready PR.

Draft PR updates may instantiate a skipped compatibility job, but consume no
matrix runners. This makes Draft/Ready state the explicit cost and acceptance
boundary.

For PR #75, the PR remains Draft through P1-4. P1-0, P1-1, P1-2, and P1-3 do
not require the six-leg hosted matrix. After the whole P1 implementation and
local/package acceptance are complete, P1-4 may move the PR to Ready and must
then require the exact-head six-leg matrix before merge or any Phase 1
implementation claim.

This timing change does not weaken candidate or release validation. Candidate
workflows keep their existing locked native source checks, and `main` retains
the complete matrix.

## Cache Contract

Use the official GitHub `actions/cache` action. Cache only:

```text
~/.cargo/registry/index/
~/.cargo/registry/cache/
~/.cargo/git/db/
target/
```

The primary key contains:

```text
cache schema epoch + runner OS + explicit RUSTUP_TOOLCHAIN + Cargo.lock hash
```

Restore keys may fall back only within the same schema epoch, OS, and explicit
toolchain. Cross-OS or cross-toolchain restore is forbidden. `Cargo.lock`
remains dependency truth; cache content is never evidence, an artifact, or a
release input. A miss, eviction, stale entry, or corrupt entry must degrade to
a normal rebuild and cannot skip a command or turn failure into success.

GitHub caches are immutable for an exact primary-key hit. The manual schema
epoch is bumped when the cached path contract changes. The cache adds no
repository write permission, secret, release environment, artifact upload, or
network authority beyond the official cache service already available to the
workflow.

`CARGO_INCREMENTAL=0` is used in hosted CI to keep cached build artifacts
smaller and deterministic enough for dependency reuse. This is a performance
setting, not a compiler or optimization contract.

## Inner Loop And Stop Gates

During P1-0 through P1-3, normal iteration uses the narrowest affected checks:

```text
cargo check -p <affected-package> --all-targets --locked
cargo test -p <affected-package> --locked
cargo fmt --all -- --check
```

At each package checkpoint, run the affected package tests, one complete local
current-toolchain workspace check/test when required by the owning contract,
the available local MSRV focused test, deterministic governance contracts, and
exact-head Rust Fast CI. Do not repeat the hosted six-leg matrix.

P1-4 owns the accumulated native compatibility gate. It must run the six legs
after all P1 code and evidence changes intended for review are present.

## Trigger And Permission Contract

`rust-fast.yml`:

- event: affected `pull_request` `opened`, `reopened`, or `synchronize`;
- job admission: `pull_request.draft == true`, preventing duplicate fast and
  full jobs on a non-Draft PR;
- permissions: `contents: read` only;
- one Ubuntu stable job;
- workflow concurrency cancels obsolete same-PR runs;
- no secrets, credentials, release environment, upload, packaging, signing, or
  mutation.

`rust-compatibility.yml`:

- event: affected `push` to `main`, or affected PR `opened`, `reopened`,
  `synchronize`, or `ready_for_review`;
- job admission: `push` to `main` or `pull_request.draft == false`;
- permissions: `contents: read` only;
- six identities and all locked commands remain unchanged;
- workflow concurrency continues to cancel obsolete same-ref runs.

Both workflows include themselves and the deterministic MSRV contract script
in their path filters. Changes to the fast lane therefore cannot silently avoid
its own validation.

## Deterministic Enforcement

Extend `scripts/test-rust-msrv-contract.mjs` so positive and negative fixtures
verify:

- the fast workflow exists, is read-only, single-platform, stable, locked, and
  non-mutating;
- fast PR activity types and path filters remain present;
- cache paths and key isolate OS, toolchain, and lockfile;
- fast concurrency cancels obsolete runs;
- the compatibility matrix still has all six exact identities;
- compatibility PR triggers include `ready_for_review`;
- Draft PRs cannot admit the matrix job;
- main pushes and non-Draft PRs can admit it; and
- removal of any guard, cache dimension, locked command, matrix identity, or
  explicit toolchain selection fails the self-test.

Workflow YAML must also parse successfully. If `actionlint` is unavailable,
record that fact and run the repository's deterministic parser/contract checks;
never claim an unrun validator as passing.

## Failure And Recovery

- Fast failure blocks the affected development checkpoint and retains the
  focused failure output.
- Cache restore/save failure falls back to uncached commands; it does not make
  a test optional.
- A cancelled obsolete fast run is expected and is not evidence for its old
  commit.
- A skipped Draft compatibility job is expected and explicitly not native/MSRV
  acceptance.
- A Ready PR or `main` matrix failure remains blocking and cannot be replaced
  by fast CI.
- Reverting CI-FAST1 restores the former every-PR matrix trigger; no application
  state or user data is involved.

## Verification

Required local checks:

```text
node --check scripts/test-rust-msrv-contract.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
git diff --check
```

After push, the exact head must show:

- `Rust Fast` passed;
- Rust Compatibility did not consume six Draft matrix runners; and
- no unexpected release, artifact, or write-capable workflow ran.

## Version, NEWS, And Release Impact

CI-FAST1 changes development feedback timing only. It changes no application
or R package version, `NEWS.md`, runtime behavior, schema, protocol, installer,
candidate, or release decision.

## Implementation And Local Evidence

Implementation present:

- `.github/workflows/rust-fast.yml` adds one Draft-only Ubuntu stable job with
  read-only permissions, same-PR cancellation, explicit toolchain selection,
  pinned Linux Ark staging, deterministic contracts, formatting, locked check,
  and locked workspace tests;
- `.github/workflows/rust-compatibility.yml` retains all six identities and
  commands but admits them only for `main` pushes or non-Draft PRs, including
  `ready_for_review`;
- both workflows use the reviewed official `actions/cache@v4` paths and an
  epoch/OS/toolchain/lockfile key with same-OS/toolchain restore scope;
- Ready PRs do not also run the fast job because Rust Fast admits Draft PRs
  only; and
- `scripts/test-rust-msrv-contract.mjs` now validates and failure-injects both
  workflows, cache dimensions, event types, Draft guards, concurrency,
  permissions, commands, and the unchanged six identities.

Local evidence on the implementation tree:

```text
node --check scripts/test-rust-msrv-contract.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
  PASS
Ruby Psych parse of rust-fast.yml and rust-compatibility.yml
  PASS
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
  PASS
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
  PASS; 398 passed, 0 failed, 1 existing opt-in macOS Keychain test ignored
git diff --check
  PASS
```

`actionlint` was unavailable locally and is not reported as passing. Ruby YAML
parsing plus the project-owned positive/negative workflow contract ran instead.

The superseded PR #75 six-leg run `32107811887` was explicitly cancelled after
the user deferred full native compatibility to P1-4. Any legs that completed
before cancellation are partial historical observations, not CI-FAST1 or P1-0
acceptance.

Review findings resolved:

- the first trigger split would have run Rust Fast alongside the full matrix on
  a non-Draft PR; a Draft-only fast job guard now makes the two lanes mutually
  exclusive;
- full workflow path filters now include `rust-fast.yml` on both PR and `main`
  events, and Rust Fast includes both workflow files plus its contract script;
- cache restore cannot cross OS or explicit toolchain; and
- cache failure cannot skip any verification command or create release truth.

Hosted evidence remains pending for the exact pushed implementation head:

- Rust Fast must pass;
- Rust Compatibility must be skipped without six runner jobs while PR #75 is
  Draft; and
- the cache step may miss on its first run without weakening acceptance.

Implementation-head hosted evidence is now available:

- commit `68050678e47c65f93eac815313c897fd8169a86e`;
- Rust Compatibility run `32109328630` completed `skipped` with one skipped
  pre-matrix job and no six runner expansion;
- Rust Fast run `32109328681`, job `95625195904`, passed in 5m21s;
- deterministic contracts, formatting, locked workspace check, and locked
  workspace tests all passed;
- the first cache restore truthfully reported a miss; and
- post-job save created key
  `rho-rust-v1-Linux-stable-x86_64-unknown-linux-gnu-eeb6d67f00256a4a737e5a57abd57a2d1e8d30c20fe84822ea866008f0f028b7`.

The first run is the expected cold-cache baseline. The evidence-reconciliation
head `f5b85519d63d6bd9e4778cff1659764ecdb7e692` passed Rust Fast run
`32109891797` in 1m58s with an exact 1128 MiB cache hit; Rust Compatibility run
`32109891648` skipped before matrix expansion. Later P1 package heads continued
to prove the same mutually exclusive Draft lane.

At the authorized integration boundary, PR #75 became Ready. Rust Fast run
`32129768023` skipped and Rust Compatibility run `32129767978` expanded to all
six stable/MSRV legs and passed on exact head
`3e710acab51ea6400ba2e0ef8ff6e41429da4b0c`. This closes the deferred-matrix
acceptance without turning cache state into evidence.

Version/NEWS: no application or R package version change and no `NEWS.md`
entry. Manual UI, installed-app, packaging, signing, and release checks are not
applicable to this CI-only package.

## Definition Of Done

- the active MSRV and P1 contracts record the new feedback/acceptance split;
- fast and full workflow contracts are deterministic and negative-tested;
- exact-head Draft CI proves the fast job and matrix skip behavior;
- cache isolation and failure semantics are reviewed;
- P1-0 no longer claims a deferred matrix as pending local work;
- the long-lived construction stream remains fast while Draft; and
- the exact Ready integration boundary runs the complete native/MSRV matrix.
