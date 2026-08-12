# Rho Code Signing Policy

Last updated: 2026-08-12

Rho's current Windows signing path uses a self-signed test certificate,
`Rho Test Signing`, managed through [SignPath.io](https://about.signpath.io).
It is not a SignPath Foundation certificate and is not a publicly trusted
Windows publisher identity.

Rho publishes its source at <https://github.com/YuLab-SMU/Rho> under
`AGPL-3.0-only`. This policy defines the narrow trial signing scope, the
verification required before release assets are created, and incident handling.
It never treats a present self-signed signature as Windows or SmartScreen trust.

## Current platform status

- Apple Silicon macOS candidate packages use Apple's Developer ID Application
  signing and notarization path. That Apple trust chain is independent of
  SignPath.
- Historical Windows packages are unsigned. A future Windows installer signed
  by the configured trial workflow carries a self-signed certificate and may
  still show a Windows/SmartScreen warning. Exact release evidence, not this
  policy, establishes the status of any specific artifact.
- A self-signed Authenticode signature can bind the returned installer to the
  configured certificate, but Windows does not trust that certificate by
  default. It is not a verified publisher claim and does not establish
  Microsoft SmartScreen reputation.

## Signing scope

Only the final Rho NSIS installer (`Rho_*_x64-setup.exe`) is in scope for the
current trial profile. The installer contains an unsigned `rho-desktop.exe`;
this is deliberately a single-stage installer signature, not a claim that the
installed application executable is separately signed.

Rho does not use its SignPath certificate to re-sign third-party upstream
binaries. This exclusion includes Ark, Jet, WebView2Loader, operating-system
components, R, R packages, and other dependency payloads. Those components
retain their upstream licenses, publishers, signatures, and notices.

## Trial build and signer controls

Only upstream `YuLab-SMU/Rho` candidate and manual-release workflow runs may
request the trial signature. The secret interface is the protected GitHub
Actions repository secret `SIGNPATH_API_TOKEN`; its value is never stored in
the repository, evidence, artifacts, or logs. The certificate private key
remains in SignPath's protected signing infrastructure and is not exported to
a runner or repository.

Candidate and manual paths bind the exact source commit, workflow run/attempt,
unsigned GitHub Actions artifact, configured project/policy/artifact
configuration, returned installer, signer subject/thumbprint/status, and final
SHA-256. Pull request, fork, and rehearsal paths receive no SignPath token and
fail closed; they cannot use the signing action. Missing configuration, an action failure,
zero/multiple returned installers, a mismatched installer name, a missing
signer certificate, or `NotSigned` fails before candidate evidence, a draft,
or a Release is created.

The current SignPath trial policy has no trusted-build/origin verification and
does not require separate manual approval. It is a constrained test policy;
it must not be described as the role-separated Foundation approval process.
Sensitive workflow, policy, and ownership files remain assigned through
`.github/CODEOWNERS` and subject to the default-branch review rules.

## Trial signing and verification procedure

1. Build and smoke-test the exact Windows source, then require exactly one
   versioned NSIS installer.
2. Upload only that installer as a run-scoped Actions artifact and submit it to
   SignPath with the explicit trial project, policy, and ZIP artifact-
   configuration identifiers.
3. Wait for SignPath, require exactly one returned installer with the same
   expected basename, and stage only that returned file.
4. Run `Get-AuthenticodeSignature` over the staged bytes. A missing signer or
   `NotSigned` result fails closed. The returned status is recorded, but this
   self-signed profile intentionally does **not** require a trusted `Valid`
   chain or a timestamp claim it cannot prove.
5. Generate the checksum and evidence from the staged returned bytes only; the
   release asset, if separately approved, is that same file.

Signing changes bytes, so an unsigned pre-submission hash cannot serve as the
released artifact hash. The retained manual workflow enforces the same
post-signing stage before it creates a GitHub Release.

## Release and incident response

A self-signed installer is still only a candidate. Public publication requires
the repository's exact-candidate checks, clean-install and core-workflow
acceptance, uninstall acceptance, macOS trust evidence, and explicit release
GO for the same immutable bytes. It does not become publicly trusted merely
because it contains `Rho Test Signing`.

If a token, certificate, policy, artifact, or returned signature may be
compromised or incorrect, maintainers must stop new signing and publication,
preserve bounded non-secret evidence, remove affected releases and update
entries, rotate/revoke credentials or certificates with SignPath as
appropriate, and publish corrected incident information. Existing release
assets are never silently overwritten or relabelled.

Report signing or supply-chain vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/YuLab-SMU/Rho/security/advisories/new),
without including secrets in a public Issue.

References:

- [SignPath GitHub Actions integration](https://docs.signpath.io/trusted-build-systems/github)
- [Rho license and third-party notices](LICENSES.md)
- [Rho privacy policy](PRIVACY.md)
