# Windows Startup Diagnostics and Recovery Specification

Status: implementation handoff

Target release: `0.2.0-dev.11` or the next Windows installer

Date: 2026-07-21

## 1. Goal

Rho must not appear to crash when a Windows prerequisite, local R runtime, or
optional Agent dependency is unavailable. It must preserve a usable native
window whenever WebView2 can be created, explain the failed startup phase in
plain language, and provide an action that can resolve or diagnose the issue.

## 2. Current Architecture Problem

The current desktop startup has three coupled behaviors:

1. Tauri `setup()` calls `prepare_runtime()` before the frontend can recover.
2. `probe_r_runtime()` mixes required R metadata with optional
   `loadNamespace("aisdk")` work in one R process.
3. A setup error reaches `.expect("error while running Rho desktop")`, becomes
   a panic, overwrites the startup log, and terminates the GUI process.

The R expression catches ordinary R errors from `loadNamespace("aisdk")`, but
it cannot catch process-level outcomes such as a native DLL abort, an explicit
R process exit, or a hung package load. A failure in an optional Agent
dependency can therefore prevent the editor and Workspace R from opening.

The current log also records only stderr when the probe exits unsuccessfully.
When the probe exits unsuccessfully with empty stderr, the current error can
end after `R runtime probe failed:` without useful detail. Stdout, exit code,
command phase and elapsed time are lost.

## 3. Product Decisions

### 3.1 The application shell starts before R

Tauri setup must create and retain the application shell without requiring R,
Ark, aisdk, a model credential, Quarto, or an open project. Runtime preparation
is an explicit asynchronous bootstrap operation after the frontend is ready.

Recoverable bootstrap failure keeps the process and window alive.

### 3.2 Required and optional capabilities are isolated

Startup dependencies are classified as follows:

| Capability | Requirement | Failure behavior |
| --- | --- | --- |
| Tauri process and WebView2 | Required for graphical UI | Native dialog and durable log |
| Rho application data | Required for normal operation | Native dialog or in-app fatal page |
| Bundled Ark executable | Required for Workspace R | In-app repair page; no process panic |
| R 4.4 or later | Required for Workspace R | In-app R setup page |
| Base R metadata probe | Required for Workspace R | In-app R diagnostics page |
| Ark session startup | Required for execution | Workbench opens in disconnected state with retry |
| aisdk and its dependencies | Optional | Agent marked unavailable; editor remains usable |
| Model credentials/network | Optional | Selected model marked unavailable or untested |
| Quarto/R Markdown tooling | Optional | Render capability disabled with reason |

An optional capability must never share a process whose failure determines a
required startup result.

### 3.3 Errors use stable codes

Frontend behavior must not depend on matching English error strings. Backend
bootstrap operations return a structured issue with a stable code, phase and
severity.

```rust
#[derive(Clone, Serialize)]
struct StartupIssue {
    code: String,
    phase: StartupPhase,
    severity: StartupSeverity,
    title: String,
    message: String,
    technical_detail: Option<String>,
    actions: Vec<StartupAction>,
    diagnostics_path: Option<String>,
}
```

Initial codes:

```text
APP_DATA_UNAVAILABLE
ARK_RESOURCE_MISSING
R_NOT_FOUND
R_PATH_INVALID
R_VERSION_UNSUPPORTED
R_PROBE_SPAWN_FAILED
R_PROBE_TIMED_OUT
R_PROBE_EXITED
R_PROBE_OUTPUT_INVALID
ARK_START_FAILED
AGENT_R_UNAVAILABLE
AISDK_LOAD_FAILED
WEBVIEW2_START_FAILED
INSTALLATION_DAMAGED
```

`technical_detail` is available through a disclosure or copy action. The main
message must state what failed, what remains usable, and the next action.

### 3.4 Build paths are not user-facing diagnostics

Release builds should remap local Cargo and repository source prefixes with
Rust `--remap-path-prefix` so panic locations do not expose or imply a build
machine dependency. This is release hygiene, not a runtime fix.

Normal startup errors must not be represented as panics. Source locations may
remain in developer logs but must not be the headline shown to users.

## 4. Startup State Machine

The backend owns a single idempotent bootstrap state machine:

```text
shell_ready
  -> checking_installation
  -> locating_r
  -> probing_base_r
  -> runtime_ready
  -> starting_workspace
  -> ready
```

Terminal and degraded states are:

```text
needs_r
installation_damaged
workspace_disconnected
ready_agent_unavailable
fatal_native_error
```

Only one bootstrap attempt may run at a time. Repeated Retry clicks return the
active attempt rather than starting overlapping R or Ark processes. Every
attempt has a generated ID and emits bounded phase updates to the frontend.

Suggested state ownership:

