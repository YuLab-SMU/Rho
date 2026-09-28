# Agent package source

The public native transport, task state machine and Rig model engine are extracted
parts of the Agent plugin, including the component model-task state machine.
`api/` owns its Rust DTOs; `sdk/` contains generated TypeScript declarations and
JSON schemas. `backend/client/` owns deterministic Codex app-server, Kimi ACP and
DeepSeek ACP communication, bounded observations and owned-process recovery.
`backend/native/` owns native task scheduling, connection slots, original receipt
observation and cleanup. It uses the same injected task owner as handoff, plus
captured input and ephemeral endpoint ports; it does not open a core database.
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

`AgentTaskOwner::admit_native` atomically retains the containing backend's original
Operation, request, exact provider binding and scopes with the task receipt and
pre-command task/draft input. Later configuration or draft editing cannot change
that capture. Identical retries observe the original admission; changed input,
instance replacement and reusing an original native parent are refused. These
records are recovery observations, not reusable dispatch credentials. The backend
must still validate the current native caller and instance before admission.
Captures are bounded to 128 KiB each and 64 MiB per project/principal. Binary
attachment input is excluded; it requires a separate scoped ephemeral Control.
The ordinary backend now composes the same native owner, store and scheduler for
`agent.native.command`, task/receipt/event/history observations and ephemeral
`agent.native.assets.upload`. It captures a freshly observed caller before writes,
retains Send until its original native receipt and accepted scientific children
settle, and only observes repeated requests. Persisted controller labels use view/window or instance identity so
renderer reconnection does not change the original input digest; they are not
credentials. Cross-window stop/takeover observes the old controller through
`views.presence`; attached and closing views are refused. A detached/closed result
is followed by a fresh `views.caller` check, then the same generation and native
quiet checks. Unknown presence never authorizes takeover, and retries only observe
the original admitted command. Upload stores an asset without changing a draft or opening a native
Agent. A subsequent versioned draft write selects the asset. The current upload
accepts at most 524288 encoded bytes; larger assets still need controlled resource
transfer. Contributed context input is still refused before native submission.

Send can explicitly select up to 16 contributed Query/Operation tools by exact
provider binding. With the declared optional grants enabled, the backend reads
their immutable public manifests and revalidates the live caller before capturing
descriptions, schemas, scopes and targets with the original Send. The private MCP
endpoint exposes `rho_tools` and `rho_call`; callers must name that Send and a
canonical tool UUID. Identity reuse observes the original call; changed input or
an old Send on a later turn is refused. The current package declares R query/run
grants; selecting other capabilities requires their explicit package declarations.
Control and runtime capabilities cannot be selected as tools.

Tool admission shares Stop's owner gate and durably records a bounded semantic
request before queuing it under the original Send's Host parent. Dropping an HTTP
wait does not discard that child. Stop fences new calls while accepted scientific
work and its independent result remain retained. Each Send accepts at most 64
calls, with 64 KiB inputs and 96 KiB observations. Invalid, oversized or missing
replies preserve uncertainty; partial/cached queries retain their labels.
`agent.native.tool` reads the scoped receipt; `agent.native.tool.operation` follows
the original delegated request into the scientific journal and verifies its exact
parent, provider, arguments and preconditions. Neither read replays work or rewrites
an uncertain receipt. Only core Operation commits scientific results.

`backend/native::mcp` supplies the private transport for an explicitly opened
connection: its own loopback listener, bearer and session manager. It never
receives a general Host credential. `NativeMcpPort::begin` synchronously admits
and retains work; the returned receiver observes it. The containing owner must
check the original active task, scope, tool budget and durable request identity,
and await accepted children before settling their parent. A descriptor or an
MCP session/request ID alone cannot authorize or deduplicate a scientific write.
Endpoint revocation fences new calls without cancelling accepted work. Explicit
`close` confirms HTTP/session cleanup only, never native process quiet or
scientific cancellation. Invalid initialization sessions are reclaimed; requests,
sessions, tool waits, catalogs and results are bounded. HTTP capacity remains
leased until a streaming response closes. Foreign session deletion is refused
before reaching the SDK's idempotent deletion handler. No endpoint is created by
an observation query.

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
instances use their supplied managed plugin storage location.
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

`cargo test -p rho-agent-native --lib --locked` checks native scheduling, receipt
recovery and private MCP HTTP isolation. Use the `mcp` filter for transport changes.
The `native_tasks` filter on `cargo test -p rho-agent-backend --test metadata
--locked` exercises ordinary framed task composition with an injected native
factory: retained Send/Stop outcomes, uploaded input, next-draft preservation,
reopen idempotency and unconfirmed process cleanup. It reads no user configuration
and starts no installed model. `node scripts/test-agent-plugin.mjs` checks the
independent package through a previously compiled generic Host, including native
task metadata, instance separation and attachment journal exclusion.
`node scripts/test-agent-plugin-native.mjs` repeats the runtime cases in
an independent source assembly with the public owner/store/client dependencies.
The temporary Host adapter delegates to this runtime while continuing to supply
caller validation, scientific context capture and the scoped MCP lease. This
temporary adapter remains until the remaining context, tool grants, attachment
transfer and ordinary Agent views replace the fixed composition. Release checks persisted native process
quiet as well as live handles, including after a failed explicit disconnect.

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

The `backend/` process composes the same owner and store for task metadata.
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

The explicit `agent.model.test` Operation runs the existing Rig engine's bounded
synthetic connection or image diagnostic. It receives no scientific context or
Host tools. This explicit action reads the captured model's scoped key and
contacts the selected endpoint. The original Operation stays active until the
test ends; `agent.model.diagnostic` only reads its retained state. An explicit
`agent.model.test.stop` checks the native controller and expected version, and
disabling model settings also stops live diagnostics. A stop request does not
claim the original Operation already finished. Repeated requests and process
reopen observe the original diagnostic and never restart it.

`agent.model.run` also composes the real model-task owner and Rig loop for explicit
submitted text. It captures the original native Operation, request and provider
binding atomically with admission. Text, usage and terminal state use the existing
task event log. `agent.model.run.request`, `.get` and `.events` only observe that
original record; `.stop`, disabling settings and explicit controller takeover fence
the original loop. A duplicate semantic request returns the original run without
reading a key or restarting, even if its new transport admission differs. It cannot
replace the stored parent or change the provider binding. Tool intent receipts
already have durable unique request IDs; native delegation will reuse these.
An optional exact R provider/session and Explain/Run mode now select native
observation or execution through public Host calls. The owner captures original
grants, and native replies must match the original binding, project and parent.
Stop retains already dispatched R work until its actual reply; original-result
queries never replay it. The build instructions distinguish framed fixtures from
the separate independent-package real-R acceptance.

Native Agent connections and explicitly selected scientific tools are composed as
described above. General context providers, full-size attachment transfer,
component-model continuation and Agent views still require integration. Synthetic diagnostics and
submitted-text runs alone do not establish scientific execution or real-provider quality. Default
delivery remains unfinished.
The backend transport and independent Host verification commands are described
in the build instructions.
