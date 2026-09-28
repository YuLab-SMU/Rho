# Rho backend SDK

`rho-plugin-sdk` depends only on the public protocol and ordinary Rust libraries.
It is independently packageable. Other languages can implement the same wire
format without using this crate: each JSON RPC frame is prefixed by its byte
length as an unsigned four-byte big-endian integer. The maximum is 1 MiB.
Stdout is exclusively the protocol; write diagnostic logs to stderr.

Receive `Initialize` with `accept_stdio`, initialize the owner, then send `Ready`
with `ready`. The Host does not publish contributions before readiness. Validate
incoming call identity with `validate_call`; enforce native identity and
preconditions in the owner. Return a query observation or a proposed CommitPlan.
The Host's Operation mechanism commits results. Never write its database.

For a failed query or preflight, return `Error` with an exact diagnostic `code`
and useful `message`. The Host preserves the provider error; common codes such as
`busy`, `invalid_input`, `observation_expired`, `content_changed` and
`budget_exceeded` retain their typed observation hints at public edges. Unknown
codes remain visible in the error and use the generic unavailable hint. Message
text is never parsed to classify an error. These read diagnostics do not authorize
work or establish an Operation outcome. Transient Control errors remain redacted.

Owners that can atomically fence a waiting invocation may advertise
`pending_cancellation_v1` with `ready_with_features`. `ready` advertises no optional
extensions, so existing exact revisions keep their original capability contracts.
Handle `PreparePendingCancellation` on the reader/control lane. Match its complete
provider binding, project, native target and original Operation ID. Atomically
reserve cancellation only while that invocation is waiting; a running or completed
invocation returns `prepared: false`. Echo the exact request in
`PendingCancellationPrepared`. Preparation fences native start but cannot finish
the Operation, interrupt running work or manufacture a result. Wait for the ordinary
`Cancel` after the Host records the original cancellation request.

Preparation is idempotent. A lost reply or failed Host journal write leaves the
fence observable; the user can retry the same original cancellation. The Host waits
up to five seconds per preparation attempt and coalesces retries under the same
unanswered transport identity. Exact late duplicate replies are bounded to the
128-entry transport history. Never release a fence by a timeout or queue resume.
After the actual cancellation, use the normal CommitPlan and settlement handshake.
If the original invocation returns while preparation is unanswered, the Host retires
that preparation without claiming success and accepts only a bounded late reply
for its exact identity. The unanswered preparation cannot indefinitely block release.

Declare `kind: "control"` for transient answers to an existing owner request.
Handle `Control(PluginCall)` without taking the lane held by the waiting execution,
then return `ControlResult`. Its `operation_id` must be null; original native
operation/request identities belong in the owner's validated arguments. Controls
have no new Operation, idempotency receipt, event, recovery candidate or resource
transfer authority. Host arguments and results are each bounded to 256 KiB.
Do not log answers or include them in errors; Host control diagnostics redact
native errors and schema failures. The owner must fence stale and duplicate input.
After lost acknowledgement, observe the original native request before retrying.
Explicitly bound queries and controls remain available while an instance drains;
new Operations and automatic provider selection cannot enter that instance.

Handle `OperationSettled` independently of the execution lane. This Host-only
notification contains the original Operation ID, exact provider/native binding
and terminal outcome read from the authoritative journal. Validate it with
`validate_settlement`, then match any live owner scheduling fence. Release the
matching fence on success, or retain an explicit pause on failure/cancellation/
uncertainty according to the owner. Echo it as `SettlementAcknowledged` only after
applying that scheduling change. It must be idempotent: a repeated or unknown old
ID cannot advance another queue item. An operation cancelled before native dispatch
may have no local item and still needs acknowledgement. This is not a new execution
or result database; do not accept settlement through user controls or reverse calls.

Each settlement attempt waits up to five seconds for acknowledgement. Timeout or
invalid acknowledgement preserves the already committed result and the protecting
operation reference. Explicit `plugins.reconcile_references` reads the original
journal and resends only its settlement to the original live instance. A resend
keeps an unanswered transport request ID; owners must accept it with a new ordered
frame sequence. No scientific invocation is repeated. After disconnection/restart,
reconciliation can release the operation reference without starting a replacement
owner; the failed instance and native recovery material remain retained.

Initialization may include a Host-issued `environment` with the normalized
`project_root` and a private, persistent `data_root` for this exact instance.
Use these paths for owner storage; do not infer a project from the artifact working
directory or accept configuration as authority over another instance’s data.
The data directory is retained after release, including failed initialization.
It does not grant access through other Host ports or provide an OS sandbox.

