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

Use one dedicated reader task, and serialize writes through `RpcWriter`. The
reader checks the Host-issued instance/connection and ordered sequences. Split
the connection's public reader/writer fields when execution must run concurrently
with cancellation or reverse calls. The small `echo-backend` example implements
a read-only provider without any Host or scientific crate.

A reverse `HostCall` names its active parent request and one declared grant;
the Host bounds it by that parent's project, principal and scopes. It carries
no generic Host credential. Cancellation acknowledgement with `confirmed: false`
only reports receipt. Neither disconnect nor timeout means execution stopped;
return confirmed cancellation only after the native owner observes it stopped.

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
