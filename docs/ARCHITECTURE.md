# Architecture

Rho is a local-first scientific workbench and execution environment for external
ACP Agents. Rho exposes state and capabilities, executes well-formed requests,
records observable outcomes, and preserves recovery information. It does not
implement an Agent model loop or a second permission system.

```text
React Workbench
  │ typed Tauri commands
  ▼
Desktop composition root
  ├─ external ACP process ── Rho MCP state/capability projection
  │                         └─ authenticated turn-scoped Agent Gateway
  ├─ rho-workspace ── live Workspace R binding and revisions
  ├─ rho-environment ── Environment contracts, observation and realization state
  ├─ rho-store ── durable runs, artifacts, conversations and receipts
  ├─ rho-evidence-graph ── project-local claims, gaps and traces
  └─ rho-sandbox ── disposable snapshots, staging and network containment

Agent Gateway
  ├─ CapabilityRegistry: identity, schema and byte-bound validation
  ├─ operation owners: execute the request
  └─ OperationMonitor: passive factual observation
```

## Runtime rules

- External ACP Agents receive the disposable project Workspace, native ACP
  filesystem and terminal capabilities, an MCP state snapshot, and live Rho
  capabilities.
- Rho validates identity, shape, containment, quotas and revision integrity. It
  does not judge intent or ask for a second approval.
- Project changes are captured as a snapshot delta and committed through a
  journal with base revision and per-file digest checks. Partial outcomes remain
  explicit and retain reconciliation material.
- Workspace R is the single live scientific state. Terminal execution advances
  revisions when it may have mutated the Workspace or when the outcome is
  uncertain.
- Environment bindings activate only after a verified receipt and required
  restart/re-observation. This is state consistency, not Agent permission.
- Network modes are deny, provider-only, allowlisted, or unrestricted. Every
  enabled mode still enforces HTTPS parsing, DNS pinning/rebinding checks,
  forbidden-address checks, redirect bounds and byte quotas.
- Store owns durable facts. Evidence Graph owns claims and links but resolves
  current Authority facts from their owners.

## Component boundaries

| Component | Current responsibility |
| --- | --- |
| `rho-protocol` | Canonical IDs, requests, events, revisions and receipts |
| `rho-control-plane` | Capability contract validation, journaled project commits and passive operation observation |
| `rho-acp-client` | ACP transport and client capabilities for external Agents |
| `rho-mcp` | Bounded state/capability projection and Gateway forwarding |
| `rho-workspace` | Environment-binding state and Workspace revision tracking |
| `rho-environment` | Environment discovery, planning and realization semantics |
| `rho-store` | Durable operational projections and Authority feed |
| `rho-evidence-graph` | Project-local evidence graph |
| `rho-sandbox` | Snapshot, staging, process and network containment |
| `rho-server` | Live Workspace protocol and ACP turn persistence |
| `rho-core`, `rho-kernel` | Workspace broker state and Ark session |
| `rho-ui-contract`, `desktop/` | Typed desktop composition and presentation |
| `rho-extension-runtime`, `rho-plugin-dev` | Isolated extension runtime and authoring |
| `rho-runner` | Standalone authenticated structured-spec runner |

`rho-execution`, `rho-artifact-store`, and `rho-secret-broker` remain
standalone library components; the current desktop dependency graph does not
claim that they are wired into its live path.

The generated [source index](SOURCE-INDEX.md) maps files to executable checks.
