# Rho Development Roadmap

Date: 2026-07-16
Current baseline: `0.2.0-dev.1` Windows project-file prototype

Progress: `0.2.x` project-file foundation in progress. The first slice now
provides a broker-safe project root, source file listing, multi-document
frontend state, reads/writes, new files and Workspace R `setwd()` synchronization.

## Direction

The next objective is not another architecture spike. It is a reliable
Windows daily-use slice in which a scientist can open a real R project, run
code, inspect objects and plots, ask the Agent for help, review proposed
changes and recover from ordinary errors without losing the Workspace R state.

The two-session architecture remains the boundary:

- Workspace R is the only authority for live scientific objects and project
  execution.
- Agent R runs `aisdk`, model calls and orchestration.
- Rust broker owns transport, revisions, approvals, persistence and process
  lifecycle.
- The Tauri frontend consumes broker/workbench events and does not talk to Ark
  or `aisdk` directly.

No aisdk family change is required for the next milestone. We will continue
with the Rho adapter shims until a missing upstream seam is demonstrated by a
concrete workflow and covered by an isolated compatibility test.

## Milestones

### M1: Windows daily-use slice (`0.2.x`)

Priority: highest. This is the next development target.

Deliverables:

- Open a local project directory and display a real file tree.
- Edit and save multiple `.R` files; preserve the active document and cursor
  position across restarts.
- Replace the prototype textarea with a language-aware editor, completion and
  source/run selection commands.
- Keep Console, Plots, Problems, Environment and the resizable panel layout
  working with real project files.
- Add explicit user/agent/system execution origin, timestamps and run links.
- Add a real approval surface for Act-mode `run_r`, package installation and
  shell-like operations.
- Persist the Agent timeline and restore it after Agent R restarts while
  preserving the independent Workspace R session.
- Add user-facing cancellation, timeout, crash and restart states.

Completed in the first `0.2.x` slice:

- project root and source-file listing API;
- path traversal protection and editable extension allowlist;
- multiple open document state with file-tree and document-tab rendering;
- read, save and create-file commands;
- Workspace R working-directory synchronization on project open.

Still required to close M1:

- native directory picker and project-opening UX;
- durable document/session restoration;
- editor completion and source/run selection commands;
- real approval, cancellation, error/retry and Agent restart flows.

Acceptance gate:

> A user can open a small single-cell R project, execute a QC script, inspect
> an object and plot, ask DeepSeek to explain an error, approve a correction,
> and restart either R process without losing the project or audit trail.

### M2: Scientific workflow foundation (`0.3.x`)

Priority: high after M1 is stable.

Deliverables:

- `renv` detection, status, initialize, restore and snapshot workflows.
- Bioconductor version and package diagnostics.
- Bounded viewers for data frames and common bioinformatics objects.
- Plot history, export and provenance links back to code and run records.
- Quarto `.qmd` and `.Rmd` editing/rendering with structured Problems output.
- Project-scoped skills and the first `aisdk.bioc` semantic adapters through
  Workspace R probes.

Acceptance gate:

> A second user can reproduce a selected QC result from the project files,
> environment metadata, run record and generated artifacts without relying on
> chat text alone.

### M3: Cross-platform beta (`0.4.x`)

Priority: after the Windows contract is stable.

Deliverables:

- macOS arm64/x64 and Linux x64 process and packaging probes.
- One generated Workbench Protocol contract across Tauri and browser mode.
- Platform-specific R discovery, paths, signals, permissions and WebView
  behavior.
- Signed internal builds and a dependency/license manifest.
- Cross-platform fixtures for Unicode, paths with spaces, plots, HTML and
  large object summaries.

Acceptance gate:

> The same project workflow and protocol tests pass on Windows, macOS and
> Linux without platform-specific frontend behavior leaking into Workspace R
> semantics.

### M4: Advanced execution and reproducibility (`0.5.x`)

Priority: after local workflows are dependable.

Deliverables:

- Debugger/DAP integration where Ark and R support it.
- Long-running jobs with checkpoints and resource monitoring.
- Exportable run reports with code, environment, artifacts and approvals.
- Remote Workspace R, SSH and Slurm adapters behind the same broker contract.
- Optional containerized workspace backend.

Acceptance gate:

> Local and remote runs have the same execution/revision/provenance semantics,
> and disconnect/reconnect cannot duplicate a scientific execution.

## Work order for the next iterations

1. Fix the current prototype's remaining correctness gaps: durable run state,
   cancellation, crash recovery, structured error/retry flow and real project
   files.
2. Productize the Windows workbench surface: multi-file editor, file tree,
   approval dialogs, Environment/Plot viewers and session restoration.
3. Add scientific environment operations: `renv`, Bioconductor, Quarto and
   bounded object adapters.
4. Freeze the Workbench Protocol and run the cross-platform transport and UI
   matrix.
5. Only then expand to remote compute, MCP-heavy workflows, debugger support
   and public release hardening.

## Explicitly deferred

- Python, Jupyter Server and JupyterLab dependencies.
- Electron or a second production frontend shell.
- A second authoritative Workspace R session.
- Broad aisdk family refactors without a demonstrated Rho use case.
- Remote/cloud multi-user collaboration before local provenance is reliable.
- Installer signing and auto-update until the product surface and release
  identity are stable.

## Decision checkpoints

Every milestone should end with a short evidence review:

- Which user workflow is now demonstrably complete?
- Which state transitions and failure paths have tests?
- Does the change preserve Workspace R authority and revision checks?
- Does it introduce a real aisdk family gap, or can the Rho adapter remain
  local?
- Is the result ready for the next internal user, or only for another spike?
