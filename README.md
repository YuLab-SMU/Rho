# Rho

Rho is an agent-native desktop workbench for R. It combines a persistent R
workspace, project-aware code editing, scientific outputs, and an AI
collaborator in one application. The user remains in control: editor, Console,
and approved Agent actions all work with the same live Workspace R session.

## Features

- **Project-aware R editing** with a Monaco editor, multiple documents, a real
  file tree, source execution, and project/session restoration.
- **One persistent Workspace R** powered by Ark, shared by manual Console work,
  editor execution, and approved Agent actions.
- **Scientific output surfaces** for Console output, Environment objects,
  plots, Problems, and durable run history with provenance.
- **Ask, Plan, and Act modes** for explanation, planning, and reviewed actions
  against the current project and R session.
- **Configurable LLMs** with provider/model selection, tool-capability checks,
  and credentials read from the effective user `.Renviron`.
- **Reviewable file changes** so Agent-proposed project edits can be inspected
  before they are applied.
- **Resizable, persistent workspace layout** for Files, editor, Agent,
  Environment, Console, Plots, and Problems.
- **Local-first runtime** with no Python, Jupyter Server, JupyterLab, or
  Electron dependency.

## Installation

Rho is currently an unsigned Windows x64 development prototype. It requires:

- Windows 10 or Windows 11 with Microsoft Edge WebView2 Runtime;
- R 4.4 or later;
- `aisdk` and a configured model only for Agent features.

The current internal installer is generated at:

```text
target\release\bundle\nsis\Rho_0.2.0-dev.11_x64-setup.exe
```

Windows SmartScreen may display an unrecognized-publisher warning. See the
[Windows prototype guide](docs/windows-prototype.md) for prerequisites and
installation details.

## Quick Start

1. Launch Rho and open an R project directory.
2. Open or create an `.R` file, then run a selection, the current line, or the
   complete file in Workspace R.
3. Inspect results in Console, Environment, Plots, Problems, and Runs.
4. Open **Manage LLMs...** to configure an Agent provider and model when AI
   assistance is needed.
5. Use Ask or Plan for read-only help, or Act for actions that require review
   and approval.

## Architecture

Workspace R is authoritative for project execution and scientific objects.
Agent R handles LLM orchestration, while the Rust broker owns transport,
approvals, revisions, persistence, and process lifecycle. See the
[architecture documentation](docs/architecture/aisdk-family-integration.md)
for details.

## Project Status

Rho `0.2.x` is under active development as a Windows daily-use prototype.
Windows packaging and the core project workflow are implemented; release
hardening, signing, and macOS/Linux packaging remain in progress.

## Documentation

- [Windows prototype and user workflow](docs/windows-prototype.md)
- [Windows build and acceptance guide](docs/windows-build-environment.md)
- [Development roadmap](docs/development-roadmap.md)
- [Phase 0 implementation evidence](docs/phase-0-status.md)
- [Agent and aisdk architecture](docs/architecture/aisdk-family-integration.md)
- [Release notes](NEWS.md)
