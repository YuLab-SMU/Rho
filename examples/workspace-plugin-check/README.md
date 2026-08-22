# Workspace Check rule example

This project contains a zero-permission Manifest V3 `check.rule.*` component.
It receives only an immutable project descriptor and returns one bounded,
typed informational finding. The host binds the result to the accepted plugin
digest and activation generation; the guest cannot choose or receive broker
handles in the Check lane.

From the repository root:

```sh
cargo run -p rho-plugin-dev -- build examples/workspace-plugin-check
cargo run -p rho-plugin-dev -- smoke-check \
  examples/workspace-plugin-check \
  org.yulab.rho.local-check \
  check.rule.local.structure
```

Open this directory as a Rho project, enable `org.yulab.rho.local-check`, then
run **Check project**. Its finding is labelled as a Workspace rule pack rather
than Rho core truth.
