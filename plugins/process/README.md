# Process owner

`api` owns the public bounded process report. `backend/engine` contains the single
implementation of native subprocess supervision used by Files/Git and the retiring
process adapter. It has no private Host, journal or Operation dependency.

Supervision preserves separate stdout/stderr, full stream draining with bounded
retention, binary stdin, original exit details, explicit cancellation and timeout,
and process-group cleanup. A closed cancellation channel does not request a stop.
Cleanup uncertainty remains visible in the report. These mechanisms do not provide
an operating-system sandbox for trusted native code.

The engine's existing executable tests moved with its source, including native
parent/descendant cleanup. Run `cargo test -p rho-process-engine --locked` for this
library. The ordinary process plugin transport, recovery owner and user-facing
composition remain to be migrated; this directory is not yet an installable package.
