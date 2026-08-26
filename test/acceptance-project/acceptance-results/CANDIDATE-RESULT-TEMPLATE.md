# Rho Acceptance Result Record

Status: template

The human-executed candidate checklist is retired (user authorization
2026-08-26). Candidate acceptance evidence is produced by the automated
visual acceptance lane described in `../VISUAL-ACCEPTANCE.md`. Duplicate this
record per candidate and attach the automated evidence instead of a manual
walkthrough.

## Candidate

- Version:
- Source commit:
- Installer path (when an installed candidate is reviewed):
- SHA-256:
- Test date:
- Reviewer:
- Platform and R version:
- Distribution intent: unsigned internal / signed public / undecided

## Automated Evidence

- Run directory (contains `evidence.json`, `screenshots/`,
  `visual-review-manifest.json`, `report.md`, app logs):
- Run status after final visual review: PASS / FAIL
- Deterministic gates failed: none / list
- Visual verdicts failed: none / list
- Truthful skips and reasons (credentials, Quarto, removed gates):

## Removed Manual Gates

The gates listed under "Removed Manual Gates" in `../VISUAL-ACCEPTANCE.md`
are closed by the 2026-08-26 authorization, not by this record. Do not
recreate them as manual checklist items.

## Separate Facts (unchanged)

Keep these separate; none is established by the lane alone:

- browser/mock verification;
- automated visual acceptance (this record);
- affected cross-package suite rerun against the exact candidate;
- unsigned-internal versus signed-public distribution decision;
- release GO/NO-GO.
