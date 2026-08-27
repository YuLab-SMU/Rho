# Automated visual acceptance

This lane drives the real debug application and Workspace R backend. Browser
mock previews are useful during development but are not equivalent to this run.

## Run

```bash
npm run rsr:build --prefix desktop
cargo build -p rho-desktop
node scripts/visual-acceptance.mjs run --output target/visual-acceptance/<run>
# or: npm run rsr:accept:visual --prefix desktop
```

The driver creates isolated fixture projects and runs the startup, workbench,
QC, Agent, Git, persistence, and boundary scenarios. An output directory is
used once; retry into a new path.

## Output

Each run contains:

- `evidence.json` with deterministic and visual status per gate;
- `screenshots/` and `visual-review-manifest.json` for frame review;
- `report.md`, regenerated after verdicts are recorded;
- bounded application stdout and stderr logs.

Record a verdict only after inspecting the named frame:

```bash
node scripts/visual-acceptance.mjs record-review --run <run> --frame <name> \
  --verdict pass --note "layout readable; no clipping or overlap"
node scripts/visual-acceptance.mjs finalize --run <run>
```

The generated ledger is the result. A deterministic failure, failed frame, or
pending frame keeps the run from passing. A truthful skip remains a skip.

## Scenarios

| Scenario | Current behavior exercised |
| --- | --- |
| S0 | startup, project open, Navigator, status |
| S1 | Console, Workspace objects, Environment, plots, warnings, failed run |
| S2 | deterministic single-cell QC and plot records |
| S3 | credential detection and one real restricted Agent turn when available |
| S7 | read-only Git status, diff, and conflict presentation |
| S8 | restart, project isolation, large-project/file bounds, responsive frames |

The runner preserves every failed run under `target/`; it never rewrites a
result or turns a product failure into a skip. Installer, signing, and release
operations use their own executable workflows.
