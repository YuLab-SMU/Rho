# Running and using Rho

## Start Studio

From the repository, build the binary with the pinned Rust toolchain:

```sh
cargo build --locked
target/debug/rho workbench
```

Open the full private URL printed by the command. Select an absolute project
directory, then use Studio to edit scripts, run R, inspect objects and view plots.
Node is needed for frontend development, not for running the embedded application.

For explicit storage, runtime and project paths:

```sh
target/debug/rho --database /absolute/path/to/state.sqlite \
  --project /absolute/path/to/project \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home \
  workbench --url-file /absolute/path/to/private-launch-url
```

Global flags precede the subcommand. `--url-file` must name a new file; otherwise
the private URL is printed to stdout. The server listens on `127.0.0.1` using an
ephemeral port, or the workbench's explicit `--port`. Keep the launch token private.
Unix URL files use mode 0600. Ctrl-C stops the server and drains accepted work;
closing a browser page does not cancel it.

## Select R

Workbench selection uses explicit launch arguments, a saved user choice, available
R executables on PATH, then the standard macOS installation location. Ark discovery
checks beside the running binary and on PATH. Settings can select existing absolute
R and Ark executable paths and probe version, architecture, R home and bridge support.

An invalid explicit or saved choice is reported without silently substituting R.
The bridge needs jsonlite; rlang enables non-forcing object inspection. Without
usable R, project browsing and editing remain available. R, Ark and R packages
are not installed automatically. Optional Ark acquisition scripts live under
`scripts/bootstrap-ark-*`; they retain upstream notices and return an executable
path to configure explicitly.

Changing R requires an explicit acknowledgement that session memory ends. Invalid
candidates do not tear down the existing session. Active requests/work and attached
MCP sessions prevent switching. Failed startup retains its diagnostic and provides
a project without R where possible; it does not restore the ended memory.

CLI `invoke`, `session` and stdio `mcp` use explicit runtime flags. Omitting R flags
there selects Project/Process-only hosting; `--rscript /path/to/Rscript` adds
Environment capabilities without live R. `--demo` is a test-only fake runtime and
is not accepted by the workbench.

## Work with scripts and outputs

| Action | Current behavior |
| --- | --- |
| Open | Browse the real project filesystem, including Git-ignored data, or enter a relative file path |
| Save | Apply a bounded patch with the original file digest and verify the resulting bytes; no Git commit |
| Run selection/current line | Execute selected text, or the current line when selection is empty; no automatic save |
| Run File | Capture the text, save and verify it, then execute that snapshot; later edits remain dirty |
| Format | Invoke native R tooling; apply only if the document still matches, otherwise offer comparison |
| Inspect objects | Retrieve read-only metadata/bounded previews; unsupported classed objects remain metadata-only |
| View/export a plot | Use the original operation/output reference; viewing does not execute R |

Cmd/Ctrl-S saves, Cmd/Ctrl-Enter runs a selection/current line, and
Cmd/Ctrl-Shift-Enter runs a file. Multiline expressions must be selected for
selection execution. New files need a path before Run File. Conflict, rejected or
oversized input, or an unconfirmed save stops before execution.

The editor preserves UTF-8 BOM and existing line endings. The editing limit is
512 KiB; larger, binary or non-UTF-8 files receive read-only information or a
bounded preview. Patch input is limited to 200 KiB and transport limits also apply.
Drafts are retained when a write is refused.

Studio supports PNG, JPEG and SVG output references. SVG is loaded as an image;
HTML/widgets are not executed. Original export saves the selected output's bytes,
not a new rendering with arbitrary dimensions. Script-controlled rendering is
appropriate when dimensions and reproducibility matter.

Output is observed incrementally, with explicit truncation/gap information.
Execution outcome still comes from the Operation record. Resource metrics cover
known Ark/R processes, not every descendant or inferred UI activity. The current
interaction limitations and requested refinements are in [Status](STATUS.md)
and [Studio feedback](STUDIO-FEEDBACK.md).

## Application state and recovery

The default macOS journal is
`~/Library/Application Support/rho/next.sqlite`. An explicit `--database` overrides
it. The application store is its sibling with the extension `.studio.sqlite`
(for example, `state.sqlite` uses `state.studio.sqlite`). Runtime/environment
materials live in the configured data area beside the journal.

The application store contains project layouts, drafts, view positions, recent
projects, preferences and unconfirmed request IDs. Browser session storage retains
the current local access token. Draft synchronization is separate from saving a
project file. Restart restores synchronized UI state across ports, not R memory
or the previous in-memory undo stack.

Closing a panel retains its document. Discarding a draft is explicit. Concurrent
windows use version checks; conflicts preserve local text for comparison and
explicit resolution. A reconnect queries original requests without replaying them.
Explicit retry retains the original client request ID; using a new ID means a
new intended action.

