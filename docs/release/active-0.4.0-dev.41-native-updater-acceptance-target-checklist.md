# Rho 0.4.0-dev.41 Native Updater Acceptance Target Checklist

Date: 2026-08-15

Status: accepted bounded `UPDATER-1C-T1` transport evidence. The project owner
explicitly authorized this bounded work package on 2026-08-15. The source
transport integrated through PR #80 at protected-main commit
`9ec8117bedea33d18e2ed367ec56bd9138cc40ef`. Candidate run `31986077326`
constructed the signed `v0.4.0-dev.41` Draft with eleven assets. Independent
pre-publication audit then reproduced a Draft-URL normalization defect before
marker creation: GitHub returned an `untagged-*` Draft `html_url`, while the
validated release record requires the stable URL derived from `tag_name`.
The bounded normalization repair merged through PR #81 at
`f4bcf9e1cd6e1a46b3f517d3587a7ff15983009f`. Protected run `31989055536`
repeated the two-Draft/four-signature audit, uploaded the one bound marker, and
published the exact twelve-asset dev.41 acceptance-only prerelease while normal
Pages/native endpoints remained unchanged. The first signature-rejection
window run `31989333325` then stopped before any Pages mutation because the
fixture parser rejected the real Tauri/minisign terminal newline. PR #82
integrated the bounded terminal-newline and generated-Windows-filename repair.
Signature-rejection window `31990624696` passed on both platforms and cleaned
to verified `404`. Valid window `31991536953` then passed both post-shutdown
failure/recovery rows and both explicit install/restart rows, with final About
version `0.4.0-dev.41` on Windows x86-64 and macOS arm64; cleanup again proved
both native endpoints `404`. The public target remains acceptance-only and
excluded from normal Update Site projection.

Owner: Rho release owner

Parent specification:
`docs/plans/active-2026-08-15-tauri-native-updater-spec.md`, Section 5.1 and
`UPDATER-1C`

Change class / risk: D4 / R4. This is a public prerelease and a temporary
update-channel mutation. Human installation and recovery evidence remain
mandatory.

## Authorization, Problem, And Boundaries

The immutable `v0.4.0-dev.40` Draft is correctly private: anonymous direct
GitHub Release asset URLs return `404`, and
`https://yulab-smu.top/Rho/updates/tauri/development.json` intentionally does
not exist. Its compiled runtime selects that endpoint and permits only GitHub
Release download URLs. Therefore a Draft alone cannot prove a real updater
download/install flow.

The owner authorized only this bridge: “创建更高版本的 `dev.41` 测试目标，并在
受控、限时的测试 manifest 下完成双平台真实更新/恢复验证（不发布 `dev.40`、不启用
正式 Pages 更新入口）。”

This contract owns an acceptance-only `dev.41` public target and temporary
transport. It does not own the normal Release decision, regular Download page,
V1 update manifests, stable channel, production/native Pages projection,
Issue #27, SignPath/Apple trust policy, application updater behavior, or a
`dev.40` acceptance/release transition.

The target must be labelled as an acceptance fixture in its reviewed release
body and name. It may remain a visible GitHub prerelease for audit after the
test, but it must never become a normal Update Site record or endpoint. Its
visibility is necessary only because the installed runtime correctly restricts
downloads to public GitHub Release URLs.

## Exact Identities

| Role | Required identity | Current state |
| --- | --- | --- |
| Source installed build | `0.4.0-dev.40` / `v0.4.0-dev.40`, Draft from `14b16ced90df02621e37913e23c6a555cf5963f0` | signed Draft constructed and independently audited; remains Draft |
| Test target | fresh `0.4.0-dev.41` / `v0.4.0-dev.41`, one clean protected-main commit after this contract integrates | exact twelve-asset acceptance-only prerelease published by protected run `31989055536`; normal Update Site excludes it |
| Supported updater platforms | Windows x86-64 NSIS and macOS Apple Silicon application archive | both required |
| Permanent endpoint state before/after a window | `/updates/tauri/development.json` and `/updates/tauri/stable.json` absent | verify each time |
| Normal V1 state | existing `updates/development.json` and download page unchanged; the currently absent `updates/stable.json` remains absent | verify byte preservation and exact `404` preservation |

No `dev.39` asset, conditional acceptance, public manifest, or earlier
candidate evidence can be reused. The `dev.40` source/asset hashes and target
hashes must be recorded verbatim in the eventual installed-app acceptance
record.

## Draft URL Normalization Defect Gate

