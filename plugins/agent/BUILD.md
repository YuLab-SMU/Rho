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
draft, title/archive, explicit control-transfer and model-configuration Operations.
Configuration validates an expected settings version and credential references.
`agent.model.key.store` accepts plaintext only through ephemeral Control, outside
the Operation journal. Its immutable key and original-request reference are saved
atomically in the instance credential file. After a lost reply, the read-only
`agent.model.key.receipt` resolves that reference; missing receipts remain partial
observations. Neither port configures or contacts a model. Native initialization
selects the exact instance data directory. Mutations observe the original caller
through `views.caller`; callers cannot select a project, principal, controller or
database path. The Agent metadata store is separate from the scientific journal.
Only the Host commits Operation results. A result candidate is retained until its
original Host settlement; disconnect never means cancellation or rollback.

`agent.model.test` explicitly runs a bounded synthetic connection/image diagnostic
through the same public Rig engine. It captures settings and a scoped key, retains
the original native Operation until completion, and offers read-only observation
and explicit stopping. Disabling settings also fences live diagnostics. Neither
reopen nor repeated requests restart an original test. These diagnostics have no
scientific tools or project context.

`agent.model.run` executes explicit submitted text with the existing task owner,
model engine, retained native admission and task events. Its original-request/run
queries and event pages are read-only. Explicit stop, disable and controller
takeover fence the same live loop. Repeated requests and reopen never restart it.
The current run input has no native tools, scientific context, attachments or
continuation; those and native Agent transports and views remain implementation
work.
Importing the package does not activate it. Installing or activating a development
package is an explicit plugin lifecycle operation.

Run `cargo test -p rho-agent-backend --test metadata --locked --offline` for public
framed transport, calling-origin, metadata version, controller and restart checks.
The fixtures use local synthetic Host exchanges and a loopback HTTP/SSE model,
never real user keys or remote models. They cover model/task lifetime, original
native identity, text, stopping, takeover and interrupted reopen; scientific-tool
execution and provider quality require separate acceptance.
`node scripts/test-agent-plugin-backend.mjs` independently builds the package and
runs these framed cases. `node scripts/test-agent-plugin.mjs` freezes the generic
Host harness before building and loading the external package, then exercises
metadata, key Controls, diagnostics and ordinary model-task lifetime through the
same native ports. All projects, instance storage and keys are disposable.
