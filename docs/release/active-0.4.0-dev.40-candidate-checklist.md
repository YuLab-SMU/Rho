# Rho 0.4.0-dev.40 Native Updater Candidate Checklist

Status: active immutable NO-GO ledger. Source/candidate construction and the
dual-platform dev.40→dev.41 updater behavior matrix passed, but installed
Windows evidence found `rho-desktop.exe` was `NotSigned`. The dev.40 Draft
remains unpublished and cannot be repaired or relabelled; the authorized
two-stage replacement is fresh dev.42.

Owner: Rho release owner

Specification: `docs/plans/active-2026-08-15-tauri-native-updater-spec.md`

## Identity

| Field | Required value |
| --- | --- |
| Application version | `0.4.0-dev.40` |
| Release tag/name | `v0.4.0-dev.40` / `Rho 0.4.0-dev.40` |
| Channel | development prerelease |
| Source commit | unresolved until protected integration |

## Required Evidence

| Gate | Required evidence | Current state |
| --- | --- | --- |
| UPDATER-1A source | reviewed updater runtime/config, docs, deterministic tests, and protected integration | author review, deterministic matrix, and PR CI passed; required review and protected integration pending |
| Windows final bytes | final Authenticode NSIS installer, fresh Tauri `.sig` cryptographically verified against the configured public key, and bound native-updater evidence | not run |
| macOS final bytes | independently accepted app archive, stapled app, final `.tar.gz`, fresh Tauri `.sig` cryptographically verified against the configured public key, and bound evidence | not run |
| Candidate Draft | immutable exact asset set, reviewed release notes, aggregate evidence, and explicit acceptance decision | not run |
| Installed update | supported installed build checks, user-authorized install/restart, and truthful failure recovery on both platforms | not run |
| Public native manifest | exact accepted published Release, post-deploy manifest validation, and explicit release decision | not run |

## Pre-Integration Source Evidence

- Passed on 2026-08-15: `cargo fmt --all -- --check`, `cargo test --workspace
  --locked --no-fail-fast` (including 179 passed in `rho-desktop` and its one
  pre-existing opt-in macOS Keychain test ignored), both `r/rho.bridge` and
  `r/rho.agent` test suites, all 67
  `scripts/test-*.mjs` checks, `node --check desktop/dist/app.js`, Rust 1.88
  checks for `rho-desktop` and `rho-updater-verifier`, candidate/Pages/native
  updater generator tests, YAML parsing, release-notes validation, and `git
  diff --check`.
- Author review checked manual-only authority, platform exclusion, endpoint and
  redirect allowlists, bounded download and metadata validation, signature and
  final-byte evidence binding, secret isolation, shutdown/restart recovery,
  browser/mock truthfulness, and documentation ownership. It added check-time
  rejection for malformed pending version, download URL, and signature text.
- Windows target compilation and native installer behavior are not claimed by
  this local macOS evidence; the protected Windows GNU CI and later exact
  candidate/installed-app gates remain required.
- Upstream PR [#78](https://github.com/YuLab-SMU/Rho/pull/78) Rust
  compatibility run `31871247195` passed on 2026-08-15 for macOS stable, macOS
  Rust 1.88, Windows GNU stable, and Windows GNU Rust 1.88. It is source CI,
  not a candidate, installed-app, or release acceptance result.

## Release Decision

Current decision: `NO-GO` for dev.40 publication and permanent native endpoint.
The prior dev.39 conditional decision is historical and cannot be reused.
Updater behavior evidence composes only as a regression baseline for the fresh
dev.42 two-stage candidate; no dev.40 artifact/hash/acceptance may be replaced.
