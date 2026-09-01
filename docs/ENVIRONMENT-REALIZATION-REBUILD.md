# Environment Realization System rebuild

> Temporary construction contract for replacing `rho-toolchain` with explicit
> Environment ownership. Progress is tracked by
> `programs/rho-rebuild/PROGRESS.json`. This plan reuses proven execution,
> journal and target code, but it does not retain the old module as a forwarding
> compatibility crate.

| Field | Current value |
| --- | --- |
| Project | `environment-realization` |
| Status | complete; local production cut, hermetic R slice, Desktop receipt/restart slice and required YuLab acceptance pass |
| Baseline | `main@56380569917b` plus active Evidence Graph changes |
| Platform | local macOS first; remote YuLab only at the remote acceptance package |
| Compatibility | destructive owner migration; preserve user projects and receipts, not module APIs |
| Completed package | `ENV-00`–`ENV-15` |
| Active package | none |
| First real slice | Native User R missing-package plan → approval → isolated install → verify → receipt → Workspace rebind |

## Goal

Build a complete Environment Realization System:

```text
System/User-selected R and user packages
        +
Project renv desired state
        +
Rho private core support environment
        +
Conda / Lmod / Slurm / Apptainer profiles
        ↓
identity -> plan -> approval -> execution -> verification -> receipt -> reconcile
```

Rho does not implement an R package resolver. The verified upstream boundaries
are:

- rig: enumerate and locate installed R versions; selecting a project runtime
  must not change the user's default or system configuration;
- renv: `plan()` resolves without install, `restore()` realizes an existing
  lock, and `snapshot()` writes desired lock state with non-interactive prompts
  disabled;
- pak: dependency solving/install, cache, binary/source selection and
  `pkg_sysreqs()`; Rho materializes and approves the exact result around it;
- Conda/Lmod: runtime/native realization rather than an implicit shell profile;
- Broker: sole admission and exact-effect approval authority;
- Execution/Runner: sole process and remote effect mechanism.

## Baseline audit and completed cut

At the recorded baseline, useful mechanisms existed but ownership was mixed:

- `rho-toolchain` already contains strict `rho.toml`, rig discovery,
  rig/renv/pak/uv Doctor, Target Admission, local Docker/Conda adapters,
  authenticated SSH helper transport, operation journal, uncertain outcome and
  reconciliation logic.
- `rho-execution` already owns local, OCI, SSH and Slurm process lifecycle.
- `rho-runner` already owns a bounded remote protocol, journal and artifacts.
- `rho-store` already owns environment snapshots and operation requests.
- Desktop already exposes Toolchain Doctor, resource monitoring, compute target
  setup, plan review and environment operation requests.

Those baseline defects drove the work packages below. The completed cut now has
`rho-environment`, canonical plan/revision/receipt contracts, schema v19 Store
projections, exact Broker/Execution coordination and the split Environment
Authority UI. `rho-toolchain`, direct live-Workspace renv mutation requests and
their `environment_operation_requests` table are absent.

The baseline defects were:

- `rho-toolchain` combines desired state, runtime discovery, target adaptation,
  package effects, remote transport semantics and receipts.
- Desktop startup automatically initializes renv for an ordinary R project
  with no contract; this must be removed.
- there is no canonical Desired versus Realization revision split;
- System/UserSelected/Rig/Conda/Module/Image ownership and support tier are not
  orthogonal first-class contracts;
- Rho core support packages are not modeled as a private realization isolated
  from Native User and Project Renv libraries;
- package inventory does not preserve every installation/layer identity;
- repository, binary/source, sysreq, artifact, network and secret requirements
  are not frozen into one immutable materialized plan;
- Workspace does not bind an explicit desired + realization + receipt identity;
- no `rho-environment` owner exists, so deleting `rho-toolchain` is not yet safe.

## Frozen decisions

### Runtime ownership and support are independent

```text
RuntimeOwnership
  System
  UserSelected
  Rig
  Conda
  Module
  ImmutableImage

RuntimeSupportTier
  Verified
  Compatible
  ObservedOnly
```

