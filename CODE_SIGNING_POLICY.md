# Rho code signing

Artifact trust is established by the bytes, signatures, hashes, and evidence
for that exact build. This page explains the current implementation; it does
not upgrade the trust status of any release.

Free code signing is provided by [SignPath.io](https://about.signpath.io), with
certificates supplied through [SignPath Foundation](https://signpath.org).
macOS uses the independent Apple Developer ID and notarization path.

## Windows

The candidate workflow signs only Rho-owned artifacts:

1. build and test `rho-desktop.exe`;
2. sign that exact executable;
3. build NSIS without rebuilding or changing the signed executable;
4. sign the exact installer; and
5. install to an isolated location and verify the installed executable before
   recording final hashes.

Ark, Jet, WebView2Loader, R, and other third-party payloads retain their
upstream publishers and signatures.

The configured development lane uses a SignPath Free Trial self-signed test
certificate. It is not publicly trusted and may still trigger Windows or
SmartScreen warnings. A release may claim a production publisher only when its
own signature and evidence show that identity.

## Native updater

Tauri updater signatures cover the final Windows installer, final macOS app
archive, and Linux AppImage. They are separate from Authenticode and Apple
notarization. The public key is compiled into the app; signing secrets are
available only to protected candidate jobs and never to forks, pull requests,
release assets, logs, Pages, or the WebView.

## Operational boundary

Signing requests bind the source commit, workflow run, input artifact, returned
artifact, and final SHA-256. A rehearsal cannot publish or use protected
signing credentials. Publication consumes the already reviewed candidate; it
does not rebuild or silently replace assets.

If signing material or a published signature may be compromised, stop signing
and publication, preserve bounded evidence, rotate or revoke the affected
credentials, and correct the public release record. Report vulnerabilities
through [GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new).

See [privacy](PRIVACY.md), [security](SECURITY.md), and
[third-party notices](LICENSES.md).
