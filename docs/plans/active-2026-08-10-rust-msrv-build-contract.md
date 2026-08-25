# Rust Toolchain And Reproducible Build Contract

Status: active rolling-toolchain contract; `TOOLCHAIN-VELOCITY-1` authorized by
the repository owner on 2026-08-24 and supersedes the frozen Rust 1.88 policy.
The historical filename is retained so existing evidence links remain valid.

Date: 2026-08-24
Change class: D3 shared build and toolchain policy
Risk: R3 build and integration foundation
Authorized work package: `AM-W1-03`
Next mandatory stop: validate the exact pinned compiler, locked dependency graph,
and affected source contracts; an old-compiler failure is not a stop condition.

## Problem And Reproduction

Rho is an early-stage product that is changing quickly. A fixed long-term MSRV
turned a historical compatibility choice into an architecture veto: the Runtime
Output IPC spike selected published `tauri-specta 2.0.0-rc.25` and
`specta 2.0.0-rc.25`, but `cargo +1.88.0 check -p rho-desktop` failed because
that Specta release uses `std::fmt::from_fn`, which Rust 1.88 does not provide.
The identical locked graph passed with the repository's already-pinned Rust
1.97.0 toolchain in 18.97 seconds.

Supporting an old compiler has no current user, binary-distribution, plugin, or
public-protocol requirement. Letting it force a second-choice generator would
increase handwritten contracts and maintenance risk without improving the
product. The useful parts of the former policy are reproducibility, explicit
compiler selection, locked dependencies, and deterministic failure reporting;
those remain.

## Goals

- Use one exact compiler selected by `rust-toolchain.toml` for normal local and
  integration work.
- Keep `[workspace.package].rust-version` aligned with the pinned compiler's
  major/minor as a build baseline, inherited by every workspace member.
- Treat a toolchain advance as a normal atomic tooling/dependency change, not as
  an exceptional compatibility-policy event.
- Keep Cargo resolver 3, the committed lockfile, explicit CI toolchain
  selection, formatting, locked checks, and locked tests.
- Fail on correctness, authority, deterministic-generation, serialization,
  recovery, or reproducibility regressions.
- Report older-compiler compatibility, compile-time changes, binary-size
  changes, and ecosystem maturity as engineering evidence instead of fixed
  automatic vetoes unless an active release contract defines an exact limit.
- Avoid running installer construction or installed-app acceptance in ordinary
  Rust source compatibility jobs; candidate/release contracts own those gates.

## Non-Goals

- This contract does not promise support for Rust 1.88 or any compiler older
  than the repository pin.
- It does not use floating `stable` for the normal development baseline.
- It does not permit `--ignore-rust-version`, unlocked builds, silent generated
  drift, public-shape drift, or weakening security and recovery tests.
- It does not change application behavior, project identity, persistence,
  permissions, credentials, runtime admission, release authority, or package an
  installer.
- It does not prevent an active release contract from adding candidate-specific
  platform or installed-app acceptance after a candidate exists.

## Authority And Engineering Policy

This document owns:

- the repository Rust compiler pin and workspace build-baseline metadata;
- exact compiler selection in Draft and Rust integration workflows;
- locked source check/test behavior in those workflows; and
- deterministic checks that keep those values aligned.

`Cargo.lock` remains the exact dependency authority. Candidate and release
documents retain packaging, signing, artifact, installed-app, and GO/NO-GO
authority. Product and architecture documents retain behavior and public
contract authority.

The decision rule is quality-first:

1. If the pinned compiler and locked graph pass the affected correctness and
   contract suite, an older compiler failure cannot select a fallback.
2. If a preferred dependency requires a newer stable Rust, advance the exact
   repository pin and workspace build baseline together, inspect release notes,
   refresh the lockfile if needed, and run the affected matrix.
3. Compile-time and binary-size measurements trigger profiling and judgment;
   they become blockers only when their user or delivery impact is material and
   cannot be bounded in the current slice.
4. Serialization drift, command-name drift, non-deterministic generation,
   authority broadening, security regression, unrecoverable failure, and test
   regression remain hard blockers.

## Manifest Contract

The current exact toolchain is:

```toml
[toolchain]
channel = "1.97.0"
profile = "default"
```

The virtual workspace declares:

```toml
[workspace]
resolver = "3"

[workspace.package]
rust-version = "1.97"
```

