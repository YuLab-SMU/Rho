# Source Install Diagnostic Script

Status: active; direction and key decisions authorized by the project owner on
2026-08-20 ("对于可能不兼容的 unix-like 系统,可以通过这个脚本,自动编译并安装
... 缺乏这些要报出来的信息,包括可以通过安装什么包"; decisions recorded below).
S1 implementation complete on 2026-08-20: `scripts/install-from-source.sh` and
`scripts/test-install-from-source.sh` merged into the repository after PR #79
landed (linux-arm64 bootstrap wiring is in `main`); S1-A..S1-D acceptance gates
below are satisfied with the verification record at the end of this document.

Date: 2026-08-20 (authored and activated)

Scope: one maintainable source-install script for Linux systems that are
not covered by the official installer artifacts (Windows NSIS, macOS DMG,
Linux AppImage/deb). The script detects the platform, checks toolchain and
system dependencies, reports every missing requirement together with the
distro-specific package that provides it, builds the desktop binary from
source, and installs it under a configurable prefix.

Cross-reviewed against:

- `docs/project/active-development-governance.md` (proposal-to-release
  lifecycle, risk/test depth, evidence rules);
- `docs/project/active-document-cross-review.md` (this document is added to
  the status matrix in the same change);
- `docs/plans/active-2026-08-11-linux-appimage-support.md` — the project owner
  explicitly rejected the GNU autotools model (`./configure; make; make
  install`). This script does not reintroduce that model: it is a
  diagnostics-driven build-and-install helper, not an autotools-configured
  source tree;
- `docs/plans/active-2026-08-10-rust-msrv-build-contract.md` — the build uses
  the repository `rust-toolchain.toml` (channel 1.97.0); the script does not
  change MSRV policy or CI matrix semantics;
- `docs/plans/implemented-2026-08-17-three-platform-automatic-updater-dev43-spec.md`
  — official installers and the updater channel remain the authoritative
  distribution path on supported platforms; this script installs a plain
  `rho-desktop` binary with no updater wiring and must not be described as an
  official update channel.

## Summary

Rho ships official installers for Windows x64, macOS arm64, and Linux x86-64
(AppImage and deb). A user on another Linux system (other distributions, other
architectures such as arm64) has no installer. The project owner wants a
source-install path for those users: run one script, get a clear
report of what the build needs and how to install it on this specific system,
build from source, and install the result. The script is also a collaboration
surface: a user who cannot use an installer can have an AI run the script,
feed the diagnostics back, and extend the script when their platform needs a
different package name — eventually contributing a PR so the next user on that
platform gets a mapped report.

## Decisions Recorded With The Project Owner (2026-08-20)

1. Dependency handling: the script **only reports** missing toolchain/system
   requirements and the distro-specific packages that provide them. It never
   installs packages, never invokes a package manager, never prompts for
   `sudo`. (Owner: "始终只报告,绝不自动安装")
2. Install location: system-level `PREFIX/bin` with `PREFIX=/usr/local` as
   default, overridable with `--prefix` (owner: "系统级 /usr/local/bin,支持
   --prefix 覆盖"). The script does not self-escalate; when the prefix is not
   writable it reports the exact command to run with `sudo` or with an
   alternative prefix.
3. Platform scope: Linux only, and the supported set follows the Ark R
   sidecar manifest `runtime/ark.json` (owner review on 2026-08-20: "如果ark是
   linux-64 only的话,那么BSD我们可以直接说不支持了... 我们能支持的平台,就取决于
   ark所支持的平台"). The manifest declares `linux-x64` and `linux-arm64`,
   and both are fully wired through `scripts/bootstrap-ark-linux.sh` (the
   PR #79 arm64 follow-up landed in the S1 slice: the bootstrap and runtime
   preparation scripts consume the `linux-arm64` manifest entry and stage
   `binaries/ark-aarch64-unknown-linux-gnu`). BSD is explicitly rejected: Ark
   has no BSD build, so R sessions could never work there. Precise
   package-name maps are provided for common Linux package managers
   (apt/dnf/pacman/zypper/apk); unknown distributions fall back to a generic
   report plus an explicit invitation to contribute a package map via PR.

## Goals

This work will:

- provide `scripts/install-from-source.sh` that:
  - detects `uname -s`/`uname -m` and (on Linux) `/etc/os-release`;
  - checks the build toolchain (cargo/rustup, node, curl, unzip, file,
    Rscript) and system libraries via `pkg-config` (`webkit2gtk-4.1`,
    `gtk+-3.0`);
  - reports every missing requirement with: what it is for, the
    distro-specific package command that provides it (when mapped), and a
    pointer to `rustup`/system package docs where the distro package is known
    to lag (e.g. `cargo`);
  - supports `--json` output whose schema is stable enough for an AI or a
    human to act on the diagnostics;
  - supports `--prefix DIR` (default `/usr/local`), `--skip-ark`,
    `--skip-deps`, `--build-only`, and a hidden `--os-release FILE` override
    used by the fixture tests;
  - exits with a distinct, documented status code for "missing dependencies"
    vs "build failed" vs "install failed" so callers (human or AI) can branch
    on the cause;
  - after a successful build, installs `rho-desktop` into `$PREFIX/bin`
    without self-escalation;
  - prints a final report: installed path, version, and the platform
    limitations (Ark sidecar availability) that apply to this system;
- add `scripts/test-install-from-source.sh` fixture tests in the style of
  `scripts/test-bootstrap-ark-linux.sh` (negative fixtures with a fake
  `/etc/os-release` and a restricted PATH; no real network or package
  operations);
- wire the fixture test into the existing Linux validation lane in
  `.github/workflows/linux-appimage-build.yml` (same step family as the Ark
  bootstrap tests);
- document the script in `README.md` under Installation, clearly positioned
  as the fallback path for unsupported platforms, never as an official
  installer or update channel.

## Non-Goals

- No autotools-style `./configure; make; make install` (already rejected by
  the owner); the script is a diagnostics-driven helper over the existing
  cargo build.
- No official installer/package building: the script does not produce or
  install AppImage/deb/dmg artifacts and does not sign anything.
- No automatic dependency installation, package-manager invocation, or
  privilege escalation.
- No updater-channel integration; installed-from-source binaries are not
  updated by the official updater.
- No change to MSRV, CI matrix, or the official three-platform release lanes.
- No BSD support: Ark has no BSD build, so the script rejects non-Linux
  `uname -s` systems with an explicit message (owner decision 2026-08-20).
- No macOS arm64 support in v1 (official DMG covers it; brew mapping can be a
  follow-up PR, but `uname -s` detection is structured so it can be added).
- No `linux-arm64` **official AppImage/deb** distribution in this slice: the
  source-install path fully supports arm64 (bootstrap + build + install), but
  the official AppImage lane (`scripts/build-linux.sh`) remains x86-64 and the
  three-platform release lanes are unchanged; arm64 packaging is follow-up
  scope.

## Current Behavior And Compatibility Constraints

- The repository already contains everything needed to build the binary:
  `desktop/dist/` is tracked, so no frontend build step is required; the
  desktop crate is `rho-desktop` in the workspace; `rust-toolchain.toml`
  pins 1.97.0.
- `scripts/bootstrap-ark-linux.sh` downloads/verifies/stages the Ark linux-x64
  sidecar and writes a Linux kernelspec (needs curl, unzip, file, Rscript,
  node). It refuses non-x86-64 ELF and exits non-zero.
- `scripts/prepare-runtime-resources.sh` copies runtime LICENSE/NOTICE into
  the Tauri resource tree before building.
- `pkg-config` must find `webkit2gtk-4.1` and `gtk+-3.0` for the Tauri build
  to compile.
- The script must preserve the existing scripts' contract: it calls
  `bootstrap-ark-linux.sh` and `prepare-runtime-resources.sh` unmodified, in
  order, unless `--skip-ark` is given.
- Official distribution documents (README, linux-appimage-support spec) keep
  their authority: this script is an additional, clearly-marked fallback.

## User-Visible Behavior

### Synopsis

```
scripts/install-from-source.sh [--prefix DIR] [--json] [--skip-ark]
                               [--skip-deps] [--build-only] [--help]
```

### Diagnostics Phase (always runs first unless --skip-deps)

For each requirement the script prints one block:

```
MISSING COMMAND: cargo
  required for: building the rho-desktop binary
  suggest: install rustup (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)
           or install the distro package: <distro command> cargo
```

For pkg-config libraries:

```
MISSING LIBRARY: webkit2gtk-4.1
  required for: Tauri WebKitGTK 4.1 bindings (build-time headers and runtime library)
  suggest: <distro command> libwebkit2gtk-4.1-dev
```

When no map exists for the detected system the script prints an explicit
invitation:

```
NOTE: no package-name map for <os> yet; install the equivalent of
<requirement> with your system package manager, or open a PR to
scripts/install-from-source.sh to add a map for <os>.
```

If any requirement is missing, the script prints a summary
(`N missing requirements`), exits with code 2, and does not attempt to build.
With `--json` the summary is a single JSON object on stdout.

### Build Phase

Runs, in order: `scripts/bootstrap-ark-linux.sh`, `scripts/prepare-runtime-
resources.sh` (both skipped with `--skip-ark`), then
`cargo build --release -p rho-desktop` from the repository root. Build
failures exit with code 3.

### Install Phase

Installs `target/release/rho-desktop` to `$PREFIX/bin/rho-desktop` via
`install -m 755`. If `$PREFIX/bin` is not writable, the script prints the
exact command to run (prefix with `sudo` or pass `--prefix` to a writable
location) and exits with code 4 without touching anything. `--build-only`
skips this phase. After install, the script prints the installed path, the
`rho-desktop --version` value, and the Ark availability note for the current
platform/architecture.

### Exit Codes (documented, stable)

| code | meaning |
| --- | --- |
| 0 | installed (or built with --build-only) successfully |
| 1 | usage/argument error or unsupported `uname -s` (with an explicit message) |
| 2 | missing dependencies (report printed; nothing built) |
| 3 | build failed |
| 4 | install failed (prefix not writable) |

### JSON Schema (--json)

```json
{
  "os": "linux", "distro": "debian", "arch": "x86_64",
  "ok": false,
  "missing": [
    {"kind": "command", "name": "cargo", "purpose": "...", "suggest": "..."},
    {"kind": "library", "name": "webkit2gtk-4.1", "purpose": "...", "suggest": "..."}
  ],
  "warnings": ["no usable Ark sidecar for this platform; see runtime/ark.json"]
}
```

`ok: true` when nothing is missing. The schema is intentionally small and
stable; additions are additive.

## Platform Map (v1, best-effort, extensible)

| package manager | distros (os-release ID) | representative packages |
| --- | --- | --- |
| apt | debian, ubuntu, linuxmint, pop, elementary, zorin | build-essential curl unzip file pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev r-base |
| dnf | fedora, rhel, rocky, almalinux, centos | gcc gcc-c++ make curl unzip file pkgconf-pkg-config webkit2gtk4.1-devel gtk3-devel librsvg2-devel libappindicator-gtk3-devel openssl-devel R |
| pacman | arch, manjaro, endeavouros | base-devel curl unzip file pkg-config webkit2gtk-4.1 gtk3 librsvg libappindicator-gtk3 openssl r |
| zypper | opensuse, sles | gcc gcc-c++ make curl unzip file pkgconf-pkg-config webkit2gtk4-devel gtk3-devel librsvg2-devel libappindicator3-devel libopenssl-devel R-base |
| apk | alpine | build-base curl unzip file pkgconf webkit2gtk-4.1-dev gtk3-dev librsvg-dev libayatana-appindicator3-dev openssl-dev R |
| pkg | freebsd | not supported: Ark has no BSD build; `uname -s` other than Linux is rejected with an explicit message |

cargo/node suggestions prefer the version-manager route (rustup; nvm/volta or
distro nodejs) because distro packages can lag `rust-toolchain.toml`; both
options are printed.

Unknown systems: generic fallback + PR invitation (see Diagnostics Phase).

## Failure, Cancellation, Restart, Recovery

- Missing dependencies: exit 2 before any build; re-running after installing
  the reported packages resumes cleanly (no partial state).
- Build failure: exit 3; the script does not clean the cargo target dir (cargo
  incremental state is kept, so a retry resumes).
- Install failure (prefix not writable): exit 4; nothing is written; the user
  re-runs with `sudo` or `--prefix`.
- `--skip-ark`: explicit opt-out; on the wired Linux architectures
  (`x86_64`, `aarch64`/`arm64`) it skips an otherwise-working bootstrap, while
  on other Linux architectures (no Ark build in `runtime/ark.json`) the script
  warns and skips the bootstrap automatically because it could not succeed;
  the final report then states that R sessions will not work.
- The script never mutates the repository beyond what the existing bootstrap
  scripts already do (staged sidecar and runtime resources under
  `.rho/runtime` and `desktop/src-tauri/binaries`), and it never requires
  network beyond the existing pinned Ark download.

## Work Packages And Acceptance Gates

Single slice (S1): script + fixture tests + README section + CI wiring.

| gate | acceptance | status |
| --- | --- | --- |
| S1-A | `scripts/test-install-from-source.sh` passes on Linux x86-64: negative fixtures cover each distro map entry, unknown-distro fallback, missing-command report, missing-library report, `--json` schema, exit code 2, `--prefix` parsing, and usage errors | **PASSED** 2026-08-20 |
| S1-B | on this repository's Linux environment with the real toolchain, the diagnostics phase runs against the real system (`scripts/install-from-source.sh --build-only --skip-ark` reaches the build phase or reports the true system state with exit 2 and actionable suggestions); full build is out of scope for this gate because the official AppImage lane already proves the compile | **PASSED** 2026-08-20 (real `--json` diagnostic `ok:true` on ubuntu/x86_64; full build reached with `--skip-ark --build-only`) |
| S1-C | README documents the script as the unsupported-platform fallback, not an official installer/update channel | **PASSED** 2026-08-20 |
| S1-D | fixture test is wired into the Linux validation lane in `.github/workflows/linux-appimage-build.yml` | **PASSED** 2026-08-20 |

Deferred (follow-up PRs): macOS/brew map, official linux-arm64 AppImage/deb
packaging lane (source install already covers arm64), auto-install opt-in
(explicitly out of scope per owner decision).

## Verification Matrix

- fixture: `scripts/test-install-from-source.sh` (bash, no network, no root);
- manual: `scripts/install-from-source.sh --help`, `--prefix` parsing,
  `--json` on the real system;
- affected existing suites: `scripts/test-bootstrap-ark-linux.sh` and
  `scripts/test-linux-apprun.sh` are untouched but re-run to confirm the new
  script does not disturb them;
- `git diff --check`.

## Version, NEWS, And Release Impact

Development tooling only: no application version bump, no `NEWS.md` entry,
no release checklist change. The official installer/updater lanes are
unaffected. README documentation update accompanies the slice.

## Open Decisions

None blocking S1. Follow-up scope (brew, ARM64, auto-install opt-in) is
explicitly deferred and requires fresh authorization.
