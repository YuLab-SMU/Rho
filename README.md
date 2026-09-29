# Rho

Rho is a local scientific workspace for writing R code, running an analysis,
inspecting objects and figures, and revising the work in one Studio.

Project files, a persistent R session, reproducible environments and native
process/job execution share one Host. People use the browser workbench; external
Agents use the same scientific capabilities. The Agent platform owns conversation
and planning, while Rho executes requests and reports observed results.

## Run Studio

Build with the pinned Rust toolchain, then launch the local workbench:

```sh
cargo build --locked
target/debug/rho workbench
```

Open the private URL printed by the command and select a project directory.
Choose an installed workspace view, then use **Plugins → Scenarios → New R
workspace** to compose the scientific tools with existing R and Ark paths.
Startup uses the ordinary plugin composition. Packages must currently be imported
explicitly; an empty repository shows recovery instructions. Runtimes and packages
are not installed automatically. See [Operations](docs/OPERATIONS.md) for setup.

For a guided real project, use **Open Rho Demo** on the welcome page, or launch
it directly after building:

```sh
target/debug/rho --demo-project workbench
```

The demo is a materialized Gapminder project. After preparing a scientific scenario,
run `run_demo.R` in Editor to
populate real R objects, Plots output, generated files and an HTML report for
Viewer. It uses base R and does not install packages or send Agent requests.

The binary embeds its HTML, CSS, JavaScript and bundled frontend assets; Node is
not required to run it. The server listens on `127.0.0.1`. Its authenticated `/mcp`
endpoint shares the live session with Studio; standalone stdio MCP is also available.
See [Operations](docs/OPERATIONS.md) for explicit paths and other entry points.

## Current work

The local edit/save/run/object/plot loop has been verified on macOS with Chrome.
The current focus is professional Studio interaction: component management,
group docking, English UI, R highlighting, Console flow, inline object inspection
and plot viewing. These user-reported experience issues remain open.

Start with [Current state](docs/STATUS.md), the proposed
[design philosophy](docs/RHO-DESIGN.md), and [Studio feedback](docs/STUDIO-FEEDBACK.md).
Functional verification is separate from product usability acceptance.

## Develop

The root Cargo workspace builds `rho`. Rust lives in `crates/`, native R helpers
in `r/`, the React/TypeScript client in `ui/`, and verification tools in `scripts/`.
Read [Architecture](docs/ARCHITECTURE.md) and [Development](docs/DEVELOPMENT.md)
for ownership, frontend iteration and focused checks.

Native execution uses the local user's OS access. Rho preserves partial and
uncertain outcomes; a cancellation request does not prove work stopped.
[Build and release](docs/RELEASE.md) describes the current binary artifact and
separates building from signing, installation and publication.

## License and reporting

Rho-original work uses [AGPL-3.0-only](LICENSE). Dependencies retain their own
licenses; see [third-party notices](LICENSES.md). See [Privacy](PRIVACY.md)
for data handling and [Security](SECURITY.md) for private vulnerability reporting.