A system R may be Verified. A rig experimental R may be ObservedOnly. Rho never
upgrades or deletes a System/UserSelected runtime.

### Three local environment roles never collapse

```text
Rho Core Support Environment
  rho.bridge / rho.environment / jsonlite / renv / pak / first-party adapters
  Rho-owned, versioned per RuntimeRealization, absent from user renv.lock

Native User Environment
  User library -> Site library -> System library
  preserves the selected R, safe project startup files and effective .libPaths()

Project Renv Environment
  Project renv library -> explicitly admitted external layers -> base/recommended
  strict when renv.lock exists or the user explicitly adopts reproducibility
```

### Existing projects do not auto-adopt renv

| Project | Default |
| --- | --- |
| Existing `renv.lock` | Project Renv |
| Existing ordinary R project | Native User |
| New reproducible Rho project | Project Renv |
| Explicit “make reproducible” action | reviewed Native → Renv adoption |

Detecting an R file is not authority to create `renv/`, install packages or
write a lockfile.

### Desired and Realization revisions are separate

```text
EnvironmentDesiredRevision
  core manifest / renv.lock digest
  RepositoryProfile digest
  ExecutionProfile digest
  ownership policy

EnvironmentRealizationRevision
  exact R build fingerprint
  LibraryStack digest
  installed PackageInstallation inventory digest
  native/toolchain fingerprint
  Conda/module/image realization digest
```

Every receipt binds both. A desired revision may legitimately be ahead of the
realization after a crash; recovery restores or reconciles rather than claiming
rollback.

### Authority and recovery

- `rho-environment` owns semantics and provider adapters, not approval.
- Broker owns admission, policy and exact approval.
- Agent may inspect, explain, propose and request apply; it receives no install
  permission, arbitrary shell, sudo or repository secret.
- The shipped Agent adapter advertises only inspect, explain, propose and
  operation-inspect. `environment.request_apply_plan` belongs to the trusted
  Broker/Desktop apply handoff and is not an Agent-side install tool.
- The general guarantee is journal + checkpoints + verification + reconcile.
- Only the Rho Core Support Pack may provide true directory-version rollback
  through an atomic active pointer.

## Target ownership

| Module | Responsibility |
| --- | --- |
| `rho-protocol` | canonical Runtime, Library, Profile, Plan, Incident, Binding and Receipt types |
| new `rho-environment` | environment semantics, provider SPI, plan normalization and verification |
| new `r/rho.environment` | fixed non-interactive renv/pak/Bioc probes and effects |
| `rho-control-plane` | admission, exact approval and environment operation coordination |
| `rho-execution` | local/OCI/SSH/Slurm environment mutation process lifecycle |
| `rho-runner` | remote helper, operation journal and staged artifact custody |
| `rho-store` | desired, realization, operation, incident and receipt events/projections |
| `rho-secret-broker` | repository/proxy/Git credential leases |
| `rho-sandbox` | retrieve/build/verify isolation |
| `rho-workspace` | EnvironmentBinding, stale detection and restart/rebind |
| `rho-agent-host` | Agent Doctor and typed proposal capabilities |
| `rho-ui-contract` / Desktop | immutable plan review, activity, recovery and health UX |

After all live logic moves to the new owners, delete `rho-toolchain`. Do not
retain a forwarding crate.

## Canonical model

```text
RuntimeRequirement
  distribution, exact_version, platform, architecture

RuntimeRealization
  runtime_id, ownership, support_tier
  r, rscript, r_home
  executable_digest, build_fingerprint, compiler_fingerprint

LibraryLayer
  layer_id
  kind: RhoCoreSupport | ProjectRenv | User | Site | System
  owner: Rho | Project | User | SiteAdministrator | RDistribution
  mutability: RhoManaged | UserWritable | ReadOnly | ExternallyManaged
  canonical_path, filesystem_identity, priority

LibraryStack
  ordered_layers, effective_digest

PackageInstallation
  name, version, library_layer_id, built_r_version
  source, repository, native_code, loadable

EnvironmentIdentity
  environment_id, role, project_id?, target_id, execution_profile_id

ExpectedEnvironmentState
  desired_revision, realization_revision, project_revision?, repository_profile_digest
```

