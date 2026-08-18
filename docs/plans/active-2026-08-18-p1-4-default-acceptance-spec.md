# P1-4 Default Switch And Phase 1 Acceptance Specification

Status: active; default/version/smoke implementation, local source/macOS
installed-app verification, and exact-head Draft Fast passed; Ready six-leg and
hosted installed-app gates pending

Date: 2026-08-18
Owning architecture:
[`accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md`](../design/accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md)
Predecessor:
[`active-2026-08-18-p1-3-workspace-snapshot-viewer-spec.md`](active-2026-08-18-p1-3-workspace-snapshot-viewer-spec.md)
PR: [#75](https://github.com/YuLab-SMU/Rho/pull/75)
Upstream baseline: `95d7d2c7774519ef956637aeff678ed4f2752ab5`
P1-4 branch baseline: `3de973d440728e99793aaad82340bca3db5c6ec5`

Change class: D4 internal runtime default, development candidate identity,
cross-platform installed application acceptance, and Phase 1 decision
Risk: R4 default routing, Workspace/Agent/filesystem authority, release
metadata, native packaging, and multi-platform acceptance
Authorized work package: `P1-4`
Mandatory stop: complete local, six-leg, installed-app, contract review, and
documentation evidence before PR #75 becomes Ready

## Default And Legacy Override

Missing `RHO_INTERNAL_EXTENSION_RUNTIME` now selects `candidate`. Explicit
values remain:

```text
candidate  use the Phase 1 runtime and three compiled-in migrations
legacy     use the unchanged pre-Phase-1 wiring
invalid    fall back to legacy and emit one bounded typed diagnostic
```

The value remains private, process-local, unpersisted, absent from UI/mock
state, and unsupported as a public feature flag. `legacy` remains available for
one later release cycle. Removing it requires a new reviewed package and is not
authorized in PR #75.

Default-mode tests must prove application Viewer activation, project Run
History activation, Workspace Snapshot activation, project A/B/A generation,
Workspace restart, Agent adapter, and shutdown without setting the variable.
Explicit legacy tests must prove no product plugin activates and all three
existing direct paths still work.

## Development Candidate Identity

Repository and GitHub audit on 2026-08-18 found stable `v0.4.0` as the latest
release and no `v0.4.1*` tag or release. P1-4 allocates the next unused
development identity:

```text
0.4.1-dev.0
v0.4.1-dev.0
Rho 0.4.1-dev.0
```

Synchronize only the application-owned version surfaces:

- Cargo workspace package version and generated `Cargo.lock` workspace entries;
- `desktop/src-tauri/tauri.conf.json`;
- `desktop/package.json` and `desktop/package-lock.json`;
- browser mock application/update version fixtures;
- frontend asset cache-busting version query; and
- a new top `NEWS.md` section describing the internal runtime default and the
  unchanged legacy escape hatch without claiming a public plugin SDK.

R package versions do not change because their package contracts did not
change. P1-4 does not create a tag, GitHub Release, updater manifest, download,
signature, publication, or release decision.

## Packaged Smoke Contract

`rho-desktop --smoke-test` must exercise the default candidate runtime in
addition to its existing Trusted Kernel checks:

- construct the application scope with the fixed Viewer contribution;
- construct and publish project Run History plus Workspace Snapshot scopes;
- call candidate Run History and compare it to Store authority;
- call candidate Workspace Snapshot through the typed tool and existing broker;
- read a project viewer file through the application contribution and unchanged
  containment helper;
- switch/reparent or otherwise prove current project/Workspace identity;
- restart Workspace R and prove the old Workspace generation is non-routable;
- shut down child-first without a leaked effect/lease/task; and
- include bounded machine-readable booleans for these facts in the smoke JSON.

`RHO_INTERNAL_EXTENSION_RUNTIME=legacy` smoke remains a separate parity leg.
Agent network smoke is not required for every unsigned PR build; the local
Agent adapter/R suite and offline candidate adapter tests remain mandatory.

## Six-Leg Rust Matrix

When PR #75 is changed from Draft to Ready, existing `Rust Compatibility` must
run all locked legs:

```text
macos-26       stable-aarch64-apple-darwin
macos-26       1.88.0-aarch64-apple-darwin
windows-latest stable-x86_64-pc-windows-gnu
windows-latest 1.88.0-x86_64-pc-windows-gnu
ubuntu-22.04   stable-x86_64-unknown-linux-gnu
ubuntu-22.04   1.88.0-x86_64-unknown-linux-gnu
```

Every leg runs locked check/test; stable legs also run format, deterministic
contracts, frontend syntax, licensing, and release-tool self-tests. Rust Fast
must skip when the PR is Ready so the two workflow signals remain mutually
exclusive.

## Unsigned Installed-App Acceptance

Extend the existing `Rust Compatibility` workflow with stable-only,
non-publishing installed-app acceptance. It keeps `contents: read`, uses no
repository signing/publication secret, creates only short-lived runner state,
and always cleans installed/mounted state.

### Windows x64

- use Rust stable GNU plus Rtools45 and R 4.6.1;
- bootstrap the pinned Ark sidecar and build the NSIS package with the reviewed
  packaging script;
- verify application/installer version and hashes;
- silently install on a clean hosted runner;
- locate the installed executable outside the workspace;
- run default-candidate and explicit-legacy `--smoke-test`;
- silently uninstall and prove executable plus uninstall registry cleanup.

The package is unsigned; SmartScreen/publisher acceptance is not claimed.

### macOS arm64

- use macos-26 arm64, stable Rust, current release R, and pinned Ark;
- create only an ephemeral Tauri updater key;
- build unsigned `Rho.app` and DMG;
- verify exact arm64 executable/Ark, version metadata, license resources, and
  DMG integrity;
- run default-candidate and explicit-legacy smoke from the built app;
- mount the DMG read-only, run both smokes from the mounted app, then detach;
- remove temporary keys/mounts.

No Developer ID, notarization, staple, or Gatekeeper acceptance is claimed.

### Linux x86-64

- use Ubuntu 22.04, stable Rust, R 4.6.1, pinned Ark, and the reviewed AppRun
  dependency baseline;
- build the final AppRun-patched AppImage with an ephemeral updater key;
- verify AppImage/version/license/AppRun contracts;
- extract the final image and run default-candidate plus explicit-legacy smoke
  from the packaged executable;
- remove the extracted application and ephemeral key.

No package publication or distribution-signature acceptance is claimed.

## Final Internal API And Safety Review

P1-4 freezes these Phase 1 semantics as authoritative internal invariants:

- validated IDs, descriptor limits, capability-major compatibility, stable
  activation order, explicit optional absence, and canonical cycle errors;
- host-owned scope kinds/tree/generations and pointer-CAS publication;
- immediate effect ownership, reverse/idempotent cleanup, bounded deadlines,
  non-routable failure, task/call lease admission, and late-result rejection;
- application/project/Workspace ownership and child-first teardown;
- bounded typed broker calls and diagnostics;
- Store, Workspace broker/Ark, Agent lane, and project file containment remain
  product authorities; and
- compiled-in first-party inventory only.

Rust module layout, trait/method names, constructors, and ergonomic API remain
internal experimental. P1-4 does not announce or freeze a public SDK.

Review explicitly covers Trusted Kernel/raw expression, project isolation,
credentials/redaction, fallback, cleanup/leaks, generation/CAS, panic
containment, request/response bounds, filesystem/symlink containment, duplicate
registration/event/run prevention, and no new permission authority.

## Documentation Lifecycle And PR State

Only after every required fact is true:

- update this contract and predecessors with exact commands/runs/artifacts;
- mark the accepted architecture `implemented` (rename file and repair links);
- record internal API acceptance and residual legacy-removal follow-up;
- update the central cross-review and documentation index;
- update PR #75 body with P1-0 through P1-4 evidence;
- change PR #75 from Draft to Ready to trigger the full matrix; and
- keep it Ready only if all required hosted gates pass.

The Ready transition may precede final evidence text solely to trigger the
non-Draft matrix/installed jobs. If a required job fails, fix it on the same PR
or return the PR to Draft; never report Phase 1 complete while required evidence
is failing.

## Verification

Local before Ready:

```text
cargo fmt --all -- --check
cargo test -p rho-extension-runtime --locked
cargo +1.88.0-aarch64-apple-darwin test -p rho-extension-runtime --locked
cargo clippy -p rho-extension-runtime --all-targets --locked -- -D warnings
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
Rscript -e 'testthat::test_local("r/rho.bridge")'
Rscript -e 'testthat::test_local("r/rho.agent")'
node --check desktop/dist/app.js
node scripts/test-extension-phase-1-acceptance.mjs --test
node scripts/test-extension-phase-1-acceptance.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
git diff --check
```

Also build local unsigned macOS app/DMG, run default and legacy smoke from the
built app and read-only mounted DMG, and record paths/sizes/SHA-256. Hosted
completion requires six Rust legs plus all three unsigned installed-app legs.

## Definition Of Done

- candidate is the missing-variable default and explicit legacy remains;
- `0.4.1-dev.0` metadata and NEWS are synchronized without R package bump;
- default/legacy source tests and packaged smoke pass;
- full local Rust/R/frontend/license gates pass;
- six hosted stable/MSRV legs pass on the exact Ready head;
- Windows/macOS/Linux unsigned installed-app build/smoke/cleanup pass;
- final contract/safety/internal-API review has no blocking finding;
- architecture/document/PR lifecycle reflects only verified facts;
- version, NEWS, unrun checks, residual risks, commits, CI runs, artifact facts,
  worktree, and non-release decision are recorded; and
- Phase 1 is complete without deleting legacy or claiming Phase 2/public SDK.

## Local Implementation Evidence

Verified on 2026-08-18 against P1-4 branch baseline
`3de973d440728e99793aaad82340bca3db5c6ec5`:

- commit `4b92bc4` makes missing runtime mode select candidate, preserves explicit
  legacy/invalid fallback, synchronizes `0.4.1-dev.0` across Cargo/Tauri/npm/
  mock/cache-bust surfaces, updates NEWS, and makes `--smoke-test` exercise the
  three compiled-in migrations, generation replacement, and clean shutdown;
- commit `66120a8` adds the self-testing Phase 1 acceptance contract and
  stable-only, read-only, unsigned Windows/macOS/Linux installed-app acceptance
  to the existing six-leg Ready workflow;
- commit `bd66e59` makes the existing runtime-cache mutation fixture
  deterministic across Linux filesystems by changing payload size instead of
  relying on two writes receiving different millisecond mtimes;
- no dependency was added or removed; `Cargo.lock` changed only the eleven
  workspace-owned Rho package versions;
- R package versions remain unchanged;
- all repository `scripts/test-*.mjs` passed after the version allocation; and
- workflow YAML parsing and negative MSRV/Phase-1 contract fixtures passed.

Commands and results:

```text
cargo fmt --all -- --check
  passed
cargo +1.88.0 test -p rho-extension-runtime --locked
  passed: 26 graph-contract + 34 lifecycle tests
cargo clippy -p rho-extension-runtime --all-targets --locked -- -D warnings
  passed
cargo check --workspace --all-targets --locked
  passed
cargo test --workspace --locked --no-fail-fast
  passed: 453; ignored: 1 existing opt-in macOS Keychain smoke
Rscript -e 'testthat::test_local("r/rho.bridge")'
  passed: 575
Rscript -e 'testthat::test_local("r/rho.agent")'
  passed: 120
for test_script in scripts/test-*.mjs; do node "$test_script"; done
  passed: every tracked Node contract
node scripts/test-extension-phase-1-acceptance.mjs --test
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-license-contract.mjs --test
node --check desktop/dist/app.js
git diff --check
  all passed
```

Unbundled default-candidate and explicit-legacy `cargo run ... --smoke-test`
both passed. Their JSON proved project isolation, Workspace restart recovery,
candidate Run History parity, typed Workspace Snapshot, viewer host injection,
old Workspace rejection, and clean shutdown.

Local unsigned macOS arm64 acceptance:

```text
Built app:
  target/aarch64-apple-darwin/release/bundle/macos/Rho.app
Built DMG:
  target/aarch64-apple-darwin/release/bundle/dmg/Rho_0.4.1-dev.0_aarch64.dmg
Executable:
  36,090,864 bytes
  SHA-256 7379879b952ee7beb1ba8c72b62b53bd38782b0dda7522aac09ecac591542bc9
DMG:
  22,689,295 bytes
  SHA-256 ee09db111ddfc54012d7c6d760e6f8eb57abb968ee746bba7324f47fb73d3c3d
```

The app/Ark were exactly arm64; Info.plist reported `0.4.1-dev.0`; bundled Rho
license matched source; `hdiutil verify` passed. Default-candidate and legacy
smoke passed from both the built app and read-only mounted DMG. The mount was
detached and the ephemeral updater private/public key files were zeroed and
deleted. No app was installed, signed, notarized, uploaded, tagged, released,
or published.

Interactive browser review was not rerun because P1-4 changes no UI state or
protocol and the complete browser/mock contract set passed. Windows/Linux
installed-app and the six stable/MSRV legs remain pending until the exact head
is pushed and PR #75 becomes Ready.

The first P1-4 Draft Fast run `32127215983` reached all workspace tests but
exposed the pre-existing equal-size runtime-cache fixture race on Linux. The
size-based `bd66e59` regression ran five consecutive local passes. Exact-head
Rust Fast run `32127514055` then passed on
`bd66e59bcc1594396d6062921cf4f19d466b8231` in 2 minutes 25 seconds. It restored
the previous 1305 MiB lock-compatible cache as a fallback and saved the new
exact `0.4.1-dev.0` lock key
`rho-rust-v1-Linux-stable-x86_64-unknown-linux-gnu-950bf8c54d23a3bc241b05454b313d6a9f63af516abe7f407e54976fe40eaa71`.
Rust Compatibility run `32127514056` skipped while PR #75 remained Draft.
