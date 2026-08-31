# Build and release

Ordinary development produces commits, not release claims. A release starts
from an exact clean commit and uses the repository scripts and workflows as its
executable definition.

## Local builds

```bash
npm --prefix desktop run rsr:build
cargo build -p rho-desktop
```

Platform bootstraps and packaging live in `scripts/bootstrap-*` and
`scripts/build-*`. On Windows, `scripts/build-windows-installer.ps1` selects
the supported GNU/Rtools toolchain and builds the NSIS bundle. On macOS,
notarization helpers live in `scripts/macos-notary.mjs`; Linux packaging uses
the AppImage and bundle scripts beside it.

## Candidate operations

`scripts/candidate-release.mjs`, the candidate workflows under
`.github/workflows/`, and update-site tooling own candidate construction and
machine evidence. Generated evidence belongs under `target/` or on the release
it describes. It is not copied into `docs/`.

Version metadata must agree for the artifact being built. Signing, notarizing,
installing, publishing, and updating are separate observable operations; report
their actual result and artifact hash. A green source test does not imply an
installed or published release.

Provider and runner installation is also explicit. Signed metadata binds
package ID, semver, channel, source origin, size, SHA-256, protocol, capability
tier, and acknowledged permissions. Bytes stage into a version directory and
an atomic active pointer changes only after verification. Rollback, mirror,
truncation, and partial activation fail closed; the prior active version remains
bootable. A staged runner cannot activate while jobs are running or its protocol
is incompatible. Runtime job protocols contain no self-update command.

Current legal and trust information lives at the repository root:
[license](../LICENSE), [third-party notices](../LICENSES.md),
[privacy](../PRIVACY.md), [security](../SECURITY.md), and
[code signing](../CODE_SIGNING_POLICY.md).