One Host owns a canonical project at a time through `.rho/next-host.lock`, and a
journal allows one writer. A second database does not bypass project ownership.
Lock-file existence alone does not indicate a running Host. Project metadata must
be writable. Use the existing workbench's MCP endpoint to share its session.

If a connection fails, inspect the original Operation before retrying. A writer
opening after a crash reconciles incomplete journal state; read-only `get-operation`
does not start R, change the record or clean up processes. Explicit reconciliation
preserves the original terminal outcome and reports observed remaining resources.

## Frontend development without restarting R

In one terminal:

```sh
npm ci --ignore-scripts --prefix ui
npm run dev --prefix ui
```

The watched build writes `target/studio-assets`. Start the workbench in another
terminal, then reload the browser after changes:

```sh
target/debug/rho --project /absolute/path/to/project \
  workbench --dev-assets /absolute/path/to/Rho/target/studio-assets
```

Only allowed, bounded `app.js` and `style.css` assets are served from that directory.
The Host and R session remain running. Normal launches use embedded assets.
See [Development](DEVELOPMENT.md) for generation, tests and visual review.

## Share Studio's R session through MCP

Configure an MCP client with the workbench's `/mcp` URL and
`Authorization: Bearer <launch-token>`. The token is the `token` value from the
private launch fragment. The HTTP endpoint uses official Streamable HTTP MCP.
Host/Origin and bearer checks also protect hosting/state endpoints.

MCP sessions pin the selected Host until the client closes them with the protocol's
DELETE request. RPC cancellation or disconnection does not prove native work stopped;
use the explicit cancellation tool and inspect the actual outcome.

For a standalone stdio Host:

```sh
target/debug/rho --database /absolute/path/to/state.sqlite \
  --project /absolute/path/to/project \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home mcp
```

Capability tools are derived from the registry as `rho.<capability>.v<version>`.
Query tools accept capability arguments directly. Command tools accept:

```json
{"client_request_id":"unique-action-id","arguments":{"code":"x <- 21; x * 2"},"preconditions":[]}
```

Results use `structuredContent.result` with a text fallback. Failed/uncertain
operations retain their identity and outcome. `rho.operation.get`,
`rho.operation.request_cancellation` and `rho.events.poll` expose the remaining
ports. Events are cursor pages, not a push-delivery guarantee.

The local MCP actor and human caller share the OS user's principal while retaining
separate actor identity. Tool arguments and client initialization names do not
grant authority. The Agent platform owns conversation and permission behavior.

## CLI and JSON sessions

A one-shot invocation starts its Host, performs the action, and closes on exit:

```sh
target/debug/rho --database /absolute/path/to/state.sqlite \
  --project /absolute/path/to/project \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home \
  invoke --client-request-id example-1 --code 'x <- 21; x * 2'
```

Read its result with the returned ID and the same database:

```sh
target/debug/rho --database /absolute/path/to/state.sqlite get-operation OPERATION_ID
```

Use `session` with the same startup flags for a persistent Host/R session. It emits
a ready frame containing capability descriptors and accepts one JSON frame per
line. Send these in sequence, waiting for the run reply before reading its object:

```json
{"id":"run","request":{"method":"invoke","params":{"client_request_id":"example-1","capability":{"id":"workspace.run_r","version":1},"arguments":{"code":"x <- 21; x * 2"},"preconditions":[]}}}
{"id":"inspect","request":{"method":"query_snapshot","params":{"capability":{"id":"workspace.inspect_object","version":1},"arguments":{"name":"x","max_items":5}}}}
```

Replies carry the transport ID and may arrive out of order. The methods are
`invoke`, `get_operation`, `request_cancellation`, `query_snapshot` and `subscribe`.
Get/cancel use `operation_id`; subscribe uses `after_sequence` and `limit`.
End stdin to drain accepted work and close the session. Exact schemas are in the
ready frame/MCP discovery and [Rust contract](../crates/contract/src/lib.rs).

## Domain capabilities

Availability depends on the selected Host configuration. These are scientific
capabilities, not a promise of dedicated Studio controls for each one.

