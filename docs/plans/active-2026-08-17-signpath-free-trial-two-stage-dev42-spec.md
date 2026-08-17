# SignPath Free Trial Two-Stage Windows Candidate Specification

Date: 2026-08-17

Status: active `SP-FT2-DEV42` D4/R4 work package. Source implementation,
version/NEWS/release-note synchronization, local affected validation, and
encrypted binary-configuration registration completed on 2026-08-17;
protected hosted validation and integration remain pending. The project owner
stated in Issue #26 that Windows will use the SignPath Free Trial certificate
for an extended period and instructed the administrator to solve the updater
work as one bounded stream. The exact external binary artifact configuration
was created and visually verified in the SignPath `rho` project on 2026-08-17.

Owner: Rho release owner

Candidate identity: `0.4.0-dev.42` / `v0.4.0-dev.42` /
`Rho 0.4.0-dev.42`

Parent contracts:

- `active-2026-08-11-signpath-application-readiness-spec.md`;
- `active-2026-08-15-tauri-native-updater-spec.md`; and
- `../release/active-0.4.0-dev.42-two-stage-signing-checklist.md`.

Change class / risk: D4 / R4. This changes the exact Windows executable and
installer signing order, candidate evidence, installed-byte acceptance, public
trust disclosure, and eventual native-update release identity.

## Problem And Authoritative Evidence

The immutable dev.40 and public acceptance-only dev.41 candidates completed
the full dual-platform updater behavior matrix: intentional signature
rejection, post-shutdown failure recovery, user-authorized install/restart, and
final-version verification. Both bounded Pages fixtures cleaned up and the
native stable/development endpoints returned to `404`.

Windows installed evidence then found
`C:\Users\xiayh17\AppData\Local\Rho\rho-desktop.exe` was `NotSigned`. Candidate
evidence truthfully proves only that the outer NSIS installer entered the
SignPath Free Trial `test-signing` policy with a self-signed certificate and
`UnknownError` trust status. Issue #26 already states that signing only the
outer NSIS wrapper is insufficient because NSIS does not deep-sign the
installed executable.

The existing `github-actions-nsis-installer` artifact configuration remains
the exact installer lane. The owner created a second strict configuration:

```text
name: Rho desktop binary
slug: github-actions-rho-desktop-binary
container: ZIP
only signed path: rho-desktop.exe
operation: Authenticode sign
```

Its XML constrains one root `rho-desktop.exe` inside the ZIP transport. No
organization ID, API token, complete deployment config, or certificate private
key is recorded in source or this contract.

## Decision And Public Trust Boundary

Free Trial use is an explicit development-prerelease decision. It does not
establish SignPath Foundation acceptance, a publicly trusted chain, production
publisher identity, or SmartScreen reputation. Both the signed binary and
installer are expected to have the configured self-signed certificate and
PowerShell `UnknownError`, never `Valid` or `NotSigned`. Public pages and
release evidence must continue to disclose the self-signed/untrusted status.

This work does not weaken the eventual Foundation production contract. It
implements the already-required two-stage own-binary signing topology using
the available test certificate so the installed executable is no longer
unsigned.

## Exact Candidate Workflow

Candidate mode must use this fail-closed order:

1. check out the exact current protected-main commit and run the complete
   Windows source/test matrix;
2. bootstrap runtime resources and run Tauri `build --no-bundle` exactly once;
3. smoke-test the exact unsigned `target/release/rho-desktop.exe`, require
   `NotSigned`, hash it, and wrap only that root filename in one ZIP;
4. load the existing protected installer deployment config plus the separate
   encrypted binary-config slug, validate/mask all values, and install the
   pinned official SignPath PowerShell module once;
5. submit binary request 1 with artifact configuration
   `github-actions-rho-desktop-binary`, wait boundedly, require one returned
   ZIP/root executable, changed bytes, the configured self-signed certificate,
   expected thumbprint, and `UnknownError`, then promote those exact bytes to
   `target/release/rho-desktop.exe`;
6. run Tauri `bundle --bundles nsis` without recompiling, require the signed
   executable hash/certificate to remain unchanged, create exactly one NSIS
   installer, and reject any stale updater signature as final evidence;
7. require the installer is `NotSigned`, hash it, wrap exactly the installer
   root filename in one ZIP, submit installer request 2 through the existing
   configuration, and verify/promote one changed self-signed result;
8. run `tauri signer sign` only over the final post-SignPath installer and
   independently verify the Tauri signature with the compiled public key;
9. silently install the exact final installer on the hosted runner, resolve
   installed bytes outside the workspace, require installed
   `rho-desktop.exe` byte equality with the signed binary, expected self-signed
   certificate/thumbprint/status, smoke-test it, then uninstall and prove both
   executable and registry state are removed; and
10. create one version-specific two-stage evidence record binding both request
    IDs, module identity, thumbprint, each unsigned/signed hash, installed hash,
    certificate status, final installer, and native-updater signature.

Rehearsal remains unsigned and uses the ordinary one-shot local build path. It
must not receive SignPath secrets, requests, or false two-stage evidence.

## Build Script Contract

`scripts/build-windows-installer.ps1` gains explicit, mutually exclusive modes:

- `Full`: current build-and-bundle behavior for local packaging/rehearsal and
  existing acceptance workflows;