GitHub's Release API returns an internal
`https://github.com/YuLab-SMU/Rho/releases/tag/untagged-*` `html_url` for an
unpublished Draft. That URL is mutable implementation detail and does not equal
the stable public identity required by `validateReleaseRecord()`. The first
independent dev.41 audit downloaded both exact eleven-asset Drafts successfully
but stopped at `Release identity is invalid for 0.4.0-dev.40` before creating
or uploading a marker.

Every target-publish and bounded-window release record must therefore derive
`html_url` only from the fixed repository and the already validated
`release.tag_name`:

```text
https://github.com/YuLab-SMU/Rho/releases/tag/<tag_name>
```

It must never copy the API's Draft `release.html_url`. This normalization is an
audit projection only: it does not edit a Release, tag, body, asset, signature,
target commit, or publication state. Regression automation must reject raw
`release.html_url` projection in both acceptance workflows and require the
canonical projection at both target-workflow record sites and the window
record site. The full independent two-Draft asset and four-signature audit must
pass after protected integration before the public-target workflow may run.

The repaired local audit used the exact downloaded eleven-asset dev.40 and
dev.41 Draft directories, bound source commit
`14b16ced90df02621e37913e23c6a555cf5963f0` to target commit
`9ec8117bedea33d18e2ed367ec56bd9138cc40ef`, verified both Windows and both
macOS Tauri signatures, and generated but did not upload marker SHA-256
`21812b18b43adb39163d61b76632fe21ee452d6d7db006defa0a393dd5738af0`.
This is pre-integration engineering evidence only; the protected workflow must
repeat the same validation after the repair lands.

Version decision: no application or R-package version bump. The repair changes
only an internal audit-record URL projection and leaves the already built
dev.41 candidate bytes and public application behavior unchanged. NEWS decision:
no entry for the same reason.

## Signature Fixture Terminal-Newline Defect Gate

The public `.sig` files are canonical outer base64. Their decoded minisign text
contains four non-empty lines followed by exactly one terminal LF. The first
signature-rejection run validated the exact source/target pair, then failed in
`mutatedNativeUpdaterSignature()` because `text.split("\n")` treated that
terminal LF as a fifth empty line. The fixture was not armed or deployed, the
cleanup job correctly had nothing to remove, and independent HTTPS checks kept
both native endpoints at `404`.

The bounded repair may accept zero or one terminal LF after the four required
minisign lines, must preserve the original terminal-LF framing, and must still
mutate only one byte in the untrusted signature payload. Empty interior lines,
CRLF drift, multiple terminal newlines, malformed/canonical-base64 failures,
or changed comment/trusted-signature lines remain rejected. Regression evidence
must cover both no-terminal-LF test fixtures and the real one-terminal-LF
shape, plus rejection of multiple terminal newlines. Before redispatch, the
real public dev.41 signatures must generate a syntactically valid fixture whose
mutated Windows and macOS signatures both fail the configured public-key
verifier for the expected reason.

The same real-byte regression exposed a second pre-deployment mismatch before
redispatch: fixture generation writes the manifest platform key verbatim as
`windows-x86_64.sig`, while the workflow referenced
`windows-x86-64.sig`. The workflow must consume the generated underscore name,
contract automation must reject the stale hyphen spelling, and the real
Windows verifier must reach signature verification and fail for the same
configured-public-key reason as macOS. A missing-file failure is not acceptable
signature-rejection evidence.

On 2026-08-16 the project owner instructed the administrator to “一次性解决所有
问题”. That authorizes this exact release-blocking repair, complete validation,
one PR, a temporary exact-user PR-only ruleset bypass after checks pass,
immediate verified ruleset restoration, and redispatch of the same bounded
signature-rejection window. It does not waive the two-platform human
observation, valid-window recovery/install rows, or the final dev.40 GO/NO-GO.

Version and NEWS decision: no application/R-package bump and no NEWS entry.
This repair changes only acceptance-fixture parsing for already signed public
bytes; candidate artifacts and product runtime behavior remain unchanged.

## Target Construction And Public-Test Marker

The ordinary candidate workflow builds `dev.41` from its exact protected-main
commit with the same trusted candidate signing lanes and final-byte ordering as
`dev.40`. Its initial Draft contains exactly these eleven files:

```text
Rho_0.4.0-dev.41_x64-setup.exe
Rho_0.4.0-dev.41_x64-setup.exe.sha256
rho-0.4.0-dev.41-windows-x86_64-evidence.json
Rho_0.4.0-dev.41_aarch64.dmg
Rho_0.4.0-dev.41_aarch64.dmg.sha256
rho-0.4.0-dev.41-macos-aarch64-evidence.json
rho-0.4.0-dev.41-candidate-evidence.json
Rho_0.4.0-dev.41_x64-setup.exe.sig
Rho_0.4.0-dev.41_aarch64.app.tar.gz
Rho_0.4.0-dev.41_aarch64.app.tar.gz.sig
rho-0.4.0-dev.41-tauri-native-updater-evidence.json
```

