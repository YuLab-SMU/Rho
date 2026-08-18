# P1-0 Internal Extension Runtime Contracts Specification

Status: active; P1-0 authorized 2026-08-18; implementation pending

Date: 2026-08-18
Owning architecture:
[`accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md`](../design/accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md)
Issue: [#17](https://github.com/YuLab-SMU/Rho/issues/17)
PR: [#75](https://github.com/YuLab-SMU/Rho/pull/75)
Rebased source baseline: `95d7d2c7774519ef956637aeff678ed4f2752ab5`

Change class: D3 shared architecture
Risk: R3 safety-critical lifecycle foundation, bounded in this package to pure,
side-effect-free contracts

Authorization: the user authorized P1-0 on 2026-08-18 through the reviewed
Phase 1 implementation plan. P1-1, P1-2, P1-3, and P1-4 are not authorized.
The mandatory stop point is the P1-0 evidence and review checkpoint.

## Purpose And Acceptance Boundary

P1-0 creates the host-neutral vocabulary and deterministic dependency planner
needed by later internal first-party extension work. It may add one workspace
crate and its tests. It must not activate plugins, create scopes at runtime,
register effects, integrate project switching, add a feature flag, change a
Tauri command, touch the desktop/browser mock, add persistence, or change user
behavior.

P1-0 is accepted only when:

- IDs, descriptors, scope ancestry, provider visibility, compatibility, graph
  limits, stable ordering, canonical cycles, plans, errors, and diagnostics are
  represented by typed contracts;
- equivalent descriptor sets produce byte-for-byte equivalent serializable
  plans, errors, and diagnostics regardless of input order;
- capability registration is demonstrably separate from broker permission;
- the focused and complete locked Rust checks pass locally;
- the exact pushed head passes macOS, Windows, and Linux on stable and Rust
  1.88 through the existing Rust Compatibility workflow;
- dependency license/MSRV/maintenance review is recorded; and
- the implementation is reviewed against this contract before the checkpoint
  is marked complete.

Hosted evidence cannot be claimed before the exact pushed commit finishes all
six workflow legs. P1-1 remains blocked even after P1-0 passes until separately
authorized.

## Ownership And Cross-Review

This specification owns only:

- `rho-extension-runtime` P1-0 public-within-the-workspace Rust contracts;
- validation of descriptors and the host-owned Phase 1 scope policy;
- pure capability resolution and immutable activation-plan construction;
- deterministic structured errors and diagnostics; and
- P1-0 dependency and compatibility evidence.

It does not own:

- broker policy, approvals, credentials, execution, process, filesystem,
  network, persistence, audit, or project identity;
- the authoritative project-transition sequence;
- Workspace R or Agent R transport;
- UI, Tauri commands, browser/mock state, or public Workbench Protocol;
- effect registration, task cancellation, activation, publication, quiesce,
  disposal, or feature-flag behavior; or
- Execution Target, Conda, SSH, Slurm, Compute Job, Wasm, Tauri Plugin,
  third-party discovery, marketplace, or public SDK behavior.

Cross-review conclusions:

- accepted ADR-002/ADR-003 keep the Rust broker and existing transports
  authoritative; P1-0 passes no native broker or transport object;
- BH1/BH2 keep canonical project identity and switching authority; P1-0 has no
  active-project state;
- PR #76 remains a proposed third-party design and supplies only a negative
  boundary: no third-party provider or permission API is introduced;
- Issues #95/#96 may later consume generic capability, scope/generation, effect,
  and candidate semantics, but retain complete ownership of target/runtime/job
  state and implementation;
- `active-2026-08-10-rust-msrv-build-contract.md` retains Rust 1.88, Resolver 3,
  locked dependency, and six-leg native matrix authority; and
- `active-2026-08-10-agpl-license-transition-spec.md` retains source and
  third-party licensing authority.

No schema, state, persistence, approval, policy, project-switch sequencing, or
release ownership conflict remains inside P1-0.

## Crate And Dependency Contract

Add `crates/rho-extension-runtime` as a workspace member. It inherits:

- workspace version `0.4.0`;
- Edition 2024;
- Rust 1.88 MSRV;
- `AGPL-3.0-only`; and
- the workspace repository metadata.

P1-0 dependencies are limited to:

| Dependency | Source and feature contract | Reason | Review |
| --- | --- | --- | --- |
| `serde` | existing workspace dependency with `derive` | deterministic typed contract serialization | already workspace-owned |
| `thiserror` | existing workspace dependency | structured internal error display/source integration | already workspace-owned |
| `semver` | workspace `1.x` with `serde` | standards-compliant `PluginVersion`; capability compatibility still compares only declared contract major | MIT OR Apache-2.0; Rust 1.31 for locked 1.0.26; mature maintained upstream |
| `petgraph` | `0.8`, default features off, `std` only | explicit graph representation and SCC detection | 0.8.3 reviewed; MIT OR Apache-2.0; Rust 1.64; maintained upstream; below workspace MSRV |

Rho implements stable Kahn ordering and canonical cycle-path selection itself;
petgraph iteration order is never treated as output order. `inventory`, Tokio,
ArcSwap, Wasm/Extism/Wasmtime/WASI, and dynamic loading dependencies are not
permitted in P1-0.

The lockfile may change only for this dependency addition. The final review
records the selected locked versions and verifies that no unrelated package was
updated.

## Identifier And Version Contract

Define validated newtypes for at least:

- `PluginId`;
- `CapabilityId`;
- `OperationId`;
- `ScopeKindId`;
- `ScopeId`;
- `ActivationGeneration`; and
- `PluginVersion` backed by `semver::Version`.

String identifiers accept 1 through 128 bytes. Every byte must be lowercase
ASCII `a-z`, digit `0-9`, `.`, `_`, or `-`. Empty values, 129-byte values,
uppercase ASCII, whitespace, controls, `/`, `\\`, non-ASCII, and Unicode
normalization variants fail before a descriptor can be resolved. Values round
trip through serde as strings.

`ActivationGeneration` wraps a non-zero unsigned 64-bit integer and rejects
zero. `PluginVersion` accepts complete semantic versions through
`semver::Version`; capability compatibility never uses plugin/application
version equality.

Capability declarations and requirements carry an explicit unsigned contract
major. Phase 1 compatibility is exact major equality, including major zero.

## Descriptor Contract

`PluginDescriptor` contains:

- one `PluginId` and `PluginVersion`;
- one or more allowed `ScopeKindId` values;
- `provides`, `requires`, and `optional` declarations; and
- the only P1 activation policy, `ActivationPolicy::Eager`.

Limits:

- at most 256 descriptors in one scope;
- at most 64 provided capabilities per descriptor;
- at most 64 required capabilities per descriptor;
- at most 64 optional capabilities per descriptor; and
- at most 8192 resolved requirement-provider edges in the effective graph.

Descriptor validation rejects duplicate allowed scopes, duplicate provided
capabilities, duplicate entries in either requirement class, and one
capability appearing in both required and optional sets. A descriptor is
invalid when it does not allow the scope being planned.

The dependency graph represents provider implementations only. Product-owned
configured instances are not descriptor nodes, do not provide another graph
capability, and cannot cause or resolve duplicate-provider errors.

## Scope Policy Contract

`ScopeIdentity` contains:

- validated kind;
- validated scope ID;
- optional parent scope ID; and
- non-zero activation generation.

The standard host policy is:

```text
application
  └── project
        ├── workspace
        └── agent
```

Application requires no parent. Project requires application. Workspace and
Agent require project. Validation rejects unknown kinds, missing or unexpected
parents, a parent ID that differs from the supplied parent identity, and a
parent kind not permitted by the host policy.

The policy may represent a future host-defined kind only when constructed from
host rules. No plugin descriptor or resolver API can register a kind, create a
scope, choose a parent, or reparent an identity.

## Resolver And Plan Contract

The resolver accepts one validated scope identity, descriptors selected for
that scope, and at most one already-resolved visible parent plan. A parent plan
contains the effective provider view inherited from its ancestors.

Resolution performs these steps in deterministic order:

1. enforce inventory and descriptor limits;
2. sort and validate descriptors by `PluginId`;
3. reject duplicate plugin IDs;
4. build the effective provider map;
5. reject duplicate providers in the current scope;
6. reject current-scope capability shadowing of any visible parent provider;
7. resolve required and optional requirements in plugin/capability order;
8. reject a present provider with an incompatible contract major;
9. record every absent optional requirement explicitly;
10. enforce the 8192-edge budget;
11. use petgraph to identify strongly connected components;
12. reject a canonical cycle when any cyclic component exists; and
13. use Rho's `BTreeSet`-backed Kahn algorithm with `PluginId` tie-breaking to
    produce activation order.

An optional requirement may be absent. If a provider is visible but has an
incompatible major, resolution fails rather than silently treating that
provider as absent.

The plan is immutable and serializable. It contains:

- the planned scope identity;
- stable activation order for current-scope plugins;
- every requirement's provider binding, including provider plugin, provider
  scope/generation, and contract major; and
- an explicit absent-optional binding and typed diagnostic for every missing
  optional capability;
- the effective provider view required by a child plan.

Bindings and diagnostics use sorted containers or sorted vectors. No hash-map,
petgraph node/edge iteration, or caller input order may leak into output.

## Canonical Error And Cycle Contract

The structured error surface covers at least:

- invalid identifier or zero generation;
- invalid descriptor;
- plugin/declaration/edge limit exceeded;
- duplicate plugin ID;
- duplicate provider, including current-versus-parent shadowing;
- missing required capability;
- incompatible contract major;
- invalid scope or parent; and
- dependency cycle.

When multiple candidates exist, the resolver reports the first error according
to sorted plugin/capability/provider order, never caller order.

For cycles:

1. normalize every cyclic SCC by sorted `PluginId`;
2. select the lexicographically smallest normalized cyclic SCC;
3. start at its smallest `PluginId`;
4. traverse only that SCC with lexicographically sorted adjacency and
   deterministic backtracking; and
5. return a closed path whose final ID repeats the first.

A self-loop is `[plugin, plugin]`. Equivalent inventories must return exactly
the same canonical path.

Every error converts to an `ExtensionDiagnostic` with a stable typed code,
severity, and bounded typed context. P1-0 adds no log sink or persistence.

## Test Matrix

Focused unit/contract coverage includes:

- every identifier boundary and rejected character class;
- semantic plugin-version parsing and major-only capability compatibility;
- descriptor empty/duplicate/limit failures;
- empty inventory and independent plugins;
- required ordering;
- optional present, absent, and incompatible-provider behavior;
- duplicate plugin and same-scope provider;
- current-versus-parent provider shadowing;
- missing required provider;
- direct, multi-node, self, and multiple-SCC cycles;
- canonical cycle and complete plan/error/diagnostic permutation invariance;
- all four standard scope parent relationships and invalid parent cases;
- future host-owned kind representation without plugin registration;
- provider implementation versus multiple configured product instances;
- 256/257 plugin, 64/65 declaration, and 8192/8193 edge boundaries using
  bounded payload shapes; and
- serialization round trips for core contracts and plans.

Required local stop-gate commands:

```text
cargo fmt --all -- --check
cargo test -p rho-extension-runtime --locked
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
git diff --check
```

Run the focused crate on local Rust 1.88 when that toolchain is available. The
existing GitHub Rust Compatibility workflow is the authoritative six-leg
macOS/Windows/Linux stable/1.88 locked matrix.

No R, frontend, browser/mock, installed-app, packaging, or manual UI check is
affected by this pure package. These are recorded as intentionally unrun, not
as passing.

## Version, NEWS, And Release Decision

P1-0 adds an internal, unused workspace crate and no user-visible behavior,
distributed protocol, R package contract, schema, command, or UI. It does not
change the application version, R package versions, `NEWS.md`, installer, or
release decision.

P1-4 owns the first possible development-candidate version decision after the
runtime becomes user-reachable. If an earlier package unexpectedly changes
visible behavior, work stops and this contract is amended before versioning.

## P1-0 Stop Gate And Handoff

At completion, update this active contract with:

- exact implementation commit and locked dependency versions;
- exact local commands, counts, and results;
- exact hosted workflow run and all six job results, or an explicit open gate;
- independent contract/security review findings and resolutions;
- actual deviations;
- version/NEWS decision;
- manual/installed checks not run;
- residual risks and worktree state; and
- the statement that P1-1 is still unauthorized.

This document remains `active-` after P1-0 because Phase 1 integration and
acceptance are incomplete. Passing P1-0 is not Phase 1 implementation or
release readiness.