| Family | Main operations and queries | Important behavior |
| --- | --- | --- |
| Workspace | `run_r`, `snapshot`, `inspect_object`, `help`, `lint`, `format` | One live session; pure queries do not force active/lazy bindings; native code tools are explicit Operations |
| Outputs | `operation.list_recent`, `workspace.output_events`, `workspace.read_output`, `workspace.runtime_status` | Bounded summaries/observations; original references rather than filename lookup |
| Project | `snapshot`, `list_directory`, `read_file`, `apply_patch` | Real filesystem/Git observations; patch preserves unrelated work and does not commit |
| Environment | `observe`, `plan`, `realize`, `verify`, `reconcile` | Native pak/renv, isolated libraries, explicit verification and activation |
| Environment material | `retention`, `cleanup`, `cleanup_status`, `restore_cleanup`, `purge_cleanup` | Preview/fingerprint checks, quarantine, restore and explicit permanent purge |
| Local process | `process.run_local`, `process.reconcile` | Program/argument vector, exact bounded streams, cancellation and tagged-process recovery; works without R |
| Configured remote | `process.run_remote`, `slurm.submit`, `slurm.snapshot`, `slurm.reconcile`, `slurm.request_cancel` | Native remote/job identities; connection loss is not proof of job termination |

### Workspace and file bounds

Workspace snapshots list at most 200 bindings. Vector previews support at most
100 items; ordinary data frames at most 20 rows and 10 columns. Classed objects
may expose only metadata. Busy/unavailable observations carry source, time and
completeness rather than fabricated values.

`workspace.help` accepts `topic`, optional `package` and bounded `max_chars`.
Lint/format accept up to 64 KiB of code; lintr/styler must already be installed.
They do not evaluate the supplied program or edit files. Help avoids dynamic Rd
execution; lint avoids project `.lintr` configuration. Format output over 128 KiB
fails instead of returning a truncated program.

File pages contain exact byte arrays, at most 64 KiB per page, with optional
`expected_sha256`. Hashed file observations are bounded to 64 MiB. Snapshot requests
allow up to 64 paths and 200 entries. `project.list_directory` lists actual files
including ignored data and reports when its bounded scan is incomplete.

Use `project.apply_patch` with a unified `patch` and native preconditions:

```json
{"kind":"file.sha256","subject":"analysis.R","expected":"sha256:<digest>"}
```

A null digest requires absence. `git.head` can name the expected project commit.
Host-owned data and disallowed/symlink-traversing paths are excluded. External
editors are not locked; partial or unconfirmed writes retain recovery observations.

Output logs are bounded to 1 MiB/4096 events per run; originals to 16 MiB per image
and 32 MiB of images per run. Read original content with the returned reference,
offset and bounded page size. Missing or changed originals produce explicit errors.

### Environments and cleanup

Use `environment.plan` with `{"manager":"pak","packages":["local::pkg"]}` or
`{"manager":"renv","lockfile":"renv.lock"}`. Realize with `plan_operation_id`,
then verify with `realization_operation_id`. Source/lock/library references are
checked against native content and scope. Keep application data outside a local
source package to avoid self-containing builds.

Verified libraries are `available_not_active`; an existing R session is unchanged.
Start a new Ark Host with `--environment <realization operation ID>` to reverify and
activate the library. Explicit package operations write isolated libraries rather
than modifying the user's existing library. Package scripts still have native OS access.

After a crash, invoke `environment.reconcile` or `process.reconcile` with the original
terminal `operation_id`, a new client request ID, and the same project/data context.
Cleanup checks observed ownership and retained markers; an old PID or missing
reference is not proof that termination is safe or complete. Reconciliation does
not roll back effects or replay the original action.

For environment staging, query `environment.retention` by source `operation_id`.
`environment.cleanup` requires its `expected_fingerprint`; `cleanup_status` reads
by `cleanup_operation_id`. Restore/purge use that ID and the current trash
fingerprint. Only eligible failed/confirmed-cancelled staging is collected.
Successful, uncertain, active or unobservable references are protected. Purge is
irreversible; original operation records and native recovery markers remain.

### Remote execution

Supply an existing OpenSSH alias with `--remote-host ALIAS --remote-root /absolute/project`;
add `--slurm-cluster NAME` for Slurm. Host startup does not connect. OpenSSH owns
credentials and host-key verification; unknown/changed host keys are not accepted
automatically and there is no password prompt.

`slurm.submit` takes Bash `body` and optional explicit resource fields such as
`cpus`, `memory_mb`, `time_minutes`, `gpus`, `partition` and `account`. Version 1
uses one node/task allocation. The result is a submission receipt, not completion.
Snapshot/reconcile/cancel use `submission_operation_id`. Lost receipts are reconciled
through a unique native job reference without resubmission; missing/ambiguous
accounting is not proof of absence. Cancel acknowledgement is separate from
scheduler terminal state.

Opt-in live verification requires a chosen host and empty writable shared scratch:

```sh
node scripts/test-remote-live.mjs HOST_ALIAS /absolute/empty/shared/scratch CLUSTER CPU_PARTITION
```

It submits two real CPU jobs and cancels only its own receipt-loss test job. It
retains evidence and is excluded from default CI. Inspect original operations/native
references after failure instead of resubmitting blindly. See [Status](STATUS.md)
for the actual tested scope and [Development](DEVELOPMENT.md) for local fixtures.