Package inventory records every installation, not one value per package name.
Shadowing and mixed-prefix incidents are therefore observable facts.

```text
RepositoryProfile
  repositories, bioconductor_version, snapshot
  binary_preference, source_fallback_policy, offline_policy
  proxy_profile_ref, trust_bundle_ref, credential_refs, allowed_origins

PackageIntent
  restore_locked | add_dependency | install_user_package | install_unlocked
  adopt_project_environment | repair_core | update_dependency | remove_dependency

MaterializedPackagePlan
  plan_id = sha256(canonical plan)
  environment_id, expected_before, intent, runtime
  exact ordered LibraryStack digest and writable role-layer target path
  repository_profile_digest
  package_actions, native_requirement_actions, toolchain_actions, lockfile_action
  artifact_digests, network_intents, secret_requirements
  verification_probes, restart_required, expires_at
```

Plans contain secret requirements/refs, never leased credential material.

```text
EnvironmentOperationReceipt
  operation_id, plan_id, actor, approval/effect digest
  desired_before/after, realization_before/after
  checkpoints, execution refs, verification refs
  outcome: succeeded | failed | cancelled | uncertain | reconcile_required
  partial_effects_possible, restart_required

WorkspaceEnvironmentBinding
  environment_id, desired_revision, realization_revision, receipt_digest
```

## Operation pipeline

```text
Observe
  -> classify intent
  -> resolve with renv::plan / pak metadata into quarantine candidate
  -> materialize exact archives, Git commit SHA, SHA-256, binary/source form
  -> freeze immutable MaterializedPackagePlan
  -> persist a read-only plan review projection
  -> Broker exact approval
  -> isolated stage/build through Execution
  -> verify loadability, runtime/library/native facts
  -> commit desired state
  -> commit realization state
  -> durable receipt
  -> Workspace restart/rebind and re-observe
```

Isolation is phase-specific:

| Phase | Network | Secret | Filesystem |
| --- | --- | --- | --- |
| Resolve/retrieve | repository allowlist | repository credential only | cache/quarantine RW |
| Build/install | denied by default | none | project RO, staging RW |
| Verify | denied | none | staged realization RO |
| Commit | none | none | exact admitted library/lock destination |

Source package install scripts are untrusted code.

### Commit semantics

Native User installs to the exact selected user library, verifies it, records an
externally-mutable realization and writes no lockfile.

Project Renv add/update stages and verifies before committing the candidate
lock desired revision and project library realization. If a crash leaves
desired ahead of realization, the recovery action is `restore_locked`.

Restore Locked keeps the existing desired revision and creates only a new
verified realization. Core Repair builds a new version directory, verifies it,
then atomically switches the active pointer.

## Discovery and incidents

The Local Runtime provider observes user-selected Rscript, PATH R/Rscript,
macOS R.framework, Windows registry/standard roots, Linux prefixes, rig, Conda
prefixes and admitted Module profiles. Canonical R home deduplicates equivalent
entry points. Discovery never changes PATH, a default symlink or registry.

Two probes remain distinct:

```text
Controlled Probe
  Rscript --vanilla for trusted fingerprint and fixed helpers

User Session Probe
  the actual admitted Workspace startup configuration for .Rprofile,
  .Renviron and .libPaths() observations
```

Structured incidents include at least:

```text
missing_package, version_mismatch, namespace_load_failure
package_built_for_other_r, shadowed_package, mixed_prefix, path_shadowing
header_missing, shared_library_missing, symbol_mismatch
compiler_missing, fortran_missing
repository_tls_failure, credential_failure
environment_not_propagated, module_not_available
```

## Conda, Lmod, Slurm and Apptainer

An `ExecutionProfile` binds target, scheduler, module stack, Conda prefix,
runtime, ownership split, RepositoryProfile, StorageProfile and resource
defaults.

