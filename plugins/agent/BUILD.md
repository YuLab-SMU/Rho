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
The generated manifest uses compact JSON so the complete encoded file, including
its source inventory, remains within the public protocol's 256 KiB read limit.

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
An optional exact R binding and Explain/Run mode select scientific access. Activate
only the desired optional capabilities: `r.session@1` for observation (an Explain
request can select that read-only binding directly), and
`r.execute@2`, `operation.get@1` and `plugins.delegated_operation@1` for execution
and original-result inspection. The original caller must also hold each selected
scope. Model arguments carry only code; they cannot replace the selected provider,
revision, native session or request identity. Querying never creates an R session.
`agent.model.run.admission` exposes the original parent and exact provider bindings
for scoped inspection. Tool receipts retain the original reverse request before dispatch. Stopping the
model does not cancel or roll back R: its containing Operation waits for already
issued native work, retaining late results. After disconnect, `agent.model.run.tools`
and `agent.model.tool.operation` observe original evidence without replay or task
store updates. Missing evidence remains partial. General context contributions,
component-model attachments/continuation and ordinary views remain implementation work.

`agent.native.command` composes the same native task owner, store and scheduler.
Send can capture explicit ordinary-plugin Query/Operation tools. Enable
`plugins.inspect@1` to resolve immutable tool contracts, the selected scientific
capabilities, and `operation.get@1`/`plugins.delegated_operation@1` for effectful
tools. The package declares exact optional Query/Operation grants for R, Files,
Process, Remote, Environment and Editor. Activation does not automatically select
them, and declaring several versions does not choose a version for a Send.
Each tool carries an exact provider binding and target; the original caller
must hold its scopes. The private `rho_call` method requires the original Send and
a semantic tool UUID, with no provider selector in its arguments. Accepted children
survive Stop and dropped reply observers. `agent.native.tool` and
`agent.native.tool.operation` inspect retained evidence without replay. General
contributed context remains unfinished. Full 8 MiB resource attachments use the
separate `agent.native.assets.import` Control with an exact resource reference and
an explicit `resources.read@1` optional grant. Only small inline uploads use
`agent.native.assets.upload`. Neither path starts a native Agent or journals bytes;
select the resulting asset with a separate versioned draft write. Import retries
observe the original receipt without another resource read. Browser local-file
capture/staging remains separate implementation work.
Importing the package does not activate it. Installing or activating a development
package is an explicit plugin lifecycle operation.

Run `cargo test -p rho-agent-backend --test metadata --locked --offline` for public
framed transport, calling-origin, metadata version, controller and restart checks.
The fixtures use local synthetic Host exchanges and a loopback HTTP/SSE model,
never real user keys or remote models. They cover model/task lifetime, original
native identity, text, stopping, takeover, interrupted reopen, scientific reverse
requests, late native results, scoped Explain/Run and read-only original recovery.
The `native_science` cases use actual private MCP HTTP with synthetic Host records
to check selected grants, original Send identity, retries, Stop, later turns,
partial/cached observations and unverified/oversized result refusal. Multiple
scientific owners in one Send retain separate bindings, requests and results.
The repository check `node scripts/test-agent-tool-grants.mjs` compares the
published optional versions/scopes with all six public provider manifests and
rejects accidental Control/Runtime grants. It does not execute those providers.
Real R and provider quality require separate acceptance.
`node scripts/test-agent-plugin-backend.mjs` independently builds the package and
runs these framed cases. `node scripts/test-agent-plugin.mjs` freezes the generic
Host harness before building and loading the external package, then exercises
metadata, key Controls, diagnostics and ordinary model-task lifetime through the
same native ports. At a milestone, run only the latter: it also runs the framed
cases against its single independent build (`--evidence <file>` records stages and
hashes; `--skip-framed` when a current framed result already covers the source).
All projects, instance storage and keys are disposable.

`RHO_ARK=/absolute/existing/ark RHO_R_HOME=/absolute/existing/R/home node
scripts/test-agent-plugin-real-r.mjs` freezes a generic plugin-only Host harness
and builds both packages outside the checkout. It also freezes and reruns the
ordinary metadata, key and model lifetime harness against that same Agent package.
It runs separate disposable R counter fixtures through the loopback model and a
local native ACP process/private MCP endpoint. They check native causation,
retained reports, stopping Agent/model waiting while R is executing, and repeated
request observations without repeated effects. The native fixture uses only its
isolated PATH and disposable files; it does not need forwarded Host environment
variables. These checks do not contact external models, use existing user sessions
or establish native model quality/full Host restart. Required runtimes must already
be installed.
