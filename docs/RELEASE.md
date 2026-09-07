# Build and release

The current artifact is the `rho` CLI/local-browser workbench binary:

```sh
cargo build --release --locked
```

The output is `target/release/rho` (`rho.exe` on Windows), including embedded
HTML, CSS and JavaScript. R and Ark are external runtimes; the binary does not
bundle their installations. Build frontend changes first using
[Development](DEVELOPMENT.md).

`.github/workflows/rho.yml` defines native source/transport checks.
`.github/workflows/build-rho.yml` is a manually triggered binary build that uploads
artifacts. Neither a workflow definition nor an older successful run proves that
the current commit passed remote CI.

The current path does not produce a signed/notarized installer or automatic updater.
For a requested distribution, report the exact source commit, artifact paths, sizes,
hashes, signatures actually present and checks that ran. Build, signing, installation
and publication are separate outcomes. Do not install or publish automatically.

See [current validation scope](STATUS.md), [artifact trust](../CODE_SIGNING_POLICY.md),
[license](../LICENSE), [third-party notices](../LICENSES.md) and
[security reporting](../SECURITY.md).
