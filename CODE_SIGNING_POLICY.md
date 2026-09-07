# Rho build and artifact trust

The current production artifact is the `rho` CLI/local-workbench binary.
The manual build workflow compiles and uploads that binary. It does not perform
code signing, Apple notarization, installer construction, updater signing or
automatic publication. See [Build and release](docs/RELEASE.md).

For an explicitly requested distribution, verify the exact source commit,
artifact bytes, hashes and any signatures actually present. Build, signing,
installation and publication remain separate actions. A workflow definition or
an earlier successful build is not evidence that the current artifact is signed.

Third-party runtimes and libraries retain their own licenses and publisher
identities. Preserve the notices required for any payload actually distributed;
see [third-party notices](LICENSES.md). Project acknowledgements include [SignPath.io](https://about.signpath.io) and
[SignPath Foundation](https://signpath.org); these acknowledgements do not establish
that a particular artifact is signed.

Report suspected artifact or signing-material compromise through the
[security reporting process](SECURITY.md). No signing secret belongs in project
files, logs or public reports.
