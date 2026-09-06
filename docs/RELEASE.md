# Build and release

The current production build is the new CLI/local-browser workbench:

```sh
cargo build --release --locked
```

The artifact is `target/release/rho` (`rho.exe` on Windows). It embeds the client
HTML, CSS and JavaScript. Ark and R remain explicitly configured external
runtimes; an embedded UI does not imply those runtimes are bundled.

`.github/workflows/rho.yml` runs the new native source/transport checks.
`.github/workflows/build-rho.yml` is an explicit manual binary build. It uploads
build artifacts only; it does not sign, install, create a Release, update a site
or publish a package. A workflow definition is not evidence that remote CI passed.

The old Tauri candidate, NSIS/AppImage, updater and publication workflows have
been removed, along with their old packaging scripts. Installer
or signing work needs an explicit task and real platform verification; do not
reuse old package metadata or claim an old installer contains the new Host.

When handing off an explicitly requested distribution, report the exact commit,
artifact paths, sizes, hashes and checks that actually ran. Build, signing,
installation and publication are separate outcomes. Do not install or publish
automatically.

Legal and trust information remains in [LICENSE](../LICENSE),
[LICENSES.md](../LICENSES.md), [SECURITY.md](../SECURITY.md) and
[CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md).
