# Jet core

This is the generated core-library snapshot used by Rho's native R adapter.
It is third-party Jet code, with the original MIT license in [LICENSE](LICENSE).

- Upstream: https://github.com/wurli/jet
- Pinned revision: `52ae131dd168fe2e104d306cc4bf5bbeae749200`
- Selected upstream tree: `crates/core/`, plus the root `LICENSE`
- Archive SHA-256: `6aba87d548a06a3905341306921c9555bbb7ddc80838b9180e4f1dff8898c663`
- Upstream workspace manifest SHA-256: `22ec691655eca7973272829df21174d3daa138cf9c1cd38a40354a28efa4631d`

The standalone Cargo manifest retains the inherited upstream version, edition,
dependency requirements and features. CLI, Lua/Neovim, release infrastructure and
other upstream components are not included. Core tests inside the Rust sources
are retained. Rho's root Cargo.lock controls production dependency resolution.

Local modifications are replayed in order from [patches/jet](../../patches/jet/README.md).
The machine-readable pin, file hashes and patch hashes live in
[manifest.json](../../patches/jet/manifest.json). Do not edit this generated snapshot
without also updating the patch series and lock metadata.

From the Rho repository root:

```sh
node scripts/vendor-jet.mjs check
node scripts/vendor-jet.mjs verify
```

The first command verifies offline hashes and reverse/forward patch replay. The
second reconstructs from the checksum-pinned upstream archive and verifies the
standalone manifest's effective dependency settings against the upstream workspace.
See the patch README for rebuilding and preparing a reviewed upstream update.
