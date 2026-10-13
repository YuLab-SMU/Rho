# Artifact trust

Rho has no application build entry, installer or official signed distribution yet.
The [official distribution design](docs/RELEASE.md#official-distribution) is a
future delivery boundary. Source publication does not establish binary delivery,
signing or installation.

For a selected artifact, verify its source composition, origin, exact bytes,
digest, signing identity and the signatures actually present. Record acceptance
for that exact composition and platform, including failed or unverified scope.
A branch name, build receipt or publication acknowledgement is insufficient
signing evidence. A signature does not prove application or scientific correctness.

Build and test without signing keys or publication credentials. A separate release
stage verifies the immutable accepted candidate, then signs, notarizes and packages
it without rebuilding the application or running source build scripts with signing
credentials. Record unsigned candidate and final signed/package digests separately.
Installation and update channels consume only verified published assets.

Preserve required origin and license notices for the payload actually distributed.
No signing secret belongs in source, public logs or diagnostics. Report suspected
artifact compromise through [Security](SECURITY.md).
