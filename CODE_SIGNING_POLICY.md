# Rho Code Signing Policy

Last updated: 2026-08-17

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

Rho publishes its source at <https://github.com/YuLab-SMU/Rho> under
`AGPL-3.0-only`. This policy defines which Rho artifacts may be signed, who may
request and approve signing, how signed bytes are verified, and how a signing
incident is handled. It does not claim that SignPath Foundation has accepted
the project before that external approval is recorded.

## Current platform status

- Apple Silicon macOS candidate packages use Apple's Developer ID Application
  signing and notarization path. That Apple trust chain is independent of
  SignPath.
- The published `0.4.0-dev.24` Windows download and historical review packages
  are not Authenticode-signed. Their exact evidence must not be relabelled.
- The public conditional `0.4.0-dev.39` and acceptance-only `0.4.0-dev.41`
  packages use the historical outer-installer-only Free Trial lane. Installed
  dev.41 evidence found `rho-desktop.exe` remained unsigned, so neither result
  is two-stage or production-signing evidence.
- A development prerelease may carry an Authenticode signature created with a
  SignPath Free Trial self-signed test certificate only when its exact platform
  evidence records that request and final hash. This test signature is not
  publicly trusted, does not establish SignPath Foundation acceptance or a
  production publisher, and may still trigger Windows or SmartScreen warnings.
- If the SignPath Foundation application and production pipeline are approved,
  Windows will show the approved SignPath Foundation certificate identity as
  the publisher. A valid signature protects integrity and publisher identity;
  it does not guarantee immediate Microsoft SmartScreen reputation.

The exact status of a release is established by that release's evidence and
checksums, not by this policy alone.

## Native updater signature boundary

The active Tauri native-updater contract adds a separate minisign-compatible
signature over the final Windows NSIS installer and final notarized/stapled
macOS application archive. It is independent of Windows Authenticode and
Apple Developer ID/notarization: neither platform signature substitutes for
the updater signature, and an updater signature does not make a Windows
certificate publicly trusted.

The updater public key is compiled into the desktop configuration. Its private
key and password are held only in the two protected repository secrets used by
the trusted candidate signing jobs. GitHub Pages, publish-only jobs, pull
requests, forks, release assets, logs, and the WebView do not receive them.
The signer runs only after all byte-changing platform transitions: after
SignPath returns the final Windows installer, and after the macOS app archive
has been notarized/stapled and reconstructed. Candidate evidence binds the
final artifact and `.sig` hashes before a release manifest can name them.

This source policy does not claim that any already-published release has a
native updater. Such a claim requires the exact public Release assets,
evidence, manifest, and installed-update acceptance described in the active
native-updater contract.

## Free Trial test-signed prerelease boundary

The bounded `0.4.0-dev.39` candidate contract may submit only its final Rho NSIS
installer to the existing SignPath Free Trial test policy after complete build
and smoke validation. Fork rehearsal remains unsigned and cannot create a
Release. The workflow must prove the input was unsigned, use the pinned official
SignPath module, validate the protected test-certificate thumbprint and self-
signed subject/issuer, require the expected untrusted `UnknownError` status,
and hash the returned bytes before candidate evidence is created.

The request identifier, module identity, normalized public thumbprint,
self-signed flag, trust status, and before/after hashes may be published as
bounded evidence. Organization identifiers, protected JSON, API tokens, and
credentials may not be logged or published. Operational project, policy, and
artifact-configuration values are masked in CI and omitted from release
evidence even where a reviewed configuration name is documented in an active
source contract. The test certificate is never installed into a trust store
to make the result appear publicly valid.

That historical lane signs only the outer test candidate installer. It is not
two-stage evidence and creates no exception to Foundation, MFA, trusted-build,
per-request approval, or installed-payload gates. The `0.4.0-dev.39` release
contract separately permits one public conditional prerelease that truthfully
records Windows human installation and enabled-Gatekeeper macOS human launch
as not run; it does not make either check pass.

Fresh `0.4.0-dev.42` uses the same Free Trial self-signed certificate through
the common two-stage sequence below. The binary and installer are separate
requests; bundling must preserve the signed binary hash and certificate; and a
silent install must prove the installed executable is byte-identical, carries
the same `UnknownError` self-signed certificate, passes smoke testing, and is
cleanly removable. This closes the unsigned-inner-payload defect without
claiming public trust, Foundation acceptance, a production publisher, or
SmartScreen reputation.

