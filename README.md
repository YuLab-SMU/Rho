# Rho

Rho is an agent-native scientific workbench for R. Phase 0 validates a no-Python architecture with:

- Ark as the authoritative Workspace R kernel;
- a Rust broker using the Jupyter wire protocol directly;
- a separate Agent R process powered by `YuLab-SMU/aisdk`;
- typed workspace identities, a broker-owned SQLite event store, and structured output.

## Phase 0 commands

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-ark-windows.ps1
cargo test --workspace
cargo run -p rho-server -- doctor
cargo run -p rho-server -- probe-agent-r
cargo run -p rho-server -- probe-ark --kernelspec .rho/runtime/ark-0.1.252/kernel.json --code "1 + 1"
```

The Windows bootstrap downloads the pinned Ark binary, verifies its SHA-256,
and writes a broker-private kernelspec. It does not install Python or Jupyter.
On Windows, Rust can use either MSVC Build Tools or the GNU host toolchain with
the GCC linker already provided by Rtools.

The full reviewed implementation plan is in `Rho-implementation-plan.md`.
Current evidence and remaining Phase 0 gates are tracked in
`docs/phase-0-status.md`.
