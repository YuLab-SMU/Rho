# Process owner

`api` owns local process requests, validation and bounded native/recovery reports.
`backend/engine` contains the single
implementation of native subprocess supervision used by Files/Git and the retiring
process adapter. It has no private Host, journal or Operation dependency.

Supervision preserves separate stdout/stderr, full stream draining with bounded
retention, binary stdin, original exit details, explicit cancellation and timeout,
and process-group cleanup. A closed cancellation channel does not request a stop.
Cleanup uncertainty remains visible in the report. These mechanisms do not provide
an operating-system sandbox for trusted native code.

`backend/owner` owns canonical project-root checks, native launch setup, removal
of inherited credential-like environment keys, process tagging and native
inspection/reconciliation. It uses the public OperationId and has no private Host,
journal or scientific dependency. Reconciliation requires the caller to establish
the original terminal operation and scope before invoking it. A saved PID does
not authorize a signal: the owner rechecks same-user identity, native start time
and the original operation tag. Incomplete native evidence remains uncertain.
The retiring adapter delegates to this owner; there is one native implementation.

The executable tests moved with their owners, including parent/descendant cleanup
and read-only marker inspection. Run `cargo test -p rho-process-owner --lib --locked` for focused owner checks and
`node scripts/test-process-plugin-owner.mjs` for independent source assembly and
native checks without private core crates. The ordinary process plugin RPC,
operation-result settlement and user-facing composition remain to be implemented;
this directory is not yet an installable package.
