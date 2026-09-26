# Processes

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

`backend/src` implements the ordinary `org.rho.process` RPC service. Its local
execution capability returns a resource-backed report; only the Host commits the
original scientific result. The native execution lane stays held until exact
settlement. Unconfirmed output transfer retains uncertainty and recovery evidence
without replay. The package also provides read-only preflight and activity queries.
Explicit reconciliation obtains the original terminal record through a delegated
Host query, fixes its original binding and cleans only freshly verified native
processes retaining that operation tag. It records its own result without changing
the original outcome; incomplete native visibility stays explicit.

See [BUILD.md](BUILD.md) for independent assembly, public contracts and executable
acceptance. Focused checks use `cargo test -p rho-process-backend --lib --locked`
and `cargo test -p rho-process-owner --lib --locked`.
`node scripts/test-process-plugin-owner.mjs` separately assembles the native owner
without private core crates. Parent/descendant cleanup and read-only marker
inspection tests live with those owners. SSH/Slurm and default scenario composition
remain under implementation.
