# Windows prototype

Status: implemented in the current Windows baseline

Date: 2026-07-21

## Installer

The current internal prototype installer is generated at:

```text
D:\Rho\target\release\bundle\nsis\Rho_0.2.0-dev.11_x64-setup.exe
```

It is an unsigned 64-bit NSIS installer. Windows SmartScreen may therefore
show an unrecognized-publisher warning. Code signing is deferred until the
prototype workflow and publisher identity are stable.

The installer places Rho below `%LOCALAPPDATA%\Rho`, creates a Start Menu
shortcut, and includes:

- `rho-desktop.exe`;
- Ark 0.1.252 and its license/notice;
- `WebView2Loader.dll` required by the GNU Windows build;
- the HTML, CSS and JavaScript workbench frontend embedded in the executable.

## Prerequisites

- Windows 10 or Windows 11 x64 with the Microsoft Edge WebView2 runtime;
- R 4.4 or later, available through `PATH` or installed below
  `C:\Program Files\R`;
- `aisdk` for Agent turns; provider metadata is managed in Rho and credentials
  come from the effective user `.Renviron`.

The editor, Console, Environment and Plots work without a model credential.
Only the Agent panel requires aisdk plus at least one valid configured model.
Python, Jupyter Server and JupyterLab are not installed or used.

`RHO_RSCRIPT` may be set to an explicit `Rscript.exe` path when R is installed
in a nonstandard location.

## Startup recovery

Rho creates its application shell before probing R. Missing R, unsupported R
versions and failed base-runtime probes therefore open a recovery view instead
of terminating the desktop process. The recovery view supports Retry, native
`Rscript.exe` selection, copying bounded diagnostics and opening the log at:

```text
%LOCALAPPDATA%\org.yulab.rho\logs\startup.jsonl
```

The required base-R probe, effective user-profile `.libPaths()` probe and
optional `aisdk` probe run in separate bounded processes. Rho passes successful
profile-derived library paths to Ark through `R_LIBS` and explicitly loads the
user `~/.Rprofile` and `~/.Renviron` in Workspace R. Project startup files do
not take precedence, and site profile code remains disabled. Values in the user
`.Renviron`, including credentials, are consequently visible to Workspace R.
If only `aisdk` fails, the workbench remains available and the Agent panel
reports `Unavailable` with an independent Retry Agent action.

## Implemented workflow

1. Rho discovers the local R installation and writes a controlled kernelspec
   in its application-data directory.
2. The bundled Ark binary starts one persistent authoritative Workspace R.
3. The source editor and Console execute against that same session.
4. Structured output populates Console, Problems, Plots and Environment.
5. Horizontal and vertical dividers resize the execution, Files and context
   panels; sizes restore per project and the execution panel has
   expand/restore.
6. Ask and Plan are read-only Agent modes. Act may approve `run_r` calls.
7. Agent R uses `YuLab-SMU/aisdk` and broker tools against the same Workspace R.
8. The broker persists execution and agent events in its SQLite store.
9. Native project selection restores the last opened project, open documents,
   cursor positions and panel sizes from the app-local data directory.
10. Missing project roots surface an explicit unavailable-project state instead
    of silently falling back to another directory.
11. External file changes refresh the tree and do not silently overwrite dirty
    editor content.
12. Monaco now provides the main R editing surface with syntax-aware
    highlighting, bracket matching and safe textarea fallback.
13. The editor can execute a selection, the current line or the whole source
    file while keeping execution in the same authoritative Workspace R.
14. User, agent and system executions now persist as durable run records with
    explicit lifecycle states in the broker-owned SQLite store.
15. Problems are now backed by structured execution records that retain
    execution ID, source path, retry linkage and recovery semantics.
16. Incomplete runs are marked on restart, active runs can be cancelled through
    bounded interrupt, and the Runs panel now reflects durable run history.
17. Ask and Plan mutations are rejected by broker policy. Act approvals are
    single-use and bound to the exact code and workspace revision shown in UI.
18. Agent turns and approval outcomes persist independently from Workspace R;
    restart interrupts orphaned turns and approvals explicitly.
19. Environment reports R, library paths, `renv`, Bioconductor, attached
    packages and optional render capabilities from bounded Workspace probes.
20. Data-frame, matrix, vector and list previews cap rows, columns, items and
    individual value size before JSON serialization.
21. Plot history links images to run, source path, document version and
    workspace revision, marking incomplete provenance explicitly.
22. `.Rmd` and `.qmd` rendering is restricted to the active project root and
    reports missing tooling or render failures through structured runs.
23. The Agent composer now exposes a compact model selector for the next turn
    and disables Act automatically for models without confirmed tool support.
24. `Manage LLMs...` provides global provider/model configuration, effective
    user `.Renviron` opening, credential refresh and bounded connection tests
    without storing API keys in Rho-owned files.

The installed build was verified to launch Ark from:

```text
%LOCALAPPDATA%\Rho\resources\runtime\ark.exe
```

## Prototype verification

```powershell
target\debug\rho-desktop.exe --smoke-test
target\debug\rho-desktop.exe --smoke-agent
```

The repository does not track the 23 MB Ark executable. Run the Phase 0 Ark
bootstrap before `scripts/build-windows-installer.ps1`; the build script copies
the pinned, checksum-verified binary into the temporary desktop resource tree.

The desktop smoke test creates a data frame, receives a real plot, and finds
the object in the Environment snapshot. The Agent smoke test additionally
runs a real configured Agent model turn against that live workspace.

Browser-mode UI verification covers 1280 by 720 and the minimum 1024 by 680
window size. Run, Plots, Environment, the Agent model selector and the
Manage LLMs dialog were exercised without incoherent overlap. Resizer keyboard
controls, persisted sizes, execution-panel expansion, minimum-window clamping
and Monaco frontend loading are also covered.

## Deliberately deferred

- bounded local completion and richer R language features;
- persistent multi-turn ChatSession context beyond durable turn history;
- paged full-table viewers and standalone HTML artifact viewers;
- richer job management beyond the current bounded cancellation/restart model;
- automatic R/aisdk installation and operating-system credential vault
  integration;
- installer signing, auto-update and external distribution hardening;
- macOS and Linux packaging.

These are productization items, not blockers for evaluating the Windows
workbench shape and the shared Workspace R/Agent R architecture.

## Panel interaction

The execution dock is separated from the editor by a draggable horizontal
divider. Drag it upward to inspect a larger Plot or Problems surface; drag it
downward to return more space to the editor. Double-click the divider restores
the default height. The Files and Agent/Environment columns have equivalent
vertical dividers. All three sizes persist locally, support keyboard arrow
adjustment when focused, and the execution dock has an expand/restore button.
