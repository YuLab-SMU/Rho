# SignPath Free Trial Windows Smoke Contract

Status: active; FT-SIGN1 source implementation, repository-variable setup,
deterministic validation, protected integration, and separate security review
complete; the first hosted request exposed an authorization/variable-log
defect, its run was deleted, the token was rotated, and the privacy correction
plus one successful hosted request remain open

Date: 2026-08-12 EDT

Authorization: after the existing SignPath organization, project, test
certificate, signing policy, artifact configuration, API token, and repository
secret were verified, the project owner instructed `继续，使用Free trial
subscription`. This authorizes FT-SIGN1: one isolated manual workflow, its
contract tests and documentation, protected integration, and one test signing
request against the existing Free Trial configuration. It does not authorize a
candidate, tag, GitHub Release, update-site mutation, Foundation/public-trust
claim, or modification of the existing SignPath account configuration.

Owning issue: GitHub Issue #26

Amends: `active-2026-08-11-signpath-application-readiness-spec.md` only for the
bounded Free Trial smoke lane

Change class: D4 release-supply-chain integration

Risk: R4 overall; R3 credential, remote-signing, and returned-byte handling

Work package: FT-SIGN1

## Current External Evidence

The SignPath organization uses a Free Trial subscription. Project `rho`, test
policy `test-signing`, artifact configuration
`github-actions-nsis-installer`, and the `Rho Test Signing` certificate are
valid. A submitter API token exists and the upstream repository exposes it only
through the protected `SIGNPATH_API_TOKEN` Actions secret. The certificate is a
SignPath self-signed X.509 test certificate and is not publicly trusted by
Windows or Microsoft SmartScreen.

The organization identifier, configured slugs, and expected certificate
thumbprint are external deployment configuration. Repository source references
only these Actions variables:

- `SIGNPATH_ORGANIZATION_ID`;
- `SIGNPATH_PROJECT_SLUG`;
- `SIGNPATH_SIGNING_POLICY_SLUG`;
- `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`; and
- `SIGNPATH_CERTIFICATE_THUMBPRINT`.

All five variable names were configured on the upstream repository on
2026-08-12 after the current certificate page independently confirmed a
self-signed RSA-4096 Code Signing certificate whose subject and issuer are both
`CN=Rho Test Signing`. Only the variable names, not their configured values,
are repository evidence before the hosted request.

The organization identifier and configured slugs must not be copied into
repository source, Issues, pull-request discussion, or public evidence. The
certificate thumbprint may appear only in the bounded returned-signature
evidence because it identifies the certificate already embedded in the signed
file. The API token value must never appear in source, logs, artifacts,
documentation, or Actions variables.

All non-secret deployment-variable values must be registered with the GitHub
Actions masking command before the pinned SignPath action is invoked. This
includes the organization identifier, project/policy/configuration slugs, and
certificate thumbprint. Their repository-variable storage does not by itself
prevent an action from rendering input values in a public log.

## Scope And Immutable Input

FT-SIGN1 signs one already accepted, unsigned, internal-review installer rather
than rebuilding or altering a release lane:

| Field | Required value |
| --- | --- |
| Source workflow run | `31644429787` |
| Source artifact ID | `9160516935` |
| Source artifact name | `rho-0.4.0-dev.37-issue33-windows-installed-7ab861b01a36313150988b1e2fa8fdc2056325d9-31644429787` |
| Source commit | `7ab861b01a36313150988b1e2fa8fdc2056325d9` |
| Installer | `Rho_0.4.0-dev.37_x64-setup.exe` |
| Unsigned SHA-256 | `a8fa9ad2628590c9c12e176f22930d971fd8d2572dc606b52b55e38abb41bda6` |

That installer contains the Issue #33 internal acceptance overlay and remains
test-only. Signing it does not convert it into a candidate or distributable
release asset.

## Workflow Contract

The workflow is manual-only and has no inputs. It must:

1. run only from `YuLab-SMU/Rho` on the protected default branch and fail,
   rather than silently skip, when dispatched elsewhere;
2. grant only `actions: read` and `contents: read` to `GITHUB_TOKEN`;
3. verify the immutable source run completed successfully at the expected
   commit and that the exact source artifact is present and unexpired;
4. download only that artifact, locate exactly one expected installer, verify
   its SHA-256, and require `Get-AuthenticodeSignature` to report `NotSigned`;
5. re-upload only the verified installer as a run-scoped GitHub Actions
   artifact whose ID is passed directly to SignPath;
6. invoke the exact reviewed SignPath v2 action commit with the protected API
   token, Actions variables, explicit artifact-configuration slug, GitHub
   artifact ID, completion wait, and a separate output directory;
7. accept exactly one returned installer with the expected basename, reject
   `NotSigned`, `HashMismatch`, `NotSupported`, `Incompatible`, a missing signer,
   or a thumbprint mismatch, and record the actual signature status without
   relabeling it `Valid`;
8. require returned bytes to differ from the unsigned input, compute the final
   SHA-256, and write bounded JSON evidence with `public_release_authorized`
   fixed to `false`; and
9. upload only the returned installer and bounded evidence as a seven-day
   Actions artifact named as a Free Trial smoke result.

The workflow must not check out or execute code from the source artifact, write
repository contents, create/update a tag or Release, call candidate publication,
mutate Pages/update metadata, install the returned package, or expose the token.
The unsigned intermediary artifact uses the minimum supported retention period.

