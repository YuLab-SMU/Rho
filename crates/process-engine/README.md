# Shared native process supervision

This public Rust library supplies `run_command`, `ProcessOptions` and bounded
reports from `rho-plugin-protocol`. It has no Host, Operation journal, scientific
owner or model dependency. Ordinary native plugins and the package build owner
configure their command and interpret its report through their own owner.

The caller supplies a Tokio `Command`, a positive timeout, an output limit per
stream (1 byte to 16 MiB), optional stdin and a `watch::Receiver<bool>` for
cancellation. Closing that channel does not cancel. The supervisor drains both
streams, retains their bounded prefixes and total byte counts, and confirms
native cleanup or reports uncertainty. On Unix it owns a process group; on Windows
it uses a Job Object. This is process supervision, not an OS sandbox.

When assembling independent source packages, copy this crate beside the public
`plugin-protocol` crate. No scientific Process API is required. Run
`cargo test -p rho-process-engine --locked` for supervisor acceptance.
