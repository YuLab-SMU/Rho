# P1-0 Internal Extension Runtime Contracts Specification

Status: active Phase 1 predecessor; P1-0 implementation and automated Draft
verification complete 2026-08-18; P1-1 separately authorized; six-leg matrix
deferred to P1-4

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
Phase 1 implementation plan. P1-0 reached its Draft stop gate; P1-1 was
separately authorized later on 2026-08-18. P1-2, P1-3, and P1-4 are not
authorized.

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
- the exact pushed head passes the read-only Ubuntu-stable Rust Fast workflow;
- local Rust 1.88 focused and current-toolchain workspace evidence passes;
- dependency license/MSRV/maintenance review is recorded; and
- the implementation is reviewed against this contract before the checkpoint
  is marked complete.

Hosted Draft evidence cannot be claimed before the exact pushed commit finishes
Rust Fast. The full macOS/Windows/Linux stable/Rust-1.88 matrix is deliberately
deferred to P1-4 after the whole P1 stream is complete. P1-1 remains blocked
even after P1-0 passes until separately authorized.

Verification amendment (2026-08-18): the first Rust 1.88 focused run passed,
then `node scripts/test-rust-msrv-contract.mjs --test` reproduced a baseline
self-test defect. The real candidate workflow contains all three required
macOS/Windows/Linux locked workspace-test commands and the repository-mode
contract passes, but the synthetic candidate fixture contained only Windows
and macOS jobs while asserting a count of three. P1-0 may add only the missing
synthetic Linux job to that fixture. This repair must not change the real
workflow, matrix, MSRV, command contract, packaging, or release authority.

## Ownership And Cross-Review

This specification owns only:

- `rho-extension-runtime` P1-0 public-within-the-workspace Rust contracts;
- validation of descriptors and the host-owned Phase 1 scope policy;
- pure capability resolution and immutable activation-plan construction;
- deterministic structured errors and diagnostics;
- P1-0 dependency and compatibility evidence; and
- the bounded existing Rust MSRV synthetic-fixture correction recorded above.

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
| `semver` | workspace `1.x` with `serde` | standards-compliant `PluginVersion`; capability compatibility still compares only declared contract major | locked 1.0.28; MIT OR Apache-2.0; Rust 1.68; mature maintained upstream |
| `petgraph` | `0.8`, default features off, `std` only | explicit graph representation and SCC detection | 0.8.3 reviewed; MIT OR Apache-2.0; Rust 1.64; maintained upstream; below workspace MSRV |

Rho implements stable Kahn ordering and canonical cycle-path selection itself;
petgraph iteration order is never treated as output order. `inventory`, Tokio,
ArcSwap, Wasm/Extism/Wasmtime/WASI, and dynamic loading dependencies are not
permitted in P1-0.

The only new transitive lock entry is `fixedbitset 0.5.7`, maintained under the
petgraph organization, licensed MIT OR Apache-2.0, and declaring Rust 1.56.
The other petgraph dependencies were already locked in this workspace.

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
- validated serialization round trips for core input/error/diagnostic contracts
  and deterministic one-way serialization for host-built scope policies and
  resolver-built plans. `ScopePolicy` and `ActivationPlan` do not expose a
  deserialization path that bypasses their constructors.

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
exact-head Rust Fast is the Draft hosted gate. The existing GitHub Rust
Compatibility workflow remains the authoritative six-leg
macOS/Windows/Linux stable/1.88 locked matrix at P1-4/Ready and `main`.

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

### Implementation and local evidence — 2026-08-18

Implementation commit:
`bb9f1e16b742db287666de98287c4cb2ebf473dd`.

Implemented:

- new pure `rho-extension-runtime` workspace crate with `#![forbid(unsafe_code)]`;
- validated string ID newtypes, non-zero activation generation, semver-backed
  plugin version, contract-major declarations, descriptors, scope identity,
  and host-owned scope rules;
- immutable one-way-serializable activation plans, explicit parent provider
  bindings, explicit absent optional bindings, and typed diagnostics;
- deterministic descriptor normalization, provider validation, current/parent
  shadow rejection, petgraph SCC detection, canonical cycle selection, and
  Rho-owned `BTreeSet` Kahn ordering;
- all declared plugin/declaration/edge bounds; and
- the authorized synthetic Linux candidate job in the MSRV self-test fixture.

Dependency evidence:

- locked `petgraph 0.8.3` uses `default-features = false` and only `std`;
- the only new transitive lock entry is `fixedbitset 0.5.7`;
- `semver 1.0.28` was already locked and now has workspace ownership with its
  `serde` feature;
