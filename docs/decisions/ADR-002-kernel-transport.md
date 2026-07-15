# ADR-002: Ark with direct Rust transport

## Status

Accepted for Phase 0 validation.

## Decision

Rho starts Ark directly from the Rust broker and communicates using the Jupyter wire protocol through pinned Rust crates. Rho does not require Python, Jupyter Server, JupyterLab, `uv`, or Kallichore.

Jet core at commit `52ae131dd168fe2e104d306cc4bf5bbeae749200` is the reference implementation for kernel lifecycle and frame routing. Phase 0 must verify Windows execution, streaming, display data, stdin, interrupt, comms, shutdown, and licensing before the dependency is promoted beyond the spike.

## Fallback

arf headless is evaluated as a separate bounded spike. It becomes the primary runtime only through ADR-009 after its streaming, rich display, interrupt, traceback, and GUI-completion gaps are closed or accepted.

