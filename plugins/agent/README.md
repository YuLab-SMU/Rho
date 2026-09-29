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
Agent. A subsequent versioned draft write selects the asset. Inline upload accepts
at most 524288 encoded bytes. `agent.native.assets.import` accepts a controlled
`ResourceReference` up to 8 MiB under an explicit optional `resources.read@1` grant.
It reads at most 256 KiB per granted Query, checks exact owner/reference/ranges,
requires complete ready observations, and verifies all bytes against the original
length and SHA-256. Caller identity and task generation are rechecked after reading.

`AgentTaskOwner::admit_asset_import` atomically records the exact resource input,
controller and receipt in Agent storage without copying bytes into that capture or
core Operation. Captures are limited to 16 KiB each and 16 MiB per project/principal.
Identical retries inspect the original receipt without re-reading the source or
launching native work, including after backend reopen. Unconfirmed original receipts
remain uncertain; changed resources or controllers are refused. Asset bytes retain
the existing 8 MiB/file and 32 MiB/task limits. Resource import does not provide a
browser file picker or stage local files; ordinary view file capture uses the
separate bounded stage/finish Controls.

Native and Rho Send resolve selected context through the exact provider's
declared public preview Query. A `plugin` selection retains its `ContextReference`
and a JSON-encoded owner-defined inclusion. The backend verifies the immutable
manifest/artifact, inherited read grants, reference and complete preview, then
revalidates the original live caller before admission. Each inclusion is at most
16 KiB and the combined capture metadata at most 64 KiB. Truncated input is refused
with the draft retained. Explicit resource inclusions support up to two PNG/JPEG
images of at most 2 MiB each, with exact provider identity, resource read authority,
chunk ranges, digest and bounded full decoding checked before admission. Bytes are
retained separately in the scoped Agent store (64 MiB per project). Rho also checks
the combined attachment/context image count and the current model image diagnostic. The task owner saves resolved source text,
provenance and original selections atomically with Send. Replay reads that capture
without querying current sources. `agent.native.context` exposes the original
capture after reopen. Context adds no scientific/tool authority. Text history and
Continue preserve provenance without automatically resending prior pixels. See
`docs/STATUS.md` for actual Host/browser evidence and outstanding flows.

Send can explicitly select up to 16 Query/Operation tools. Provider targets retain
an exact ordinary-plugin binding and immutable public manifest; Host targets retain
the project and exact native capability inspected through `host.core_contract`.
The backend revalidates the live caller before capturing descriptions, schemas,
scopes and targets with the original Send. Host targets can freeze declared
argument fields, such as the chosen development branch. Those fields are removed
from the model's input schema and inserted by the owner; model input cannot supply
or replace them. Native compare-and-swap requirements remain in the full request.

The private MCP endpoint exposes `rho_tools` and `rho_call`; callers must name that
Send and a canonical tool UUID. Identity reuse observes the original call; changed
input or an old Send on a later turn is refused. The package declares optional
grants for public R, Files, Process, Remote, Environment and Editor contracts and
native plugin, window and scenario management. Each exact capability version
remains a separate activation choice; declarations alone neither grant authority
nor select a tool. A branch checkpoint does not authorize a build, preview or
scenario application. Control and runtime capabilities cannot be selected as tools.

Tool admission shares Stop's owner gate and durably records a bounded semantic
request before queuing it under the original Send's Host parent. Dropping an HTTP
wait does not discard that child. Stop fences new calls while accepted scientific
work and its independent result remain retained. Each Send accepts at most 64
calls, with 64 KiB inputs and 96 KiB observations. Invalid, oversized or missing
replies preserve uncertainty; partial/cached queries retain their labels.
`agent.native.tool` reads the scoped receipt; `agent.native.tool.operation` follows
the original delegated request into the native journal. Provider replies must match
captured arguments and preconditions. Host owners may normalize their input;
verification uses the independently correlated original Operation identity, parent,
project, caller and capability rather than treating normalized JSON as raw input.
Neither read replays work or rewrites an uncertain receipt. Only core Operation
commits scientific results.

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

Ordinary instances may configure `kimi_home` as an existing absolute Kimi Code
state directory. The Agent passes it only to Kimi discovery/session processes and
uses that same directory for exact-project resume checks. It does not modify the
Host environment or copy native credentials into configuration or task records.
Without this setting the client uses its existing native environment lookup;
an isolated backend may have no such environment and will refuse resume. The
directory and original session metadata must remain available after Host restart.

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

The ordinary Agent view exposes Rho settings from its task menu. Settings and
native drafts share one view-state writer. Model endpoints, credential references
and original request identities survive reload; password input does not. Saving
a key uses ephemeral Control, then a separate versioned configure Operation.
Recovering a lost key receipt never configures or tests the model automatically.
Connection and image tests require explicit actions and use synthetic content.
`agent.model.key.status` observes availability at an exact settings version;
`agent.model.key.remove` removes only that version's configured local key after a
fresh caller observation. Configuration and removal share a gate, and storage
errors do not masquerade as missing keys. Removal preserves original key receipts
and leaves accepted model work's captured key untouched.

