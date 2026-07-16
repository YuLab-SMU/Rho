# Windows prototype

Date: 2026-07-16

## Installer

The current internal prototype installer is generated at:

```text
D:\Rho\target\release\bundle\nsis\Rho_0.2.0-dev.1_x64-setup.exe
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
- `aisdk` and a configured DeepSeek provider for Agent turns.

The editor, Console, Environment and Plots work without a model credential.
Only the Agent panel requires aisdk and its provider configuration. Python,
Jupyter Server and JupyterLab are not installed or used.

`RHO_RSCRIPT` may be set to an explicit `Rscript.exe` path when R is installed
in a nonstandard location.

## Implemented workflow

1. Rho discovers the local R installation and writes a controlled kernelspec
   in its application-data directory.
2. The bundled Ark binary starts one persistent authoritative Workspace R.
3. The source editor and Console execute against that same session.
4. Structured output populates Console, Problems, Plots and Environment.
5. Horizontal and vertical dividers resize the execution, Files and context
   panels; sizes persist locally and the execution panel has expand/restore.
6. Ask and Plan are read-only Agent modes. Act may approve `run_r` calls.
7. Agent R uses `YuLab-SMU/aisdk` and broker tools against the same Workspace R.
8. The broker persists execution and agent events in its SQLite store.

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
runs a DeepSeek read-only turn against that live workspace.

Browser-mode UI verification covers 1280 by 720 and the minimum 1024 by 680
window size. Run, Plots, Environment and the Act-mode Agent timeline were
exercised without incoherent overlap. Resizer keyboard controls, persisted
sizes, execution-panel expansion and minimum-window clamping are also covered.

## Deliberately deferred

- Monaco Editor and language-aware completion;
- native project selection and a real filesystem tree;
- saving multiple source documents;
- persistent ChatSession history across Agent R restarts;
- interactive approval dialogs instead of mode-level Act approval;
- paged data viewers, plot history and HTML viewers;
- full cancellation/crash recovery UX;
- automatic R/aisdk installation and credential settings UI;
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
