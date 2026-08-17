# Rho 0.4.0-dev.42 Two-Stage Free Trial Candidate Checklist

Date: 2026-08-17

Status: active source contract; `SP-FT2-DEV42` is authorized, external binary
artifact configuration and encrypted repository secret exist, and the initial
source integrated. Deterministic pre-sign bundle-type repair implementation and
local validation pass; protected integration is pending. Failed pre-Draft run
`31999076405` is
non-composable; no dev.42 tag, Draft, acceptance record, Release, or Pages entry
exists.

Owner: Rho release owner

Specification:
`../plans/active-2026-08-17-signpath-free-trial-two-stage-dev42-spec.md`

Change class / risk: D4 / R4

## Exact Identity

| Field | Required value | Current state |
| --- | --- | --- |
| Version | `0.4.0-dev.42` | synchronized in source, Tauri/frontend metadata, lockfile, NEWS, and release notes |
| Tag/name | `v0.4.0-dev.42` / `Rho 0.4.0-dev.42` | unused; no Release |
| Channel | development prerelease | stable excluded |
| Source commit | one exact current protected-main commit | unresolved |
| Windows binary config | `github-actions-rho-desktop-binary` | created/visually verified in SignPath; encrypted repository secret registered |
| Windows installer config | protected existing NSIS config | existing Free Trial lane |
| Signing policy/certificate | existing `test-signing` / `Rho Test Signing` | self-signed, not publicly trusted |

## Source And Candidate Gates

- [x] active spec/cross-review/version/NEWS/release notes agree;
- [ ] `Full`, `NoBundle`, and `BundleOnly` build modes are deterministic and
  negative-tested; source contract negatives pass, hosted Windows execution is
  pending;
- [x] candidate-only binary request precedes NSIS bundle and installer request;
- [x] the exact single Tauri bundle-type token is changed from unknown to NSIS
  before binary signing, with missing/duplicate/already-patched/size negatives;
- [ ] signed executable hash/certificate survives bundling unchanged;
- [x] final installer is signed before its Tauri updater signature;
- [x] dev.42 platform evidence uses only the two-stage schema/check set;
- [ ] silent install proves installed executable bytes/signature and cleanup;
- [ ] secrets are bounded/masked and absent from logs/artifacts/source; source
  scoping passes, hosted log/artifact audit is pending;
- [ ] complete local affected matrix and four-leg protected CI pass;
- [ ] independent post-verification review has no blocking finding;
- [ ] exact main candidate run creates one immutable Draft;
- [ ] independent candidate audit verifies both SignPath request bindings,
  signed/installed bytes, macOS trust, and all native signatures.
- [ ] a separate protected transport-publication/finalization contract is
  integrated after Draft audit; it never rebuilds assets and normal Update Site
  stays fail-closed until exact acceptance;

## Installed And Update Gates

- [ ] Windows clean install resolves outside-workspace `rho-desktop.exe`;
- [ ] installed binary is not `NotSigned`, carries expected thumbprint,
  self-signed subject/issuer, and expected Free Trial status;
- [ ] Windows startup/core smoke, warning/publisher observation, and uninstall
  pass against exact hashes;
- [ ] macOS Developer ID, notarization, staple, Gatekeeper, startup, and
  uninstall/move-to-Trash observation pass;
- [ ] bounded dev.41→dev.42 native update succeeds on Windows x64 and macOS
  arm64 with explicit Install and Restart;
- [ ] final installed versions are dev.42 and Windows installed binary remains
  signed after updater installation;
- [ ] temporary fixture cleanup proves native development/stable endpoint
  `404` before publication.
- [ ] the exact audited prerelease is public only for bounded transport, has no
  acceptance asset yet, and normal Update Site/permanent endpoints remain
  untouched until both platform rows pass;

## Publication Gate

- [ ] exact machine-readable acceptance asset is generated from downloaded
  candidate evidence, reviewed, and uploaded once;
- [ ] owner records explicit GO/CONDITIONAL_GO consistent with Free Trial
  self-signed disclosure;
- [ ] protected transport publication changes only Draft/prerelease state, and
  protected finalization later adds only the exact acceptance asset before
  normal Update Site admission;
- [ ] normal Update Site exposes dev.42, exact hashes, and explicit untrusted
  Free Trial Windows notice;
- [ ] permanent `/updates/tauri/development.json` contains only final dev.42
  URLs/signatures and verifies over HTTPS;
- [ ] `/updates/tauri/stable.json` remains `404`;
- [ ] fresh installed manual update against the permanent endpoint passes.

Current release decision: `NO_RELEASE_DECISION`. Source implementation,
candidate construction, installed acceptance, publication, and permanent
native endpoint remain distinct facts.

## Rejected Pre-Draft Run

Run `31999076405` is rejected and non-composable. It passed the exact macOS
lane and, on Windows, `NoBundle`, binary request, binary promotion,
`BundleOnly`, signed-source hash survival, installer request/promotion, and the
final Tauri signature. Silent installation then proved the installed EXE hash
did not equal the signed pre-bundle EXE hash. Tauri `2.11.4` source review
showed its NSIS bundler patches the bundle-type token only while packaging and
restores the disk source afterward. No Windows platform evidence, aggregate
evidence, tag, Draft, or Release was created. A new protected-main run may use
the still-unused dev.42 identity only after the deterministic pre-sign NSIS
token patch and its regression tests integrate; it may reuse no run artifact,
request, hash, or notarization result.