- petgraph/fixedbitset/semver are MIT OR Apache-2.0 and declare Rust
  1.64/1.56/1.68 respectively; and
- `cargo metadata --locked --offline --no-deps` reports version `0.4.0`, Edition
  2024, Rust 1.88, `AGPL-3.0-only`, the workspace repository, and exactly the
  reviewed dependencies for the new crate.

Local automated evidence:

```text
cargo fmt --all -- --check
  PASS
cargo test -p rho-extension-runtime --locked
  PASS; 26 passed, 0 failed
cargo +1.88.0-aarch64-apple-darwin test -p rho-extension-runtime --locked
  PASS; 26 passed, 0 failed
cargo clippy -p rho-extension-runtime --all-targets --locked -- -D warnings
  PASS
cargo check --workspace --all-targets --locked
  PASS on rustc 1.97.0
cargo test --workspace --locked --no-fail-fast
  PASS on rustc 1.97.0; 398 passed, 0 failed, 1 existing opt-in
  macOS Keychain test ignored
cargo +1.88.0-aarch64-apple-darwin check --workspace --all-targets --locked
  PASS on rustc 1.88.0
cargo +1.88.0-aarch64-apple-darwin test --workspace --locked --no-fail-fast
  PASS on rustc 1.88.0; 398 passed, 0 failed, 1 existing opt-in
  macOS Keychain test ignored
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
  PASS after the authorized synthetic-fixture correction
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
  PASS
git diff --check
  PASS
```

The local `stable-aarch64-apple-darwin` alias was stale at Rust 1.88. It was not
reported as current-stable evidence. The repository-pinned Rust 1.97 and exact
MSRV both passed locally; the workflow's fresh `stable` install remains the
authoritative current-stable evidence.

Review findings resolved:

- `PluginId` and sibling serde decoding originally would have bypassed
  constructor validation; custom deserialization now revalidates every ID;
- `ScopePolicy` and `ActivationPlan` originally derived deserialization, which
  could bypass host-rule construction or resolver output; both are now
  one-way-serializable only;
- the largest structured parent-error variant triggered clippy's
  `result_large_err`; its typed context is boxed without changing error truth;
- permutation coverage now exercises all six input orders for a three-plugin
  cycle and deterministic selection among multiple simultaneous errors; and
- capability descriptors contain no permission, broker, or operation grant.

Contract deviations: no product or authority deviation. The plan-output and
scope-policy deserialization surface was narrowed to preserve the already
accepted construction invariants. The pre-existing MSRV self-test fixture
repair was explicitly amended and cross-reviewed before its script changed.

Hosted implementation-head evidence: Rust Fast run `32109328681` passed commit
`68050678e47c65f93eac815313c897fd8169a86e` in 5m21s, while Rust Compatibility
run `32109328630` skipped without expanding six runners. The superseded
six-leg run `32107811887` was cancelled after the user explicitly deferred the
full matrix to P1-4; its partial results are not P1-0 acceptance. The
evidence-reconciliation head `f5b85519d63d6bd9e4778cff1659764ecdb7e692`
passed Rust Fast run `32109891797` in 1m58s with an exact 1128 MiB cache hit;
Rust Compatibility run `32109891648` skipped before matrix expansion. P1-0 is
at its accepted Draft stop gate.

Intentionally unrun: R package suites, frontend/browser/mock checks, manual UI,
installed-app, installer, signing, and release checks. P1-0 changes no R,
frontend, command, mock, schema, runtime, or distributable behavior.

Version/NEWS: no application or R package version change and no `NEWS.md`
entry. Release decision remains unchanged; this is not a candidate or release.

Residual risks: accumulated native Windows/Linux and exact MSRV compatibility
remain intentionally deferred until P1-4. Rust Fast proves one fresh Linux
stable host only. The Rust API remains internal experimental and is not a
public SDK.

P1-1 is separately authorized and governed only by
`active-2026-08-18-p1-1-extension-runtime-lifecycle-spec.md`.

### Required final reconciliation

At completion, update this active contract with:

- exact implementation commit and locked dependency versions;
- exact local commands, counts, and results;
- exact Rust Fast workflow result and the explicit P1-4 six-leg deferral;
- independent contract/security review findings and resolutions;
- actual deviations;
- version/NEWS decision;
- manual/installed checks not run;
- residual risks and worktree state; and
- the separately authorized next-package state.

This document remains `active-` after P1-0 because Phase 1 integration and
acceptance are incomplete. Passing P1-0 is not Phase 1 implementation or
release readiness.