Every workspace member inherits `rust-version.workspace = true`. Cargo metadata
is the authority for effective member values. `rust-toolchain.toml` is the sole
current-release authority: the deterministic contract derives its expected
workspace major/minor and workflow toolchains from that file, then rejects
pin/baseline disagreement. No current Rust version is duplicated as a validator
constant.

## Development And Integration Workflow

Draft feedback uses one Ubuntu source job with the exact
`1.97.0-x86_64-unknown-linux-gnu` toolchain. It runs deterministic repository
contracts, frontend checks, formatting, a locked all-target workspace check, and
locked workspace tests.

The non-Draft/main Rust compatibility workflow retains one source leg per
development OS, all on the exact pinned compiler:

| Runner | Toolchain | Host |
| --- | --- | --- |
| `macos-26` | `1.97.0-aarch64-apple-darwin` | `aarch64-apple-darwin` |
| `windows-latest` | `1.97.0-x86_64-pc-windows-gnu` | `x86_64-pc-windows-gnu` |
| `ubuntu-22.04` | `1.97.0-x86_64-unknown-linux-gnu` | `x86_64-unknown-linux-gnu` |

Each leg explicitly sets `RUSTUP_TOOLCHAIN`, verifies `rustc 1.97.0` and the
host, and runs locked workspace check/tests. The Linux leg additionally owns
formatting and repository-wide generated/frontend contract checks so those
platform-independent gates are not repeated three times. The workflow is
read-only and may cancel obsolete runs for the same ref.

The Rust compatibility workflow does not build installers, mount packages,
install applications, sign, upload, publish, or use release credentials.
Candidate workflows continue to own locked candidate-source tests and any
candidate-specific packaging acceptance.

## Toolchain Advancement

A toolchain advance is one reviewable change containing:

1. the `rust-toolchain.toml` channel;
2. `[workspace.package].rust-version` major/minor;
3. exact workflow target toolchains and deterministic fixtures;
4. dependency/lockfile changes required by the advance; and
5. focused plus affected workspace evidence.

It does not require a product version or `NEWS.md` entry unless user-visible
behavior changes. It does not require proof on the superseded compiler. A
failed dependency experiment may revert normally; no persistent user data is
involved.

The repository validator must accept such a coherent stable-semver advance
without first being taught that version. It owns consistency and
reproducibility, not dependency or architecture selection. If the currently
pinned compiler is too old for a preferred dependency, advance the pin and
validate the resulting graph; do not select a weaker implementation merely to
satisfy the superseded baseline.

## Automated Verification

The deterministic contract covers:

- resolver 3 and the build-baseline metadata derived from the current exact
  toolchain pin;
- inheritance by every workspace member;
- exact agreement among the repository pin, Cargo metadata, workflow target
  toolchains and runtime compiler assertions;
- one pinned source integration leg per development OS;
- no floating-stable, duplicate compiler, or installed-package leg in the
  source compatibility workflow;
- exact pinned Draft feedback;
- explicit toolchain selection, locked check/tests, read-only permissions, and
  cache isolation;
- positive fixtures for a coherent future stable-semver advance, plus negative
  fixtures for baseline drift, workflow mismatch, floating pins, missing member
  metadata, missing matrix identity and unlocked commands.

Current local acceptance commands are:

```text
node --check scripts/test-rust-msrv-contract.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
cargo +1.97.0 fmt --all -- --check
cargo +1.97.0 check --workspace --all-targets --locked
cargo +1.97.0 test --workspace --locked --no-fail-fast
git diff --check
```

The script keeps its historical filename for link and workflow stability; its
output and semantics now describe the rolling pinned-toolchain contract.

## Version, NEWS, And Release Impact

This policy correction has no user-visible application behavior and changes no
R package contract. Application/R versions and `NEWS.md` remain unchanged.
There is no release, installer, signing, publication, or upstream decision.

## Definition Of Done

- Rust 1.88 is absent from active build and architecture acceptance gates.
- All workspace packages report Rust 1.97 through Cargo metadata.
- Local development and Rust integration select exact Rust 1.97.0 toolchains.
- The Rust integration workflow has three source legs and no ordinary
  installed-package lane.
- The deterministic contract rejects drift without enforcing obsolete compiler
  compatibility.
- The locked tauri-specta graph compiles on the pinned toolchain and the Runtime
  Output modernization package resumes without a generator fallback.
