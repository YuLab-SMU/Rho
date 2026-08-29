# Architecture

Rho is a local-first R workbench. The desktop frontend presents state; the
Rust application coordinates it; long-lived R processes execute scientific and
Agent work; SQLite stores durable product state.

```text
React RSR
  │ generated Tauri facets (or browser mock)
  ▼
Tauri commands ── AppState / registries ── rho-store ── SQLite
  │                         │
  │                         └─ extension and plugin runtime
  ▼
rho-server coordinator
  ├─ Workspace lane ── Ark ── rho.bridge
  └─ Agent lane ───────────── rho.agent / aisdk

rho CLI and MCP ── public workbench protocol ── read-side store projection
```

## Authority

- Workspace R is authoritative for live R execution and scientific objects.
- The Rust broker owns process lifecycle, project identity, revisions,
  permissions, transport, durable coordination, and resource-admission policy.
- `rho-store` owns persisted projects, runs, outputs, evidence, Agent records,
  environment snapshots, and plugin lifecycle state.
- React owns presentation and ephemeral interaction state. A UI state is not
  permission or durable truth.
- Generated TypeScript mirrors Rust command contracts. Browser mock behavior
  is a development projection, not a second backend.

## Main code areas

| Area | Entry points |
| --- | --- |
| Shared protocol and broker types | `crates/rho-protocol`, `crates/rho-core` |
| Durable state | `crates/rho-store` |
| Workspace and Agent coordination | `crates/rho-server`, `crates/rho-kernel`, `crates/rho-agent-transport` |
| Desktop backend | `desktop/src-tauri/src/main.rs`, `commands/`, registries |
| Desktop frontend | `desktop/ui/src/main.tsx`, `app/`, `transport/` |
| R processes | `r/rho.bridge`, `r/rho.agent` |
| Extensions | `crates/rho-extension-runtime`, `desktop/src-tauri/src/workspace_plugins` |
| Targets and resource governance | `crates/rho-toolchain`, `desktop/src-tauri/src/commands/resource_monitor.rs` |
| Public tools | `crates/rho-cli`, `crates/rho-mcp` |

Open the generated [source index](SOURCE-INDEX.md) for exact paths
and executable checks. Component pages explain only details that are difficult
to infer from the directory structure.