- `NoBundle`: prepare resources and run Tauri `build --no-bundle`, require the
  release executable, and forbid an installer result; and
- `BundleOnly`: require a pre-existing release executable, capture its hash,
  run Tauri `bundle --bundles nsis`, require that hash unchanged, and require
  exactly one expected installer.

Mode inputs are fixed choices. Overlay/retry behavior remains valid only where
the existing contract permits it. `BundleOnly` never rebuilds or replaces the
signed executable.

## Evidence Schema And Compatibility

Historical schema/version evidence remains immutable. For dev.42 only, Windows
platform evidence requires these passed checks:

```text
release_metadata
rust_workspace
rho_bridge
rho_agent
frontend
workspace_smoke
authenticode_binary
authenticode_installer
installed_payload_signature
signpath_binary_request_binding
signpath_installer_request_binding
free_trial_self_signed
```

The two-stage signing record has exact binary and installer request/status/hash
fields. Dev.38-dev.41 retain their legacy single-installer record. An old
record cannot satisfy dev.42, and dev.42 cannot be validated through the
legacy check list.

## Negative And Recovery Matrix

Automation must reject:

- missing/blank/multiline/invalid binary-config slug;
- binary config accidentally equal to the installer config;
- API token/config exposure outside the bounded signing steps;
- wrong ZIP cardinality, nesting, filename, or output path for either request;
- already-signed binary input, unchanged returned bytes, missing signer,
  unexpected status, thumbprint, subject/issuer relation, or request ID;
- Tauri bundle recompiling or changing the signed executable;
- unsigned installer input that is not exact, or installer signing that changes
  the embedded signed executable;
- final Tauri signature produced before installer SignPath promotion;
- installed payload missing, under the workspace, byte-different, unsigned,
  wrong signer/status/thumbprint, or not cleanly removable;
- stale/rerun/foreign-request evidence, partial success, or cleanup failure;
- fork/PR/rehearsal access to signing credentials; and
- publication, Pages projection, or ordinary GO before exact installed human
  acceptance.

Any request failure preserves truthful failure state and no Draft/Release. A
new candidate run may be attempted only after the cause is fixed; no artifact
from a failed run may be composed into another run.

## Work Packages And Stop Points

### SP-FT2-A — contract, implementation, and protected integration

Authorized now. Implement build modes, two signing requests, schema,
version/release notes/NEWS, negative tests, and CI enforcement. Run the full
affected validation and independent contract/security review. Merge only the
reviewed exact head; stop before candidate construction.

### SP-FT2-B — exact dev.42 Draft and independent audit

After A and encrypted binary slug configuration, build once from exact current
main. Independently download and validate both platform assets, both Windows
signing requests, installed payload evidence, macOS notarization/stapling, and
final Tauri signatures. Stop with an unpublished Draft.

### SP-FT2-C — installed candidate and native-update acceptance

On Windows, clean-install dev.42 and require the installed executable to carry
the expected Free Trial self-signed certificate rather than `NotSigned`; record
SmartScreen/publisher presentation and uninstall. On macOS, verify the exact
notarized/stapled dev.42 package. Use a bounded temporary native development
manifest to update supported installed dev.41 builds to dev.42, prove restart
and final versions, then clean to `404`.

### SP-FT2-C0 — bounded public transport prerequisite

GitHub Draft asset URLs are not anonymously downloadable, while the installed
runtime correctly sends no GitHub credential and accepts only final GitHub
Release download URLs. Therefore C cannot use the private Draft directly. The
owner's prior “publish first, audit afterward, with an explanation” instruction
authorizes one protected transport-only transition after B audit and before C:

- publish the exact already-audited dev.42 Draft as a prerelease without
  rebuilding, resigning, replacing, deleting, or adding an asset;
- retain the reviewed body that discloses Free Trial trust and pending
  acceptance, and do not upload an acceptance record yet;
- do not invoke normal Update Site or create a permanent native endpoint;
- accept that ordinary Update Site remains fail-closed on the missing exact
  acceptance asset throughout this short transport state; and
- use only the bounded temporary development manifest for dev.41→dev.42, then
  clean it to verified `404` before the final decision.

This requires a separate environment-protected source workflow and negative
tests before the transport transition. It is an explicit post-B stop point and
is not silently included in this A implementation slice. After C passes, the
exact acceptance asset and a protected already-public finalizer may admit the
same immutable prerelease to normal Update Site. A failed C leaves the public
prerelease truthfully marked as pending/rejected and the permanent endpoint
absent; it never authorizes asset replacement.

### SP-FT2-D — decision, publication, and permanent development endpoint

Only after exact C evidence and explicit owner decision, create/upload one
acceptance asset, validate the immutable already-public transport prerelease
without rebuilding/replacing assets, invoke normal Update Site once, and
independently verify public downloads, disclosure, hashes, native development
manifest, final signatures, and a fresh installed update. Stable native
endpoint remains absent.

## Version, NEWS, And Definition Of Done

Application version advances to `0.4.0-dev.42` because a fresh candidate with
different signed binary/installer bytes and public evidence is mandatory.
Synchronize Cargo/Tauri/frontend mock/cache-busting/release metadata, add
reviewed release notes and NEWS. R package versions remain unchanged.

The work package remains active until the permanent development endpoint and
fresh installed update are verified. Passing source tests or creating a Draft
alone is not completion.
