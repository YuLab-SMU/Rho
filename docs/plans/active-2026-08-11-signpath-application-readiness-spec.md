# SignPath Application Readiness Contract

Status: active; SP-READY1 repository-readiness package, exact-head and merged-
main hosted validation, upstream integration, public policy deployment, private
reporting, and default-branch ruleset complete; the authorized STS1 trial-
signing amendment owns current SignPath configuration and workflow integration;
hosted signing, exact candidate, and installed acceptance remain open

Date: 2026-08-11 EDT / 2026-08-12 UTC
Authorization: after directing the next version to be merged and published,
the project owner instructed the agent to complete every remaining required
item. This activates only the bounded SP-READY1 repository-readiness package;
it does not waive SignPath's approval, organization-owner actions, exact signed
candidate acceptance, or the release GO gate.
Owning issue: GitHub Issue #26
Change class: D4 public policy, release supply chain, and application-readiness
work; the update behavior correction is D3 network/privacy behavior
Risk: R4 overall; R3 for user-initiated network admission
Work package: SP-READY1

## 2026-08-12 Trial-Signing Amendment

The project owner subsequently selected the already-created SignPath trial
configuration for Rho's Windows path. The active
`active-2026-08-12-signpath-trial-signing-spec.md` owns that bounded STS1
implementation. It supersedes this document's future-only assumptions about a
Foundation certificate, GitHub App, per-request manual approval, and a
two-stage executable/installer process **only for the configured trial path**.

The trial profile signs only the final NSIS installer with the self-signed
`Rho Test Signing` certificate. It is not publicly trusted by Windows or
SmartScreen, does not make a Foundation attribution, and does not authorize a
candidate, Release, or update-site claim before exact evidence exists. The
manual-only update/privacy, security-reporting, policy-link, and CODEOWNERS
work completed by SP-READY1 remains unchanged.

## Problem And Current Evidence

Rho's macOS candidate path uses Developer ID signing and notarization, while
the Windows candidate path currently produces an unsigned Rho executable and
NSIS installer. SignPath Foundation application readiness requires truthful
public license, privacy, security, and code-signing information plus protected
source/build ownership. At activation, the repository lacked `PRIVACY.md`,
`CODE_SIGNING_POLICY.md`, `SECURITY.md`, and `.github/CODEOWNERS`.

At activation, the accepted About/update design also admitted one automatic
update request after startup at most every 24 hours. That conflicted with Issue
#26's approved privacy principle that Rho has no background telemetry and that
product-owned remote requests are initiated by a user. The implementation
stored the last automatic-check time and dismissed version in WebView local
storage and called `maybeCheckForUpdates()` after Workspace R started.

SP-READY1 resolves that conflict before an external application or a signed
candidate is attempted. It creates no SignPath project, signing request,
signature, candidate, tag, Release, or updater mutation.

## Decisions

1. Update discovery is manual-only. Rho contacts the fixed
   `https://yulab-smu.top/Rho/` update endpoint only after the user selects
   **Help > Check for Updates...** or **Try Again** in the open update dialog.
2. Startup never schedules an update request. The background option,
   notification, 24-hour timestamp, and dismissed-version persistence are
   removed. Existing legacy local-storage values are inert and require no
   migration or deletion authority.
3. Manual update behavior, endpoint/channel policy, bounds, timeout, URL
   allowlists, structured failure states, and user-initiated external browser
   navigation remain unchanged.
4. `PRIVACY.md` is the public data/network contract. It must distinguish local
   project/application data from user-initiated remote operations, describe OS
   credential storage and custom Base URL risk, state retention/deletion
   limits truthfully, and provide a private security-reporting path.
5. `CODE_SIGNING_POLICY.md` is the public signing contract. It must use the
   required SignPath attribution, identify the current unsigned Windows state,
   define the eventual two-stage Rho-binary/NSIS scope, exclude third-party
   upstream binaries, require manual approval, and describe verification and
   incident response.
6. `SECURITY.md` routes confidential reports to GitHub private vulnerability
   reporting. No public Issue should contain credentials, private project
   content, or unredacted diagnostics.
