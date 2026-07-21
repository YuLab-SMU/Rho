# Phase 0 implementation status

Status: historical completed baseline

Date: 2026-07-16
Platform: Windows x64  
R: 4.6.0  
Ark: 0.1.252  
Jet revision: `52ae131dd168fe2e104d306cc4bf5bbeae749200`

## Implemented and verified

- A Tauri 2 Windows prototype is now packaged as an 11.45 MB x64 NSIS
  installer. It installs per-user, creates a Start Menu shortcut, and launches
  the bundled Ark binary from the installation directory rather than the
  development tree.
- The prototype exposes a live source editor and Console, Environment object
  manifest, PNG plot output, structured Problems, revision status, interrupt
  and restart controls, plus an Ask/Plan/Act Agent timeline. The Files,
  execution and context regions now have draggable, persistent dividers; the
  execution panel also supports one-click expand and restore.
- The first `0.2.x` project-file slice is implemented behind a broker-safe API:
  source files are listed under a selected project root, paths cannot escape
  that root, multiple document tabs can be read/edited/saved, new source files
  can be created, and opening a project synchronizes Workspace R `setwd()`.
- Desktop backend smoke tests create a data frame in Workspace R, receive a
  real plot and Environment object, then complete a read-only DeepSeek turn
  against the same Ark session. Browser UI checks cover 1280 by 720 and the
  minimum 1024 by 680 viewport without incoherent overlap.

- Rust starts Ark directly and connects over signed Jupyter/ZeroMQ channels.
- No Python, Jupyter Server, JupyterLab, notebook process, or `uv` is used.
- Shell, iopub, stdin, control, and shutdown paths work on Windows.
- Every kernel event carries the originating parent message ID.
- Execution completion waits for both shell `execute_reply` and iopub `idle`,
  tolerating cross-socket reordering.
- Persistent workspace state survived 100 sequential executions: 100 idle
  events, 100 replies, final counter value 100, 4.202 seconds total.
- A timed Windows interrupt stopped a CPU-bound R loop, returned Ark to idle,
  and a follow-up expression in the same kernel returned 42.
- stdout, stderr, message, warning, structured error, PNG display data, and
  stdin request/reply were observed without console scraping.
- A 1,000 by 1,000 integer matrix was inspected through `rho.bridge` as bounded
  metadata without serializing its values.
- Workspace identity revisions, stale request rejection, restart invalidation,
  SQLite WAL event persistence, and interrupted-run recovery have unit tests.
- A real Agent R process authenticates over loopback with a 256-bit single-use
  token delivered through stdin. Deliberate stdout/stderr contamination does
  not enter the framed protocol, and token replay is rejected.
- `rho.agent` now contains an initial `aisdk` desktop adapter for ChatSession
  streaming, run traces, tool lifecycle events, broker approvals and
  revision-aware Workspace tool RPC. `aisdk.console` is recorded as the
  reference frontend rather than an embedded terminal UI.
- A complete mock `ChatSession` streaming turn validates the public `on_event`
  API and forwards text, final, done, run-state and trace records as framed
  broker events without a model API call.
- The internally maintained `aisdk` family has been reviewed as a set of
  co-evolving upstream packages. Reusable changes are separated from
  Rho-specific Ark, broker, persistence and desktop concerns in
  `docs/architecture/proposed-aisdk-family-change-proposals.md`.
- The end-to-end coordinator now runs a real Agent R request through broker
  revision checks, Ark, `rho.bridge`, a bounded structured result channel and
  the broker-owned SQLite store. The successful probe returned value 42 and
  persisted 21 correlated events without Python.
- Two overlapping logical clients are exercised in the coordinator probe. A
  user execution advances the workspace after Agent R receives its identity;
  the stale Agent request is rejected, the broker pushes the new identity, and
  the Agent retry succeeds. Final `execution_seq` and `state_revision` are 3.
- An opt-in real-model coordinator probe passed with
  `deepseek:deepseek-v4-flash`. The model called `run_r` exactly once with
  `rho_model_probe_value <- 6 * 7`; the broker completed the approval RPC,
  Workspace R returned value 42 and a revised workspace identity, and a
  subsequent broker-backed inspection reported a 56-byte numeric object with
  structure `num 42`. The run persisted 130 correlated events and all three
  broker executions finished as `completed`.
- Agent process diagnostics now apply broker-side defense-in-depth redaction
  for common API-key/token query parameters, JSON credential fields, and
  bearer tokens. The redaction path has a Rust regression test and is applied
  to early-loop failures as well as final stdout/stderr reporting.
- Ark code completeness is exposed through Rust and verified against complete,
  incomplete (`+` indent), and invalid R input.
- Ark comms are verified without Jet's Lua layer. The LSP comm reports
  `server_started` and is visible through `comm_info`; `positron.ui` reports
  distinct `prompt_state` and `working_directory` events.
