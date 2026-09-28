# Agent package source

The public native transport, task state machine and Rig model engine are extracted
parts of the Agent plugin, including the component model-task state machine.
`api/` owns its Rust DTOs; `sdk/` contains generated TypeScript declarations and
JSON schemas. `backend/client/` owns deterministic Codex app-server, Kimi ACP and
DeepSeek ACP communication, bounded observations and owned-process recovery.
`backend/owner/` owns task admission, captured drafts, original receipts, control
generation, observation-only restart handling, model-setting/credential validation,
manual draft handoff and the repository ports. `backend/store/` owns the sole SQLite
implementation for native/component tasks, assets, task-list projections and atomic
handoff receipts. `backend/engine/` owns the sole Rig driver, provider
protocols, synthetic diagnostics and deterministic permission rules. These
libraries do not depend on private Rho core crates. The transport and task owner
have no model-engine dependency.

`AgentControllerRef` is owner-supplied correlation data, not a credential. Admission,
project scope, native MCP credentials and authorized scientific execution remain
the responsibility of the containing owner. The native and component task state machines each use their one injected
repository. The transitional Application adapter revalidates its original live
controller and converts captured component records into the Agent-owned atomic store
transaction, sharing the same writer gate with manual handoff. Component public
captures include complete native document receipts; fixed-view controls cannot be
admitted. The public API depends only on the plugin protocol and R media API,
which are included in the independent source assemblies. The current Host converts its admitted scope/window identity at the boundary.
Moving DTO ownership does not change wire field names, replay input, authorize tools or transfer scientific
truth to the transport.

`api::handoff` and `owner::handoff` own the handoff contract and policy. The
containing owner supplies readable scientific references and the original live
controller. The target writer gate and injected repository retain one atomic
source/target precondition check, draft append and receipt. Handoff does not send
a turn or transfer assets, grants or model credentials. Original request recovery
returns its receipt even after the source changes; changed reuse is refused.

The store accepts an explicit new Agent storage path and checks its format before
initializing tables. It does not connect to a scientific journal or read the old
Application task tables. The temporary core composition uses a separate
`agent-v1.sqlite` suffix, keeps one store for both task owners and only forwards
repository calls. Existing files are not imported or deleted. Ordinary backend
instances must eventually supply their own managed plugin storage location.

Generate declarations with `node plugins/agent/generate-sdk.mjs`; add `--check` to
verify freshness. `node scripts/test-agent-plugin-types.mjs` checks an independent
TypeScript consumer. Run `node scripts/test-agent-plugin-client.mjs` from the checkout
to assemble these sources outside it, check dependency containment and run all
native protocol/recovery fixtures. Those fixtures use local fake processes, never
real providers, model requests or user sessions. The native transport's explicit
DeepSeek setup entry point is retained but is not invoked by these checks.

`node scripts/test-agent-plugin-owner.mjs` builds the task owner and public API
outside the checkout. Its focused fixtures cover original-request deduplication,
scope and draft fences, atomic write failure, captured input retention, uncertain
restart observations, stop/takeover fencing, all handoff source/target pairs,
controller loss, stale material and atomic handoff failures. Shared SQLite, component handoff
and Host integration retain their own cross-boundary tests.

`node scripts/test-agent-plugin-store.mjs` assembles the store, owner and public API
outside the checkout. It runs storage and owner tests, checks source/dependency
containment and verifies public schemas. The store has no private core dependency.

`node scripts/test-agent-plugin-engine.mjs` builds the API, owner and model engine
outside the checkout and runs protocol, production-driver and task-owner tests.
The production driver accepts captured public model input and an owner callback
port. Tool tickets are opaque, transient handles returned to the same port;
interrupted waits retain the original owner receipt. Model output cannot replace
an owner-admitted request or receipt, or commit an operation. Image labels and
verified bytes are supplied by the containing owner. The transitional core adapter
preserves admitted actions and records owner diagnostics before returning errors.

This source is not yet a loadable Agent plugin: ordinary backend process composition,
context providers and Agent views still require migration. No backend manifest,
default activation or delivery claim is made until those owners use public ports.