7. `.github/CODEOWNERS` assigns the two current repository administrators to
   policy, workflow, SignPath policy, release-script, and ownership changes.
   Enforcement remains a repository-ruleset gate and is not claimed by the
   file alone.
8. The README and generated download page link License, Privacy, Security, and
   the exact phrase **Code signing policy**. The page remains truthful that
   listed macOS packages are Developer ID signed/notarized and that Windows is
   not Authenticode-signed until the SignPath chain actually passes.
9. No `.signpath/policies/` source/build policy or production signing workflow
   is created with guessed slugs. Those become authorized only after SignPath
   supplies the real organization, project, policy, and artifact-configuration
   identifiers and the organization owner installs/configures the GitHub App.

## Ownership And Cross-Review

- Issue #26 retains SignPath eligibility, external application, GitHub App,
  organization MFA, Authenticode architecture, signing credentials, approval,
  signed-byte evidence, and Windows release admission.
- The accepted About/update design retains manifest schema, channel, endpoint,
  allowlist, bounds, manual UI, and Pages ownership. SP-READY1 narrows only its
  request admission from manual-plus-background to manual-only.
- The system-credential and Provider contracts retain key storage, custom Base
  URL, model discovery, connection testing, and Agent request authority.
- Scientific environment, DOI, R execution, and external-tool contracts retain
  their existing explicit user action/approval boundaries. This policy does
  not grant new network or execution authority.
- BH4 retains project-scoped retention and deletion semantics. A public privacy
  summary cannot imply deletion beyond implemented local records, project
  files, application data, logs, or operating-system credential storage.
- The AGPL contract owns license identity and installed license bytes, not
  signing or privacy. LIC-2 protected integration is a prerequisite.
- The `0.4.0-dev.33` checklist alone owns exact candidate identity, artifact
  construction, installed acceptance, MAC5, publication, and update-site
  mutation. SP-READY1 cannot satisfy those gates.

No schema, project identity, approval table, Provider format, credential
format, R package contract, or public updater manifest changes. Cross-review
found no unresolved state, persistence, approval, or mutation ownership
collision after the manual-only amendment above.

## Public Privacy Contract

The policy must state, at minimum:

- Rho has no first-party analytics, advertising, telemetry upload, or automatic
  crash-report submission;
- project files and scientific outputs remain local unless the user explicitly
  directs an operation that sends selected content elsewhere;
- application state, Agent history, evidence metadata, approvals, and logs are
  local, with bounded diagnostics that can contain paths, error text, stdout,
  or stderr and must be reviewed before sharing;
- API keys saved through Rho use the operating-system credential store and are
  sent only to the configured Provider endpoint for an explicit model action;
- a custom Base URL changes the data recipient and trust boundary;
- manual update checks, Provider/model discovery, connection tests, Agent
  requests, DOI resolution, package/environment operations, user code, and
  external tools are user-initiated network-capable lanes with their respective
  prompts, previews, or approvals;
- ordinary HTTPS metadata such as IP address, time, TLS/HTTP headers, and user
  agent is visible to the selected remote service;
- local records persist until removed through an available Rho or operating-
  system mechanism, and uninstalling the app may leave application data or
  credential-store entries; and
- security reports use the private reporting path and never include secrets in
  a public Issue.

## Public Code-Signing Contract

The policy must state, at minimum:

- `Free code signing provided by SignPath.io, certificate by SignPath
  Foundation`, with `SignPath.io` linked to <https://about.signpath.io> and
  `SignPath Foundation` linked to <https://signpath.org>;
- macOS uses Apple's Developer ID/notarization path independently;
- Windows artifacts are currently unsigned and cannot be represented as
  Authenticode-signed until the production workflow and exact evidence pass;
- the future publisher shown by Windows is SignPath Foundation, and a valid
  signature does not guarantee immediate SmartScreen reputation;
- only the Rho-authored `rho-desktop.exe` and Rho NSIS wrapper are in signing
  scope; Ark, Jet, WebView2Loader, system, and other upstream binaries are not
  re-signed with the Rho/SignPath certificate;
- authoritative production requests originate from the upstream default branch
  on GitHub-hosted runners, bind exact run/source/artifact identities, and are
  manually approved for each request;
