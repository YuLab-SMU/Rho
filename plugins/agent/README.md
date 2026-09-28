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
handoff receipts, plus scoped local credential-file persistence. `backend/engine/` owns the sole Rig driver, provider
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
`CredentialFile::at` likewise takes an explicit absolute path, never searches for
keys and performs no I/O at construction. Its locking, atomic writes and immutable
references preserve accepted requests across replacement; reads/removals validate
both project and principal. Missing-file observations do not create a directory.
The temporary Host adapter supplies the existing user configuration location. Raw
keys are never included in task metadata, source revisions, diagnostics or archives.

`CredentialFile::put_for_request` atomically stores the secret and its scoped
original request reference in that same credential file. Repeating identical
input returns the original reference; changed reuse is refused. Read-only
`reference_for_request` resolves a lost acknowledgement after reopen without
returning secret bytes. Explicit removal retains the non-secret receipt and
prevents replay from recreating that key. The ordinary backend exposes them as `agent.model.key.store` (ephemeral
Control) and `agent.model.key.receipt` (read-only Query). A native caller observation
precedes each key write. Raw key input never enters an Operation or Agent task
record; settings retain references only. An absent receipt is partial evidence,
not proof that an outstanding write cannot finish. Each instance uses its own
native data directory; it does not import existing user keys.

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

The new `backend/` process composes the same owner and store for task metadata.
Its public manifest contributes task-list/conversation/settings queries plus
model-task creation, draft saving, title/archive updates, explicit control
transfer and versioned model configuration. Configuration accepts credential
references only; it does not read a key, test an endpoint or start a model.
It accepts only native initialization paths. Each mutation uses the
original `views.caller` observation and a synchronous, one-use owner admission;
neither arguments nor stored observations can grant a later action. Task results
are submitted to the original Host Operation and retained until terminal settlement.
This process uses the public SDK's bounded Host-call client and imports no private
core crate. [Build instructions](BUILD.md) describe the independent source package.

The process currently provides metadata only. Model execution, native Agent
connections, context providers and Agent views still require integration. The
registered metadata capabilities do not claim those features; default delivery
remains unfinished. The backend transport and independent Host verification
commands are described in the build instructions.
