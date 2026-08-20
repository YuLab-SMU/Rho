# Rho Agent Notes

## Required development governance

All non-trivial product work must follow
`docs/project/active-development-governance.md`. That document is the execution
contract for proposal, specification, implementation, testing, review, version,
documentation status, commit, and release handoff.

### Hard gates

- Inspect the repository, relevant active/proposed documents, and worktree
  before changing files. Preserve unrelated user changes.
- Classify the change risk and identify the owning document and acceptance gate
  before implementation.
- Do not implement a `proposed-` document. Record explicit authorization and
  rename the authorized implementation contract to `active-` first.
- For non-trivial behavior, write or amend a testable proposal/spec before code.
  Cross-review it against `docs/project/active-document-cross-review.md` and
  resolve ownership, schema, policy, persistence, and sequencing conflicts.
- Keep implementation slices small enough to review and roll back. Stop at the
  work-package checkpoint instead of implementing a whole multi-phase proposal.
- Keep the checked-in baseline buildable and testable at every integration
  boundary. Do not merge half-wired schema/backend/frontend states or depend on
  a later commit to restore required behavior.
- Write tests in proportion to risk. Every defect fix gets a regression test;
  every state mutation gets success, rejection/stale, failure, and recovery
  coverage; every project-owned feature gets two-project isolation coverage.
- Treat schema migrations, approvals, project switching, execution, file or
  environment mutation, credentials, public protocol, and release tooling as
  high-risk. They require negative tests and failure-injection/recovery evidence.
- Run the narrowest relevant tests while iterating, then the complete affected
  validation matrix before completion. Never report an unrun check as passing.
- Review the implementation against the accepted contract after tests pass.
  Record deviations in the contract; do not silently let code redefine it.
- Before handoff, decide and record version impact. User-visible application
  behavior included in a new development candidate requires synchronized
  application version metadata and `NEWS.md`. Internal R package versions are
  independent and change when their package contract changes.
- Update document lifecycle and evidence only after the corresponding fact is
  true. Implementation presence, automated verification, milestone acceptance,
  installed-app acceptance, and release readiness are separate states.
- Commit only the reviewed files in scope. Report tests, manual acceptance,
  version/document changes, residual risks, worktree state, and release decision
  separately.
- Prefer automated enforcement over remembered convention. When a governance
  rule can be checked deterministically, add it to repository validation or CI
  in the same workstream or record a bounded follow-up gate.

### Stop conditions

Stop and amend/review the contract before continuing when:

- implementation requires behavior outside the active spec;
- two documents claim the same state, persistence, approval, or acceptance
  semantics;
- a migration or compatibility rule would guess historical ownership or data;
- a required test cannot be made deterministic or a failure cannot recover
  truthfully;
- the change would broaden credentials, network, filesystem, execution, or
  approval authority;
- affected manual acceptance cannot be completed for a release candidate.

## Scientific workflow implementation

- Keep scientific environment operations in their own broker-owned lane.
  Do not reuse `approval_requests` for direct UI `renv` actions. Use a dedicated request table and dedicated dialog surface so direct UI and Agent approvals stay auditable and separable.

- Always bind environment previews to a normalized project root.
  When calling `rho_environment_evidence()` or `rho_environment_operation()`, pass the explicit normalized project root from the broker/store. Do not rely on `getwd()` silently matching the active project.

- In R, named atomic vectors are not lists.
  `installed_versions[[missing_name]]` throws `subscript out of bounds` for a named character vector. Check membership first, then index.

- Size-limit tests by payload shape, not raw item count.
  The canonical environment snapshot budget test became pathologically slow when it used thousands of rows. Prefer fewer records with longer strings so the byte-budget path is exercised without turning CI into wet cement.

- For Windows Rust tests in this repo, prepend the Rtools GNU toolchain path.
  Use:
  `$env:PATH="C:\\rtools45\\x86_64-w64-mingw32.static.posix\\bin;$env:PATH"`
  before `cargo +stable-x86_64-pc-windows-gnu ...`

- Keep browser/mock mode in lockstep with new Tauri commands.
  If a new desktop command changes Environment panel state, add a mock handler in `desktop/dist/app.js` in the same round. Otherwise UI review in browser mode quickly drifts away from the real contract.

- Do not trust `msedge --dump-dom` blindly for local preview evidence on Windows.
  In this repo it can return empty output even when the page rendered and screenshots succeeded. Keep a deterministic preview hook in the page, and treat screenshot readiness checks as the primary fallback when DOM capture goes mute.

