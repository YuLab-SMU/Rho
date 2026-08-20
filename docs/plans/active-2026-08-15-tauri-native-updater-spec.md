# Tauri Native Updater Enablement Specification

Date: 2026-08-15

Status: active; `UPDATER-1A` source/signing/publication-contract work is
integrated in protected `main`; `UPDATER-1B` built immutable signed
`0.4.0-dev.40` Draft `v0.4.0-dev.40` from
`14b16ced90df02621e37913e23c6a555cf5963f0` and passed independent asset and
signature audit. `UPDATER-1C-T1`, the bounded `dev.41` acceptance transport,
integrated through PR #80 at `9ec8117bedea33d18e2ed367ec56bd9138cc40ef`;
candidate run `31986077326` constructed its signed eleven-asset Draft.
Independent audit stopped before marker creation or publication because the
workflow copied GitHub's internal Draft `untagged-*` URL instead of deriving
the stable tag URL required by the release-record validator. The bounded repair
merged through PR #81, and protected run `31989055536` published the exact
twelve-asset acceptance-only target after repeating the audit. Window run
`31989333325` stopped before Pages mutation because the fixture parser did not
accept the real four-line minisign text's terminal LF. Pre-redispatch real-byte
testing also found that the workflow used `windows-x86-64.sig` while the fixed
platform key generates `windows-x86_64.sig`. PR #82 integrated the bounded
framing/path repair. Signature-rejection window `31990624696` then passed on
Windows x86-64 and macOS arm64 without shutdown or mutation and cleaned the
fixture back to verified `404`. Valid window `31991536953` passed both
post-shutdown failure/recovery rows and both explicit install/restart rows;
About reported `0.4.0-dev.41` on both platforms, and cleanup again restored
both native endpoints to `404`.

That completes the bounded dual-platform dev.40→dev.41 behavior matrix, but
installed Windows evidence found `rho-desktop.exe` remained `NotSigned`
because only the outer NSIS installer used the Free Trial signing lane.
`UPDATER-1D` therefore remains `NO-GO` for dev.40. The active successor
`active-2026-08-17-signpath-free-trial-two-stage-dev42-spec.md` owns the fresh
dev.42 two-stage binary/installer repair and the remaining path to a permanent
development endpoint. No dev.40/dev.41 byte or historical result is relabelled.

Authorization: after Issue #27 was audited and its explicit native-updater
exclusion was confirmed, the project owner instructed the agent to continue
until “Tauri 原生 updater 启用” on 2026-08-15. That authorized the bounded
`UPDATER-1A` implementation below: a fresh `dev.40` source contract, native
updater key/configuration, supported-platform runtime/UI, signing and manifest
pipeline, verification, documentation, and protected integration. After the
immutable `dev.40` Draft proved that Draft assets are not anonymously
downloadable and the compiled endpoint has no test override, the owner further
authorized this exact `UPDATER-1C-T1` scope on 2026-08-15: “创建更高版本的
`dev.41` 测试目标，并在受控、限时的测试 manifest 下完成双平台真实更新/恢复验证
（不发布 `dev.40`、不启用正式 Pages 更新入口）。” The detailed D4/R4
transport and stop conditions are the subordinate
`release/active-0.4.0-dev.41-native-updater-acceptance-target-checklist.md`.
Neither authorization waives exact-candidate, human installed-update,
macOS/Windows trust, or explicit release-decision gates.

