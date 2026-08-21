# Minimal Workspace Plugin

This is the smallest locally runnable Rho component project. One
zero-permission Manifest V2 package contributes a UI Command, an Agent Tool,
and a trusted Viewer through the same no-import Guest ABI V2 module and exact
package digest.

From the repository root:

```sh
cargo run -p rho-plugin-dev -- build examples/workspace-plugin-minimal
cargo run -p rho-plugin-dev -- check examples/workspace-plugin-minimal
cargo run -p rho-plugin-dev -- smoke-command \
  examples/workspace-plugin-minimal \
  org.yulab.rho.local-hello \
  ui.command.local_hello
cargo run -p rho-plugin-dev -- smoke-tool \
  examples/workspace-plugin-minimal \
  org.yulab.rho.local-hello \
  tool.local_status
cargo run -p rho-plugin-dev -- smoke-viewer \
  examples/workspace-plugin-minimal \
  org.yulab.rho.local-hello \
  ui.viewer.local_status
```

`build` compiles `src/plugin.wat` into the manifest-declared
`dist/plugin.wasm`, then validates the exact package digest. `check` performs
package validation without executing the guest. `smoke-command` activates the
exact snapshotted Wasm module and validates its result through the declared
output schema and Rho's trusted Command result contract.

This is a local component-engineering fixture, not a store package or stable
public SDK. Change the source, rebuild it, and the authoritative package digest
changes while all three surfaces remain bound to the same exact component. It
deliberately has no filesystem, Workspace R, network, process, credential, or
write permission.