- Authors/Reviewers are YuLab-SMU organization members, Approvers are
  organization owners, and all signing-team participants must use MFA;
- the eventual order is build Rho binary, sign/verify it, bundle NSIS, then
  sign/verify the installer; verification includes Authenticode validity,
  expected publisher, RFC 3161 timestamp, installed payload, and final hash;
- fork, pull-request, rehearsal, rerun-substitution, missing configuration, and
  legacy manual publication paths fail closed; and
- compromise or signing-policy failure stops signing/publication, preserves
  evidence, invokes revocation/support as appropriate, and removes affected
  releases/update entries rather than silently replacing bytes.

## Verification Matrix

SP-READY1 automated evidence must prove:

1. the frontend has no startup/background update scheduler, background option,
   update-throttle/dismiss persistence, or background notification path;
2. Help and dialog Retry still invoke the one manual checker, which preserves
   loading, success, failure, duplicate suppression, and allowlisted backend
   behavior;
3. the four public policies/surfaces contain consistent links, linked exact
   SignPath attribution, truthful current platform status, role/scope rules,
   privacy disclosures, private reporting, and user-executable Windows/macOS
   uninstall guidance;
4. the generated download page contains the public policy links, explicitly
   names the pending SignPath Foundation application with official attribution
   links, supplies visible Windows/macOS uninstall instructions, and does not
   claim Windows signing before evidence exists;
5. CODEOWNERS covers itself, workflows, future SignPath policy files, signing
   policy, privacy/security policy, and release/signing scripts;
6. a deterministic negative self-test rejects a missing attribution, hidden
   background update path, missing manual entry, missing owner, absent policy
   link, missing uninstall guidance, or false Windows-signing claim;
7. both stable CI jobs execute the readiness contract while policy, frontend,
   generator, workflow, and owning-document changes trigger the four-leg
   macOS/Windows stable/MSRV matrix;
8. Node syntax, all deterministic JavaScript contracts, update-site generation,
   focused affected Rust tests, and `git diff --check` pass.

Manual review must confirm that Help still exposes **Check for Updates...** and
that opening it is the first network action. No installed-candidate claim is
made by browser/mock review.

## SP-READY1 Implementation And Local Evidence

The implementation removes the startup scheduler, background option,
notification helper, update timestamp/dismissed-version writes, and their dead
styles. The one Help/Retry path still opens the existing modal, suppresses a
duplicate request, invokes the bounded backend checker, renders every terminal
state, and opens only the validated release-page URL after another user action.

Repository readiness adds `PRIVACY.md`, `CODE_SIGNING_POLICY.md`, `SECURITY.md`,
and `.github/CODEOWNERS`; links them from the README and generated download
page; corrects the documentation index; and runs the positive/negative
readiness contract in both stable compatibility jobs. No `.signpath` policy,
secret, signing request, artifact, candidate, tag, Release, or Pages mutation
was created.

Local evidence on 2026-08-11 EDT:

- `node --check` passed for `desktop/dist/app.js`, the update-site generator,
  and the readiness contract;
- all 60 `scripts/test-*.mjs` contracts passed once, including the readiness
  negative self-tests, updater historical-compatibility self-test, installed-
  license contract, MAC4 release contract, AGPL/license inventory, MSRV, and
  frontend/mock suites;
- `cargo test -p rho-desktop update::tests --locked -- --nocapture` passed all
  eight update tests after the isolated worktree bootstrapped the repository-
  pinned macOS Ark sidecar; the first attempt failed before tests exactly
  because that required sidecar was absent and is not counted as a pass;
- `git diff --check` passed;
- Computer Use browser/mock review observed a ready workbench with no automatic
  update dialog, exposed **Help > Check for Updates...**, observed the explicit
  `Checking...` state and `up to date` terminal state only after clicking it,
  then reloaded and observed no automatic dialog; and
- a separate post-test review compared the public documents and ownership
  boundaries with the current SignPath Foundation terms and GitHub trusted-
  build documentation. It confirmed the required attribution, OSI/open-source
  boundary, own-binaries-only scope, role links, MFA, per-release manual
  approval, GitHub-hosted artifact origin, policy-file ownership, and truthful
  unsigned Windows status. No blocking contract deviation was found.

