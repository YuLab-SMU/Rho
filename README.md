# Rho

Rho — R-centered Human–AI Orchestration — is a local-first desktop workbench
for R. It combines a persistent Workspace R session, project-aware editing,
scientific outputs, and an AI collaborator in one application.

## What it does

- edits and runs R code against one persistent Ark-backed Workspace R session;
- presents Console output, Environment objects, plots, problems, and durable
  run history with project provenance;
- supports Ask, Plan, and reviewed Act workflows through a separate Agent R
  process;
- admits exact R/rig/renv/pak and Python/uv project toolchains from
  `rho.toml`, with explicit effect journals and environment receipts;
- manages model providers, capabilities, routes, and credentials;
- previews Agent file proposals before applying them;
- hosts bounded project plugins and typed plugin surfaces;
- exposes read-side workbench data through the local CLI and MCP server.

The Rust desktop broker owns process lifecycle, projects, revisions,
permissions, persistence, and transport. Workspace R owns live R execution and
scientific objects. React owns presentation, not authority.

## Requirements

- Windows 10/11 with WebView2, Apple Silicon macOS 14+, or a supported Linux
  desktop environment;
- R 4.4 or later;
- `aisdk` and configured model credentials only for Agent features.

## Develop

```bash
npm install --prefix desktop
npm run rsr:dev --prefix desktop
```

Run the Rust desktop from a second terminal when needed:

```bash
cargo run -p rho-desktop
```

The fast workflow and affected-check discovery are documented in
[Development](docs/DEVELOPMENT.md). Start with the compact
[documentation map](docs/README.md) or the current
[architecture](docs/ARCHITECTURE.md).

## Build

```bash
npm run rsr:build --prefix desktop
cargo build -p rho-desktop
```

Platform packaging, signing, and candidate operations are mapped in
[Build and release](docs/RELEASE.md). Generated artifacts and command output are
the evidence for a particular build.

## Privacy and security

Rho has no first-party background telemetry. Network-capable operations follow
an explicit product action, such as using a model provider, resolving a DOI,
managing an R environment, or running approved code. Read the
[privacy policy](PRIVACY.md), report vulnerabilities through
[SECURITY.md](SECURITY.md), and review [code signing](CODE_SIGNING_POLICY.md)
before distributing a build.

Uninstalling Rho does not automatically remove projects, local application
data, logs, or stored provider credentials.

## License

Rho-original source, documentation, tests, and scripts are licensed under
[AGPL-3.0-only](LICENSE). Bundled dependencies retain their own licenses; see
[LICENSES.md](LICENSES.md). Read [CONTRIBUTING.md](CONTRIBUTING.md) before
submitting changes.