The only permitted Draft mutation is the protected,
workflow-generated bounded marker
`rho-0.4.0-dev.41-native-updater-acceptance-target.json`. It binds:

- the exact `dev.40` Draft identity, title/body SHA-256, and SHA-256 values of
  its candidate and native-updater evidence;
- the exact `dev.41` Draft identity, name, reviewed-body SHA-256, candidate and
  native-updater evidence asset records; and
- the fixed type `rho_native_updater_acceptance_target`, schema version `1`,
  status `prepared`, test-only purpose, prerelease requirement, and both
  supported platforms.

The target-publish workflow must first re-download and validate both candidate
records, final platform evidence, native evidence, updater signatures, body,
and exact 11-file target asset set. It then uploads the one marker, snapshots
all 12 asset identifiers/names/sizes and body hash, and changes only the target
Release from `draft: true` to `draft: false`, retaining `prerelease: true`.
It must not rebuild/re-sign/replace/delete an asset, add a candidate acceptance
asset, invoke `Publish Rho Candidate`, or dispatch Update Site.

The ordinary candidate-publish workflow must reject `dev.41`; only the
dedicated test-target workflow is allowed to make that exact marker-bearing
test prerelease public. The normal Update Site collector must validate the
marker, exact target evidence/body/asset binding, and then omit the target
entirely. A missing, duplicated, stale, malformed, wrong-version, normal-
acceptance-bearing, or unbound marker is a hard failure, never a reason to
silently omit a release.

## Temporary Native Manifest Window

Only a manually dispatched, `rho-release`-environment-protected workflow may
create the fixture. It accepts exactly these modes and no arbitrary URL,
version, target, proxy, signing key, or endpoint input:

| Mode | Manifest | Required manual observation |
| --- | --- | --- |
| `signature_rejection` | valid `dev.41` target/version/notes/URLs with a syntactically valid, one-byte-mutated Tauri signature for each supported platform | Check reports `dev.41`; install rejects before shutdown; `dev.40` continues and can retry |
| `valid` | exact `dev.41` evidence-derived URLs and final Tauri signatures | explicit Install and Restart updates to `dev.41` only after the separate failure-recovery row passes |

Before creating a window, the workflow re-downloads and pair-validates the
unchanged `dev.40` Draft and the public `dev.41` target against the target
marker. It then checks a fresh `gh-pages` tree: no normal native
stable/development manifest, no prior fixture marker, and normal V1/page
availability plus byte hashes are captured. It writes only:

```text
updates/tauri/development.json
updates/tauri/.rho-native-updater-acceptance.json
```

The manifest contains only the accepted Tauri fields. Its bounded notes make
the fixture/test-only status and deadline visible to the human tester; the
separate non-Tauri operational marker records mode, target/source identity, SHA-256 values,
baseline hashes, deployment time, and deadline. V1 files are never rewritten.

The activation job verifies the deployed manifest byte hash over HTTPS, holds
the window for a requested positive duration no greater than 45 minutes, and
uses a dependent `if: always()` cleanup job. GitHub Actions documents that
`always()` jobs run after failed/skipped dependencies and remain eligible during
cancellation; the cleanup authority is intentionally narrower than activation:
it may delete only an exact current fixture marker/manifest pair. It takes a
fresh Pages checkout, verifies the marker, manifest hash, deadline, and
unchanged V1 hashes, removes both fixture files, republishes, and proves the
native URL is `404`. A manually dispatched recovery cleanup uses the same
exact-pair checks. If cleanup cannot prove ownership, it must leave all files
in place and fail loudly; the release owner resolves it before any normal Pages
or `dev.40` release action.

Cancellation, a concurrent normal Pages deploy, changed marker/hash, a
non-404 baseline native endpoint, or expiry do not authorize overwrite or
deletion. The fixture must never be asserted gone until an independent HTTPS
`404` check succeeds.

## Required Installed-App Evidence

All manual records use a freshly installed `dev.40` source artifact from the
Draft and the public final `dev.41` target asset for the same platform. Record
the source/target SHA-256, Tauri signature-file SHA-256, GitHub asset URL,
fixture manifest SHA-256, installed path, OS/build, app version before/after,
timestamps, screenshots/log observations, and human tester identity.