Use one dedicated reader task, and serialize writes through `RpcWriter`. The
reader checks the Host-issued instance/connection and ordered sequences. Split
the connection's public reader/writer fields when execution must run concurrently
with cancellation or reverse calls. The small `echo-backend` example implements
a read-only provider without any Host or scientific crate.

A dedicated reader using Tokio stdin can leave an uncancellable blocking read
after `Release`. A standalone backend that owns its runtime must finish and
await its native owner work, then shut down without waiting for that idle stdin
thread (for example, `Runtime::shutdown_background`). Do not use runtime shutdown
as confirmation that scientific work stopped. See [Tokio stdin](https://docs.rs/tokio/latest/tokio/io/struct.Stdin.html).

A reverse `HostCall` names its active parent request and one declared grant;
the Host bounds it by that parent's project, principal and scopes. It carries
no generic Host credential. Cancellation acknowledgement with `confirmed: false`
only reports receipt. Neither disconnect nor timeout means execution stopped;
return confirmed cancellation only after the native owner observes it stopped.

`host_call_channel(1..=32)` supplies a cloneable `HostCallClient` and one
`HostCallPump` for asynchronous owner callbacks. `begin` queues one captured
request with the owner's retained request ID, active parent ID, capability and
arguments (at most 256 KiB; use resources for larger content). It reserves the
slot and queues synchronously. The server selects `pump.next()` alongside its
dedicated reader's decoded frames, checks that the parent is still active, and
sends the returned request/body through its existing `RpcWriter`. Pass only
validated `HostResult`/`Error` frames to `pump.respond`; other frames stay with the
ordinary server loop. Host still checks declared grants and original caller scope.

Await `PendingHostCall::receive()` in the task's callback. Concurrent results may
arrive in a different order. Dropping that wait leaves the original slot reserved
until its response or connection closure; it never retracts or replays the call.
The task owner retains its recovery identities and decides whether to continue
waiting or inspect the original Operation. Close or drop the pump when the server
connection ends: queued and dispatched waiters return `Unconfirmed`, never a
successful cancellation. Admission after closure is refused. Structured Host
errors retain their code and recovery without including recovery in debug output.
The helper is a transient transport, not an idempotency database, authorization
grant, retry policy or scientific result owner.

Retain both the native parent `operation_id` and your original reverse `RequestId`
before dispatching scientific work. With an explicit `plugins.delegated_operation`
grant containing `operation.read`, a later active query can pass
`{parent_operation, request}` to resolve that original Operation, then read it
through `operation.get`. The Host derives the provider from its native parent
admission and verifies the original backend caller, project and principal. You
cannot select another caller or supply the Host's opaque idempotency key. A null
identity is a partial observation: dispatch may still be pending. Do not replay
an unresolved mutation. Observation does not reconnect or recover a backend.

For files and other large observations, initialization can include a
`resource_channel`. On the current Unix target, construct `ResourceClient` from
it and call `put` with the active incoming request ID, declared size, media type,
SHA-256 and an asynchronous byte reader. Await the returned `ResourceReference`
before using it as query source or commit evidence. `resource-backend` is a
standalone example. Keep reading control frames concurrently during long work.

Each transfer opens a separate local socket. Its header is at most 16 KiB JSON,
prefixed by a four-byte big-endian length. `ResourceTransferRequest` carries the
channel version/token, active parent request and `put` or `read` request. Raw
upload bytes follow the header; close the write half after the declared length.
`ResourceTransferResponse` confirms a stored reference, reports an error, or
precedes exactly the declared raw read bytes. This channel never carries Host
credentials or backend-supplied filesystem paths. The SDK supplies framed-header
helpers for other native implementations and tests.

The Host fixes ownership from the active parent. A native channel can read only
its own instance's resources; cross-owner reads require a declared, scoped Host
`resources.read` query. A query may retain observation bytes, which does not
commit scientific facts. Uploads are limited to 256 MiB, reads to 256 KiB, with
four concurrent transfers per Host, 512 MiB retained per instance, and 2 GiB /
16,384 resources per store. Quota rejection preserves existing resources.
Incomplete uploads never become evidence. Repeating a complete identical upload
returns the same reference. `resources.list` can discover completed bytes after
a lost acknowledgement. Retained resources survive provider release and Host
restart; a reference alone never grants read access.

Native backends and their explicit build scripts are trusted local code. Process
and protocol isolation are not an operating-system filesystem/network sandbox.