## Failure And Recovery

Missing variables or secret, an unavailable/expired source artifact, source
identity/hash/signature mismatch, zero or multiple installers, SignPath
rejection/timeout, an unexpected returned filename, signer/thumbprint failure,
or unsupported/corrupt signature status fails before the final artifact upload.
Reruns create a new signing request and new run-scoped artifacts; their evidence
must never be composed. A failed request changes no repository, Release, or
update-site state and needs no rollback beyond retaining bounded logs and
revoking/rotating the API token if compromise is suspected.

Hosted run `31651681715` passed immutable input admission and unsigned
artifact isolation, then failed at SignPath authorization before a signing
request was created. The third-party action rendered repository-variable
inputs while reporting that failure. The run and its run-scoped intermediary
artifact were deleted, the invalid token was regenerated and written directly
to the protected repository secret, and the local/browser clipboard was
cleared. The regression invariant is that every deployment-variable value is
masked in the validation step before any third-party action starts. A retry is
forbidden until that correction is integrated on the default branch.

## Cross-Review And Non-Goals

SP-READY1 retains privacy, manual update admission, public policy, Foundation
application, MFA, trusted-build/GitHub App, and production-signing ownership.
The `0.4.0-dev.37` checklist retains candidate identity, installed-candidate
acceptance, MAC5, publication, and updater authority. The Issue #33 artifact is
immutable input evidence only.

FT-SIGN1 creates no application/R-package behavior, schema, product network
lane, credential format, `.signpath/policies` source/build policy, Webhook,
trusted-build link, Foundation application, or public trust. It does not modify
the candidate or Windows manual-publish workflows. The prior PR #51 design,
which coupled Free Trial signing to those publication lanes, is superseded by
this isolated contract and must not merge.

## Verification And Acceptance

Deterministic verification must prove:

- manual-only admission, exact repository/default-branch failure, and
  read-only permissions;
- immutable run/artifact/commit/name/hash binding;
- variable-only SignPath identifiers, secret-only token, explicit artifact
  configuration, exact pinned action commit, and direct upload artifact ID;
- unsigned-input, returned-cardinality/name, forbidden signature-status,
  signer, thumbprint, and changed-byte checks;
- absence of Release/tag/update-site/candidate publication operations;
- bounded test-only output name, retention, and false publication authority;
- negative self-tests for removal or weakening of every gate above; and
- Node syntax, affected readiness contracts, workflow parsing by GitHub, and
  `git diff --check`.

Hosted acceptance is a separate fact. After protected integration, one manual
run must finish successfully and its SignPath request must be visible in the
configured project. The downloaded result must reproduce the workflow evidence
for installer name, signer subject/thumbprint/status, unsigned and signed
SHA-256, and `public_release_authorized: false`. No installation is required
because this package already passed Issue #33 installation before signing and
the smoke gate owns only transport/signature integrity.

## Implementation And Local Evidence

The source implementation adds only
`.github/workflows/signpath-free-trial-smoke.yml` and its deterministic contract
surface. It performs an admission-only metadata check, downloads but never
executes the immutable Issue #33 artifact, re-uploads only the verified unsigned
installer, invokes the exact reviewed SignPath v2 commit, validates the returned
self-signed certificate and bytes, and retains the result for seven days. The
candidate, candidate-publish, and Windows manual-publish workflows are unchanged
from upstream `main`.

Local evidence on 2026-08-12:

- all 63 `scripts/test-*.mjs` contracts passed once without rerun, including
  both the positive FT-SIGN1 contract and its negative self-test;
- both SignPath readiness modes passed, preserving the manual-update/public-
  policy contract while recognizing the bounded Free Trial amendment;
- Ruby parsed every checked-in workflow YAML file, Node syntax checks passed,
  update-site self-tests passed, and `git diff --check` passed;
- a fresh authenticated download of source artifact `9160516935` reproduced
  the one expected installer at 18,315,177 bytes and the required unsigned
  SHA-256; and
- repository settings expose the five required variable names and the existing
  `SIGNPATH_API_TOKEN` secret name without reading or logging its value.

A separate post-test supply-chain review found no checkout/execution of
downloaded source, write-scoped token permission, Release/tag/update-site call,
candidate/manual-publish modification, committed organization identifier or
certificate thumbprint, token reference outside the SignPath action, or path
that uploads the unsigned installer as the final result. The exact certificate
page independently confirmed self-signed subject/issuer equality and the
thumbprint stored in the repository variable. No blocking finding remains.

Rust/R/application suites were not rerun locally because FT-SIGN1 changes no
Rust, R, frontend, package, schema, or installer-construction source. The
affected protected PR matrix remains mandatory and runs the complete locked
workspace on macOS/Windows stable and MSRV before integration.

## Version And Release Decision

FT-SIGN1 changes only internal CI and external test-signing evidence. It changes
no distributable application behavior, so application/R-package versions and
`NEWS.md` remain unchanged. The current release decision remains `NO-GO` for
SignPath production signing, candidate construction, human installed-candidate
acceptance, MAC5, publication, and updater mutation.

## Stop Point

Stop after one successful hosted Free Trial request and evidence reconciliation.
Any use of returned bytes in a candidate or Release, any production certificate
or trusted-build integration, or any public wording change requires a separate
active D4/R4 contract and explicit authorization.
