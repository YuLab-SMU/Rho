# ADR-002: Ark with direct Rust transport

## Status

Accepted for Phase 0 validation.

## Decision

Rho starts Ark directly from the Rust broker and communicates using the Jupyter wire protocol through pinned Rust crates. Rho does not require Python, Jupyter Server, JupyterLab, `uv`, or Kallichore.

Jet core at commit `52ae131dd168fe2e104d306cc4bf5bbeae749200` is the reference implementation for kernel lifecycle and frame routing. Phase 0 must verify Windows execution, streaming, display data, stdin, interrupt, comms, shutdown, and licensing before the dependency is promoted beyond the spike.

The validation now covers code completeness, LSP and `positron.ui` comms,
static PNG display data, console-mode HTML viewer events, and dynamic SVG plot
rendering. Execution is complete only after both shell `execute_reply` and
iopub `idle`; an early listener close is an error.

The same direct transport has also passed an opt-in real-model coordinator
probe with `deepseek:deepseek-v4-flash`: Agent R requested an approved tool
call, the broker executed it in Ark-backed Workspace R, the returned workspace
revision was reused, and a follow-up object inspection succeeded. This proof
introduced no Python or Jupyter server process.

On Windows, vendored Jet uses a hidden `taskkill /T /F` fallback when its child
handle has moved to the liveness watcher and PID-only drop cleanup is required.
This prevents Ark and LSP orphans during the spike. The packaged desktop broker
should replace the fallback with Windows Job Object ownership before release.

## Fallback

arf headless is evaluated as a separate bounded spike. It becomes the primary runtime only through ADR-009 after its streaming, rich display, interrupt, traceback, and GUI-completion gaps are closed or accepted.
