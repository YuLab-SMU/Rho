# Multi-instance Workspace Surface

This project is the shortest local engineering loop for a Manifest V3
`ui.surface.*` component. Its zero-permission Wasm guest contributes one
declarative Surface factory with `multi_instance` policy, a compact/full sizing
range, a field, and a command button.

From the repository root:

```sh
cargo run -p rho-plugin-dev -- build examples/workspace-plugin-surface
cargo run -p rho-plugin-dev -- check examples/workspace-plugin-surface
cargo run -p rho-plugin-dev -- smoke-surface \
  examples/workspace-plugin-surface \
  org.yulab.rho.local-surface \
  ui.surface.local_notes
```

`smoke-surface` opens two independent logical instances when the declaration is
multi-instance, invokes the exact snapshotted Guest ABI V2 component once for
each, parses both results through the bounded SurfaceDocument contract, and
reports document/block/control counts. It does not install, publish, sign, or
grant authority to the component.

The fixture intentionally has no resource or runtime requirement. A real
Console Surface would declare a runtime kind and receive the exact selected
runtime binding; a file Surface would receive an independently selected
resource binding and mode. Repeating a mode or binding is valid because each
placement owns an independent Surface instance.