| Platform | Signature rejection | Post-shutdown failed-install recovery | Valid update |
| --- | --- | --- | --- |
| Windows x86-64 | `dev.40` remains open after the intentionally wrong signature; no runtime shutdown/mutation | launch `dev.40` with `TEMP` and `TMP` set to an existing directory where the current user lacks create/write permission; after a verified valid download, temporary handoff creation fails, the existing build restarts, and the ACL/environment is restored | user explicitly chooses Install and Restart; final installed app is `dev.41` |
| macOS Apple Silicon | `dev.40` remains open after the intentionally wrong signature; no runtime shutdown/mutation | launch a copied `dev.40` app; while it is open, remove write permission from its parent directory while retaining read/execute traversal. Same-volume staging fails after shutdown, the old bundle relaunches, then permissions are restored | user explicitly chooses Install and Restart; final app bundle is `dev.41` |

The failure setup is performed only on a disposable test installation and must
be restored immediately after the observation. A test that cannot make its
failure deterministic is a `NO-GO` until the contract is amended; it may not
be replaced by a claim based on unit tests. The signature-rejection fixture
must be run before the valid target replaces the only `dev.40` installation.

## Evidence, Release Gate, And Stop Points

1. Integrate the source/version/docs/workflow/script contract and review it.
   Stop; no candidate or Pages action happens in that source pull request.
2. From the exact protected-main `dev.41` commit, construct and independently
   audit the Draft. Stop; no target is public yet.
3. Run the environment-protected target workflow, audit public target identity
   and direct HTTPS asset reachability, and prove normal Pages still excludes
   it. Stop; no native manifest exists yet.
4. Run the bounded signature-rejection window and capture both human results;
   cleanup must prove `404` before the next window.
5. Run a bounded valid window, first capture both post-shutdown failure
   recoveries, then both user-confirmed successful update/restart/final-version
   records. Cleanup must again prove `404`.
6. Only if every row is an exact human `GO`, prepare a separate `dev.40`
   acceptance asset/review under the parent spec. Do not publish `dev.40` or
   invoke normal Pages before that separate explicit decision.

Any missing row, target mismatch, signature failure outside the intended test,
unexpected app shutdown, inability to recover, leftover manifest, or platform
limitation is an explicit `NO-GO` for `UPDATER-1D`. It never converts the test
target into a normal release and never allows a conditional `dev.40` native
updater publication.

## Completed Acceptance Record

- signature rejection: run `31990624696`, Windows x86-64 and macOS arm64
  rejected the intentionally invalid signatures before shutdown, retained
  running dev.40, and repeated the same refusal on retry;
- valid recovery/install: run `31991536953`, both deterministic
  post-shutdown failure paths restored dev.40, then both explicit
  Install-and-Restart paths completed at `0.4.0-dev.41`;
- macOS final identity: About `0.4.0-dev.41`, platform `macos-aarch64`, copied
  bundle codesign valid, Gatekeeper accepted, notarized Developer ID;
- Windows final identity: About `0.4.0-dev.41`, platform Windows x86-64 on
  64-bit build `26200`; installed executable resolved at
  `C:\Users\xiayh17\AppData\Local\Rho\rho-desktop.exe`;
- cleanup: both runs completed the exact fixture cleanup and independent
  native development/stable HTTPS checks returned `404`; and
- release blocker: `Get-AuthenticodeSignature` reported the installed Windows
  executable as `NotSigned`. This does not invalidate the updater behavior
  matrix, but it makes dev.40 publication and a permanent endpoint `NO-GO`.
  Fresh dev.42 owns the two-stage signing correction.

## Cross-Review And Version Impact

- The parent updater specification owns runtime endpoints, compiled public key,
  final-byte signing, installer recovery, and exact `dev.40` GO/NO-GO.
- RELEASE-NOTES-1 remains the sole source for the `dev.41` body; this checklist
  requires the body to disclose test-only scope but does not create a second
  notes source.
- About/Update V1 remains owner of normal V1/Pages schemas and the Download
  page. The marker is an explicit exclusion rule, not a new product channel.
- Apple/macOS and SignPath contracts retain their final-byte/platform trust
  gates. This package consumes their evidence and cannot weaken it.
- The temporary Pages workflow receives no Tauri private key/password,
  SignPath/Apple credential, browser/mock authority, or arbitrary download
  target. Its cleanup operation has only exact fixture-removal authority.
- `0.4.0-dev.41` updates desktop version metadata, frontend mock identity,
  cache-busting references, Cargo lockfile local package versions, reviewed
  release notes, NEWS, tests, and active-doc source baseline. R package
  versions remain unchanged.

Definition of done for this bounded transport package is now met: protected
integration, target construction, both human behavior windows, and exact
cleanup passed. It is deliberately not the definition of done for an enabled
native updater: installed Windows signing, a fresh candidate decision,
publication, and live normal Pages verification remain owned by dev.42.
