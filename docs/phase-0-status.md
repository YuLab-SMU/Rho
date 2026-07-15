# Phase 0 implementation status

Date: 2026-07-15  
Platform: Windows x64  
R: 4.6.0  
Ark: 0.1.252  
Jet revision: `52ae131dd168fe2e104d306cc4bf5bbeae749200`

## Implemented and verified

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

## Remaining before Phase 0 exit

- Exercise HTML and SVG bundles plus Ark comms and code completeness.
- Prove two simultaneous logical clients through the broker.
- Integrate `aisdk` task execution rather than only the Agent R transport.
- Wire kernel, broker revisions, bridge probes, and SQLite into one end-to-end
  execution coordinator.
- Add cancellation, timeout, crash, oversized-frame, and child credential
  redaction integration tests.
- Compare arf headless against the measured Ark path and close ADR-009.
- Stream events into the minimal browser UI through generated Workbench
  Protocol types.
- Run equivalent runtime probes on macOS and Linux and add signed packaging
  inputs for each target.