- Conda prefix is a locator; `conda list --explicit` digest is realization
  identity. Use `conda run --prefix`; never modify shell startup files.
- Initial ownership is Conda for R/native dependencies and renv for R packages.
- Lmod persists an ordered fully-qualified module stack plus environment-delta
  digest, not an unexplained PATH string.
- Package builds do not run on a login node. Exact artifacts go to remote CAS,
  then a Slurm compute job builds offline, verifies and commits to admitted
  shared storage.
- `ExecutionSpec v1` binds the exact Environment receipt plus desired,
  realization, ExecutionProfile and RepositoryProfile digests. Runner accepts
  it only with a matching immutable staging manifest whose Environment and
  input blobs were lease-scoped, size/digest verified from remote CAS and
  atomically installed read-only.
- Slurm uses `--export=NIL` or an exact export file; never implicit user-env
  recovery.
- Apptainer has `RPackageOwnership=ImmutableImage`; package changes produce a
  reviewed image rebuild plan, never an in-container install.

## Workspace, Agent and UI

An environment change never silently upgrades the current Workspace. New work
is marked `restart_required`; restart creates a new kernel identity and binding.
Failed source code is not replayed. Agent must re-observe.

Agent-provider capabilities:

```text
environment.inspect
environment.explain_incident
environment.propose_change
environment.operation.inspect
```

The Agent proposal carries the trusted handoff capability identifier
`environment.request_apply_plan`, but the Agent provider cannot invoke it.
Only a reviewed materialized plan plus an exact Broker lease can enter the
Desktop apply composition seam.

The initial UI is contextual rather than a traditional Packages control panel:

- project-open Environment health;
- missing-package card beside the failed Console/Run;
- Agent proposal card;
- immutable exact-plan review;
- Slurm build link into Jobs;
- Activity stages: resolve/retrieve/build/verify/commit/reconcile;
- explicit Workspace restart/rebind after success.

## Work packages

| ID | Status | Depends on | Outcome |
| --- | --- | --- | --- |
| `ENV-00` | done | — | current implementation audit, upstream boundary check, and this contract |
| `ENV-01` | done | `ENV-00` | canonical Runtime/Library/Profile/Plan/Incident/Binding/Receipt contracts and architecture guards |
| `ENV-02` | done | `ENV-01` | create `rho-environment` and fixed `r/rho.environment`; migrate semantic seams and define `rho-toolchain` deletion map |
| `ENV-03` | done | `ENV-01` | desired/realization/operation/incident Store events and projections |
| `ENV-04` | done | `ENV-01` | Broker capabilities, exact plan/effect binding, and Agent proposal-only boundary |
| `ENV-05` | done | `ENV-02` | System/UserSelected/Rig discovery, dual probes, LibraryStack and PackageInstallation inventory |
| `ENV-06` | done | `ENV-02`, `ENV-05` | versioned Rho Core Support Pack with atomic active pointer |
| `ENV-07` | done | `ENV-02`, `ENV-05` | Native User and Project Renv planning; remove automatic renv adoption |
| `ENV-08` | done | `ENV-07` | RepositoryProfile, exact artifact materialization, sysreq, network and secret requirements |
| `ENV-09` | done | `ENV-03`, `ENV-04`, `ENV-07`, `ENV-08` | local apply/verify/commit checkpoints, cancel and reconcile through Execution |
| `ENV-10` | done | `ENV-09` | Workspace binding, PackageIncident, restart admission and re-observation |
| `ENV-11` | done | `ENV-10`, `FE-03` | contextual Environment UI, Agent Doctor and local Environment gate |
| `ENV-12` | done | `ENV-09` | ExecutionSpec Environment/Profile refs, runner staging and remote CAS contract |
| `ENV-13` | done | `ENV-12` | Conda/Lmod profile resolver, Slurm offline build and remote environment reconciliation |
| `ENV-14` | done | `ENV-13` | Apptainer immutable profile, real YuLab acceptance and local hardening closure |
| `ENV-15` | done | `ENV-14` | delete `rho-toolchain`, dead UI/commands/tests and update current docs |