The public privacy inventory names the already implemented, explicitly user-
initiated DOI, package/environment, R-code, and external-tool lanes in addition
to Issue #26's update/Provider/Agent examples. This is a truthfulness
clarification, not expanded network or execution authority.

Full local Rust workspace and R package suites were not rerun because this
slice changes no Rust/R source or package contract. Exact PR and merged-main
hosted stable/MSRV matrices remain required and execute the full locked Rust
workspace on macOS and Windows.

## Hosted Integration And Repository Evidence

SP-READY1 exact head `ee7100866d547c0a43ba814464a960e29846fa43`
passed all four macOS/Windows stable and Rust 1.88.0 jobs in run
`31561610111`. PR #45 merged as
`e6fec3ecc286db93aa38c227e896ef077bdf17bd`, whose exact-main run
`31562213275` passed the same four identities. No rerun substituted for either
exact result.

Update-site run `31562817460` regenerated and deployed the public page from
that exact `main`. Live verification found the License, Privacy, Security, and
Code signing policy links, the truthful unsigned-Windows statement, and the
unchanged published development identity `0.4.0-dev.24` with both existing
platform artifacts.

GitHub private vulnerability reporting is enabled. Repository ruleset
`20728497` is active on `~DEFAULT_BRANCH` with no bypass actors. Its applied
rules require a pull request, one approving review, CODEOWNER review, dismissal
of stale approvals, approval of the latest push by someone other than its
pusher, and resolution of review threads; deletion and non-fast-forward pushes
are blocked.

The authenticated maintainer `xiayh17` is an active YuLab-SMU member and Rho
repository administrator. `GuangchuangYu` is the organization owner and a Rho
repository administrator. GitHub rejected the authenticated member's
organization-wide `2fa_disabled` audit because only organization owners may
use that filter, so MFA compliance for every future signing role remains an
explicit owner-owned gate rather than a claimed pass. No SignPath application
or GitHub App installation/configuration has occurred.

The 2026-08-12 application-form audit found that the public attribution named
SignPath.io and SignPath Foundation without the official links required by the
Foundation terms, while the privacy policy described retained data after
uninstall but no public surface supplied executable Windows/macOS uninstall
steps. PR #46 amends this contract and carries linked attribution, README and
download-page instructions and pending-application disclosure, generator
assertions, and separate negative tests for loss of either public uninstall
surface or the download-page SignPath disclosure. On the amended local tree,
all 60 deterministic JavaScript contracts, both focused readiness modes, Node
syntax, and `git diff --check` pass. Protected integration, public-site
deployment, and live verification remain open facts and are not inferred from
local tests.

## Version, NEWS, And Release Decision

SP-READY1 changes user-visible update behavior and therefore amends the
`0.4.0-dev.33` NEWS entry. That identity is already synchronized, has never
produced an artifact, tag, or Release, and remains the single active source
candidate; no additional application-version bump is required for this
pre-candidate integration. R package versions and store schema remain fixed.

The release decision remains `NO-GO`. SP-READY1 PR-gated integration, private
vulnerability reporting, default-branch review enforcement, and public policy
deployment pass. The mandatory stop is now external readiness: obtain the
organization-owner MFA verification and GitHub App configuration, then submit
and receive the SignPath Foundation decision. Production two-stage signing is
a later D4/R4 package using real identifiers. Only a new exact signed candidate
with two-platform installed acceptance and explicit MAC5 GO can proceed to
publication.

## SP-READY1 Definition Of Done

- accepted About/update and cross-review documents reflect manual-only network
  admission and the ownership rules above;
- policies, CODEOWNERS, README, generated page, regression contract, NEWS, and
  CI enforcement are implemented as one reviewable slice;
- affected local verification and a separate post-test contract/security review
  have no blocking finding;
- the exact PR head and exact merged `main` pass the four-leg hosted matrix;
- repository/external gates are reported separately and no signing, candidate,
  installed, or release claim exceeds the evidence.
