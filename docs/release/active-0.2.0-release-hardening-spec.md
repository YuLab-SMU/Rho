# Rho 0.2.0 Release Hardening Specification

Status: implemented; release acceptance active

Date: 2026-07-22

Target: `0.2.0` Windows x64 release

## 1. Goal

Close the engineering and evidence gaps between the current `0.2.0-dev.12`
candidate and a reproducible `0.2.0` Windows release without expanding the
product into unfinished package-management, shell, or cross-platform work.

The release process must fail before publication when source checks, version
metadata, bundled runtime resources, the Workspace smoke test, or required
release evidence are incomplete. Manual clean-install acceptance remains a
human-owned gate and must never be inferred from unit or hosted-runner tests.

## 2. Release Scope

`0.2.0` includes the implemented Windows daily-use workflow:

- native project opening and project-scoped session restoration;
- Monaco multi-document editing and source execution;
- one authoritative Ark-backed Workspace R shared by editor, Console, and
  approved Agent execution;
- Console, Runs, Problems, Plots, Environment, render diagnostics, and bounded
  object previews;
- Ask and Plan read-only policy plus exact, single-use Act approval for
  `run_r`;
- review, Accept, Reject, and guarded Undo for Agent-proposed file edits;
- configurable Agent models with credentials read from the effective user
  `.Renviron`;
- recoverable Windows startup for missing or unsupported R and independent
  degradation when optional Agent dependencies are unavailable;
- durable execution, Agent, approval, plot-provenance, and recovery records.

## 3. Explicit Non-goals

The following are not release requirements for `0.2.0`:

- autonomous package installation or a package-installation Agent tool;
- shell, PowerShell, terminal, or arbitrary process-execution tools;
- user-facing file rename or general file deletion commands;
- installer signing, automatic update, macOS, or Linux packaging;
- full-table paging, remote execution, debugger, or job-management features;
- automatic installation or repair of R, `aisdk`, Quarto, or model providers.

Package installation and shell-like tools require a separate mutation policy,
argument model, approval contract, and audit design. They must not be added as
an incidental release-hardening change.

## 4. Release Invariants

### 4.1 Version identity

The Cargo workspace, Tauri bundle, and desktop frontend package must report the
same application version. A final tag `v0.2.0` may only publish metadata whose
version is exactly `0.2.0`. A prerelease tag must equal the corresponding
prerelease version.

Internal R package versions are independent implementation package versions
and are not required to match the desktop release.

### 4.2 Source quality

Before an installer can be published, the release workflow must pass:

- `cargo fmt --all -- --check`;
- `cargo test --workspace`;
- `node --check desktop/dist/app.js`;
- `testthat::test_local('r/rho.bridge')`;
- `testthat::test_local('r/rho.agent')` when its declared dependencies are
  available in the release environment;
- a clean `git diff --check` result.

The required CI environment must install the R test dependencies. It must not
silently skip a package test because a dependency is missing.

### 4.3 Project-path and scale boundaries

Automated Rust tests must cover:

- project roots and nested source names containing spaces and non-ASCII text;
- session persistence and atomic writes under such a project root;
- deterministic truncation when supported project files exceed the 2,000-file
  discovery limit;
- rejection of source files above the 8 MiB editor limit.

These tests prove path and boundary behavior in code. They do not replace the
installed-application acceptance run.

### 4.4 Runtime resources and smoke tests

The build must fail unless Ark, its license and notice, and
`WebView2Loader.dll` are present in the bundle input. The release binary must
pass `--smoke-test`, proving Workspace R execution, plot delivery, Environment
inspection, persistence, and clean Ark shutdown.

The network-dependent `--smoke-agent` check is required release evidence but
must remain a separate step so provider outages do not masquerade as a local
Workspace failure. A failed Agent smoke blocks final `0.2.0` publication until
it is rerun successfully or the release owner records an explicit exception.

### 4.5 Publication safety

The publish workflow must validate the requested tag, release name, prerelease
flag, checked-out commit, and application version before creating or updating a
GitHub Release. Build and verification must complete before release creation.

The generated release must attach:

- the NSIS installer;
- a SHA-256 sidecar;
- machine-readable release evidence containing version, commit, test results,
  artifact name, size, and checksum.

No workflow may describe an unchecked manual acceptance item as passed.

## 5. Manual P0 Acceptance

The release owner must run the current P0 checklist against the exact installer
and source commit being considered for publication. At minimum the record must
identify:

- tester, date, Windows version, and test account type;
- installer filename, SHA-256, source commit, R version, and WebView2 version;
- pass/fail evidence for missing R, unsupported R, normal Workspace startup,
  paths with spaces and non-ASCII text, document restoration, execution,
  interruption, restart recovery, Agent approval, model configuration,
  optional Agent failure, external file changes, rendering, panel sizing, and
  uninstall behavior;
- the distribution decision: unsigned internal release or signed public
  release.

All P0 items must pass for `GO`. P1 failures need an owner and workaround; they
block general public release when they affect data safety.

## 6. Implementation Work Packages

### WP1: Release metadata validator

Add a PowerShell entry point that validates version agreement, optional release
tag agreement, required files, and repository whitespace errors. It must work
locally and in GitHub Actions and return non-zero on any mismatch.

### WP2: Automated verification runner

Add a PowerShell runner that executes the source-quality checks in a stable
order, records each command and outcome, and writes machine-readable JSON
evidence. Optional build, Workspace smoke, and Agent smoke phases must be
explicit switches rather than implicit best-effort behavior.

### WP3: Project acceptance regressions

Extend Rust tests for Unicode/space paths and the supported-file discovery
limit. Keep the tests isolated in temporary directories and do not rely on the
developer's projects or user profile.

### WP4: Publish workflow hardening

Run metadata validation and all required source checks before building. Validate
the publication inputs, run the Workspace smoke test, generate release evidence,
and upload it with the installer and checksum. The final workflow may publish
only after all enabled gates succeed.

### WP5: Documentation and release state

Resolve roadmap scope ambiguity, link this specification from the documentation
index and release checklist, and record implemented hardening in `NEWS.md`.
Only completed checks receive `[x]`; manual gates remain unchecked until their
evidence exists.

## 7. Acceptance Criteria

Implementation of this specification is complete when:

1. one command runs the local automated `0.2.0` source checks and emits JSON
   evidence;
2. version or tag mismatch fails before build or publication;
3. Unicode/space project paths and the 2,000-file boundary have automated
   regression coverage;
4. the Windows publish workflow runs verification before release creation and
   uploads the evidence artifact;
5. roadmap, checklist, documentation index, and NEWS agree on release scope;
6. all locally runnable checks pass;
7. remaining clean-install and network-dependent gates are reported as open,
   not inferred as complete.

Promotion from `0.2.0-dev.12` to `0.2.0` is a separate finalization action. It
occurs only after the exact candidate installer passes every P0 gate and the
distribution decision is recorded.