Issue linkage: [Issue #27](https://github.com/YuLab-SMU/Rho/issues/27) is the
Update Site candidate-publication prerequisite. It explicitly excludes Tauri
native updating. This document is the separate signed-updater contract that
Issue #27 requires before native update installation can be enabled.

Change class: D3 for application/update-signing architecture and D4 for every
candidate, manifest, and public update-channel mutation

Risk: R3 for download, signature, restart, credentials, and recovery; R4 for
candidate and public-release acceptance

## 1. Problem And Evidence

Rho currently has a manually invoked V1 discovery flow. It fetches one bounded
Rho-hosted JSON manifest, compares versions, and opens the release page. It
does not download, verify, install, or restart. The accepted About/Update V1
design deliberately forbids those actions pending a signed-updater contract.

The repository has no `tauri-plugin-updater` dependency, no updater plugin
registration or capability, no updater public key, no
`bundle.createUpdaterArtifacts`, no `TAURI_SIGNING_PRIVATE_KEY` secret, no
Tauri-schema `latest.json` / signatures, and no release evidence binding the
final installer bytes to a Tauri update signature. The checked-in candidate
pipeline additionally changes the Windows NSIS bytes through Authenticode after
Tauri bundling, and notarizes/staples a macOS DMG without producing the
notarized/stapled updater archive. A signature created before either final-byte
transition is invalid for a native updater.

The official Tauri v2 updater uses a compiled public key plus HTTPS endpoint,
checks a Tauri release manifest, verifies an artifact signature before install,
and requires `createUpdaterArtifacts` for updater bundles. It supports NSIS on
Windows and a `.tar.gz` application archive on macOS. `tauri signer sign` can
sign an already-final artifact, so the signing order can bind the final
Authenticode installer and final notarized/stapled application archive.

## 2. Product Decisions

### 2.1 Initial supported updater platforms

`UPDATER-1` enables a native updater only for the current candidate platforms:

- Windows x86-64 NSIS; and
- macOS Apple Silicon (`darwin-aarch64`) application archive.

Linux AppImage remains outside this work package. The active Linux contract
explicitly excludes automatic Linux updates in this round. The updater crate
may compile on Linux because it is a cross-platform desktop dependency, but
Rho's user-invoked updater command must reject Linux with
`UPDATE_PLATFORM_UNAVAILABLE` and must not issue an updater network request.
There is no Linux updater manifest, Linux signing secret exposure, or Linux
automatic installation in `UPDATER-1`.

`AUTO3-DEV43`, explicitly authorized on 2026-08-17, supersedes this platform
exclusion and the manual-only discovery rule for fresh dev.43 and later
candidates. Historical dev.40-dev.42 behavior and evidence remain unchanged.

### 2.2 User authority and interaction

Network activity remains manual-only. Rho contacts an updater endpoint only
after the user selects **Help > Check for Updates** or retries that dialog.
There is no startup check, background poll, silent download, throttle,
dismissed-version persistence, or channel selector.

For dev.43 and later, the successor contract performs one readiness-bound
startup check and installs a newer verified update automatically. Failure keeps
the current version and the manual dialog remains a retry surface.

When a newer release has valid bounded manifest metadata, the dialog states the
available version, publication date, bounded notes, and that choosing **Install
and Restart** downloads and cryptographically verifies a signed update before
Rho closes active runtime work, installs it, and restarts. Clicking that
expressly labelled button is the only authority to download and install. The
browser/mock surface presents the same state and a deterministic mock result;
it never pretends that a browser page installed an application.

The updater does not claim a user-facing rollback feature. Before mutation it
retains the current artifact through a controlled platform handoff; if a
download/signature error occurs, the current app continues to run. On Windows,
Rho exits only after it has successfully spawned the verified NSIS installer.
On macOS, Rho stages and code-signature-checks the verified app archive on the
target volume, moves the current app to a private same-volume backup, and
restores that backup if replacement or launch fails. A protected or otherwise
unwritable macOS app location fails before replacement and restarts the current
app; it does not request elevated destructive replacement. Any post-download
installation failure after Rho's runtime has been cleanly stopped restarts the
existing installed build and records a truthful local diagnostic. A failed
native update is never presented as installed.

### 2.3 Channels and endpoints

The existing V1 discovery endpoints remain their schema-v1 contract:

```text
https://yulab-smu.top/Rho/updates/stable.json
https://yulab-smu.top/Rho/updates/development.json
```

Native updater manifests are distinct static resources and must never be
parsed as V1 manifests:

```text
https://yulab-smu.top/Rho/updates/tauri/stable.json
https://yulab-smu.top/Rho/updates/tauri/development.json
```

At runtime Rho selects exactly one native endpoint from the installed SemVer
channel: prerelease versions use `development`; stable versions use `stable`.
The native manifest is Tauri v2 schema with bounded `version`, `notes`,
`pub_date`, and platform maps. A stable installation never receives a
prerelease because the native publication generator selects the latest
non-prerelease accepted record for `stable`; the development endpoint selects
the latest accepted stable-or-prerelease release under existing SemVer policy.

The app configuration contains a nonempty HTTPS fallback endpoint required by
the plugin, but Rho's Rust command replaces it with the channel-specific
allowlisted endpoint before every check. The frontend receives no generic
plugin command permission and cannot select arbitrary endpoints, headers,
proxies, targets, or installer arguments.

### 2.4 Key and credential boundary

One new, project-owned Tauri signing keypair is generated with the exact Tauri
2.11.4 CLI. The public minisign key is checked into `tauri.conf.json`; no
private key, password, backup location, or key material is committed, logged,
included in an artifact, or surfaced to the WebView.

The upstream repository has exactly two new repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`; and
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Only trusted `workflow_dispatch` candidate jobs in `YuLab-SMU/Rho` may receive
them. They are absent from pull-request, source-CI, Pages, release-publication,
fork rehearsal, test artifact, and log-scanning jobs. Candidate jobs fail
closed before creating updater evidence or a Draft when either value is blank.
The password is used only through the environment expected by Tauri's signer;
neither secret is interpolated into command output.

Routine multi-key rotation is not supported by Tauri's single configured
public key. Rotation therefore requires a separately authorized security
package: while the old key is still trusted, ship one fully verified transition
release embedding the new public key and signed by the old private key. If the
old key is compromised or unavailable, native update trust is disabled and a
manually verified reinstall plus incident response is required; no manifest may
assert a replacement key by itself.

### 2.5 Final-byte signing order

Windows candidate mode follows this exact order:

1. build the NSIS installer with `createUpdaterArtifacts: true` and require
   the Tauri bundler's updater output;
2. run existing source/smoke validation and obtain the final Authenticode
   installer from the approved SignPath lane;
3. verify the returned installer is the final candidate byte stream and has
   the expected Authenticode evidence;
4. run `tauri signer sign` over that returned final NSIS file; and
5. upload only the final installer and its final `.sig` as candidate/Release
   assets, with evidence binding both exact hashes and signature-file bytes.

macOS candidate mode follows this exact order:

1. build the Developer-ID-signed arm64 app and DMG with
   `createUpdaterArtifacts: true`;
2. submit the final DMG and an archive containing the same signed app to Apple
   notarization; require independent accepted receipts;
3. extract the accepted app archive, staple and validate the app itself, then
   construct the updater `.tar.gz` containing `Rho.app` at its root;
4. verify its code signature, architecture, entitlement, notarization/staple
   evidence, archive shape, and Workspace smoke; and
5. run `tauri signer sign` over that final `.tar.gz` and publish that archive
   and `.sig` alongside the existing final stapled DMG.

No updater signature may be reused after a byte-changing Authenticode,
notarization, staple, archive, or artifact promotion step. `.sig` files are
not checksums; the native updater verifies them with the compiled public key.

## 3. Ownership, Compatibility, And Cross-Review

- This document owns the native updater runtime command/state, public key,
  Tauri artifact generation/signing, native manifest projection, signing
  evidence, release assets, exact native-update acceptance, and recovery UX.
- `design/accepted-2026-07-25-about-and-update-check-design.md` retains About,
  Help menu, manual-only network admission, release channels, V1 manifest,
  user-facing diagnostics, Rho domain, and release-page identity. It must be
  amended to state that `UPDATER-1` supersedes its V1 no-install boundary only
  for the supported native-install action.
- `plans/active-2026-08-11-signpath-application-readiness-spec.md` retains
  SignPath Foundation/production eligibility, Authenticode trust, policy,
  public disclosure, and incident response. This document consumes only its
  final Windows installer evidence and cannot turn a Free Trial signature into
  production trust.
- `plans/active-2026-08-05-macos-arm64-support-spec.md` retains platform,
  Developer ID, entitlements, notarization, and MAC5 authority. This document
  adds a final updater archive and its native-update acceptance; it does not
  redefine Apple acceptance or existing DMG evidence.
- `plans/active-2026-08-11-linux-appimage-support.md` retains Linux ownership.
  It is amended only to record that this package does not enable Linux native
  updates.
- `plans/active-2026-08-10-versioned-release-notes-spec.md` remains the sole
  source for Release body text. Native `notes` are derived from the validated,
  bounded first release-body line; this package adds no competing notes source.
- existing candidate/publish workflows and the next `dev.40` checklist retain
  immutable Draft, platform evidence, acceptance, and public-release state
  transitions. Native assets are additive and must be present in their exact
  expected sets before Draft creation or publication.
- Issue #27 remains open as its narrower Update Site contract. It must not be
  closed or relabelled as a native-updater implementation. A linked follow-up
  record will describe this independent contract and its evidence.

There is no persistence, project ownership, Workspace R protocol, Agent
authority, package version, schema migration, fallback mirror, or GitHub API
discovery change in this package.

## 4. Runtime Contract

`check_for_updates` remains the sole frontend command entry. On Windows/macOS
it calls the Rust-owned `tauri-plugin-updater` API, using a channel-selected
HTTPS endpoint and the checked-in public key. It returns one of:

```json
{
  "status": "update_available",
  "channel": "development",
  "installed_version": "0.4.0-dev.40",
  "available_version": "0.4.0-dev.41",
  "published_at": "2026-08-15T00:00:00Z",
  "summary": "Bounded release note text."
}
```

or:

```json
{
  "status": "up_to_date",
  "channel": "development",
  "installed_version": "0.4.0-dev.40"
}
```

`summary` is bounded plain text and rendered only with `textContent`. Missing
or invalid endpoint/network/manifest/signature metadata becomes a bounded
`UPDATE_*` failure; raw response content, URL credentials, key material,
headers, paths, or proxy details are never rendered.

An available result is stored only in app-memory as one pending native update
bound to the checked version, channel, updater target, download URL, and
signature. A second check replaces it. `install_native_update(expected_version)`
requires an exact SemVer version matching that pending result; absent, replaced,
concurrent, malformed, or mismatched requests fail stale and require a fresh
manual check. It cannot synthesize an update from frontend fields.

The install command downloads and verifies the pending bytes before stopping
Rho's runtime. It accepts only an exact HTTPS GitHub Release download URL and
bounded GitHub release-asset redirects, streams at most 1 GiB into memory, and
verifies the Tauri/minisign signature against the compiled public key before
stopping any runtime work. It then stops current Agent/Workspace work using the
existing shutdown path, and uses a controlled platform installer handoff.
Windows writes the verified NSIS payload to a private temporary executable,
requires a successful `/UPDATE` process spawn before exit, and never exits on a
spawn failure. macOS extracts only a bounded `Rho.app` archive to a same-volume
private staging directory, checks its Developer ID signature, swaps it only
after preserving the current app, restores the old app if replacement or launch
fails, then opens the new app and exits. Download or verification failure
retains a retryable pending update and leaves runtime work intact. Any failure
after shutdown is logged and causes the existing binary to restart; it is not
reported as an installed version.

## 5. Publication And Manifest Contract

For an accepted candidate version `X`, additive Release assets are:

- `Rho_X_x64-setup.exe.sig`, signing the final Authenticode NSIS installer;
- `Rho_X_aarch64.app.tar.gz`, a final notarized/stapled Rho.app updater archive;
- `Rho_X_aarch64.app.tar.gz.sig`, signing that final archive; and
- bounded native-updater evidence binding artifact names, size, SHA-256,
  target key, signature-file SHA-256, public-key fingerprint, source version,
  tag, commit, and required platform acceptance checks.

The generated Tauri manifest has no V1-only fields and is shaped as:

```json
{
  "version": "0.4.0-dev.40",
  "notes": "Bounded reviewed release summary.",
  "pub_date": "2026-08-15T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/YuLab-SMU/Rho/releases/download/v0.4.0-dev.40/Rho_0.4.0-dev.40_x64-setup.exe",
      "signature": "minisign signature"
    },
    "darwin-aarch64": {
      "url": "https://github.com/YuLab-SMU/Rho/releases/download/v0.4.0-dev.40/Rho_0.4.0-dev.40_aarch64.app.tar.gz",
      "signature": "minisign signature"
    }
  }
}
```

The generator reads the `.sig` release assets only after verifying their
bounded size, textual shape, exact hash/evidence binding, accepted candidate
record, channel, tag, version, and final artifact URL. Any missing, duplicate,
malformed, mismatched, draft, unaccepted, wrong-channel, unsupported-platform,
or stale asset fails the Pages job before deploy. The Pages workflow does not
have private-key access and never signs anything.

Immediately after each candidate-only `tauri signer sign` call, the trusted
candidate job streams the final artifact through an independent verifier using
only the public key compiled into `tauri.conf.json`. A syntactically valid
signature from the wrong key, or one over any earlier byte stream, fails before
the artifact can be handed to Draft assembly. This verifier has no signing
capability and receives no private key or password.

Native manifest publication remains idempotent and recovery-safe: a rerun can
regenerate the same Pages tree from immutable public Release assets, but cannot
alter a Release, re-sign an asset, or accept a Draft. A later release replaces
only the manifest projection; older Release assets remain immutable.

### 5.1 `UPDATER-1C-T1` controlled acceptance transport

The immutable `dev.40` Draft cannot itself be an anonymously downloadable
Tauri update target, while its compiled development endpoint intentionally has
no test override. The sole authorized bridge is one fresh, higher,
equivalently signed `0.4.0-dev.41` acceptance target and a temporary fixture at
the already compiled development endpoint. The target is a public, clearly
labelled acceptance-only prerelease so its GitHub Release asset URLs satisfy
the runtime allowlist; it is not a `dev.40` publication, ordinary product
release, V1 download-site entry, or normal native endpoint.

The exact target/pair, marker schema, Pages-tree mutation, bounded test window,
automatic cleanup, and manual evidence rows are owned by
`release/active-0.4.0-dev.41-native-updater-acceptance-target-checklist.md`.
That checklist must retain all of these boundaries:

- no source, artifact, Release body, asset, acceptance record, tag, or Draft
  field of `v0.4.0-dev.40` is changed;
- the `dev.41` target is constructed from a fresh protected-main commit with
  final Windows/macOS platform trust and Tauri-signature evidence, then only a
  bounded test-target marker may be added before its one public prerelease
  transition;
- the ordinary candidate-publish workflow rejects the target, and normal Pages
  generation validates then excludes its exact marker rather than treating it
  as a normal accepted release;
- a manually dispatched, environment-protected fixture job may place only a
  valid or deliberately signature-invalid Tauri manifest at
  `/updates/tauri/development.json`, leaves the V1 site byte-for-byte intact,
  and removes the fixture after at most 45 minutes; and
- cleanup is allowed without a second production mutation approval only when a
  fresh Pages checkout contains the exact fixture marker and exact generated
  manifest hash. Any unexpected production/native file, marker, identity,
  expiry, or hash fails closed and is preserved for human recovery.

The fixture does not add an unbounded endpoint override, proxy, key, secret,
background check, server component, Release rebuild, or normal publication
authority. It is acceptance infrastructure only; successful automation cannot
substitute for the two human installed-update records.

## 6. Work Packages And Stop Points

### UPDATER-1A — source, signing, and publication contract

Implement the plugin/config/public key, manual native-check/install UI,
browser mock parity, constrained runtime state/recovery, updater artifact
construction, post-final-byte signing, evidence schema, candidate/Draft/Pub
asset validation, native manifest generation, deterministic positive/negative
tests, version `0.4.0-dev.40`, NEWS, release notes, checklist, and all
cross-review amendments. Stop after independent contract review and protected
integration. No public Release or Pages manifest is changed by this work
package.

### UPDATER-1B — exact `dev.40` candidate and endpoint construction

From one clean protected-main commit only, build an immutable candidate with
both final native updater assets/signatures, complete exact signing/notary and
asset audit, create a Draft, and verify that native manifest generation would
reject every incomplete/legacy asset set. Stop with no public native endpoint
unless the separate exact acceptance gate passes.

### UPDATER-1C — installed native-update acceptance

Use only the immutable `dev.40` candidate and a separately built higher
versioned, equivalently signed test target to prove the full supported-platform
flow: manual check, notes/version, user confirmation, download, signature
rejection, successful install, clean shutdown, restart, final version, and
recovery after denied/failed install. Record exact source/artifact hashes,
target manifest, installed paths, final version, human observations, and any
platform limitation. Automated checks do not replace human acceptance.

`UPDATER-1C-T1` is the only currently authorized sub-package of this work:
implement and review the `dev.41` target/fixture transport described in
Section 5.1, stop at protected integration, construct its exact Draft, and
obtain the test-target/public-fixture evidence before asking humans to perform
the two platform records. It does not authorize a `dev.40` acceptance asset,
Draft publication, or permanent Pages native manifest.

### UPDATER-1D — public release and live native endpoint

Only after 1C's exact GO, upload acceptance evidence, publish the existing
Draft without rebuilding, invoke Pages publication once, and independently
verify the public Release asset set, Tauri manifest content/signature files,
channel policy, HTTPS endpoint, and a fresh installed-app manual check. If a
platform is unavailable or any native updater failure is unresolved, record
NO-GO or a separately authorized conditional policy; do not publish a
native-updatable release as fully accepted.

## 7. Verification Matrix

The source work package requires, at minimum:

- Rust tests for channel endpoint selection, supported-platform rejection,
  summary/date/version bounds, stale/concurrent pending update rejection,
  allowlisted and bounded final-artifact download, signature failure without
  shutdown, and post-shutdown installation failure restart recovery;
- static/runtime tests proving plugin registration, no direct WebView updater
  permissions, HTTPS-only channel endpoints, public-key shape, no key material
  in tracked files, browser/mock parity, one manual invocation path, and no
  background scheduler/persistence;
- deterministic generator tests for valid Windows/macOS native manifests and
  every absent, duplicate, wrong name, wrong hash, wrong signature, invalid
  signature text, unaccepted/draft, prerelease/stable, legacy asset, and
  unsupported-platform rejection;
- workflow contract tests for final-byte ordering, no key in Pages/publish/fork
  lanes, exact candidate asset cardinality, streaming public-key verification
  of each final updater signature, post-Authenticode Windows signing,
  post-staple macOS archive signing, and release/publish stale guards;
- `cargo fmt --all -- --check`, focused Rust tests, `cargo test --workspace
  --locked --no-fail-fast`, `node --check desktop/dist/app.js`, every affected
  `scripts/test-*.mjs`, YAML validation, the supported macOS/Windows stable and
  MSRV CI matrix, and `git diff --check`; and
- source review independent of implementation, including credentials, network,
  shutdown/restart, signature, platform, release asset, and documentation
  authority.

Candidate/acceptance work additionally requires the exact release contract,
fresh installer hashes, macOS notarization/stapling, Windows Authenticode
evidence, native signature verification, final asset/manifest audit, clean
install/manual workflow, and explicit GO/NO-GO record.

## 8. Version, Documentation, And Release Impact

This is user-visible application and public release behavior. `UPDATER-1A`
must synchronize the desktop version to `0.4.0-dev.40` in all application
authorities, add a concise `NEWS.md` entry only after implementation exists,
and add reviewed `.github/release-notes/v0.4.0-dev.40.md`. R package versions
do not change because their exported/package contracts are unaffected.

`UPDATER-1C-T1` uses a fresh `0.4.0-dev.41` desktop-only version in all
application authorities, its own reviewed release-notes file and `NEWS.md`
entry. It does not alter R package versions. The source version and test target
remain separate from the exact `dev.40` candidate/release decision.

The active cross-review record, About/Update V1 design, Linux plan, candidate
checklist, Privacy wording where needed, and this lifecycle status must be
reconciled after each fact becomes true. No later candidate, acceptance, or
release may reuse `dev.39` assets, evidence, signatures, or public manifest.

## 9. Definition Of Done

Tauri native updater is enabled only when all of the following are true for an
exact new public release:

1. the supported installed app embeds the reviewed public key and uses the
   native plugin only after an explicit user action;
2. its public HTTPS channel endpoint serves a validated Tauri manifest with
   final Windows/macOS artifact URLs and matching final signatures;
3. the released Windows NSIS and macOS updater archive have passed their
   platform trust gates before their Tauri signatures were generated;
4. the final Release assets/evidence/manifest are immutable, bounded, and
   independently audited;
5. an installed supported app has demonstrated successful check, verification,
   installation, shutdown/restart, and final-version recovery against that
   deployment, with negative/failure paths recorded; and
6. the exact candidate has an explicit release decision consistent with its
   manual acceptance record.

Until then the status is **implementation or candidate work in progress**, not
“native updater enabled.”
