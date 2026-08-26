# Rho Acceptance Test Project

The self-contained acceptance and hands-on evaluation project for Rho.
Consolidated development visual acceptance is automated: the lane drives the real
application through the scenarios in `scripts/visual-acceptance/`. The
generated `working-project` is the one primary project for the normal
workflow: startup, core workbench tour, deterministic single-cell QC, Agent
(credential-gated), rendering, Environment, Evidence, Git (read-only),
persistence, and boundary review. Separate generated projects exist only for
conflict, Unicode/space, large-project, and oversized-file boundary
conditions.

## Structure

```
acceptance-project/
├── VISUAL-ACCEPTANCE.md        # Automated lane: run order, evidence model, coverage index
├── acceptance-results/         # Per-candidate record template (attaches automated evidence)
├── tools/                      # Cross-platform fixture generator (+ legacy ps1)
├── examples/
│   ├── single-cell-qc/         # Generate, analyze, plot, and repair QC workflow
│   ├── rho-workbench-tour.R    # One-file Console/Data/Plot/Run/Problem tour
│   ├── editor-intelligence.R   # Completion, Help, references, diagnostics
│   └── git-review-demo.txt     # Two-hunk stage/restore exercise
├── rho-acceptance.Rproj       # R project file
├── .Rprofile                  # Minimal startup message
├── .gitignore
├── scripts/
│   ├── 01-load-explore.R      # Data loading & exploration
│   ├── 02-modeling.R          # lm() + k-means + intentional error
│   └── 03-visualize.R         # base plot + ggplot2
├── reports/
│   ├── cell-qc-report.Rmd     # Complete reproducible QC report
│   ├── iris-analysis.Rmd      # Multi-chunk Rmd with unclosed chunk
│   └── iris-summary.qmd       # Minimal Quarto document
└── .rho/
    └── skills/
        ├── manifest.json
        ├── iris-analyzer/
        │   └── skill.md       # Agent skill for iris analysis
        └── qc-reviewer/
            └── skill.md       # Agent skill for QC correction review
```

## Quick Start (automated lane)

1. Read [`VISUAL-ACCEPTANCE.md`](VISUAL-ACCEPTANCE.md); it is the executable
   source of truth for the consolidated development visual lane.
2. After UI changes, build frontend assets first with
   `npm run rsr:build --prefix desktop`, then build the debug app with
   `cargo build -p rho-desktop`.
3. Run `node scripts/visual-acceptance.mjs run --output
   target/visual-acceptance/<run>` from the repository root. Fixtures are
   generated per run into the run directory.
4. Review every frame in `visual-review-manifest.json` and record verdicts
   with `record-review`; duplicate
   [`CANDIDATE-RESULT-TEMPLATE.md`](acceptance-results/CANDIDATE-RESULT-TEMPLATE.md)
   per candidate and attach the run evidence.

To generate the fixture set by hand (for exploration, not acceptance):
`node tools/prepare-fixtures.mjs` (Windows equivalent:
`tools\prepare-manual-fixtures.ps1`).

## Fixture Inventory

The files below support current and future acceptance packages. VA1 automates
only the S0/S1/S2/S3/S7/S8 coverage listed in `VISUAL-ACCEPTANCE.md`; fixture
presence does not claim that a removed or follow-up UI gate passed.

| Script / File | Features Reviewed |
|---------------|----------------|
| `examples/rho-workbench-tour.R` | Console markers, live Workspace object probes, package Environment observation, Plot record, warning observation, Run/Problem |
| `examples/single-cell-qc/` | Deterministic 240/217 QC data and exactly two plot records; repair scripts remain follow-up fixtures |
| `examples/editor-intelligence.R`, `examples/editor-refactor-use.R` | Completion, installed Help/example, references, refactor, Agent Help context, diagnostics |
| `examples/git-review-demo.txt` | Current read-only Git status/history/conflict review; retired mutation gates remain fixture history |
| `reports/cell-qc-report.Rmd` | Chunks, render, Artifact provenance, Runs, Audit |
| `reports/claim-review-demo.qmd` | EW-CR2 source/Artifact anchors, Evidence links, review status and recovery |
| `01-load-explore.R` | Console, Editor, Data Viewer, Runs |
| `02-modeling.R` | Editor and source-linked Problems |
| `03-visualize.R` | Console, Editor, Plots and provenance |
| `iris-analysis.Rmd` | Editor, Chunks, R Markdown Render |
| `iris-summary.qmd` | Editor and Quarto Render |
| Project root | Files, Git, Evidence, layout, persistence and project switching |
| `.rho/skills/` | Agent project skills and Agent-first |

## Acceptance Ownership

Everything required for automated acceptance and evidence is reachable from
this directory:

- [`VISUAL-ACCEPTANCE.md`](VISUAL-ACCEPTANCE.md) is the run order, evidence
  model, coverage index, and the removed-gates record.
- [`CANDIDATE-RESULT-TEMPLATE.md`](acceptance-results/CANDIDATE-RESULT-TEMPLATE.md)
  is the per-candidate record that attaches the automated evidence.
- `tools/prepare-fixtures.mjs` creates the primary independent Git project
  plus the four boundary projects without tracking generated output in the
  Rho repository (`tools/prepare-manual-fixtures.ps1` is the equivalent
  Windows-native entry).

Project-level documents under `docs/` may point here for lifecycle status, but
they are not required while executing the review.

## Notes

- `02-modeling.R` contains an intentional `stop()` at the end to test Problem panel behavior.
- `iris-analysis.Rmd` has one deliberately unclosed chunk to test chunk detection.
- The single-cell QC data are synthetic and deterministic; no external data or
  network access is required. `ggplot2`, R Markdown, Quarto, `lintr`, `aisdk`,
  and model credentials remain optional feature-specific prerequisites.
