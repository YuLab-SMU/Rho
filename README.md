# Rho

**Rho** stands for **R-centered Human–AI Orchestration**: an agent-native
desktop workbench for R. It combines a persistent R workspace, project-aware
code editing, scientific outputs, and an AI collaborator in one application.
The user remains in control: editor, Console, and approved Agent actions all
work with the same live Workspace R session.

## Features

- **Project-aware R editing** with a Monaco editor, multiple documents, a real
  file tree, source execution, and project/session restoration.
- **One persistent Workspace R** powered by Ark, shared by manual Console work,
  editor execution, and approved Agent actions.
- **Scientific output surfaces** for Console output, Environment objects,
  plots, Problems, and durable run history with provenance.
- **Ask, Plan, and Act modes** for explanation, planning, and reviewed actions
  against the current project and R session.
- **Provider-first model settings** with model discovery, visible capability
  evidence, explicit capability routing, optional Base URL overrides, and API
  keys kept in the operating system credential store.
- **Reviewable file changes** so Agent-proposed project edits can be inspected
  before they are applied.
- **Resizable, persistent workspace layout** for Files, editor, Agent,
  Environment, Console, Plots, and Problems.
- **Local-first runtime** with no Python, Jupyter Server, JupyterLab, or
  Electron dependency.

## Installation

Rho currently has development builds for Windows x64 and Apple Silicon macOS.
It requires:

- Windows 10/11 with Microsoft Edge WebView2 Runtime, or Apple Silicon macOS
  14 or later;
- R 4.4 or later;
- `aisdk` 1.5.0 or later and a configured model only for Agent features; the
  pinned
  `aisdk.providers` package is additionally required when using DeepSeek,
  Moonshot, Kimi Code, Stepfun, Volcengine, AiHubMix, xAI, OpenRouter, Bailian,
  or NVIDIA.

Listed Apple Silicon macOS packages use Developer ID signing and notarization.
Windows trust status is recorded per release. The published `0.4.0-dev.24`
Windows package is unsigned; selected development prereleases may carry a
SignPath Free Trial self-signed test signature only after their exact evidence
passes. Starting with the fresh dev.42 candidate contract, both the Rho
executable and outer NSIS installer must be signed and the installed executable
must be verified. That test certificate is not publicly trusted or a SignPath Foundation production
publisher, and Windows or SmartScreen may still warn. A Release page also
identifies any conditional human-acceptance limitations; conditional builds are
for evaluation, not stable or production-ready use. Unsigned local builds are
for development review only. Verify the release SHA-256 and see the
[Windows prototype guide](docs/implementation/implemented-windows-prototype.md)
and the [macOS support specification](docs/plans/active-2026-08-05-macos-arm64-support-spec.md)
for platform-specific status and prerequisites.

## Quick Start

1. Launch Rho and open an R project directory.
2. Open or create an `.R` file, then run a selection, the current line, or the
   complete file in Workspace R.
3. Inspect results in Console, Environment, Plots, Problems, and Runs.
4. Open **Model settings**, create a Provider connection, import or add a
   model, then assign that model to the routes you intend to use.
5. Use Ask or Plan for read-only help, or Act for actions that require review
   and approval.

## Uninstallation

- **Windows:** Open **Settings > Apps > Installed apps**, find **Rho**, choose
  **Uninstall**, and follow the installer prompts.
- **macOS:** Quit Rho, then move **Rho.app** from **Applications** to the
  Trash.

Uninstalling the application does not automatically delete project files,
local application data, logs, or operating-system credential-store entries.
Remove Provider credentials from Model settings before uninstalling when
possible, and review the [Privacy policy](PRIVACY.md) before deleting retained
data manually.

## Architecture

Workspace R is authoritative for project execution and scientific objects.
Agent R handles LLM orchestration, while the Rust broker owns transport,
approvals, revisions, persistence, and process lifecycle. See the
[architecture documentation](docs/architecture/implemented-aisdk-family-integration.md)
for details, or use the [documentation index](docs/README.md) to browse design,
implementation, project, bug-fix, and release documents.

## Project Status

Rho is under active development. Windows packaging, Apple Silicon macOS
packaging, and the core project workflow are implemented; installed-candidate
acceptance, release signing/publication, macOS x64, and Linux packaging remain
in progress.

## Security, Privacy, And Signing

Rho does not perform automatic update checks or first-party background
telemetry. Network-capable operations follow an explicit user action, such as
checking for updates, connecting a model Provider, resolving a DOI, operating
on a package environment, or running user/approved code. Review the complete
[Privacy policy](PRIVACY.md), especially before configuring a custom Base URL
or sharing diagnostics.

Report vulnerabilities through the private process in the
[Security policy](SECURITY.md), not through a public Issue. Windows and macOS
trust status, signing scope, manual approval, and incident handling are defined
in the [Code signing policy](CODE_SIGNING_POLICY.md).

## License

Rho-original source code, documentation, tests, and scripts are licensed under
the [GNU Affero General Public License version 3 only](LICENSE)
(`AGPL-3.0-only`), except where a file or directory carries a different
notice. Copyright © 2026 YuLab-SMU and contributors.

Commercial use is permitted. If you distribute a modified version, or let
users interact with a modified version over a network, the AGPL requires the
corresponding source to remain available under its terms. Rho does not offer a
proprietary dual license.

This change is prospective: licenses already granted for historical Rho
versions or copies remain valid. Bundled and vendored third-party components
retain their own licenses; see [Licensing and third-party notices](LICENSES.md).
See [Contributing](CONTRIBUTING.md) before submitting changes.
