# VA1 Automated Visual Acceptance Baseline

Status: finalized local development evidence; product acceptance FAIL

Date: 2026-08-26
Owning contract:
`docs/plans/implemented-2026-08-26-visual-acceptance-automation-spec.md`

## Evidence Identity

- Integrated run: `target/visual-acceptance/va1-integrated-final3`
- `evidence.json` SHA-256:
  `d70fcae2490035dd3fdab44d3c2e979780887acaa444b49d28fc67e816cfb8d7`
- `report.md` SHA-256:
  `6d1fef87cfb9f5746a95ff6813aea38fec9d45576ddb4bb7d9f95ad85f830be3`
- Result: 35 gates; 12 PASS, 15 FAIL, 8 authorized removed-gate SKIP.
- Visual review: 17 of 17 frames reviewed; 12 FAIL, 5 PASS, 0 PENDING.
- Scenarios: S0, S1, S2, S3, S7, and S8 all remain FAIL.

Raw screenshots and ledgers stay in ignored `target/` output because they are
regenerable build evidence, not source artifacts. This tracked record preserves
the run identity, hashes, counts, and acceptance disposition.

## Deterministic Findings

- S3 reached the configured provider in the integrated run, but the restricted
  Agent answer rendered only `R` instead of `RHO_AGENT_OK`.
- S7's read-only oracle reported branch `main`, one modified file, one untracked
  file, and a 721-byte two-hunk diff; the Git surface rendered neither status
  nor diff. History did render.
- S8 lost the unsent Console draft on restart, retained
  `RHO_S8_CROSS_PROJECT=TRUE` after switching back to the working project, and
  capped discovery at 2,000 Resources without a visible warning.

## Visual Findings

- The default Agent composer hint overlaps Ask/Plan/Act controls at ordinary
  and narrow widths. The 900x700 and 1024x680 frames additionally clip draft
  and status content; 1920x1080 passes.
- Plots shows `PREVIEW UNAVAILABLE` with raw metadata instead of rendered
  graphics in both tour and QC scenarios.
- Problems can open blank with a visible `missing reference` error.
- The isolated Agent surface is readable with a stable hierarchy and no
  overlap.
- The multi-surface conflict frame compresses Agent, Git, and Source editor
  content enough to clip controls and text.
- The 9 MiB refusal message is deterministic and readable, but its full frame
  still fails because adjacent Agent controls overlap and the editor is
  excessively compressed.

## Disposition

The automation lane passed its own VA1 implementation purpose: real debug app,
real Workspace R, isolated fixtures, independent-scenario continuation,
deterministic assertions, screenshots, per-frame verdicts, immutable evidence,
and truthful final status all executed. The product findings above do not widen
VA1. Each repair needs a separately authorized active contract, regression
tests, and a fresh immutable visual run. No exact-candidate, installer,
distribution, signing, publication, or release decision is implied.
