# Running and using Rho

This guide describes current commands and ordinary-plugin use. Read
[Status](STATUS.md) for verified artifacts and limitations. The headless and
external-Agent target in [Next Version](NEXT-VERSION.md) is not a replacement
operator interface yet. Inspect existing processes and work before starting a
second Host or replacing a user's session.

## Local macOS preview

Open **Rho Preview.app**. The native launcher prepares its dedicated catalog and
Demo, then opens the default browser. Open `run_demo.R`, choose **Start R** in
Console and **Save and Run** in Editor. R starts only when requested. Navigation
reveals existing views without recreating their documents.

Preview 3 includes Ark and records an existing local R home; R must remain
available. Setup checks `jsonlite` and `rlang` without installing packages. Demo,
catalog, private connection and logs live under
`~/Library/Application Support/Rho/Preview 3`. Earlier previews keep their own
catalogs. Retry retains original setup requests; later launches do not reimport
removed packages or replay R code.

Reopening returns to the saved window. **Open Workspace**, **Show Project**,
**Show Logs** and **Quit Rho** belong to the native launcher. Save files before
quitting: synchronized drafts/layouts and files persist, but Host shutdown ends
its R memory. Closing the browser alone leaves the Host running. See
[preview assembly](RELEASE.md#native-local-preview-app) for delivery details.

## Start Studio

Build only when the selected binary needs rebuilding:

```sh
cargo build --locked
target/debug/rho --database /absolute/state/rho.sqlite \
  --project /absolute/project workbench \
  --url-file /absolute/private-launch-url
```

Global flags precede the subcommand. The project must exist; Workbench can prompt
for it when `--project` is omitted. The URL file must be new. Without `--url-file`,
the complete private URL prints to stdout. Navigate directly and keep its token
private. Workbench binds loopback with an ephemeral port unless `--port` is set.

Startup opens the generic Host and window. It does not discover/start R, install
default packages or fall back to a fixed workspace. `--plugins-only` explicitly
names this same default composition. An empty catalog requires an explicit import.
Use the same database for [bundle import and launch](RELEASE.md#portable-local-development-bundle).

One writer owns a canonical project through `.rho/next-host.lock`; another database
does not evade this lease. Lock-file existence alone is not process liveness.
Ctrl-C drains the server and terminates its managed native processes; it does not
guarantee a fresh recovery copy. A later Host does not reattach old R memory.

## Prepare an ordinary R workspace

In Plugins, choose **Scenarios → New R workspace**, installed exact artifacts,
an existing Ark executable and R home. Optional packages can be left **Not included**.
Multiple versions require an explicit selection. Preparation captures instances
and a scenario; switching applies its layout to the current window. Start R in
Console afterward. Files opens Editors bound to that same R Provider.

The R provider requires `jsonlite`; `rlang` enables non-forcing object inspection.
Files and editing remain available without a running R session. Configure scientific
providers through ordinary instances, not retired fixed R/remote/Skill flags.
Remote and Environment defaults remain unconfigured until explicitly selected.

A recovery helper is a separate acquisition for the exact R installation:

```sh
node scripts/bootstrap-recovery-component.mjs \
  --ark /absolute/ark --r /absolute/R
```

Set the R instance's `checkpoint_helper_path` to the installed library path printed
by the script. Catalog reads and copy requests never build or install this helper. Recovery support does not
promise complete capture of arbitrary R objects or external resources.

Closing a view keeps its instance and accepted work alive. **Restore saved view**
resumes a confirmed suspended instance and reconnects that view; a backend without
a view uses **Instances → Restore instance**. Dependencies are not silently
recreated. Restoring the backend is separate from restoring R memory. After a lost
reply, inspect the original request before retrying or advancing the workflow.

## Scientific work

| Action | Boundary |
| --- | --- |
| Save | Check the captured disk base and resulting bytes; preserve a refused draft |
| Run selection or line | Capture selected input; no automatic file save |
| Save and run file | Verify saved content matches the capture; later edits remain newer |
| Console | Observe original runs, ordered output, queue/input and cancellation state |
| Objects | Read the selected R session; retain busy/expired status and bounded pages |
| Packages | Inspect installed copies, library order and loaded/attached state without loading or installing |
| Plots and Viewer | Read original output/resource references; distinguish retained media from captured UI evidence |
| Annotation | Freeze exact source evidence; preserve note versions and source-change status |

Use each plugin's visible actions and published contracts for supported behavior.
[Console](../plugins/console/README.md), [Objects](../plugins/objects/README.md),
[Files](../plugins/files/README.md), [R](../plugins/r/README.md) and
[Viewer](../plugins/viewer/README.md) describe their current interfaces.
New native sessions invalidate old object references. Complete a copy/read within
its original observation; do not merge cached pages from different sessions.

The existing Agent view supports Native/Rho tasks, source selection and scoped
workspace tools. Read-only context is the default; source selection does not
execute code. See [Agent](../plugins/agent/README.md) for current package behavior.
This interface remains present even though the next-version design uses external
Agents without requiring it. A functional integration check is not proof of model
quality or image interpretation.

## Connect an external client

To share an existing Workbench and R session, use its `/mcp` endpoint with
`Authorization: Bearer <launch-token>`. Obtain the token from the private launch
URL without copying it into tracked files or diagnostics. Streamable HTTP sessions
pin their selected Host; close them through the protocol before releasing a test Host.

A standalone stdio Host is available when the project is not already owned:

```sh
target/debug/rho --database /absolute/state/rho.sqlite \
  --project /absolute/project mcp
```

Tools come from the live capability registry. Query and Control tools accept their
published arguments. Operations use a stable caller-generated `client_request_id`,
arguments and preconditions. Ordinary scientific calls retain the exact binding
returned by `plugins.resolve`; never select by a guessed alias or old session ID.
MCP schema adaptation preserves semantic validation at the Host.

The connected CLI uses the original private URL file:

```sh
target/debug/rho --connect-url-file /absolute/private-launch-url \
  query --capability plugins.instances --arguments '{"limit":20}'
```

Connected commands use the existing Host rather than opening another writer.
`--project`, if supplied, checks its root. `session` provides the JSON-lines Host
protocol; use the public request types and live catalog instead of retired
scientific command names. Standalone `query` observes generic/history state only;
ordinary live provider queries need the existing Host.

Standard `.agents/skills` files can guide external clients. The fixed `skill.list`
and `skill.read` service is removed. Consult live capability declarations before
following older examples; method text grants no authority. Package-scoped method
discovery and fully window-independent contexts remain next-version work.

## Recovery and storage

The default macOS journal is `~/Library/Application Support/rho/next.sqlite`;
`--database` selects another. Generic presentation state uses the sibling
`.studio.sqlite` path. Plugin-managed storage and immutable package content have
their own owners; do not edit their SQLite files to repair a workflow.
Draft synchronization is not a file save, and historical output is not live memory.

After a lost connection, query the original Operation. A missing observation does
not prove the action never happened. Retry only with the original caller/request
and identical content. Read-only history does not start R or perform crash recovery.
RPC cancellation ends an observation wait, not necessarily the accepted operation.

For a pending commit, read `operation.commit_status` with the original ID. Retain
the returned candidate reference. When its storage issue is resolved, use
`operation.reconcile_commit` to settle that exact candidate. Do not execute the
calculation again. Cancellation requests and confirmed native stopping remain distinct.

## Plugin package recovery CLI

These commands need neither R nor a management UI. Use an explicit disposable
store for development; the default is `plugins-v1` beside the selected database.

```sh
rho plugins --store /absolute/test-store list
rho plugins --store /absolute/test-store instances --limit 20
rho plugins --store /absolute/test-store snapshot /absolute/package --target ui-web
rho plugins --store /absolute/test-store inspect sha256:EXACT_REVISION_DIGEST
rho plugins --store /absolute/test-store export sha256:EXACT_REVISION_DIGEST /absolute/new.rho-plugin
rho plugins --store /absolute/test-store validate /absolute/new.rho-plugin
rho plugins --store /absolute/test-store import /absolute/new.rho-plugin
```

Replace the digest with the returned complete identity. Snapshot captures declared
source and existing artifacts; it does not build. Import does not activate or grant
scopes. Retained instance records are not live process proof. Used revisions retain
protecting references; removal cannot bypass them.

[Plugin Studio](../plugins/studio/README.md) uses the same source/checkpoint/build/
preview/test/apply ports. A new checkpoint does not replace a running instance.
Fixture preview has no backend or scientific grants; real tests use disposable
projects. Preserve each original request after an uncertain acknowledgement.

## Disposable tests and frontend development

`plugins.test_create` creates an isolated child from exact package selections;
queries only observe it. `plugins.test_stop` requires no active work or retained
connections and confirmed cleanup. Child directories/journals remain evidence.
Connected CLI selects a live child with `--test-project ID`; MCP pins
`X-Rho-Test-Project` at initialization and requires it on subsequent requests.
HTTP/stdio select it through the public frame's `test_project`. Selection never
creates or recovers a child and does not broaden caller authority.

For shell-only frontend iteration, run `npm run dev --prefix ui`, then initially
launch an authorized Host with `workbench --dev-assets /absolute/Rho/target/studio-assets`.
Reload after rebuilding. This preserves that live Host/R session; it does not
replace immutable plugin artifacts or add native capabilities. See
[Development](DEVELOPMENT.md#frontend-iteration) for checks and restart discipline.