- Both rich-output modes are verified. Before the UI comm opens, plots emit
  `image/png` display data. In dynamic mode, HTML is delivered through
  `positron.ui/show_html_file`, and a `positron.plot` render RPC returns
  `image/svg+xml`. The probes validate non-empty payloads rather than logging
  full binary data.
- Measured Windows process startup, Ark handshake, one execution, and graceful
  shutdown: 2.216 seconds on the development machine.

## Important implementation findings

- Pinned Jet does not compile on Windows GNU because one startup probe calls
  Unix `libc::kill` unconditionally. The vendored patch uses `Child::try_wait`.
- Jet's per-request stream closes on iopub idle and can lose a later shell
  reply. Rho uses a global listener filtered by parent ID and gates completion
  on both reply and idle.
- User `.Rprofile` code can assume a terminal and break headless Ark startup.
  The bootstrap uses a controlled startup. Project `renv/.Rprofile` activation
  must later be explicit, broker-owned, and auditable.
- A controlled Ark startup must still preserve the selected R package library
  and Windows DLL search path. The generated kernelspec now pins `R_HOME`,
  `R_LIBS`, and the R `bin/x64` PATH prefix; otherwise compiled packages can be
  resolved from a stale site library or fail to load.
- Ark 0.1.252 accepts `user_expressions` but returns an empty result map and has
  no general R API for arbitrary MIME bundles. Phase 0 therefore returns the
  bounded `rho.bridge` JSON through a broker-named temporary file, written by
  atomic rename, capped at the Agent frame limit, read only after execution
  completion, and deleted immediately. stdout remains diagnostic-only.
- Jet transfers its Windows `Child` handle to a liveness watcher after startup,
  but its PID-only `ChildGuard` previously had no Windows drop action. The
  vendored guard now uses a hidden `taskkill /T /F` fallback so an abnormal
  shutdown reclaims Ark and its LSP child tree. Desktop productization should
  replace this fallback with a broker-owned Windows Job Object.
- Ark execution now fails if its listener closes before both `execute_reply`
  and `idle`; a kernel crash can no longer be reported as successful execution.
- `aisdk.mcp` currently passes the complete Agent R environment to local MCP
  children, including model credentials. Before local MCP is enabled in Rho,
  the package must adopt an explicit environment allowlist or the broker must
  enforce equivalent redaction and process ownership.
- Provider errors may include credentials in request URLs. Rho therefore
  redacts Agent R diagnostics at the broker boundary even when an upstream
  package or HTTP client fails to sanitize its own error. Structured event and
  SQLite payload redaction still needs an end-to-end adversarial fixture.

## Before Phase 1A

- Fix or broker-isolate `aisdk.mcp` child environments.
- Add correlated public aisdk events and cooperative cancellation, or retain
  the documented Rho adapter shims until those upstream APIs land.
- Add injectable tool/context and skill-script executors so Workspace R remains
  the only authority for project code and scientific objects.

## Remaining before Phase 0 exit

- Run the representative scientific-object inspect, error, diagnosis and
  correction scenario through the real-model coordinator; the smaller
  DeepSeek execution/approval/inspection proof now passes.
- Add cancellation, timeout, crash, oversized-frame, and child credential
  redaction integration tests.
- Compare arf headless against the measured Ark path and close ADR-009.
- Replace the prototype's direct Tauri command payloads with generated
  Workbench Protocol types and incremental event streaming.
- Run equivalent runtime probes on macOS and Linux and add signed packaging
  inputs for each target.

## Reproducing the Phase 0 probes

Bootstrap the pinned Ark runtime before running the broker probes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-ark-windows.ps1
cargo test --workspace
cargo run -p rho-server -- doctor
cargo run -p rho-server -- probe-agent-r
cargo run -p rho-server -- probe-ark --kernelspec .rho/runtime/ark-0.1.252/kernel.json --code "1 + 1"
cargo run -p rho-server -- probe-coordinator --kernelspec .rho/runtime/ark-0.1.252/kernel.json
cargo run -p rho-server -- probe-completeness --kernelspec .rho/runtime/ark-0.1.252/kernel.json
cargo run -p rho-server -- probe-comms --kernelspec .rho/runtime/ark-0.1.252/kernel.json
cargo run -p rho-server -- probe-rich-output --kernelspec .rho/runtime/ark-0.1.252/kernel.json
```

The real-model coordinator probe is opt-in and requires the selected provider
credential to be available to Agent R:

```powershell
cargo run -p rho-server -- probe-coordinator --kernelspec .rho/runtime/ark-0.1.252/kernel.json --store .rho/state/coordinator-probe-deepseek.sqlite --model deepseek:deepseek-v4-flash
```

The bootstrap and Windows toolchain contract are documented in
`docs/implementation/implemented-windows-build-environment.md`.
