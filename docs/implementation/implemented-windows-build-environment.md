# Rho Windows Build Environment

Status: implemented and actively maintained

Date: 2026-07-21
Validated release: `0.2.0-dev.11`

Release automation for later candidates runs
`scripts/prepare-runtime-resources.ps1` after Ark bootstrap and before release
metadata validation. The script copies the ignored `ark.exe`, `LICENSE` and
`NOTICE` resources into the Tauri resource directory with SHA-256 verification;
the installer builder reuses the same script.
Repository root: `D:\Rho`

## Purpose

This document is the build and acceptance contract for the current Windows
prototype. An implementation agent should read it before changing desktop,
runtime, packaging or release code.

The current release build is intentionally Windows x64 only. It uses Tauri 2,
Rust, R, Ark and the existing `aisdk` R packages. It does not use Python,
Jupyter Server, JupyterLab or Electron.

## Authority And Non-Goals

- `scripts/build-windows-installer.ps1` is the authority for the release build
  target and machine-local tool paths.
- `scripts/bootstrap-ark-windows.ps1` is the authority for acquiring Ark and
  generating its controlled kernelspec.
- `runtime/ark.json` is the authority for the Ark version, URL and checksum.
- `Cargo.lock` is the authority for Rust dependency versions.
- Do not commit the Ark executable. It is downloaded into `.rho/runtime` and
  copied into `desktop/resources/runtime` only for packaging.
- Do not modify or reinstall the `aisdk` family merely to make a build pass.
- Do not automatically install the newly built Rho over a version the user is
  currently running.

## Verified Machine Snapshot

These are the versions and paths used on the current development machine. The
paths are machine-specific; the versions and targets describe the environment
that produced the validated installer.

| Component | Verified value |
| --- | --- |
| OS | Windows x64, kernel `10.0.26200` |
| PowerShell | Windows PowerShell `5.1.26100.8875`, Desktop edition, 64-bit |
| Git | `2.49.0.windows.1` |
| R | `4.6.0` UCRT |
| Rscript shim | `E:\software-data\scoop\shims\rscript.exe` |
| R home | `E:\software-data\scoop\apps\r\current` |
| Node.js | `24.12.0` |
| npm / npx | `11.6.2` |
| Rust / Cargo | `1.97.0` |
| Release Rust host | `x86_64-pc-windows-gnu` |
| Rtools compiler | Rtools45 GCC `14.3.0` |
| Ark | `0.1.252`, Windows x64 |
| Tauri Rust crate | `2.11.5` |
| Tauri CLI | pinned `2.11.4` |
| WebView2Loader.dll | `1.0.3650.58`, x64 |
| aisdk | `1.5.0` |
| aisdk.console | `0.1.0` |
| rlang | `1.3.0` (required by aisdk `1.5.0`) |

Current R library paths are:

```text
E:\software-data\RLibrary
E:\software-data\scoop\persist\r\site-library
E:\software-data\scoop\apps\r\4.6.0\library
```

The installer itself requires R 4.4 or later at runtime. R 4.6.0 is the
version used for current build and smoke-test evidence, not yet the declared
minimum runtime version.

## Machine-Local Build Paths

The installer script currently sets these paths explicitly:

```text
CARGO_HOME=E:\software-data\scoop\persist\rustup\.cargo
RUSTUP_HOME=E:\software-data\scoop\persist\rustup\.rustup
RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
Rtools bin=C:\rtools45\x86_64-w64-mingw32.static.posix\bin
```

Verify them before building:

```powershell
Test-Path E:\software-data\scoop\persist\rustup\.cargo
Test-Path E:\software-data\scoop\persist\rustup\.rustup
Test-Path C:\rtools45\x86_64-w64-mingw32.static.posix\bin
Test-Path D:\Rho\desktop\resources\WebView2Loader.dll
```

There are two Rust selections to distinguish:

- entering the repository normally activates
  `1.97.0-x86_64-pc-windows-msvc` through `rust-toolchain.toml`;
- the Windows installer script deliberately overrides this with
  `stable-x86_64-pc-windows-gnu` and places the Rtools GCC directory first on
  `PATH`.

The installer script is the release authority. An agent must not assume the
interactive `rustup` default is the packaging target.

The installer script also applies Rust `--remap-path-prefix` flags to the Cargo
home and repository root. Release panic metadata must not present a developer
machine path as if it were a runtime dependency.

## External And Cached Inputs

A clean first build may require network access for:

- the checksum-pinned Ark archive from the Posit Ark GitHub release;
- Rust crates referenced by `Cargo.lock`;
- checksum-resolved `@tauri-apps/cli@2.11.4` invoked through `npx`;
- Tauri's NSIS bundling tools if they are not already cached.

Ark is pinned exactly in `runtime/ark.json`:

```text
version: 0.1.252
sha256: A6C2C6AE931D0DD5E1F771243BF3DF4F86968462BBD8E08CEEBA7F2E53567E58
```