- For project skill discovery, validate the `.rho/skills` root itself, not just manifest and referenced files.
  Checking only `manifest.json` and relative entries still leaves a hole if `.rho` or `.rho/skills` is a symlink into content outside the project root.

## Building Rho from source (source install)

Rho ships official installers for Windows (NSIS), macOS arm64 (DMG) and
Linux x86-64 (AppImage + deb). For Linux systems without an official
installer, use `scripts/install-from-source.sh` — a diagnostics-driven
build-and-install helper. Platform support follows the Ark R sidecar manifest
`runtime/ark.json`: `linux-x64` and `linux-arm64` are both fully wired
(`scripts/bootstrap-ark-linux.sh` stages `binaries/ark-x86_64-unknown-linux-gnu`
or `binaries/ark-aarch64-unknown-linux-gnu`); BSD is unsupported because Ark
has no BSD build.

When asked to compile/install Rho from source on an unfamiliar machine, the
AI workflow is:

1. Run `scripts/install-from-source.sh --json` first. The script detects the
   distro (`/etc/os-release`), checks toolchain commands (cargo/rustup, node,
   curl, unzip, file, Rscript) and system libraries via `pkg-config`
   (`webkit2gtk-4.1`, `gtk+-3.0`), and reports every missing requirement with
   the distro-specific package command.
2. NEVER auto-install packages or escalate privileges on the user's behalf.
   Present the reported `suggest` commands and let the user (or their chosen
   package manager invocation) install them. The script deliberately has no
   `--install-deps`; this is a hard boundary.
3. Re-run after dependencies are installed. Then the script bootstraps Ark,
   runs `cargo build --release -p rho-desktop`, and installs the binary under
   the prefix (`/usr/local` by default; `--prefix` overrides, `--build-only`
   skips install). Exit codes: 0 ok; 1 usage/unsupported system; 2 missing
   deps; 3 build failed; 4 install failed (prefix not writable).
4. On an unknown distribution, the report prints a "no package-name map
   yet ... open a PR" invitation. Adding a distro map means extending the
   `RHO_PKG_*` case in `scripts/install-from-source.sh`; adding a platform
   means wiring a new `runtime/ark.json` entry through
   `scripts/bootstrap-ark-linux.sh` (arch detection, sidecar name, ELF check)
   and `scripts/prepare-runtime-resources.sh` — both already handle
   x86-64/aarch64 and are the template.
5. `--skip-ark` opts out of the Ark bootstrap (R sessions will not work).
   Linux is supported on exactly `x86_64` and `arm64`; BSD and any other
   architecture are rejected with exit 1.

Authoritative contract: `docs/plans/active-2026-08-20-source-install-diagnostic-script-spec.md`.

## Windows installer packaging

Trigger phrases: "打包一下安装包", "打包安装包", "build installer", "package the installer"

When the user asks to package the installer, follow this workflow without asking questions:

### 1. Pre-flight checks

```powershell
# Verify JS syntax
node --check desktop\dist\app.js

# Verify Ark runtime is bootstrapped
Test-Path .rho\runtime\ark-0.1.252\ark.exe
```

If Ark is missing, run `powershell -ExecutionPolicy Bypass -File scripts\bootstrap-ark-windows.ps1` first.
Do not run R tests or Rust tests during packaging — the build script handles its own compilation and these tests are for development, not packaging.

### 2. Build

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1
```

This script:
- selects the GNU Rust toolchain (`stable-x86_64-pc-windows-gnu`) and Rtools45 linker
- copies Ark runtime resources into the Tauri resource tree
- runs `npx -y "@tauri-apps/cli@2.11.4" build` from `desktop\src-tauri`
- produces the NSIS installer

### 3. Report

After the build succeeds, report the two output files with path, size (MB), and SHA-256:

```powershell
Get-ChildItem target\release\rho-desktop.exe, target\release\bundle\nsis\Rho_*.exe |
    Select-Object Name, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}
Get-FileHash target\release\rho-desktop.exe -Algorithm SHA256
Get-FileHash target\release\bundle\nsis\Rho_*.exe -Algorithm SHA256
```

### Notes

- The installer is unsigned. Windows SmartScreen will show a warning.
- Do NOT auto-install the built package. Just produce it and report the paths.
- Do NOT push the built artifacts. They are in `.gitignore`.
