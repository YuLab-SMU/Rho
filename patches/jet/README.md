# Jet core: pinned source and local patches

Rho uses Jet's core library through `rho-r-engine` in `plugins/r/backend/engine`. The snapshot in
[`vendor/jet-core`](../../vendor/jet-core/UPSTREAM.md) contains the complete core
crate's Rust sources (including their unit tests), a standalone Cargo manifest and
the original upstream license. Jet CLI, Lua/Neovim, sample kernels, release tooling
and the unrelated upstream lockfile are excluded.

[`manifest.json`](manifest.json) is the machine-readable lock: upstream repository
and full commit, archive SHA-256, upstream workspace manifest hash, selected file
hashes, ordered patch hashes and resulting file hashes. The generator compares the
standalone manifest's effective version, edition, dependency requirements and
features with the pinned upstream workspace. The original license is included in
both the input and output inventories.

## Patch series

Apply in manifest order; reverse in the opposite order. These are the existing
Rho changes relative to the pinned upstream, not new runtime behavior. Historical
Rho commit IDs in patch headers identify their original introduction.

| Patch | Purpose |
| --- | --- |
| `0001-standalone-manifest.patch` | Resolve inherited version/edition/dependencies/features locally; declare the preserved MIT license and prevent publishing this modified snapshot |
| `0002-windows-liveness.patch` | Retain the `Child::try_wait()` startup-error probe and unused-safe Unix PID bindings from the original Windows adaptation |
| `0003-kernel-environment-and-cleanup.patch` | Retain kernelspec `env_remove` for parent-environment isolation and Windows child-tree cleanup |
| `0004-shared-client-interrupt.patch` | Send an interrupt through a shared client reference, independently of the execution request's borrow |
| `0005-hidden-windows-process.patch` | Retain console-free Windows kernel startup |
| `0006-stdin-and-watchdog-isolation.patch` | Redact stdin replies in debug logs; make watchdog pipes close-on-exec and close unrelated inherited descriptors in the Unix reaper |

Patch 0001 is packaging only. The remaining patches preserve previously used and
tested code. Upstream acceptance of these local changes is not assumed.

## Check and rebuild

Run from the Rho root. Node 22+, Git and `tar` are required. Archive verification,
rebuild and preparation also run `cargo metadata --no-deps --offline` to compare
manifest semantics; serialize them with other Cargo commands.

```sh
# No network and no Cargo invocation: hashes, exact file inventory and reverse/forward replay.
node scripts/vendor-jet.mjs check

# Reconstruct independently from the pinned upstream archive, then compare.
node scripts/vendor-jet.mjs verify

# Use a previously downloaded archive; its checksum is still mandatory.
node scripts/vendor-jet.mjs verify --archive /absolute/path/to/jet.tar.gz

# Replace the generated snapshot only after all verification passes.
# Refuses local changes in vendor/jet-core; preserve them as patches first.
node scripts/vendor-jet.mjs rebuild
```

Downloads are cached under `target/jet-upstream-cache/`. A mismatched cached archive
fails explicitly; it is never silently trusted or re-pinned. Replay reads selected
regular archive members to stdout instead of extracting arbitrary archive paths.
The root `Cargo.lock` remains the production dependency lock. This one vendored
crate is not an offline bundle of every Rho dependency.

## Prepare an update or patch revision

Preparation writes review material under `target/jet-vendor-proposals/` and never
changes the committed snapshot or pin. It requires a full upstream commit, not a
moving branch or tag. Using the current commit also prepares a revised local patch
series without upgrading Jet.

```sh
node scripts/vendor-jet.mjs prepare FULL_UPSTREAM_COMMIT
```

1. Review the proposed upstream changes. If a patch fails, the script keeps the
   pristine/patched material and diagnostic in the proposal directory. Adjust the
   patch series deliberately; don't drop a patch merely to make an update apply.
2. The script checks the standalone manifest's effective version, edition,
   dependency requirements and features against the extracted upstream workspace.
   Update patch 0001 when inherited settings change. A changed upstream license
   requires separate review; it cannot be silently replaced.
3. Review the generated proposal `manifest.json`, then copy it and the proposed
   `jet-core/` tree into their repository locations. Keep source changes represented
   in patches; never record unrelated edits as an upstream snapshot.
4. Run `check`, `verify`, the script regression tests and affected Rust/native R
   checks from `docs/DEVELOPMENT.md`. Commit the pin, patches and generated snapshot
   together. CI verifies the offline reconstruction on all supported build platforms.

Use `node scripts/test-vendor-jet.mjs` for the verifier's corruption, path, replay
and non-destructive-update regression cases. It uses local fixtures, not a download.

Changes to third-party code retain upstream attribution. The source URL and
original license are in the vendored snapshot; Rho's own license does not replace
that license.
