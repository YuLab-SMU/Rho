# Minimal Workspace Plugin

This is the smallest locally runnable Rho workspace-plugin project. It contains
one zero-permission Manifest V2 Command and a no-import Guest ABI V2 module.

From the repository root:

```sh
cargo run -p rho-plugin-dev -- build examples/workspace-plugin-minimal
cargo run -p rho-plugin-dev -- check examples/workspace-plugin-minimal
cargo run -p rho-plugin-dev -- smoke-command \
  examples/workspace-plugin-minimal \
  org.yulab.rho.local-hello \
  ui.command.local_hello
```

`build` compiles `src/plugin.wat` into the manifest-declared
`dist/plugin.wasm`, then validates the exact package digest. `check` performs
package validation without executing the guest. `smoke-command` activates the
exact snapshotted Wasm module and validates its result through the declared
output schema and Rho's trusted Command result contract.

This is a developer-preview fixture, not a stable public SDK. It deliberately
has no filesystem, Workspace R, network, process, credential, or write
permission.
