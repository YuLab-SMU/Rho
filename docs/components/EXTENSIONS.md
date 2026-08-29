# Extensions and plugins

`rho-extension-runtime` defines bounded plugin identities, manifests,
capability grants, lifecycle state, component hosting, contributions, and
surface/viewer documents. Its WIT files are the guest ABI source.

`rho-plugin-dev` provides local authoring tools. `rho-server` owns filesystem,
network, workspace, cache, trash, and retention brokers. The desktop
`workspace_plugins` service binds those capabilities to the active project and
persists lifecycle and permission decisions through `rho-store`.

The runtime follows a narrow flow:

```text
discover package → validate digest/manifest → request permission
→ activate exact package → issue bounded capability handles
→ route guest calls through broker owners → revoke on transition or failure
```

Plugin UI is a typed document projected through `plugin_surface_runtime` and
the frontend plugin transport. Plugins do not inject arbitrary React or gain
ambient filesystem, network, Workspace R, or credential access.

Rho's built-in Surfaces are application capabilities, not installed plugins.
The UI groups them as Core Workbench, Workspace R, Results & Verification,
Agent Collaboration, and Project Integration; only eight stable task Surfaces
appear in Compose, ordered as work → run → results → collaborate → project.
Failed-run Problems, checks, evidence, rendering, logs, and other contextual
viewers stay available to commands and result workflows instead of competing
with Console and History, while development fixtures remain development-only. The
project extension list contains only accepted workspace-plugin packages.

Current behavior is best read from the crate public exports, the WIT contract,
`workspace_plugins/`, and their adjacent tests.
