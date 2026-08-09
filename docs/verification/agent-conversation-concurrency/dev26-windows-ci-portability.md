# DEV26 Windows Candidate Contract Portability Evidence

Status: source verification, independent R4 contract review, upstream
integration, and exact two-platform hosted candidate pass; installed acceptance
remains open

Date: 2026-08-09

Owning contract:
`docs/plans/active-2026-08-09-agent-conversation-concurrency-spec.md`

Change class: D1 release-blocking validation defect plus D4 replacement
candidate identity

Risk: R4 because the defect occurred inside required candidate validation and
the failed run produced a signed/notarized artifact

## Reproduction And Root Cause

Authoritative candidate run `31336769848` checked out upstream commit
`9baf1ea199dae30317a309f9873e34a269f4fd40`. Its macOS source-validation,
signing, notarization, stapling, Gatekeeper, mount, and Workspace-smoke jobs
passed. The Windows job failed before installer construction while executing
`scripts/test-agent-conversation-concurrency.mjs`.

The exact assertion expected the logical phrase
`CONV-3 source\ncheckpoints accepted 2026-08-09`. Windows checkout materialized
the tracked specification with CRLF, so the literal LF failed even though the
required words and application source were identical. The adjacent R package
`curl` restore messages were warnings; the job's terminal exception names the
Conversation contract script as the deterministic failure.

The run completed with `failure`; draft assembly skipped. API verification
found no `v0.4.0-dev.25` tag and no Release or draft Release for that tag. The
run-scoped macOS submission, acceptance, and final artifacts remain historical
and non-composable under the rejected checklist.

## Bounded Repair

- The Conversation source-contract reader normalizes CRLF and lone CR to LF
  before cross-line assertions.
- A direct regression assertion covers mixed LF, CRLF, and lone-CR input.
- The required phrase assertion is unchanged; no source, metadata, identity,
  behavior, or acceptance assertion was removed or weakened.
- Release metadata assertions derive version-specific regular expressions from
  one escaped expected version where practical, while existing UI cache-key
  contracts advance to the replacement identity.
- The rejected artifact consumes `0.4.0-dev.25`; application, frontend, lock,
  candidate-build, and publish defaults advance together to
  `0.4.0-dev.26`. Store schema remains 12; `rho.bridge` remains 0.1.13 and
  `rho.agent` remains 0.1.5.
- No application runtime, schema, Agent authority, credential, filesystem,
  network, approval, Workspace R, UI interaction, or dependency changed.

## Automated Evidence

The following checks passed against the final replacement source:

- `node scripts/test-agent-conversation-concurrency.mjs` — PASS, including the
  direct mixed-line-ending regression.
- `node scripts/test-mac4-release-contract.mjs` — PASS.
- `node scripts/test-macos-notary.mjs` — PASS.
- `for test_script in scripts/test-*.mjs; do node "$test_script"; done` — PASS,
  48 of 48 deterministic frontend/release contracts.
- `node --check desktop/dist/app.js` — PASS.
- `cargo fmt --all -- --check` — PASS.
- `cargo check --workspace --all-targets` — PASS; only the 13 pre-existing
  unused Git helper warnings remain.
- `cargo test --workspace --all-targets` — PASS: Desktop 167 passed with one
  opt-in macOS Keychain smoke ignored, Server 58 passed, Store 108 passed, and
  every other target passed.
- `Rscript -e "testthat::test_local('r/rho.bridge', reporter = 'summary')"` —
  PASS.
- `Rscript -e "testthat::test_local('r/rho.agent', reporter = 'summary')"` —
  PASS.
- `git diff --check` — PASS.

The previously accepted deterministic wide/narrow browser evidence remains
bound to the unchanged Issue #5 application behavior. Browser review was not
repeated because this repair changes only test input normalization, candidate
identity text, mock version fixtures, and cache-busting query values; it does
not change rendered structure, styling, state, or interaction.

## Independent Contract Review

A separate post-verification review compared the final diff with the active
Conversation specification, cross-review matrix, release identity rules, and
candidate workflows. Findings:

- the repair is at the failing input boundary and preserves the original
  content assertion;
- failed-run evidence remains immutable and cannot enter the replacement
  candidate;
- `dev.26` is synchronized across every application and workflow authority;
- no R package version or schema change is implied;
- no credential exposure, release-publication authority, or application
  behavior is broadened;
- lifecycle documents distinguish source, failed candidate, replacement
  candidate, installed acceptance, MAC5, and publication facts.

No unresolved P0/P1 finding remains. The release decision is still `NO-GO`.

The reviewed replacement repair was committed as
`b243fdb07578e7f05b5150fdcf939492c02cfaa5`. This following evidence update
changes no compiled application or validation behavior.

## Hosted Replacement Evidence

PR #12 rebase-integrated the repair into upstream `main` as
`a5fc4a153bb420968155984bf8e980973c775015`. Protected candidate run
`31337666426` bound both platforms to that exact SHA and passed:

- immutable candidate identity resolution;
- complete Windows validation, including the previously failing Conversation
  contract, followed by installer build and smoke;
- complete macOS validation, Developer ID signing, exact final-DMG submission,
  Apple acceptance, staple, Gatekeeper, read-only mount, and Workspace smoke;
- exact platform evidence aggregation and one unpublished Draft prerelease.

Draft Release `367596197` is `draft=true`, `prerelease=true`, carries tag name
`v0.4.0-dev.26`, targets the exact authoritative SHA, and contains seven
pre-acceptance assets. The DMG is
`Rho_0.4.0-dev.26_aarch64.dmg`, 21120068 bytes, SHA-256
`6fdfd492e07cfc5c0aa70e77fbc781206f43d87dd81063e3ef85170c2fdfd540`.
Candidate evidence SHA-256 is
`566b1b765412e91580494e47e6c13a296a551c80b273ef223e5afaa35e3ef483`.

An independent local download matched the DMG checksum and Draft digest;
`hdiutil verify`, `xcrun stapler validate`, and Gatekeeper assessment passed.
The Draft is not public, the Git tag ref is not created, and the acceptance
asset is intentionally absent. Release decision remains `NO-GO` pending the
owner-installed workflows.

## Remaining Gates

- obtain owner-installed acceptance for all seven Issue #5 workflows;
- bind the acceptance record to the exact candidate evidence and DMG hashes;
- add the final Issue evidence comment, then close Issue #5.
