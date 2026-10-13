# Rho artifact trust

The selected new application has no build entry, installer or signed artifact.
Removing the former implementation does not revoke or replace historical artifacts;
their original source and trust evidence remain in Git and the published archives.
A branch, build receipt or publisher acknowledgement does not prove signing.

For a selected distribution, verify the exact source composition, artifact bytes,
digests and signatures actually present. Source publication, building, signing,
installation and official publication are separate outcomes. Preserve origin and
license notices for the payload actually distributed.

The agreed future signing boundary is in
[Release](docs/RELEASE.md#future-official-release-boundary): build and test without
signing/publication credentials, verify the immutable accepted candidate, and
sign/package in a separate authorized stage without rebuilding it. Record both
unsigned and signed artifact identities. That pipeline remains unimplemented.

Report suspected artifact compromise through [Security](SECURITY.md).
No signing secret belongs in source, public logs or diagnostics.