The ordinary view also supports Rho task creation, shared task selection, versioned
drafts, rename/archive, explicit takeover, Send/Stop and bounded run history. Native
and Rho drafts share the same view-state writer while retaining separate task
identities. Unknown creation/Send replies preserve their exact original requests;
reopening reads them and never dispatches a replacement. Admission captures an
available key before changing the draft and atomically consumes only matching
input. Later typing survives delayed acknowledgements and original-request replay.
`agent.model.history` pages up to 20 scoped summaries without starting a model or
changing stored interrupted work. The Rho composer submits text and explicit
contributed references; attachments, tool selection and continuation still require
composition. Renderer fixtures establish UI behavior, not native Host acceptance.

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
and starts no installed model. `node scripts/test-agent-plugin.mjs --build` checks the
independent package through a previously compiled generic Host, including native
task metadata, instance separation and attachment journal exclusion.
`node scripts/test-agent-plugin-native.mjs` repeats the runtime cases in
an independent source assembly with the public owner/store/client dependencies.
The temporary Host adapter delegates to this runtime while continuing to supply
caller validation, scientific context capture and the scoped MCP lease. This
temporary adapter remains until the remaining context, ordinary-view attachment
capture and Agent views replace the fixed composition. Release checks persisted native process
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
binding atomically with admission and matching saved-draft consumption. Missing
credentials refuse admission and preserve the draft. Text, usage and terminal state use the existing
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

Native Agent connections and explicitly selected native tools are composed as
described above. General context providers, component-model input/continuation and
combined ordinary-view native/Host acceptance still require integration. Synthetic diagnostics and
submitted-text runs alone do not establish scientific execution or real-provider quality. Default
delivery remains unfinished.
The backend transport and independent Host verification commands are described
in the build instructions.

The ordinary native composer now has a generic @ picker. It reads active runtime
instances, discovers their declared context contributions and derives finite
inclusion choices from each preview query's schema. Search and preview are bounded
reads; opening the picker never starts or resumes a provider. Partial listings are
labeled. Only a complete supported preview can be added, retaining its exact
provider, original window, selector/version and inclusion in the ordinary draft.
Saved references remain removable and inspectable when a source changes. Send
revalidates them through the backend capture path. The message's **Sent context**
action reads the original Agent-owned capture, including its source details,
without querying the current provider. Explicit captured-image inclusions display
thumbnails after chunk/digest validation. Preview failure leaves Add unavailable;
closing the dialog releases temporary image URLs. Existing actual Editor/Host
acceptance and focused renderer fixtures are tracked in `docs/STATUS.md`.

Rho attachment input is implemented through `agent.model.assets.stage` and
`.finish` Controls and the bounded `agent.model.assets` metadata query. It uses
the existing component asset store: UTF-8 text up to 32 KiB, PNG/JPEG up to 2 MiB,
and at most two images and 16 combined sources per Send. Image input requires a
passing diagnostic for the exact selected model connection. The view saves file
identity before uploading bounded chunks; lost replies offer inspection and exact
file reselection. Inspection does not select draft input or send a message.
Send captures immutable attachment evidence and text before admission; only images
selected for that Send contribute image bytes. History and Continue preserve
references without silently resending prior image pixels. Attachment-only Send and
next-draft recovery use the same original-request checks as text. Model/renderer
checks pass; this extension's native and actual Host acceptance remain pending.

Rho uses the same source resolver before model admission. Its owner atomically
stores `ComponentAgentContext` with the original request and matching draft
consumption; partial/changed sources and missing keys preserve the saved draft.
The production Rig driver receives the retained source bytes, and original retries
read that capture without contacting the provider. The common picker edits each
native/Rho task through its own draft owner; a delayed Send cannot remove newer
reference selections. Sent context inspects the original run. Native framed and
store acceptance for this new composition remains pending.

## Component input sender SDK

`sdk/component-input/` is a public source helper for ordinary plugin views.
Package it as `public/agent-input/` alongside `public/plugin-ui/` and
`public/plugin-protocol/`; it has no private core imports or runtime dependency on
an installed Agent. Help and Viewer demonstrate its assembly and use.

The source plugin supplies an exact owner `ContextReference`, explicit inclusion,
preview capability and title. `ComponentAgent` previews/rechecks that source,
selects an observed active Agent instance, and retains the exact original
`windows.open_view` request before dispatch. `componentInputDialog` supplies the
small optional chooser UI. Neither starts an instance, creates a task nor sends.
A reopened source can inspect the original view result, but only its original
view identity may retry. An accepted opening is observed for a bounded interval;
if it has not settled, its original identity remains available for inspection. Persist `AgentState` through the source's existing serial
view-state writer so background reading choices cannot erase the request.

Declare public instance inspection, window layout/opening, original-operation
reads, and the source owner's preview contract with its actual required scopes.
Window opening follows the same target-view grant containment as Studio. The
caller still needs each individual capability to execute any scientific operation.