```rust
struct AppState {
    bootstrap: Mutex<BootstrapController>,
    config: RwLock<Option<RuntimeConfig>>,
    project_store: RwLock<Option<ProjectSessionStore>>,
    project_root: RwLock<PathBuf>,
    session: RwLock<Option<Arc<ArkSession>>>,
    // Existing coordinator, watcher, approval and task state.
}
```

Commands that require a prepared runtime call one helper which returns a typed
`STARTUP_NOT_READY` error. They must not unwrap an absent configuration.

## 5. R Discovery And Probe Contract

### 5.1 Discovery order

Rscript discovery uses this precedence:

1. the user-selected path persisted by Rho;
2. `RHO_RSCRIPT`;
3. `where.exe Rscript.exe` results;
4. versioned installations below `C:\Program Files\R`;
5. versioned installations below an explicitly supported alternate root.

Every candidate is validated as an existing regular file. Discovery records
candidate origins and validation outcomes, but the primary UI shows only the
selected path.

The R setup page provides `Choose Rscript.exe`, implemented with the existing
native file-dialog dependency. A successful choice is persisted in a small
Rho-owned settings file and immediately retried. Users should not have to edit
`PATH` or create an environment variable.

### 5.2 Required base probe

The required probe runs only bounded base-R operations:

- `R.home()`;
- `R.version.string` and `getRversion()`;
- effective `.libPaths()`;
- normalization of the R DLL directory required by Ark.

Run it with `--no-init-file --no-site-file` so user and project `.Rprofile`
code cannot abort a headless probe. Preserve the effective user environment
file because it can define `R_LIBS_USER`; never log its content.

The required probe has a 15-second timeout. Capture and retain:

- process spawn result;
- numeric exit code or termination status;
- bounded stdout and stderr;
- elapsed time;
- selected executable path;
- output-parse result.

Non-zero exit, timeout and malformed output are different error codes.

### 5.3 Optional Agent probe

After the base probe succeeds, run `loadNamespace("aisdk")` in a separate
short-lived R process with a 30-second timeout. Its failure produces an
`AgentRuntimeStatus` with the exit code and a redacted, bounded diagnostic. It
does not modify the successful base-runtime result.

The workbench enters `ready_agent_unavailable`, displays `Agent unavailable`,
and keeps editing, Console, Environment and Plots enabled. The Agent panel
offers `View details` and `Retry Agent check`.

No Agent probe is allowed to start Ark, mutate user libraries, install a
package, or change `.Renviron`.

## 6. Backend API

Add these Tauri commands:

```text
startup_status
startup_bootstrap
startup_retry
startup_choose_rscript
startup_copy_diagnostics
startup_open_log_directory
agent_runtime_retry
```

`startup_bootstrap` returns a view model rather than an unstructured result:

```json
{
  "attempt_id": "uuid",
  "phase": "ready",
  "busy": false,
  "runtime": {
    "rscript": "C:/Program Files/R/R-4.4.2/bin/Rscript.exe",
    "r_version": "R version 4.4.2 (2024-10-31 ucrt)"
  },
  "workspace": { "status": "idle", "kernel_pid": 1234 },
  "agent": { "available": false, "aisdk_version": null },
  "issue": null
}
```

The frontend may then restore the project and load histories. Project restore
failure is handled separately and must not change the successful runtime
status.

## 7. User Experience

### 7.1 Bootstrap view

The static frontend initially shows a full-window bootstrap view before the
normal workbench becomes interactive. It contains the Rho identity, current
phase and one stable progress indicator. Do not flash the full workbench and
then replace it with an error.

Expected phase labels:

```text
Checking Rho installation...
Looking for R...
Checking R 4.4.2...
Starting Workspace R...
Opening your project...
```

### 7.2 Recoverable R error

Example primary content:

```text
R needs attention

Rho found R at C:\Program Files\R\R-4.4.2\bin\Rscript.exe, but the
runtime check exited unexpectedly. Your R installation has not been changed.
```

Commands:

- `Retry`;
- `Choose Rscript.exe`;
- `Copy diagnostics`;
- `Open log folder`;
- `Exit`.

Technical output is collapsed by default and selectable when expanded.

### 7.3 Optional Agent error

The workbench opens normally. The Agent panel displays:

```text
Agent unavailable
Workspace R is ready, but aisdk could not be loaded.
```

It provides `View details` and `Retry Agent check`. It must not show a blocking
modal on every launch.

### 7.4 Workspace start failure

If base R succeeds but Ark cannot start, keep the workbench visible in a
disconnected state. Disable execution commands, preserve project editing, and
offer `Restart Workspace` plus diagnostics. Do not mislabel this as an R
installation failure.

### 7.5 Native fallback

