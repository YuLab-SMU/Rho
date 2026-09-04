# Environment realization

Rho models a scientific Environment as desired state plus an observed
realization. Agent text and UI state are never proof that a Runtime, package,
scheduler job, or Workspace binding exists.

## Ownership

- `rho-protocol` owns Runtime, LibraryStack, RepositoryProfile,
  ExecutionProfile, immutable PackagePlan, Incident, receipt and Workspace
  binding contracts.
- `rho-environment` owns discovery and plan semantics for Native User R,
  Project Renv, Core Support, Conda/Lmod and Apptainer profiles.
- `rho-store` schema v20 owns desired/realization revisions, plan records, receipts,
  incidents and bindings.
- `rho-workspace` owns the live binding state and verifies restart and
  re-observation transitions.
- `r/rho.environment` is a fixed non-interactive adapter for renv, pak and
  Bioconductor operations; it is not an arbitrary shell endpoint.

The active desktop surface currently exposes Environment health and
re-observation. Materialized plans may be displayed from Store, but there is no
registered desktop apply command in the current implementation. Code and the
Tauri inventory are authoritative.

## State transition

```text
observe → materialize immutable plan → execute through an operation owner
        → verify and record receipt → restart when required
        → re-observe live Workspace → activate binding
```

A request is accepted based on well-formed arguments, current revisions and
executor availability—not a Rho-owned approval record. Unknown execution
outcomes remain uncertain and reconcile by operation identity.

An Environment binding becomes active only when its verified receipt matches
the exact desired revision, realization revision and receipt digest. A pending
restart or failed re-observation prevents stale Workspace execution; this is an
implementation consistency constraint.

## Local and remote profiles

An ordinary existing R project stays NativeUser. An existing `renv.lock`, a
new reproducible project, or explicit adoption selects ProjectRenv. Core Support
is isolated from both. System and user-selected R are first-class; rig is an
optional provider.

ExecutionSpec binds Environment receipt, desired and realization revisions,
ExecutionProfile and RepositoryProfile digests. The standalone runner verifies
structured specs and staged bytes. Lmod state is ordered, Conda uses a canonical
prefix, and Slurm reconciliation preserves uncertain scheduler outcomes.

## Focused checks

```bash
cargo test -p rho-environment --locked
cargo test -p rho-workspace --locked
Rscript -e "testthat::test_local('r/rho.environment')"
```
