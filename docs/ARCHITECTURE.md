# Architecture

The repository's root Cargo workspace is the production system. Its default
member builds `rho`, using the components under `crates/`, helpers under `r/`
and client under `ui/`. Old crates,
the old Tauri application and their dedicated source/tests have been removed.

```text
rho CLI / local browser / official MCP
                 |
              one Host
          /                 \
 Operation Gateway       Query Gateway
 idempotency, bounds      bounded observation
          |                 |
       registered domain handlers
 Workspace / Project / Environment / Execution
          |
       domain ports
          |
 Ark + R / Git / pak + renv / OS + OpenSSH + Slurm
          |
 owner report -> CommitPlan -> SQLite transaction
                             operation + facts + events
```

Commands have one OperationId and one immutable terminal outcome. Queries do not
create Operations or trigger startup/recovery merely to read a recorded result.
Domain handlers interpret observations; the foundation enforces admission and
atomic commit. Adapters do not own a second result store.

Git owns project history, R owns live objects, native lockfiles describe package
environments, and Slurm owns scheduler state. Rho references those identities;
there is no global Rho revision counter, Agent approval flow, conversation store
or parallel audit/provenance system.

Host startup acquires an OS lease on `.rho/next-host.lock` in the canonical project
before creating its journal or runtime. Accepted work retains the runtime and
lease after the caller disconnects. This is cooperative Next ownership, not a
sandbox or a lock respected by arbitrary external processes. Lock existence does
not indicate liveness; the OS releases ownership when the holder exits.

The browser and HTTP MCP share one Host. MCP sessions pin their selected project;
active work blocks a switch. A new project's ownership is reserved before the old
session is ended. Core ports are `invoke`, `getOperation`, `requestCancellation`,
`querySnapshot` and cursor-based `subscribe`. Types are generated from Rust.

Legacy data assets are abandoned. Source replacement uses fresh application
state, not imports, archive readers, dual writes or cross-version session handoff.
See [the charter and ledger](NEXT-SYSTEM.md) for decisions, remaining work and
actual verification scope; [the operator guide](OPERATIONS.md) contains commands.
