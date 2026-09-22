# Rho Gapminder Demo

This is a real, reproducible R project for looking around Rho without bringing
in a separate application or installing packages. It follows the tutorial
workflow: project files → script → objects → plots → report.

## Start here

1. Open this project from the Rho welcome page with **Open Rho Demo**, or run
   `rho --demo-project workbench`.
2. Open `run_demo.R` in Editor and choose **Run File**.
3. Look at the results in the default layout:
   - **Console**: progress, model coefficients and the final completion message
   - **Objects**: `raw`, `clean`, `latest`, `continent_summary`, `model`, `palette`
     and `labels`
   - **Plots**: the income/life-expectancy scatter and the time trend
   - **Files**: generated RDS, PNG and HTML files
4. Use **Layout** to open **Viewer** and inspect the generated HTML report.
5. Open **Packages** and select a base package such as `stats` or `graphics`.
   Use its documentation action to see the same package copy in **Help**.
6. Open **Agent** to inspect the project context entry point. No model request is
   sent by opening the panel.

The first run is deliberate: Plots, Viewer and live R objects are real output
references from your session, not screenshots or fake startup state. The project
files and report source are already available before running anything.

## Project map

```text
data/raw/                 immutable Gapminder CSV and provenance
 data/processed/           reproducible RDS outputs
R/demo_helpers.R           small reusable plotting/report functions
scripts/01_import_clean.R  import, clean and save data
scripts/02_transform_model.R model and save results
scripts/03_figures_viewer.R plots, PNGs and HTML Viewer output
scripts/04_report.R        rebuild HTML from processed files
run_demo.R                 run the complete workflow
report/development_report.qmd optional Quarto report source
output/figures/            script-generated PNGs
```

The scripts use only base R and do not install, load or update packages. The
`.qmd` file is optional and can be rendered by an external Quarto installation;
Rho's generated HTML report is the zero-dependency path.

## Reproducibility rules

- `data/raw/` is read-only input; `source.json` records the upstream URL,
  checksum, row count and attribution.
- `data/processed/`, `output/` and the report are generated artifacts. Delete
  them and run `run_demo.R` again to rebuild them.
- Paths are project-relative. The scripts do not use `setwd()` or machine-local
  absolute paths.
- The model is descriptive. It shows how a model becomes an inspectable R
  object; it is not a causal claim.

Data: Gapminder data excerpt by Jennifer Bryan. See `data/raw/source.json` for
full provenance.
