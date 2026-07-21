# Rho Development Roadmap

Status: active

Date: 2026-07-21
Current baseline: `0.2.0-dev.11` Windows workbench candidate

Progress: the core `0.2.x` daily-use workflow is implemented and is now in
hardening. Project editing, Workspace R execution, Agent approvals, durable
runs, restart recovery, Environment, Plots and render diagnostics are present;
the remaining work is completion quality, broader mutation policy and release
acceptance on representative projects.

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

Completed in the current `0.2.x` candidate:

- native project selection and project-scoped session restoration;
- broker-safe file listing, reads, writes, new files and render paths;
- Monaco multi-document editing and selection/current-line/file execution;
- resizable Files, Agent, Environment, Console, Plots and Problems panels;
- durable runs, retry links, cancellation, restart recovery and plot provenance;
- Ask/Plan read-only enforcement and exact single-use Act approval for `run_r`;
- Environment diagnostics for R, libraries, `renv`, Bioconductor and rendering;
- bounded object previews and optional Quarto/R Markdown render diagnostics;
- atomic source/session persistence, coalesced file watching and bounded file
  discovery for large projects;
- bounded local R completion and simple document-symbol navigation.

Still required to release M1:

- clean-install acceptance on Unicode paths, paths with spaces and large projects;
- a repeatable manual acceptance record for the complete QC correction workflow;
- an explicit decision about unsigned internal versus signed public distribution.

Post-release `0.2.x` quality work:

- file rename/delete commands;
- paged plot-history payload loading and retention controls;
- package-aware completion and explicit policy for future shell-like tools.

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

1. Close M1 with completion, atomic persistence, watcher coalescing and a
   repeatable clean-install acceptance run.
2. Add scientific environment operations beyond detection: `renv` initialize,
   restore and snapshot, plus package/Bioconductor repair workflows.
3. Strengthen data, plot and document viewers while preserving bounded broker
   responses and provenance.
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
