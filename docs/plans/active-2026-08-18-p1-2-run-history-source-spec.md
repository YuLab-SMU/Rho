# P1-2 Project Run History Source Specification

Status: active; P1-2 authorized by the continuing whole-P1 objective;
implementation pending

Date: 2026-08-18
Owning architecture:
[`accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md`](../design/accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md)
Predecessor:
[`active-2026-08-18-p1-1-extension-runtime-lifecycle-spec.md`](active-2026-08-18-p1-1-extension-runtime-lifecycle-spec.md)
PR: [#75](https://github.com/YuLab-SMU/Rho/pull/75)
Upstream baseline: `95d7d2c7774519ef956637aeff678ed4f2752ab5`
P1-2 branch baseline: `89ca6c5957b5520d3cdf506c587885fa3a1e8979`

Change class: D3 project-scoped source migration
Risk: R3 project isolation, bounded serialization, fallback, restart, and
command compatibility
Authorized work package: `P1-2`
Mandatory stop: exact Run History parity and exact-head Rust Fast, then continue
to a separately active P1-3 contract under the persistent whole-P1 objective

## Fixed Migration Object

```text
Plugin ID:  org.yulab.rho.run-history
Provides:   source.project.run-history@1
Requires:   service.broker.runs@1
Scope:      project
Activation: eager
```

The provider is compiled-in first-party code from one explicit static
`Vec<Arc<dyn InternalPlugin>>`. It is not discovered from disk or configuration.

## Authority

`rho_store::Store::list_runs(project_root, limit)` remains the sole Run History
data and ordering authority. The plugin does not query SQLite, cache results,
own project identity, infer current project, or rewrite `RunSummary`.

The host supplies `service.broker.runs@1` through a project-bound
`BrokerFacade` that owns:

- exact normalized project root;
- exact configured store path;
- operation allowlisting;
- request decoding;
- Store opening/error projection;
- `Store::list_runs()` dispatch; and
- response serialization/byte enforcement.

The project root may exist only in the project-scoped facade/snapshot. It never
enters application scope or plugin descriptor state.

## Host Capability Binding

P1-2 adds a reserved host provider identity for graph resolution:

```text
org.yulab.rho.host
  provides service.broker.runs@1 in application scope
```

This identity represents an already-authoritative host service, not a plugin
permission. It has no activation callback, configurable instance, persistence,
or external loading. The application plan records it so the project plugin
requirement is explicit and deterministic.

The host capability never grants arbitrary Store access. The concrete facade
allowlists only the Run History operation in this package.

## Registry Source Contract

Extend `RegistryHub` with one generic bounded source contribution lane:

- contribution key is `CapabilityId`;
- owner is the exact `PluginInstanceIdentity`;
- handler is `Send + Sync` and object-safe;
- registration occurs only through the current host-created `EffectSink`;
- duplicate contribution in one scope fails activation;
- disposal removes only the exact owner/handler registration;
- candidate registrations remain unroutable until publication;
- every call acquires a scope routing lease; and
- handler result includes the scope identity used for late-generation
  validation by the host.

The handler receives a constructor-bounded `BoundedJson` request and returns a
constructor-bounded `BoundedJson` response. It cannot select a larger response
class or access a raw broker/store object.

## Request And Response

Candidate source request:

```json
{"limit": 50}
```

`limit` remains optional at the Tauri boundary. `null` reaches
`Store::list_runs()` as `None`, preserving its existing default. A supplied
integer reaches it unchanged. Unknown fields, negative/non-integer values, and
malformed shapes fail before Store dispatch.

Response is exactly the serde projection of current `Vec<RunSummary>` and must
deserialize back to that exact type before the Tauri command returns it.

Generic request and response limits remain 1 MiB. Boundary and just-over-limit
tests use representative long strings rather than pathological row counts.

## Tauri Command Compatibility

The `list_runs` command keeps:

- command name;
- `limit: Option<usize>` argument;
- `Result<Vec<RunSummary>, String>` response;
- default limit behavior;
- descending `started_at` ordering;
- complete `RunSummary` JSON shape;
- current project filtering; and
- current display-error projection.

Legacy mode calls the existing helper directly.

Candidate mode:

1. reads the current project snapshot;
2. verifies the snapshot scope ID matches the current normalized project root;
3. invokes `source.project.run-history` with bounded `{limit}`;
4. validates the returned scope generation is still current;
5. decodes exact `Vec<RunSummary>`; and
6. returns it without post-sorting/filtering.

The command must not hold the project transition gate or project-root lock
across Store I/O. Project/generation validation before return rejects a late
old-project result.

## Temporary P1-2 Fallback

Only these candidate availability failures fall back to the unchanged legacy
helper:

- no active project extension scope;
- active project scope does not match the current normalized root;
- Run History contribution is absent; or
- target candidate activation failed during project switching.

Fallback emits one stable bounded diagnostic and leaves no duplicate
registration, subscription, or active old-project route.

These failures do not fall back:

- malformed/oversize request;
- Store open/query failure;
- malformed/oversize response;
- handler failure after dispatch; or
- stale generation after a completed handler call.

Those return truthful command errors. Silent retry could duplicate future
side effects and hide a broken candidate path, so it is forbidden.

If project candidate activation fails before BH2 side effects, the switch may
continue in P1-2 legacy fallback mode. After BH2 commits, the host clears and
disposes the old project extension slot so an old-project contribution cannot
remain routable.

## Browser Mock

`desktop/dist/app.js` keeps its existing `list_runs` handler and response shape.
No runtime-mode UI is added. The browser mock represents externally observable
command parity, not internal routing.

Deterministic frontend contracts must prove that the mock command name,
argument, default, array response, and current rendering consumer remain
unchanged.

## Tests

Runtime registry tests:

- source registration, duplicate rejection, exact-owner disposal;
- candidate invisibility and active routing;
- request/response byte boundary and over-limit rejection;
- handler error without fallback;
- old routing closed after replacement;
- stale generation rejected after A/B/A; and
- identical contribution ID isolated between two project snapshots.

Plugin/Broker tests:

- fixed descriptor identity/provides/requires/scope;
- activation registers exactly one source effect;
- normal, empty, `None`, zero, one, and explicit limit;
- invalid/unknown request fields;
- Store open/query failure;
- response equality with direct `Store::list_runs()`;
- foreign-project rows excluded;
- restart/reopen parity; and
- 1 MiB response boundary/over-limit truth.

Desktop command tests:

- legacy/candidate deep equality;
- default and explicit limit parity;
- empty and normal project;
- candidate contribution missing fallback;
- candidate activation failure fallback with old scope cleared;
- handler error does not fallback;
- rapid A/B/A late result rejection;
- two projects with identical-shaped runs remain isolated; and
- existing BH2 failure/recovery tests remain green.

Frontend/mock checks:

- `node --check desktop/dist/app.js`;
- existing list-runs mock contract; and
- no duplicate command/tool/viewer/event contribution.

## Verification

```text
cargo fmt --all -- --check
cargo test -p rho-extension-runtime --locked
cargo +1.88.0-aarch64-apple-darwin test -p rho-extension-runtime --locked
cargo test -p rho-desktop --bin rho-desktop --locked
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
node --check desktop/dist/app.js
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
git diff --check
```

Exact-head Rust Fast is required. The six-leg matrix remains deferred to
P1-4/Ready.

## Version, NEWS, And Release Impact

Legacy remains default and candidate output must be identical. No application
or R package version bump and no `NEWS.md` entry are required for P1-2.

No schema, candidate, installer, installed-app, signing, publication, or release
decision is authorized.

## Definition Of Done

- fixed descriptor and host service requirement are present;
- Store remains sole data authority;
- command/mock schema and behavior are parity-proved;
- project/generation isolation and truthful failure/fallback rules pass;
- no duplicate registration or stale route remains;
- local affected validation and exact-head Rust Fast pass;
- implementation review has no blocking data ownership, bounds, fallback,
  project isolation, or authority finding;
- evidence, dependencies, deviations, version/NEWS, unrun checks, commit, and
  worktree state are recorded; and
- work proceeds only through a separately active P1-3 contract.
