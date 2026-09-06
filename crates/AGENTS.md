# Working on Rho components

Read [the system charter and replacement ledger](../docs/NEXT-SYSTEM.md) before
changing this workspace. It is the task-specific design and progress record;
code and reproducible execution remain evidence of what exists.

The repository root Cargo workspace is the only production system. Rust components
live here; R helpers and the UI live at the repository root. Legacy source is retired. Keep old Rho
crates out of the dependency graph. The R adapter may reuse third-party Jet code
under vendor/jet; it must not call the old rho-kernel or server coordinator.
Edges call Host ports. Domains interpret observations; adapters interact with
runtimes. All effectful requests share Operation identity, admission and
commit discipline. Queries must not start a runtime or trigger recovery merely
to read a recorded result.

Legacy data assets are abandoned because there are no real users. Do not spend
work on old-data inventory, migration, import, read-only archive access or
cross-version session handoff. Start with fresh Next application state. The
replacement task concerns capabilities and code, not legacy data continuity.

Keep native identities and owner-specific preconditions. Do not add a global
Rho revision counter, Agent approval, separate audit pipeline or duplicate
result database. Preserve uncertainty after unconfirmed external effects.
Cancellation requests and confirmed cancellation are different facts.

Use the closest Next tests while iterating. The workspace gate is
`cargo test --workspace --locked`; architecture
checks use `node scripts/check-architecture.mjs`. Real Ark/R acceptance
uses `node scripts/test-real-r.mjs` and needs an installed Ark, R/jsonlite,
and local loopback access. A skipped external-runtime test is not a pass.
Run only one Cargo build/test/check process at a time.

Update the ledger when a milestone, decision or ownership changes. Record the
commands that actually ran. Ready in Next is not production cutover: delete
legacy implementations only after their consumers have migrated. The full
goal includes the remaining domains and old-system retirement, not just the
first verified R operation.
