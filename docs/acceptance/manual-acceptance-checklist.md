# Rho Acceptance Index

Status: automated visual acceptance lane active; the human-executed manual
acceptance was retired by user authorization dated 2026-08-26

The executable acceptance review lives under `test/acceptance-project/` and in
`scripts/visual-acceptance/`. Keeping a second step-by-step checklist here
caused the product contracts and the example project to drift.

Use these files:

- `test/acceptance-project/VISUAL-ACCEPTANCE.md`: run order, evidence model,
  scenario coverage index, removed-gates record, and failure handling;
- `test/acceptance-project/acceptance-results/CANDIDATE-RESULT-TEMPLATE.md`:
  per-candidate record that attaches the automated run evidence;
- `test/acceptance-project/tools/prepare-fixtures.mjs`: primary
  `working-project` plus isolated conflict, Unicode/space, large-project, and
  oversized-file fixtures;
- `docs/plans/implemented-2026-08-26-visual-acceptance-automation-spec.md`: the
  owning contract (bridge gates, evidence classes, scenario contract).
- `docs/verification/visual-acceptance-va1-baseline.md`: the first finalized
  real-app run summary and product-finding index.

The normal feature review runs in the single generated `working-project`.
Additional generated projects are used only when a boundary condition cannot
be tested safely inside the primary project.

Automated visual acceptance, browser/mock verification, the affected
cross-package suite rerun, distribution intent, and release GO/NO-GO remain
separate facts. Browser/mock evidence cannot close real-application gates.