If Tauri cannot create the WebView, or no writable diagnostic location can be
established, use a native `rfd::MessageDialog`. The dialog states that Rho
could not open its interface and gives the fallback log path. The top-level
`.run()` result is handled explicitly; it is not passed to `.expect()`.

The Windows installer should detect or bootstrap the supported Microsoft Edge
WebView2 Runtime. Installer behavior and clean-Windows-10 evidence must be
recorded in `docs/windows-build-environment.md`.

## 8. Diagnostics And Privacy

Replace the single overwritten `%TEMP%\rho-desktop-startup.log` with append-only
startup events under:

```text
%LOCALAPPDATA%\org.yulab.rho\logs\startup.jsonl
```

If the application data directory is unavailable, fall back to:

```text
%TEMP%\rho-desktop-startup.log
```

Each event contains:

- timestamp, Rho version and bootstrap attempt ID;
- Windows version and process architecture;
- phase and stable result code;
- selected Rscript path and discovery origin;
- subprocess exit code, elapsed time and bounded stdout/stderr;
- Ark and WebView2 version when available;
- the complete Rust error chain for developer diagnosis.

Apply size rotation and keep a bounded number of historical logs. Diagnostic
copying must redact values matching credential and token patterns. Never log:

- `.Renviron` contents;
- API keys, tokens or authorization headers;
- complete inherited environment blocks;
- Agent prompts or project file contents.

Logging functions append rather than overwrite. A later panic must not erase
an earlier, more specific setup error.

## 9. Implementation Sequence

### Phase A: Stop silent exits

1. Replace top-level `.expect()` with explicit error handling.
2. Append the full error chain, exit code, stdout and stderr to diagnostics.
3. Show a native dialog for failures that occur before the frontend can help.
4. Remap build-machine source prefixes in release builds.

This phase is a hotfix but does not by itself make startup recoverable.

### Phase B: Recoverable runtime bootstrap

1. Make Tauri setup independent of R and Ark preparation.
2. Add the bootstrap state and typed command responses.
3. Add the frontend bootstrap and recovery views.
4. Add Rscript selection, retry, copy and log-folder actions.
5. Keep commands gated until runtime preparation succeeds.

### Phase C: Capability isolation

1. Split the base R and aisdk probes into separate processes.
2. Add timeouts and bounded output capture.
3. Treat Agent and render tooling as optional capabilities.
4. Expose retryable Agent status in the existing Agent panel.

## 10. Test And Acceptance Contract

### 10.1 Automated tests

Add Rust tests for:

- R 4.3 rejected and R 4.4 accepted;
- missing and invalid selected Rscript paths;
- base probe spawn failure, timeout, non-zero exit and malformed output;
- stderr-empty/non-zero-exit diagnostics retaining exit code and stdout;
- aisdk probe success, ordinary R error, timeout and process-level failure;
- every aisdk failure preserving a successful base runtime;
- bootstrap retry idempotence and single active attempt;
- secret redaction and append-only logging;
- runtime-required commands returning `STARTUP_NOT_READY` without panic.

Refactor subprocess execution behind a small injectable runner so these tests
do not depend on breaking the developer's installed R.

### 10.2 Windows acceptance matrix

Record evidence for all of these cases:

| Case | Expected result |
| --- | --- |
| Windows 10 x64, R absent | R setup page; no process exit |
| R 4.3 installed | Unsupported-version page |
| R 4.4+ in `C:\Program Files\R` | Automatic startup |
| R 4.4+ in a path containing spaces | Automatic or selected-path startup |
| `.Rprofile` throws or exits | Base probe unaffected |
| aisdk absent | Workbench ready; Agent unavailable |
| aisdk dependency version error | Workbench ready with actionable Agent detail |
| aisdk process exits non-zero with empty stderr | Workbench ready; exit code retained |
| Ark resource removed | Installation repair page |
| Ark handshake fails | Disconnected workbench with retry |
| WebView2 missing | Installer remediation or native dialog |
| Application-data directory unwritable | Native/in-app fatal explanation and fallback log |

### 10.3 Release gates

The Windows installer is not ready for general distribution until:

- no tested prerequisite failure appears as a silent exit;
- the optional aisdk failure cases cannot block Workspace R;
- another person can locate the diagnostics from the UI;
- a clean Windows 10 user profile passes installer and startup acceptance;
- release logs and user-visible errors contain no developer-machine path as
  the primary explanation and contain no secrets.

## 11. Documentation Follow-up

After implementation:

- add the new startup behavior and prerequisites to
  `docs/windows-prototype.md`;
- add the exact build flags, WebView2 installation mode and acceptance evidence
  to `docs/windows-build-environment.md`;
- add the startup cases as P0 gates in `docs/0.2-release-checklist.md`;
- record the user-visible change in `NEWS.md`.
