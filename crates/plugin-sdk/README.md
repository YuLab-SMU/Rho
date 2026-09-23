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

Native backends and their explicit build scripts are trusted local code. Process
and protocol isolation are not an operating-system filesystem/network sandbox.