## Signing scope

Only binaries built and owned by the Rho project are in the planned Windows
signing scope:

1. the Rho application executable, `rho-desktop.exe`; and
2. the final Rho NSIS installer wrapper that contains the already signed Rho
   executable.

Rho does not use its SignPath certificate to re-sign third-party upstream
binaries. This exclusion includes Ark, Jet, WebView2Loader, operating-system
components, R, R packages, and other dependency payloads. Those components
retain their upstream licenses, publishers, signatures, and notices.

## Trusted build and approval

Authoritative production signing requests must originate from the upstream
`YuLab-SMU/Rho` default branch on GitHub-hosted runners. A request binds the
exact source commit, workflow run and attempt, unsigned artifact identity,
SignPath policy/configuration, signed result, and final SHA-256 evidence.

Pull request, fork, and rehearsal paths fail closed and cannot use the
production signing policy. A workflow rerun, expired request, or artifact from
another run cannot substitute for the current candidate. Missing token,
organization, project, policy, or artifact-configuration data stops the
workflow before publication. Legacy/manual publication cannot bypass the same
signed-candidate gate.

Rho's intended production policy requires manual approval for every production
signing request. Its intended roles are:

- **Authors and Reviewers:**
  [YuLab-SMU organization members](https://github.com/orgs/YuLab-SMU/people);
- **Approvers:**
  [YuLab-SMU organization owners](https://github.com/orgs/YuLab-SMU/people?query=role%3Aowner).

Every person granted a signing-team role must use multi-factor authentication
(MFA). Authors do not approve their own request. Signing credentials and API
tokens belong only in protected encrypted secret storage; the certificate
private key remains in SignPath's protected signing infrastructure and is not
exported to the repository or runner.

Sensitive workflow, policy, and ownership files are assigned through
`.github/CODEOWNERS` and must be enforced by the default-branch repository
rules. The repository file alone is not evidence that those rules are active.

## Two-stage Windows procedure

NSIS cannot be treated as though signing only its outer wrapper also signs the
installed program. The common development and production sequence is
therefore:

1. build `rho-desktop.exe` without bundling an installer;
2. submit that exact executable to SignPath, obtain manual approval, download
   the signed result, and verify it;
3. create the NSIS installer from that verified signed executable;
4. submit the exact installer to SignPath, obtain manual approval, download the
   signed result, and verify it; and
5. install to an isolated location and verify that the installed
   `rho-desktop.exe` is the expected signed payload before computing and
   publishing final artifact hashes.

Verification is fail-closed and includes the configured publisher and trust
profile, installed payload signature, artifact names and sizes, and SHA-256
values over the final signed bytes. Signing changes bytes, so a pre-signing
hash can never serve as the released artifact hash. The Free Trial profile
requires the exact configured self-signed certificate and `UnknownError`; it
must never be presented as Authenticode `Valid`. A future production profile
additionally requires the approved SignPath Foundation publisher identity,
publicly valid Authenticode status, and an RFC 3161 timestamp.

The development two-stage workflow uses only the reviewed existing Free Trial
organization, project, policy, certificate, and separate binary/installer
configurations. Production remains gated on its own approved identifiers,
trusted-build and approval controls, certificate, timestamp, and public trust.
Placeholder or guessed identifiers are never accepted configuration.

## Release and incident response

A signed artifact is still only a candidate. Public publication requires the
repository's exact-candidate checks, clean-install and core-workflow acceptance,
installed-payload verification, uninstall acceptance, macOS trust evidence,
and explicit release GO for the same immutable bytes.

If a key, token, policy, trusted build, approval, artifact, or published
signature may be compromised or incorrect, maintainers must stop new signing
and publication, preserve bounded audit evidence, remove affected releases and
update entries, rotate/revoke credentials or certificates when appropriate,
contact SignPath support, and publish corrected incident information. Existing
release assets are never silently overwritten or relabelled.

Report signing or supply-chain vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new),
without including secrets in a public Issue.

References:

- [SignPath Foundation Terms](https://signpath.org/terms.html)
- [SignPath trusted build systems for GitHub](https://docs.signpath.io/trusted-build-systems/github)
- [Rho license and third-party notices](LICENSES.md)
- [Rho privacy policy](PRIVACY.md)
