# Rho build and artifact trust

The current production artifact is the `rho` CLI/local-workbench binary.
The manual build workflow compiles and uploads that binary. It does not perform
code signing, Apple notarization, installer construction, updater signing or
automatic publication. See [Build and release](docs/RELEASE.md).

The former Tauri/NSIS/AppImage candidate and updater workflows are retired.
Their signatures and test certificates apply only to those old artifacts;
they do not establish trust in a new build. Do not distribute an old installer
as though it contained the current Host.

For an explicitly requested distribution, verify the exact source commit,
artifact bytes, hashes and any signatures actually present. Build, signing,
installation and publication remain separate actions. A workflow definition or
an earlier successful build is not evidence that the current artifact is signed.

Third-party runtimes and libraries retain their own licenses and publisher
identities. Preserve the notices required for any payload actually distributed;
see [third-party notices](LICENSES.md). Historical signing documentation credited
[SignPath.io](https://about.signpath.io) and [SignPath Foundation](https://signpath.org);
that attribution is not a claim about the current build pipeline.

Report suspected artifact or signing-material compromise through the
[security reporting process](SECURITY.md). No signing secret belongs in project
files, logs or public reports.
