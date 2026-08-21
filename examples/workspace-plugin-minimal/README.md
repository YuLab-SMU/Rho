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

To probe one evolution locally, first preserve the exact baseline in a
temporary app-data root:

```sh
mkdir -p /tmp/rho-plugin-cache
cargo run -p rho-plugin-dev -- snapshot \
  examples/workspace-plugin-minimal \
  org.yulab.rho.local-hello \
  /tmp/rho-plugin-cache
```

After changing `src/plugin.wat` and running `build`, compare the candidate with
the digest printed by `snapshot`:

```sh
cargo run -p rho-plugin-dev -- compare \
  examples/workspace-plugin-minimal \
  org.yulab.rho.local-hello \
  /tmp/rho-plugin-cache \
  <baseline-digest>
```

`compare` loads the immutable baseline through Rho's existing broker cache and
smokes all three baseline and candidate surfaces independently. It does not
accept or publish the candidate.

The application side already owns acceptance and rollback:

1. enable the baseline from Workspace Plugins;
2. edit the component, run `build`, then run `compare` against the baseline;
3. refresh Workspace Plugins; the changed exact digest appears as
   `update_pending` while the old route remains active;
4. review and confirm Update in Rho; the shell supplies the accepted old digest,
   candidate digest, and project revision;
5. use Rollback to reactivate the immutable previous digest if needed.

Do not copy the developer cache into Rho or edit lifecycle state manually. Rho
uses its own broker-owned cache and Store transition when the user accepts an
Update or Rollback.
