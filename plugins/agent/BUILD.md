# Building the Agent package

Use the installed Rust 1.97 toolchain and Node.js. The build is offline and does
not install tools, fetch models or contact model providers.

From the Rho source checkout, `node scripts/build-agent-plugin.mjs /absolute/new-directory`
assembles a source package outside the checkout. It copies the public protocol,
backend SDK and R media API, rewrites their dependency paths within the package,
prunes the copied lockfile for the native target and verifies source containment.
Inside that standalone package, run `node build.mjs` to reproduce `plugin.json`
and `dist/rho-agent-backend`. All first-party sources, dependency locks, license
and these instructions are included in the package inventory.

The current process contributes task metadata queries and model-task create,
draft, title/archive and explicit control-transfer Operations. Native initialization
selects the exact instance data directory. Mutations observe the original caller
through `views.caller`; callers cannot select a project, principal, controller or
database path. The Agent metadata store is separate from the scientific journal.
Only the Host commits Operation results. A result candidate is retained until its
original Host settlement; disconnect never means cancellation or rollback.

This composition does not yet start models, native Agent transports or scientific
work and has no Agent view. Those remain implementation work; the extracted
engine/client sources are included but are not falsely registered as capabilities.
Importing the package does not activate it. Installing or activating a development
package is an explicit plugin lifecycle operation.

Run `cargo test -p rho-agent-backend --test metadata --locked --offline` for public
framed transport, calling-origin, metadata version, controller and restart checks.
These are local synthetic Host exchanges, not model or scientific acceptance.
