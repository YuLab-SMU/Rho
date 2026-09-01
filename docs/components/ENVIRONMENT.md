# Environment realization

Rho treats a scientific Environment as an authority-owned desired state plus
an observed realization. It does not use package-list UI state or Agent text as
proof that a Runtime, package, scheduler job, or Workspace binding exists.

## Ownership

- `rho-protocol` owns canonical Runtime, LibraryStack, RepositoryProfile,
  ExecutionProfile, immutable PackagePlan, Incident, receipt and Workspace
  binding contracts.
- `rho-environment` owns local/rig discovery, Native User and Project Renv plan
  semantics, artifact materialization, Core Support packs, Conda/Lmod profile
  resolution and Apptainer rebuild-only plans.
- `rho-control-plane` admits only exact plan/revision/destination effects through
  Broker leases.
- `rho-execution` owns process, SSH and Slurm lifecycle plus uncertain/reconcile
  semantics. `rho-runner` verifies staged specs and remote CAS bytes before
  launch.
- `rho-store` schema v19 commits immutable plan-review records,
  desired/realization revisions, receipts, incidents and bindings.
  `rho-workspace` activates a binding only after restart (when required) and
  exact re-observation.
- `r/rho.environment` is a fixed, non-interactive adapter for renv/pak/Bioc
  operations; it is not an arbitrary R or shell endpoint.

`rho-toolchain` no longer exists. There is no forwarding crate or compatibility
surface.

## Local modes

An ordinary existing R project stays `NativeUser`. An existing `renv.lock`, a
new reproducible project, or explicit adoption selects `ProjectRenv`. Rho Core
Support is private and isolated from both. System and user-selected R are
first-class; rig is only an optional provider and never changes the user's
default R.

Every effect follows:

```text
observe → materialize exact plan → persist read-only plan review
        → Broker exact approval → stage/execute → verify
        → atomic desired/realization/receipt commit
        → Workspace restart/re-observe → active binding
```

The plan hash includes the ordered `LibraryStack` digest and exact writable
role-layer path. The Desktop read surface can display a materialized pending
plan before any operation journal exists. Apply is accepted only when that
same stored plan is bound to the exact Broker lease and current Workspace
revisions.

Unknown execution outcomes remain `uncertain` and reconcile by operation
identity. A failed source expression is never replayed as part of Environment
restart.

The Agent adapter exposes `environment.inspect`,
`environment.explain_incident`, `environment.propose_change` and
`environment.operation.inspect`. It can name the trusted
`environment.request_apply_plan` handoff in a proposal, but cannot invoke the
apply capability or execute renv/pak itself. The retired live-Workspace
Environment mutation requests and their Store table are absent.

## Remote profiles

ExecutionSpec v1 binds the exact Environment receipt, desired and realization
revisions, ExecutionProfile and RepositoryProfile digests. Runner staging
requires an equal digest lease for every input and Environment manifest blob;
copied bytes are size/digest checked and made read-only before atomic rename.

Lmod state is an ordered list of fully qualified modules plus an environment
delta digest. Conda state is a canonical prefix plus sanitized
`conda list --explicit` digest and executes through structured
`conda run --prefix`, never shell activation. Slurm package builds use a clean
base environment, `--export=NIL`, verified offline inputs, operation markers,
and squeue/sacct reconciliation. Apptainer-owned packages produce image rebuild
plans and cannot be installed into a running image.

The current real-cluster receipt is
`test/remote-cluster/artifacts/yulab-acceptance-report.json`. It proves a
compute-node source-package build and namespace load on YuLab. Its stated
network limitation is intentional: the remote run requested deny and used
proxy-level enforcement; kernel-level denial is proven by local sandbox tests,
not claimed by the cluster receipt.

## Focused checks

```bash
cargo test -p rho-environment --locked
cargo test -p rho-control-plane --test environment_operation --locked
cargo test -p rho-control-plane --test environment_local_r_slice --locked -- --ignored --test-threads=1
cargo test -p rho-workspace --locked
cargo test -p rho-artifact-store -p rho-execution -p rho-runner --locked
Rscript -e "testthat::test_local('r/rho.environment')"
node test/remote-cluster/verify.mjs
```
