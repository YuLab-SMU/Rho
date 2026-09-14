# Build and release

The first user-facing preview targets the user's current environment only:
**Apple Silicon (arm64), macOS 26.5.2 (25F84)**. This is the local validation
baseline, not a claim of compatibility with older macOS versions. Installation,
launch, existing R/Ark discovery, recovery-component preparation and Rho model
configuration should be completed for that one environment before expanding the
release scope. Linux, Windows and Intel Mac distribution are outside this preview.
Existing platform-specific source and development helpers do not create a current
distribution commitment.

The current artifact is the `rho` CLI/local-browser workbench binary:

```sh
cargo build --release --locked
```

The output is `target/release/rho` for macOS arm64, including embedded
HTML, CSS and JavaScript. R and Ark are external runtimes; the binary does not
bundle their installations. Build frontend changes first using
[Development](DEVELOPMENT.md).

`.github/workflows/rho.yml` defines native source/transport checks.
`.github/workflows/build-rho.yml` is a manually triggered macOS arm64 binary build
that uploads an artifact. Its macOS 26 runner must verify the native architecture;
it does not establish that the runner has the same patch version as the local
baseline. Neither a workflow definition nor an older successful run proves that
the current commit passed remote CI.

The current path does not produce a signed/notarized installer or automatic updater.
For a requested distribution, report the exact source commit, artifact paths, sizes,
hashes, signatures actually present and checks that ran. Build, signing, installation
and publication are separate outcomes. Do not install or publish automatically.

See [current validation scope](STATUS.md), [artifact trust](../CODE_SIGNING_POLICY.md),
[license](../LICENSE), [third-party notices](../LICENSES.md) and
[security reporting](../SECURITY.md).