The Tauri CLI is pinned to `2.11.4`. For a build report, record the resolved
CLI version and do not silently update the script or `Cargo.lock` as part of
unrelated feature work.

## R And Ark Bootstrap

From a fresh PowerShell session:

```powershell
Set-Location D:\Rho
Rscript -e "cat(R.version.string, '\n'); cat(R.home(), '\n'); cat(paste(.libPaths(), collapse='\n'))"
powershell -ExecutionPolicy Bypass -File scripts\bootstrap-ark-windows.ps1
```

The bootstrap script:

1. resolves `R_HOME`, the R DLL directory and `.libPaths()` through the active
   `Rscript`; the probe reads the effective user library configuration once,
   then Ark receives the resulting `R_LIBS` while still running without user or
   site profile scripts;
2. downloads Ark only when the pinned executable is absent;
3. verifies the archive SHA-256 before extraction;
4. writes `.rho\runtime\ark-0.1.252\kernel.json` as UTF-8 without BOM;
5. starts Ark with user, site and project startup files disabled;
6. preserves the selected R home, package libraries and R DLL search path in
   the generated kernelspec.

The controlled startup is intentional. User or project `.Rprofile` files can
break a headless Ark session and must not be re-enabled during packaging work.

Expected bootstrap files:

```text
.rho\runtime\ark-0.1.252\ark.exe
.rho\runtime\ark-0.1.252\kernel.json
.rho\runtime\ark-0.1.252\LICENSE
.rho\runtime\ark-0.1.252\NOTICE
```

## Validation Before Packaging

Run the narrow checks first, then the workspace suite:

```powershell
Set-Location D:\Rho
node --check desktop\dist\app.js
Rscript -e "testthat::test_local('r/rho.bridge')"
Rscript -e "testthat::test_local('r/rho.agent')"
cargo test --workspace
```

For release-target validation, repeat Rust tests with the same GNU environment
used by the packaging script:

```powershell
$env:CARGO_HOME = 'E:\software-data\scoop\persist\rustup\.cargo'
$env:RUSTUP_HOME = 'E:\software-data\scoop\persist\rustup\.rustup'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:PATH = 'C:\rtools45\x86_64-w64-mingw32.static.posix\bin;' + $env:CARGO_HOME + '\bin;' + $env:PATH
cargo test --workspace
```

The model credential and network are not required for Rust tests, bridge
tests, editor/Console use, plot generation or Environment inspection. They are
required only for a real Agent-model smoke test and Manage LLMs connection
checks.

## Building The Installer

The canonical build command is:

```powershell
Set-Location D:\Rho
powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1
```

The script performs these steps:

1. selects the GNU Rust toolchain and Rtools45 linker;
2. requires the bootstrapped Ark runtime;
3. copies `ark.exe`, `LICENSE` and `NOTICE` into the Tauri resource tree;
4. runs `npx.cmd -y "@tauri-apps/cli@2.11.4" build` from
   `desktop\src-tauri`;
5. creates the per-user x64 NSIS installer.

For GitHub Actions, the same script also supports environment-variable
injection for `CARGO_HOME`, `RUSTUP_HOME`, `RTOOLS_BIN` and
`RUSTUP_TOOLCHAIN`, and it exports the resolved installer path through
`GITHUB_OUTPUT`. When those variables are absent, the script still keeps the
local-machine fallback behavior and prefers the standard user-profile Rust
directories before using the existing workstation-specific defaults.

Expected outputs:

```text
D:\Rho\target\release\rho-desktop.exe
D:\Rho\target\release\bundle\nsis\Rho_0.2.0-dev.11_x64-setup.exe
```

Validated `0.2.0-dev.11` artifact snapshot:

```text
Installer size: 15,853,736 bytes
Installer SHA-256: BD7CF9349DF58A8E2373D2B81ED80529DEC92E8334DFCA85AA39DC6F993667E8
rho-desktop.exe size: 39,744,648 bytes
rho-desktop.exe SHA-256: 23FDA678C7BA0455D8B05FA29E885D9404CCC5D9953B904128E1FD4491FB4EEB
```

The hash identifies the already validated artifact only. A legitimate rebuild
can have a different hash because timestamps and packaging metadata may
change.

## Package Contents And Runtime Requirements

The NSIS installer must contain or install:

- `rho-desktop.exe`;
- Ark `0.1.252` plus its license and notice;
- `WebView2Loader.dll` for the GNU Windows build;
- the embedded HTML, CSS and JavaScript frontend.

The target machine must provide:

- Windows 10 or Windows 11 x64;
- Microsoft Edge WebView2 Runtime;
- R 4.4 or later;
- `aisdk` plus at least one valid configured Agent model only when Agent turns
  are used;
- all `aisdk` runtime dependencies at their declared versions, including
  `rlang >= 1.3.0` for `aisdk 1.5.0`.

