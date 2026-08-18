# P1-3 Workspace Snapshot Tool And Project File Viewer Specification

Status: active predecessor; runtime `d67c294`, product migration `f16283c`, CI
portability repairs `efefa76`/`4c89c71`, local affected verification,
exact-head Rust Fast, and Draft matrix skip passed

Date: 2026-08-18
Owning architecture:
[`accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md`](../design/accepted-2026-08-14-plugin-runtime-phase-1-internal-plugins-design.md)
Predecessor:
[`active-2026-08-18-p1-2-run-history-source-spec.md`](active-2026-08-18-p1-2-run-history-source-spec.md)
PR: [#75](https://github.com/YuLab-SMU/Rho/pull/75)
Upstream baseline: `95d7d2c7774519ef956637aeff678ed4f2752ab5`
P1-3 branch baseline: `b984230b3819b61508998b71b8ad09b9c787cad8`

Change class: D3 Workspace-scoped tool and controlled UI contribution
migration
Risk: R3 Workspace/kernel lineage, Agent admission, cancellation, bounded
scientific payload, project filesystem containment, and trusted rendering
Risk owner: existing Workspace broker and project-file viewer contracts
Authorized work package: `P1-3`
Mandatory stop: exact legacy/candidate parity, local affected validation,
exact-head Rust Fast, and implementation review; the complete six-leg matrix
remains the P1-4/Ready gate

## Fixed Migration Objects

```text
Plugin:     org.yulab.rho.workspace-snapshot-tool
Provides:   tool.workspace.snapshot@1
Requires:   service.broker.workspace-probe@1
Scope:      workspace
Activation: eager

Plugin:     org.yulab.rho.project-file-viewer
Provides:   ui.viewer.project-file@1
Requires:   none
Scope:      application
Activation: eager
```

Both are compiled-in first-party entries in the same explicit static
`Vec<Arc<dyn InternalPlugin>>` inventory used by Phase 1. The host selects
entries by their single allowed scope. P1-3 adds no discovery, configuration,
schema, public SDK, permission manifest, DOM bridge, Tauri plugin, process,
network, or credential authority.

## Workspace Scope Completion

P1-3 completes the P1-1 host-owned scope tree needed by the first Workspace
plugin:

```text
application
  └── project
        └── workspace
```

`ScopeManager` adds one active Workspace slot and validates it against the
exact current project snapshot. A Workspace scope identity is derived from:

- the exact parent project scope ID;
- `WorkspaceIdentity.workspace_id`;
- `WorkspaceIdentity.kernel_instance_id`; and
- a fresh host-issued activation generation.

State and project revisions remain broker request preconditions; they are not
scope IDs and do not rebuild a scope after every operation. A Workspace R
restart always creates a new workspace scope. A project switch reparents the
same live kernel lineage under the target project through a fresh scope and
generation. Old Workspace routing never silently rebinds to either case.

Project-tree publication is serialized inside `ScopeManager`. When a project
switch has a live Workspace, the host publishes the ready project and ready
Workspace candidates as one guarded tree transition:

1. validate both expected old pointers and both ready candidates;
2. CAS the project and Workspace slots while old routing remains intact;
3. if either CAS loses, restore any changed slot before opening/closing routing,
   rollback both candidates, and leave the actual winner untouched;
4. attach the Workspace candidate only to its validated project candidate;
5. open new project routing, then new Workspace routing;
6. synchronously close old project routing, which closes its Workspace child;
7. dispose the old project tree child-first; and
8. return both publication/disposal reports without reviving failed routing.

No plugin may create, reparent, or publish a Workspace scope.

## Workspace Start, Switch, Restart, And Shutdown

Candidate mode integrates with existing ownership in these exact places:

- initial `workspace_start`: after Ark, Store, broker identity, and bridge
  bootstrap succeed, build and publish a Workspace candidate under the current
  project scope before reporting ready;
- project switch: build the project candidate before BH2 side effects as
  today; after existing Workspace project-root synchronization, capture the
  target broker identity and build its Workspace child before watcher/store/
  last-opened/UI commit; any later BH2 failure rolls back both candidates and
  uses existing BH2 recovery;
- Workspace restart: close/dispose the old Workspace scope before discarding
  its session/context; after the new Ark/broker/bridge and project-root sync
  succeed, publish a fresh candidate under the still-current project; and
- application/project shutdown: existing child-first disposal closes the
  Workspace tool before its project and application parents.

Candidate construction failure no longer uses P1-2's temporary per-command
Run History fallback. In candidate mode a missing/failed project or Workspace
candidate fails before the relevant authoritative commit, with old truth
preserved where it is still valid. `legacy` mode remains the complete unchanged
escape path through P1-4.

## Workspace Tool Registry

P1-3 adds an effect-bound Workspace tool contribution lane to `RegistryHub`:

- key: `CapabilityId`;
- owner: exact `PluginInstanceIdentity`;
- handler: object-safe, `Send + Sync`;
- registration: only through the activating plugin's `EffectSink`;
- duplicate contribution: activation failure and complete rollback;
- call: routing lease plus returned `ScopeIdentity` for late-generation
  validation;
- request: re-bound to the generic 1 MiB limit before handler dispatch;
- response: re-bound to the fixed Workspace Snapshot 2 MiB limit after handler
  completion; and
- disposal: remove only the exact owning registration.

The handler cannot select the response class, retain a raw Workspace handle,
or route after its scope closes.

## Typed Workspace Operation And Broker Authority

The candidate path uses a closed internal operation enum whose only P1-3
variant is equivalent to:

```rust
enum WorkspaceOperation {
    Snapshot {
        expected_workspace: ExpectedWorkspace,
        origin: ExecutionOrigin,
        execution_id: Option<String>,
    },
}
```

The host, not the plugin, supplies origin and any Agent execution ID. The
plugin translates the tool invocation into this typed request to the
allowlisted `service.broker.workspace-probe@1` façade. It cannot provide an R
expression, operation class, project root, Store record, provenance result, or
raw Ark command.

The Workspace broker façade owns the exact `ArkSession` and
`CoordinatorRuntime` references for that Workspace generation. It accepts only
`WorkspaceOperation::Snapshot`, then calls the existing
`dispatch_workspace_request[_with_execution_id]()` path with the unchanged
request type `workspace.snapshot` and empty arguments. The existing
`bridge_expression()` remains the sole generator of
`rho_workspace_snapshot(envir = .GlobalEnv)`.

Therefore the existing broker continues to own:

- stale kernel/state/project revision admission;
- the probe operation class;
- Workspace execution serialization;
- Ark execution and cancellation behavior;
- run creation, completion, recovery, and project ownership;
- response/event/provenance projection; and
- existing payload/frame checks in addition to the new 2 MiB tool boundary.

After the handler returns, the host validates both extension Workspace
generation and current broker kernel/workspace identity before returning the
payload. A late old result is an error, never a fallback or rebind.

## Tauri And Agent Compatibility

The Tauri command remains:

```text
snapshot_workspace() -> Result<Value, String>
```

Legacy mode calls the current helper. Candidate mode invokes
`tool.workspace.snapshot@1`; command name, arguments, response JSON, run type,
origin, revisions, errors, and frontend refresh behavior remain unchanged.

The Agent tool remains `get_workspace_snapshot`, and Agent R continues sending
the existing `workspace.snapshot` request. Authorization and the existing
`AgentWorkspaceLane` execute before the extension adapter. The adapter
preserves the caller-provided expected Workspace and generated Agent execution
ID, then invokes the same candidate tool. All other Agent tools remain on their
existing path. No duplicate Agent tool, approval rule, event, or run is added.

Cancellation drops the extension call lease/future and follows the existing
Ark/Agent cancellation and run-recovery truth. It does not report a successful
snapshot or leave a routable old generation.

## Project File Viewer Contribution

The application-scoped plugin registers one immutable viewer descriptor through
its `EffectSink`. It contains only:

- `ui.viewer.project-file@1` identity;
- the existing supported media/encoding declarations; and
- the existing 4 MiB general and 32 MiB HTML maximum classes.

It contains no project root, path, file handle, content, DOM object, Tauri
handle, renderer, shell command, callback with filesystem authority, or mutable
project state.

The `viewer_read_file(path)` Tauri command keeps its name, argument, return
type, and `rho.viewer_file.v1` response. In candidate mode the host first
resolves the application contribution, then reads the current project root for
that invocation and calls the unchanged `project::read_viewer_file(root,
path)`. That existing helper remains the sole containment, canonicalization,
symlink, file-kind, extension/media, UTF-8/base64, and size authority.

The trusted Tauri shell continues actual Markdown/text/image/sandboxed-HTML
rendering. The plugin receives no DOM or Tauri capability. A contribution
absence or descriptor mismatch in candidate mode is a truthful command error;
it does not bypass `read_viewer_file()` or silently retry legacy wiring.

## Browser And Mock Parity

`desktop/dist/app.js` keeps exactly one `snapshot_workspace` handler, one
`viewer_read_file` handler, the current caller names, and the current
`rho.viewer_file.v1` shape. Internal runtime mode and contribution state remain
absent from browser state.

A deterministic repository contract checks command/tool names, fixed plugin
and capability IDs, typed-operation use, broker expression ownership, viewer
host injection, one mock handler each, and unchanged consumer calls. P1-3 also
runs the relevant browser/mock contract and full `rho.agent`/`rho.bridge` tests.

## Failure And Recovery Rules

| Failure | Required result |
| --- | --- |
| malformed/duplicate descriptor or contribution | candidate activation fails; recorded effects roll back |
| application viewer activation fails | candidate runtime startup fails closed with bounded diagnostic; explicit legacy mode remains available |
| project/Workspace candidate fails before BH2 commit | rollback candidate tree; existing BH2 restore preserves old project/Workspace truth |
| Ark/bootstrap/start failure | no Workspace scope is published |
| Workspace restart after old scope closes then fails | old scope remains non-routable; restart reports failure |
| malformed/oversize tool request | reject before broker dispatch |
| broker stale/unavailable/Ark failure | return existing truthful error; no legacy retry |
| tool response over 2 MiB or malformed | reject; do not publish partial result |
| cancellation | no success projection; existing run/cancellation recovery remains authoritative |
| late Workspace generation | reject even if scope ID/kernel text resembles a later generation |
| viewer path escape/symlink/missing/directory/unsupported/invalid UTF-8/oversize | unchanged `read_viewer_file()` rejection |
| project switches during viewer call | exact current root is injected per invocation; two-project containment tests prevent cross-project reads |

## Tests

Runtime/synthetic:

- Workspace tool candidate invisibility, activation, call lease, exact-owner
  disposal, duplicate rollback, generic request and 2 MiB response boundary;
- project+Workspace tree CAS success and second-CAS rollback without opening
  candidate routing or closing old routing;
- parent mismatch, stale expected pointer, late generation, restart generation,
  child-first teardown, and identical tool IDs isolated between projects; and
- application viewer descriptor registration, duplicate rejection, disposal,
  and proof that descriptor data cannot hold a project path or handler.

Desktop/broker:

- fixed descriptors and capability-major bindings;
- direct legacy/candidate snapshot deep equality for normal/empty results;
- unchanged request type, origin, run, revision, execution ID, and provenance;
- malformed, stale, unavailable, Ark failure, cancellation, 2 MiB boundary,
  over-limit, restart, project A/B/A, and late old-workspace completion;
- Agent `get_workspace_snapshot` legacy/candidate parity through the same
  admission lane, with no duplicate tool/event/run;
- application viewer descriptor has no project state;
- legacy/candidate `viewer_read_file` deep equality for all supported media;
- path escape, symlink escape, missing, directory, unsupported media, invalid
  UTF-8, 4 MiB boundary/over-limit, 32 MiB HTML boundary/over-limit; and
- identical relative paths in two projects return only the current project's
  content.

## Verification

```text
cargo fmt --all -- --check
cargo test -p rho-extension-runtime --locked
cargo +1.88.0-aarch64-apple-darwin test -p rho-extension-runtime --locked
cargo test -p rho-server --locked
cargo test -p rho-desktop --bin rho-desktop --locked
cargo check --workspace --all-targets --locked
cargo test --workspace --locked --no-fail-fast
node --check desktop/dist/app.js
node scripts/test-extension-p1-3-contract.mjs --test
node scripts/test-extension-p1-3-contract.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
Rscript -e 'testthat::test_local("R/rho.bridge")'
Rscript -e 'testthat::test_local("R/rho.agent")'
git diff --check
```

Relevant browser/mock contracts are required if their local dependencies are
available. Exact commands and any unavailable local R/browser prerequisite are
recorded truthfully. Exact-head Rust Fast is required. The macOS/Windows/Linux
stable/Rust 1.88 six-leg matrix remains deferred to P1-4/Ready by explicit user
authorization.

## Version, NEWS, And Release Impact

P1-3 keeps `legacy` as default and candidate output must be equivalent. No
application or R package version bump and no `NEWS.md` entry are required
unless implementation review finds actual user-visible behavior.

No schema, installer, installed-app acceptance, signing, publication, public
SDK, external plugin, execution target, compute job, environment manager, SSH,
Slurm, or release decision is authorized.

## Definition Of Done

- both fixed plugins activate only in their authorized scopes;
- Workspace scope start/switch/restart/disposal and generation rules pass;
- broker remains sole R-expression, revision, Ark, run, and provenance
  authority;
- Agent admission/tool naming and Tauri/browser protocols remain unchanged;
- viewer contribution cannot retain project state or bypass host containment;
- all bounded, stale, cancellation, failure, restart, and two-project tests
  pass;
- implementation review has no blocking Trusted Kernel, filesystem, project
  isolation, cleanup, generation, duplicate registration, or credential
  finding;
- local affected validation and exact-head Rust Fast pass;
- dependencies, deviations, version/NEWS, unrun checks, commit, and worktree
  state are recorded; and
- P1-4 begins only through its own active acceptance contract.

## Local Implementation Evidence

Verified on 2026-08-18 against P1-3 branch baseline
`b984230b3819b61508998b71b8ad09b9c787cad8`. Runtime infrastructure is commit
`d67c294`; product migration, tests, mock, and CI enforcement are commit
`f16283c`:

- `RegistryHub` now has effect-owned Workspace tool and project-file viewer
  lanes. Workspace requests are re-bound to 1 MiB and responses to the fixed
  2 MiB Snapshot limit. Viewer resolution holds a routing lease and exposes
  only sorted media declarations plus the existing 4 MiB/32 MiB limits.
- `ScopeManager` now owns the Workspace slot and a serialized project-tree
  publication gate. Project and Workspace expected-old CAS both complete before
  routing opens; a failed second CAS restores the project pointer while old
  routing remains active. Every early rejection releases both candidates.
- Single-slot publication was tightened so candidate routing opens only after a
  successful CAS. Shutdown, Workspace restart, Workspace start, and project
  switching serialize their scope transitions; child-first disposal remains
  authoritative.
- Candidate mode activates the application Viewer plugin; legacy mode activates
  no product plugin and remains unchanged. The static inventory contains exactly
  the Viewer, Run History, and Workspace Snapshot first-party plugins filtered
  by their one allowed scope.
- Direct Tauri and Agent Snapshot paths now converge on
  `WorkspaceOperation::Snapshot`. Agent admission/lane and execution ID remain
  ahead of the adapter. The plugin supplies no R expression; the existing
  `rho-server` `bridge_expression()` and
  `dispatch_workspace_request_with_execution_id()` remain the only Ark/run/
  provenance path.
- Completion validates extension generation, project parent, kernel lineage,
  and returned Workspace state/project revisions. Handler/Ark, malformed,
  oversize, missing contribution, closed routing, and stale completion errors
  do not retry legacy wiring. Cancelling a pending tool future releases its
  routing lease before scope disposal.
- `viewer_read_file` resolves the application descriptor, injects the current
  project root per call, then delegates containment/media/encoding/size truth to
  unchanged `project::read_viewer_file()`. Candidate tests cover A/B isolation,
  escape/missing contribution, and an explicit symlink-escape regression.
- Browser mock parity was extended to the existing text/log and image media
  types while retaining the single `snapshot_workspace`, single
  `viewer_read_file`, and `rho.viewer_file.v1` contracts.

Commands and results:

```text
cargo fmt --all -- --check
  passed
cargo test -p rho-extension-runtime --locked
  passed: 26 graph-contract + 34 lifecycle tests
cargo +1.88.0 test -p rho-extension-runtime --locked
  passed on aarch64-apple-darwin: the same 60 tests
cargo clippy -p rho-extension-runtime --all-targets --locked -- -D warnings
  passed
cargo test -p rho-server --locked
  passed: 61 library + 1 binary test
cargo test -p rho-desktop --bin rho-desktop --locked
  passed: 199; ignored: 1 existing opt-in macOS Keychain smoke
cargo check --workspace --all-targets --locked
  passed
cargo test --workspace --locked --no-fail-fast
  passed: 453; ignored: the same 1 existing opt-in smoke
Rscript -e 'testthat::test_local("R/rho.bridge")'
  passed: 575
Rscript -e 'testthat::test_local("R/rho.agent")'
  passed: 120
node --check desktop/dist/app.js
node scripts/test-extension-run-history-contract.mjs --test
node scripts/test-extension-run-history-contract.mjs
node scripts/test-extension-p1-3-contract.mjs --test
node scripts/test-extension-p1-3-contract.mjs
node scripts/test-outputs-viewer-ui.mjs
node scripts/test-rust-msrv-contract.mjs --test
node scripts/test-rust-msrv-contract.mjs
node scripts/test-license-contract.mjs --test
node scripts/test-license-contract.mjs
  all passed
git diff --check
  passed
```

No dependency or lockfile change was required. The Tauri 2 application-scope
activation bridge uses documented `tauri::async_runtime::block_on()` from the
synchronous setup hook; Context7 was consulted before choosing that supported
API.

No schema, public command/Agent/viewer protocol, runtime-mode default,
application/R package version, or `NEWS.md` change was made. The P1-2 temporary
per-command Run History fallback was intentionally removed now that its parity
gate passed; explicit `RHO_INTERNAL_EXTENSION_RUNTIME=legacy` remains the whole
legacy escape path.

Interactive browser review, a real candidate-mode Ark installed-app run, and
the macOS/Windows/Linux stable/Rust 1.88 matrix were not run in P1-3. The
automated real broker/R-expression tests and R package suites passed; installed
app and full six-leg evidence remain the explicitly deferred P1-4/Ready gate.
The first hosted run `32123954790` failed before Rust compilation because the
contract used uppercase `R/rho.agent/...`; macOS's case-insensitive filesystem
masked that the tracked repository path is lowercase `r/rho.agent/...`.
Commit `efefa76` first isolated the checkout portability issue, and commit
`4c89c71` restored mandatory Agent-source validation against the exact tracked
lowercase path. These were CI enforcement repairs, not product behavior
changes.

Exact-head Rust Fast run `32124848409` passed on
`4c89c71efd3f3547cf29d7d3ec9b5327fcf55e83` in 2 minutes 55 seconds. It
restored the exact 1305 MiB cache key
`rho-rust-v1-Linux-stable-x86_64-unknown-linux-gnu-bc9fb070b16d52abd62c229a905e272f25158b85490bb3951775c4d64c2af6f1`.
Rust Compatibility run `32124848538` skipped as required for Draft PR #75.

Implementation review found no blocking Trusted Kernel, raw-expression,
Agent-admission, filesystem containment, project isolation, generation,
cleanup, duplicate-registration, credential, or public-protocol deviation.

P1-3 therefore passed its Draft stop gate. The continuing whole-P1 objective
authorizes preparing a separate P1-4 acceptance/default-switch contract; this
P1-3 contract does not itself authorize version allocation, NEWS, Ready state,
installed-app acceptance, or legacy deletion.
