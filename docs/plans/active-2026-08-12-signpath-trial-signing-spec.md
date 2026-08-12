# SignPath Trial Windows Signing Contract

Status: active; STS1 implementation package authorized, source implementation
and deterministic verification pending; hosted signing, exact-candidate, and
installed acceptance remain open

Date: 2026-08-12 EDT
Authorization: on 2026-08-12, after reviewing the SignPath trial organization,
project, certificate, policy, artifact configuration, and GitHub Actions secret
setup, the project owner explicitly selected the current setup ("改成现在我们
的这个") for the Windows signing path. This authorizes STS1 only: the bounded
repository policy/workflow implementation below, validation, review, a scoped
branch and pull request. It does not authorize a candidate, a GitHub Release,
an update-site mutation, or a claim of public Windows or SmartScreen trust.

Amends: `active-2026-08-11-signpath-application-readiness-spec.md` for the
trial-signing path only

Change class: D4 release installer/signing/publication workflow

Risk: R4 release/publication; R3 credential and signing-policy handling

Work package: STS1

## Purpose And Scope

Rho now has real SignPath trial identifiers rather than placeholders. STS1
uses them to sign the final NSIS installer returned by SignPath. It replaces
the future Foundation/two-stage assumption in the earlier readiness contract
for this trial path; it does not rewrite that contract's completed
privacy/update/readiness evidence.

STS1 deliberately does **not** create a public-trust claim. The current
certificate is a self-signed code-signing certificate named `Rho Test Signing`.
Windows and Microsoft SmartScreen will not trust it by default. A signature
proves only that the returned installer carries the configured certificate;
it does not make the signer a verified publisher or remove SmartScreen
warnings.

## Authoritative External Configuration

The workflow may contain these non-secret trial identifiers exactly:

| Item | Value |
| --- | --- |
| SignPath organization | `0b1b9db7-5b44-46d3-abff-faaae8ad587e` |
| Project slug | `rho` |
| Signing policy slug | `test-signing` |
| Artifact configuration slug | `github-actions-nsis-installer` |
| Certificate | `Rho Test Signing` (`74C895CBF9759AE1041A61F54F3B3BC6B0446511`) |

The only secret interface is the protected upstream repository Actions secret
`SIGNPATH_API_TOKEN`. Its value must never appear in source, logs, artifacts,
evidence, issues, or documentation. The private key remains in SignPath and
is never exported to a runner or repository.

The SignPath trial configuration uses a ZIP-rooted artifact configuration. An
Actions upload artifact wraps the NSIS executable in that ZIP, and its root
configuration matches exactly one `Rho_*_x64-setup.exe` file. STS1 must pass
that artifact-configuration slug explicitly; it must not rely on a project
default.

## Behavior Contract

### Candidate workflow

Only an upstream `YuLab-SMU/Rho` candidate run may receive the SignPath token.
After the Windows build and Workspace smoke test it must:

1. require exactly the versioned NSIS installer in the build output;
2. upload that unsigned file as a run-scoped GitHub Actions artifact;
3. submit that artifact ID through
   `signpath/github-action-submit-signing-request@v2`, with the four
   authoritative identifiers and `actions: read`/`contents: read` token
   permissions;
4. wait for completion and stage exactly one returned installer whose basename
   is the expected versioned name;
5. reject a missing signer certificate or `NotSigned` result from
   `Get-AuthenticodeSignature`, while recording the returned signature status
   rather than requiring a trusted/`Valid` chain; and
6. compute candidate evidence and hashes only from the staged returned bytes.

Rehearsal/fork paths do not receive the SignPath secret or action. They retain
their ordinary unsigned review artifact and cannot be represented as signed.
Missing input, zero/multiple returned installers, a mismatched basename, a
missing certificate, `NotSigned`, or a SignPath timeout/error fails the job
before candidate evidence or draft assembly.

### Manual Windows release workflow

The retained manual workflow is an upstream-only, exact-default-branch-head
lane. It runs all source/build/smoke checks before signing, uploads only the
single unsigned NSIS installer for SignPath, stages exactly one signed result,
then reruns release evidence against the staged file with signature presence
required. The GitHub Release and its checksum/evidence assets use only the
post-signing output. It cannot publish an unsigned installer or substitute an
artifact from another workflow run.

STS1 signs only the outer NSIS installer. The embedded `rho-desktop.exe` is
not separately signed in this trial profile. That deliberate single-stage
scope must remain explicit in policy and release evidence; it is not the
Foundation-oriented two-stage profile proposed previously.

## Policy, Trust, And Recovery

- The current SignPath trial policy does not use trusted-build/origin
  verification and does not require a separate manual approval. This is a
  constrained test policy, not an assertion that a formal approval model is
  active.
- Windows signature presence and Windows trust are different facts. Verification
  accepts a signer certificate and rejects `NotSigned`, but must not label an
  untrusted self-signed certificate `Valid`, publicly trusted, or SmartScreen
  approved.
- Existing historical Windows assets remain unsigned unless their own
  immutable evidence says otherwise. Public documentation must direct readers
  to exact release evidence and distinguish historical unsigned artifacts from
  a future self-signed trial artifact.
- Compromise, incorrect policy/configuration, unexpected signer, or a failed
  signing request stops publication, preserves bounded non-secret evidence,
  revokes/rotates credentials or certificates with SignPath as appropriate,
  and removes affected releases/update entries rather than replacing bytes.

## Cross-Review And Non-Goals

The parent SP-READY1 contract retains manual-only update admission, privacy,
security reporting, public policy links, and CODEOWNERS. This contract owns
only trial signing configuration, exact returned bytes, signer-presence
verification, and truthful public wording. The active `dev.33` checklist
retains exact candidate identity, Draft assembly, installed acceptance, MAC5,
publication, and update-site mutation.

No application/R-package version, database schema, project data, credential
format, application network authority, or desktop UI behavior changes. The
SignPath token is a GitHub Actions credential only. STS1 does not install a
GitHub App, seek Foundation status, alter the certificate, make an untrusted
certificate trusted, publish a release, or run a candidate.

## Verification And Acceptance

Automated evidence must include:

1. a deterministic workflow contract test proving the candidate and manual
   paths use the exact identifiers/action, explicit artifact configuration,
   scoped secret, expected-file cardinality, and signer-presence rejection;
2. a negative test that removes each signing input, makes the returned file
   ambiguous, uses a wrong basename, or accepts `NotSigned`/missing signer;
3. the existing SignPath/public-policy contract updated to reject an accidental
   Foundation/public-trust/two-stage claim and to require the self-signed scope
   and SmartScreen warning;
4. JavaScript syntax, affected deterministic contracts, YAML parsing, and
   `git diff --check`; and
5. a post-test review that confirms the final release upload consumes only the
   post-signing installer and final SHA-256.

Hosted acceptance remains separate: one upstream candidate run must produce a
SignPath-returned installer, record its signer subject/thumbprint/status and
final hash, and pass the existing Draft/installed/manual release gates. The
release decision remains `NO-GO` until that exact-candidate evidence and the
separate human GO decision exist.

## Version And Documentation Decision

`0.4.0-dev.33` has no candidate artifact, tag, or Release. STS1 changes only
the future release workflow and its public policy, so the synchronized active
development identity remains `0.4.0-dev.33`; no application or R-package
version increment is made in this source package. `NEWS.md` is unchanged
because no shipped user-visible application behavior has changed. The active
release checklist and policy documents record this decision.

## Definition Of Done For STS1 Source Package

- the amended and new contracts have no ownership conflict;
- workflows use only the configured trial identifiers and the protected secret
  interface, with no token value in the repository;
- candidate/release final evidence and release assets derive only from the
  returned signed installer;
- policy/README/generated download wording distinguishes a self-signed
  signature from public Windows/SmartScreen trust;
- focused automated checks and review pass; and
- a scoped branch/PR is prepared. Hosted signing, candidate, installed
  acceptance, publication, and update-site deployment remain reported as open
  facts.