Only `ENV-01` starts after planning. Desktop integration in `ENV-11` waits for
the frontend Authority boundary; local contract/store/provider work does not.

## Gates

### Local truth recoverable

Must cover System R without renv, non-PATH Rscript, layered duplicate packages,
Native User install, immutable System/Site layers, Core repair, restore_locked,
add_dependency, Git commit pinning, compiler failure before mutation, malicious
package isolation, stale-plan rejection, every commit crash window, and a
Workspace binding matching the verified receipt.

### Remote truth recoverable

Must cover login/compute fingerprint differences, Conda/Lmod reconstruction,
Slurm build off the login node, ACK loss without duplicate submission,
cancel/reconcile, shared-storage commit, Apptainer rebuild semantics and a real
YuLab scenario.

### Hardened local closure

Contract parser fuzz, Store/cache fault injection, package/security corpus,
resolution/build/restart SLO and supply-chain hashes are required. Windows and
Linux Core Pack delivery remain deferred until the user reopens them.

## Minimal verification policy

```text
contract edit       -> rho-protocol focused tests
new owner seam      -> cargo check -p rho-environment plus its focused test
Store projection    -> one environment repository test
R helper            -> fixed hermetic testthat file
Broker/Execution    -> one exact plan/effect or checkpoint test
frontend package    -> typecheck + one Environment component test
local vertical exit -> Native User hermetic repository scenario + desktop build
remote exit         -> fake boundary first, one real YuLab acceptance only at ENV-14
```

No ordinary test depends on live CRAN/Bioc. Use hermetic mini repositories,
fixed Git remotes, binary/source/sysreq fixtures, malicious install fixtures
and fake Lmod/Conda/Slurm boundaries. Full workspace, release and cross-platform
matrices do not run between packages.

The real local vertical gate is opt-in because it requires local R, `pak` and
`jsonlite`:

```bash
cargo test -p rho-control-plane --test environment_local_r_slice --locked -- --ignored --test-threads=1
```

## First implementation slice

```text
selected local System/User R
  -> observe User/Site/System libraries
  -> open an ordinary project without renv adoption
  -> detect one missing package
  -> classify Native User versus explicit Project Renv intent
  -> create exact immutable materialized plan
  -> Broker approval
  -> isolated helper install into the exact target library
  -> verify namespace and realization
  -> receipt
  -> Workspace restart/rebind
  -> continue without replaying the failed expression
```

The hermetic local-R gate executes this slice with a real `Rscript`, `pak`, a
source archive and an atomic target-library commit. The Desktop slice
separately proves pre-execution plan review, exact lease admission, canonical
receipt commit and `restart_required` staging.

The slice must also prove Rho Core Support does not pollute the user library,
rig is optional, an existing renv project stays strict, and Agent can explain
or request but cannot install.

## Completion audit

- [x] Ownership and support tier are orthogonal canonical contracts.
- [x] Desired and Realization revisions are distinct and receipt-bound.
- [x] Ordinary R projects never auto-initialize renv.
- [x] Core Support, Native User and Project Renv library stacks cannot shadow each other silently.
- [x] Plans freeze target LibraryStack, artifacts, network intents, sysreqs and secret requirements before approval.
- [x] Broker is the sole mutation authority and Agent remains proposal-only.
- [x] Effects use Execution/Runner, bind exact staged Environment/Profile identities and preserve uncertain/reconcile semantics; real-cluster evidence remains in `ENV-14`.
- [x] Live Workspace binding changes only after verified receipt, explicit restart when required, and exact re-observation.
- [x] Conda/Lmod/Slurm/Apptainer semantics are explicit, digest/target-bound and rebuild-only where immutable.
- [x] `rho-toolchain` is deleted after all owners migrate; no forwarding crate remains.
- [x] Focused local and required real-remote gates pass; the YuLab report explicitly limits network enforcement to proxy environment settings.
