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
  If a new desktop command changes Environment panel state, add the mock handler in `desktop/ui/src/transport/mock.ts` in the same round (the legacy `desktop/dist/app.js` no longer exists; parity is enforced by `scripts/test-rsr-contract.mjs`). Otherwise UI review in browser mode quickly drifts away from the real contract.

- Frontend styles live in the design-token suite under `desktop/ui/src/styles/`.
  `foundation.css` is only the layer-ordered aggregator; edit `tokens.css`, `base.css`, `components.css`, `workbench.css`, or `surfaces.css` instead. Visual values must come from tokens (`docs/design/active-2026-08-22-studio-design-language-and-ux-overhaul-design.md`), not new hard-coded colors or sizes.

- Do not trust `msedge --dump-dom` blindly for local preview evidence on Windows.
  In this repo it can return empty output even when the page rendered and screenshots succeeded. Keep a deterministic preview hook in the page, and treat screenshot readiness checks as the primary fallback when DOM capture goes mute.

- For project skill discovery, validate the `.rho/skills` root itself, not just manifest and referenced files.
  Checking only `manifest.json` and relative entries still leaves a hole if `.rho` or `.rho/skills` is a symlink into content outside the project root.

## Parallel development lanes

For multi-worktree parallel development, register each session's path
ownership with `scripts/dev-lanes.mjs` before editing. Lane leases live in the
git common dir (`.git/rho-dev-lanes/`), so every linked worktree sees the same
registry and nothing is committed to the repository.

Topology: 2–3 short-lived feature worktrees plus one integration worktree.
Feature lanes own vertical slices (backend + transport + controller + UI +
tests); the integration lane owns composition roots, lockfiles, version
metadata, and NEWS, and runs the complete affected validation matrix once.

```bash
# in each feature worktree, before editing
node scripts/dev-lanes.mjs start --id runtime-filter \
  --own 'desktop/src-tauri/src/commands/runtime_control.rs' \
  --own 'desktop/ui/src/app/controllers/console-*'

# pre-commit in a lane
node scripts/dev-lanes.mjs check --id runtime-filter --changed-auto

# before integration merges a lane branch
node scripts/dev-lanes.mjs merge-check --source work/runtime-filter

# after the lane merges
node scripts/dev-lanes.mjs finish --id runtime-filter
```

Hard rejects: owned-path overlap between active lanes (at `start`), feature
lanes writing shared authority paths (`Cargo.lock`,
`desktop/package-lock.json`, `NEWS.md`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/src/main.rs`, `desktop/ui/src/app/App.tsx`), and textual
merge conflicts. Only one integration lane may be active. A lane that must
edit a shared authority file declares it with `--own` (overlap then keeps it
single-writer); lockfiles still converge through the integration lane.

Real Tauri debug windows stay exclusive to the integration/main checkout;
feature worktrees run focused tests or their own Vite mock (`npm run rsr:dev
--prefix desktop` picks a free port).

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