Rho supports `RHO_RSCRIPT` for an explicit `Rscript.exe` when automatic R
discovery cannot find the intended installation.

The installer is currently unsigned. A SmartScreen unrecognized-publisher
warning is expected and is not itself a build failure.

## Manual GitHub Release Workflow

The repository now provides `.github/workflows/windows-manual-publish.yml` for
a manually triggered Windows release that publishes directly to GitHub
Releases.

This workflow now runs on GitHub-hosted `windows-latest`. It installs Node.js,
R, Rtools45 and the GNU Rust toolchain explicitly, then calls the same
repository scripts used for local builds. The workflow injects `CARGO_HOME`,
`RUSTUP_HOME`, `RTOOLS_BIN` and `RUSTUP_TOOLCHAIN` into
`scripts/build-windows-installer.ps1`, while the local script keeps working
without those overrides.

The workflow inputs are:

- `ref`: the ref to build;
- `release_tag`: a new GitHub release tag;
- `release_name`: the release title shown on GitHub;
- `prerelease`: whether the release should be published as a prerelease;
- `run_smoke_test`: whether to run `target\release\rho-desktop.exe --smoke-test`
  before publishing.

Each run bootstraps Ark, builds the NSIS installer, computes a `.sha256` asset,
optionally runs the non-Agent smoke test, creates or updates a GitHub Release,
and uploads both files without using a draft stage.

## Smoke And Acceptance Checks

Development smoke checks:

```powershell
target\debug\rho-desktop.exe --smoke-test
target\debug\rho-desktop.exe --smoke-agent
```

`--smoke-test` must verify that the same persistent Workspace R can execute R
code, create a data frame, return a plot and expose the object in Environment.
`--smoke-agent` additionally requires a configured Agent model and must
exercise Agent R without creating a second scientific workspace.

For an installer acceptance run:

1. close any running Rho instance before installing;
2. install the generated NSIS package per user;
3. launch Rho from the Start Menu;
4. confirm Ark starts from `%LOCALAPPDATA%\Rho\resources\runtime\ark.exe`;
5. execute `x <- 1:5`, inspect `x` in Environment and create a plot;
6. resize each workbench divider and confirm the sizes persist after restart;
7. open, edit and save a project file without leaving the project root;
8. open `Manage LLMs...`, verify the effective user `.Renviron` path, refresh
   credential detection and run one bounded connection test without exposing a
   key value;
9. run an Ask and an Act Agent turn only when credentials and network are
   available, including a chat-only model if one is configured;
10. record the installer path, size, hash and all failed or skipped checks.

Do not overwrite an installed build while its Workspace R is active. Building
an installer does not require automatically installing it.

## Common Failures

### Ark runtime not found

Run `scripts\bootstrap-ark-windows.ps1` and verify the pinned executable below
`.rho\runtime\ark-0.1.252`.

### Wrong Rust linker or target

Check `RUSTUP_TOOLCHAIN`, `CARGO_HOME`, `RUSTUP_HOME` and the Rtools45 `PATH`
prefix. The packaging target must be GNU even though the repository's normal
directory override selects MSVC.

### R package or DLL load failure

Verify which `Rscript` is active, then inspect `R.home()` and `.libPaths()`.
Regenerate the Ark kernelspec after changing R installations or libraries.
Also run `Rscript -e "loadNamespace('aisdk')"`; a package directory can exist
while namespace loading still fails because a dependency version is stale.

### `npx` hangs or attempts a download

The script requests the Tauri CLI through npm. Confirm network policy and npm
cache state. Record the resolved CLI version. Do not replace Tauri or introduce
Electron as a workaround.

### WebView is blank or the executable does not start

Verify the Microsoft Edge WebView2 Runtime on the machine and ensure the x64
`WebView2Loader.dll` remains in the bundle resources.

### R discovery or runtime probe fails

Rho must keep its recovery window open. Use Retry or choose `Rscript.exe`
directly, then copy diagnostics from the recovery view. Startup events append
to `%LOCALAPPDATA%\org.yulab.rho\logs\startup.jsonl`; the log includes the selected R path,
exit code, bounded stdout/stderr and elapsed time. An `aisdk` failure is an
optional Agent capability failure and must not block Workspace R.

### Agent smoke test fails while R execution works

Treat provider credentials, provider network access and `aisdk` configuration
as a separate runtime concern. A model-network failure does not invalidate the
non-Agent desktop build, but it must be reported as a skipped or failed Agent
acceptance gate. The same rule applies to Manage LLMs connection tests.

## Required Build Report

An implementation agent handing work back for review must provide:

- commit or complete working-tree diff;
- `git status --short` output summary;
- exact Rust, R, Node, Tauri CLI and Ark versions used;
- commands run and exact test results;
- installer path, byte size and SHA-256;
- manual workflows tested and screenshots when UI behavior changed;
- skipped checks and the reason for each skip;
- known limitations;
- an explicit statement that no aisdk family repository was changed, or a
  separately approved explanation if it was.

