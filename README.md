# Rho

Rho is an agent-native scientific workbench for R. Phase 0 validates a no-Python architecture with:

- Ark as the authoritative Workspace R kernel;
- a Rust broker using the Jupyter wire protocol directly;
- a separate Agent R process powered by `YuLab-SMU/aisdk`;
- typed workspace identities, a broker-owned SQLite event store, and structured output.

Agent R builds on the existing `YuLab-SMU/aisdk` package family. Rho reuses
`ChatSession`, streaming events, run traces, hooks, run states and branching;
`aisdk.console` is the reference frontend and developer fallback, not an
embedded terminal UI. See `docs/architecture/aisdk-family-integration.md`.
Proposed reusable changes to the family packages are listed in
`docs/architecture/aisdk-family-change-proposals.md`.

## Phase 0 commands

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

An opt-in real-model coordinator probe can be run when the selected provider
credential is available to Agent R:

```powershell
cargo run -p rho-server -- probe-coordinator --kernelspec .rho/runtime/ark-0.1.252/kernel.json --store .rho/state/coordinator-probe-deepseek.sqlite --model deepseek:deepseek-v4-flash
```

This path has been verified end to end: DeepSeek requested one approved
`run_r` call, Ark created a live Workspace R object with value 42, and a
subsequent broker-backed inspection succeeded. Model credentials are not sent
to Workspace R, and broker-reported Agent diagnostics are secret-redacted.

The Windows bootstrap downloads the pinned Ark binary, verifies its SHA-256,
and writes a broker-private kernelspec with explicit `R_HOME`, `R_LIBS` and R
DLL search paths. It does not install Python or Jupyter.
On Windows, Rust can use either MSVC Build Tools or the GNU host toolchain with
the GCC linker already provided by Rtools.

The full reviewed implementation plan is in `Rho-implementation-plan.md`.
Current evidence and remaining Phase 0 gates are tracked in
`docs/phase-0-status.md`.
