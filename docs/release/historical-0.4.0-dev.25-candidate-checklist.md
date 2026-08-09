# Rho 0.4.0-dev.25 Rejected Cross-Platform Candidate Record

Status: historical rejected candidate; immutable evidence only

Date: 2026-08-09
Last updated: 2026-08-09

## Exact Attempt

| Field | Recorded value |
| --- | --- |
| Application version | `0.4.0-dev.25` |
| `rho.bridge` version | `0.1.13` |
| `rho.agent` version | `0.1.5` |
| Store schema | `12` |
| Authoritative source commit | `9baf1ea199dae30317a309f9873e34a269f4fd40` |
| Candidate workflow run | `31336769848` |
| Workflow conclusion | `failure` |
| Release decision | `REJECTED / NO-GO` |

The run passed immutable identity resolution. The macOS arm64 lane passed its
complete source validation, Developer ID signing, exact final-DMG notarization,
stapling, Gatekeeper assessment, mount, and Workspace smoke. Its run-scoped
historical artifacts are:

- `rho-notary-submission-0.4.0-dev.25-31336769848` (artifact `9044693154`);
- `rho-notary-acceptance-0.4.0-dev.25-31336769848` (artifact `9044698696`);
- `rho-0.4.0-dev.25-macos-arm64-31336769848` (artifact `9044713389`).

The Windows lane failed during `Run complete Windows candidate validation`
before installer construction. The exact failing contract was
`scripts/test-agent-conversation-concurrency.mjs`: Windows checkout converted
the active specification to CRLF, while one required cross-line phrase was
matched with a literal LF. The same product source and assertion passed on
macOS. R package `curl` replacement messages were warnings and not the failed
assertion.

Because the Windows lane failed, draft assembly was skipped. Read-only API
checks after workflow completion found no `v0.4.0-dev.25` Git tag and no Release
or draft Release for that tag. Nothing was publicly released and the update
site was not mutated.

## Disposition

This record is immutable and cannot satisfy a later candidate, installed-app,
MAC5, publication, or update gate. The signed/notarized macOS artifact consumes
the single-use `dev.25` identity even though it never entered a draft Release.
No artifact, receipt, hash, or result from this run may be relabelled or
composed with another run.

The authorized replacement is `0.4.0-dev.26`. Its bounded repair normalizes
logical text at the affected source-contract read boundary, directly tests LF,
CRLF, and lone-CR handling, changes no application behavior or authority, and
must earn a fresh exact-commit two-platform candidate plus owner-installed
acceptance before Issue #5 may close.
