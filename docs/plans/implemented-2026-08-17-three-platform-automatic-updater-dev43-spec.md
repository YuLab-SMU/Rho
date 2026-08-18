# Three-Platform Automatic Updater dev.43 Specification

Date: 2026-08-17

Status: implemented and published `AUTO3-DEV43` D4/R4 record. Protected source,
three-platform candidate construction, automated acceptance, publication, and
live development-channel verification passed on 2026-08-17.
Explicitly authorized by the
project owner: remove formal human-intervention gates, enable automatic updates
for the existing Windows x64, macOS arm64, and Linux x86-64 builds, and publish
all three on the release page.

Owner: Rho release owner

Candidate identity: `0.4.0-dev.43` / `v0.4.0-dev.43` / `Rho 0.4.0-dev.43`

Parent contracts:

- `active-2026-08-15-tauri-native-updater-spec.md`;
- `active-2026-08-17-signpath-free-trial-two-stage-dev42-spec.md`; and
- `active-2026-08-11-linux-appimage-support.md`.

## Decision And Scope

dev.42 remains an immutable unpublished two-platform Draft and is not mutated,
published, or relabelled. dev.43 is a fresh three-platform candidate because
Linux update support and startup automatic update behavior are user-visible.

Supported native targets are exactly:

- `windows-x86_64`: final two-stage Free Trial self-signed NSIS installer;
- `darwin-aarch64`: final notarized/stapled application archive; and
- `linux-x86_64`: final AppImage after the project-owned AppRun wrapper is
  installed, then signed with the existing Tauri updater key.

The application checks the selected channel automatically only after local
startup reaches a usable workbench state. If a newer signed candidate exists,
it downloads, verifies, installs transactionally, and restarts without a
second user confirmation. Discovery or installation failure leaves the current
version running and exposes a truthful retryable status. Browser/mock mode
performs no network access or installation.

## Linux Installation Contract

On Linux the running AppImage path comes only from the absolute `APPIMAGE`
environment value. It must be a regular, non-symlink executable outside the
temporary mount. The verified update must be an ELF AppImage, is staged in the
same parent directory, made executable, synchronized, and smoke-tested. The
current AppImage is renamed to a unique backup, the staged AppImage takes its
exact path, and the new image is launched. Any replacement or launch failure
restores the original bytes; success removes the backup. Missing `APPIMAGE`,
read-only parents, symlinks, wrong bytes, stale paths, and rollback failure are
hard failures.

## Candidate And Publication Contract

Candidate construction extends the existing protected workflow with one Linux
job on Ubuntu 22.04. It runs the complete affected tests, builds the AppImage,
patches AppRun before final signing, verifies executable/runtime contents,
creates Linux platform evidence, and uploads the AppImage, checksum, evidence,
and `.sig`. Aggregate and native-updater evidence require all three platforms;
historical two-platform records retain their original schema.

Publication is fully automated after exact candidate evidence passes. The
protected release transition uploads one automated acceptance record, publishes
the immutable prerelease, and deploys the normal Update Site. The development
Tauri manifest contains exactly the three targets above; the stable Tauri
manifest remains absent. Independent HTTPS validation checks the release page,
all three asset hashes/signatures, and the development manifest. No manual
installed-app observation is a release prerequisite for this work package.

## Negative And Recovery Gates

Automation rejects missing/duplicate Linux assets, stale pre-AppRun signatures,
non-executable AppImages, wrong target keys, partial three-platform evidence,
Linux update paths outside `APPIMAGE`, non-transactional replacement, startup
network activity before readiness, browser-mode installation, publication from
a non-main commit, and any attempt to reuse dev.42 assets or evidence.

## Version And Definition Of Done

Synchronize Cargo/Tauri/frontend metadata, cache keys, `NEWS.md`, reviewed
release notes, candidate defaults, documentation, and release-page copy to
dev.43. R package versions remain unchanged.

Done means protected integration; exact three-platform candidate and automated
installed/recovery evidence; published prerelease; live release page; valid
three-target `/updates/tauri/development.json`; absent stable endpoint; and a
fresh automatic-update startup verification on each supported runner class.

Result: PRs #86-#89 integrated the source and Linux CI repairs. Exact protected
main commit `f1750c4b6cc81b464fb8f49a7376a60d6ba8a9a1` passed six-leg source run
`32016789844`; candidate run `32016818404` passed Windows two-stage installed
verification, macOS notarization/staple/Gatekeeper, Linux final AppImage and
signature, and created the exact 16-asset Draft. Publish run `32018692323`
released `v0.4.0-dev.43`, and Pages run `32018756430` deployed the exact
three-target development manifests. Independent HTTPS verification passed;
the stable endpoint remained absent at that release boundary.
