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
| Inspect objects through Host | Filter/page binding observations, open exact object references and continue values, rows/columns, lists or text; unsupported values remain metadata-only |
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
projects, preferences, window command/capture receipts, method bindings, Skill-read
receipts and unconfirmed request IDs. Browser session storage retains
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
Query and application-control tools accept their capability arguments directly.
Scientific operation tools accept:

```json
{"client_request_id":"unique-action-id","arguments":{"code":"x <- 21; x * 2"},"preconditions":[]}
```

Successful results use `structuredContent.result` and an accompanying text encoding.
Errors include typed diagnostics; failed/uncertain operations retain their identity
and outcome. `rho.output.view` additionally returns native image content and an
original/manifest resource link, without duplicating image bytes in text metadata.
The shared descriptors include `operation.get`, `operation.request_cancellation`,
`workspace.respond_input` and `operation.events`. Existing bare MCP aliases use
the same contracts and owners. `operation.events` returns an explicit continuation
page; the legacy `rho.events.poll` projects that page to its original event list.
Events are cursor pages, not a push-delivery guarantee.

The local MCP actor and human caller share the OS user's principal while retaining
separate actor identity. Tool arguments and client initialization names do not
grant authority. The Agent platform owns conversation and permission behavior.

Authenticated `GET /api/agent-connection` reports the selected project's MCP
endpoint, a port-qualified suggested Codex server name, observation time, open
protocol-session count and bounded recent sessions. It returns no bearer token or
private MCP session ID. Ordinary Studio/CLI reads do not count as Agent sessions.
Rows include client-reported name/version, the last request time, protocol closure,
and successful overview/live-window response times. Those response observations
are not delivery acknowledgements. A quiet open session can outlive its network
connection, and closing it does not cancel accepted work. New project/R Hosts
start fresh observations.

Open **Agents** in the Studio app bar or **Session → Agent Settings…**. The settings
page keeps the scientific workspace mounted. Installed Codex, Kimi and DeepSeek Harness CLIs expose
their own model list and supported reasoning choices. Select a model and click
**Connect**, or **Test** to connect and request a minimal `ok` response. Then enter
a task in the connected card. The current project, window and Rho MCP connection
are supplied to the native session; no configuration or prompt copying is needed.

The CLI must already be installed and authenticated. Discovery reads native
metadata without calling a model; a listed model can still be unavailable because
of that provider's account, quota or network state. Errors are displayed in the
card. **Rescan** refreshes local availability. Native tool permission requests
remain native decisions and appear as buttons in the conversation. **Stop Agent**
requests interruption; **Disconnect** closes the owned native client. Neither
implies cancellation or rollback of work already accepted by Rho.

Codex uses app-server; Kimi and DeepSeek Harness use ACP. Settings and conversation history remain
with the native CLI. Rho keeps a bounded live display and does not write the
CLI's user configuration. New turns require the current synchronized window.
After an uncertain response, inspect the retained native session instead of
resubmitting the same task. A lost connection acknowledgement reuses its original
request identity.

For an older DeepSeek launcher without ACP, choose **Install connection component**
once. Rho installs pinned official `@deepseek-ai/dsh` and `dsh-acp-app` packages
(`0.1.2-alpha.2`) in its application-data `rho/agent-components` directory. The
global `dsh` is unchanged. Node.js and npm must already be installed. Setup has a
three-minute npm timeout, retains the package lock, and is safe to retry after a
lost HTTP acknowledgement. No package installation runs merely to discover models.

DeepSeek launches with private copies of `settings.yaml` and `.credentials.yaml`
from `DSH_HOME` (default `~/.dsh`). Its native loader may update these temporary
copies to its current format; originals are preserved. The component does not copy
other profiles or `.env` files. Native conversations and attachments remain under
the versioned component data directory after temporary configuration is removed.
`RHO_AGENT_COMPONENTS_DIR` selects an absolute component root for isolated tests.

For an external client, open **Advanced: manual MCP setup**. The preview masks the
token; the explicitly copied block contains the actual local credential. Reload
that client's MCP servers after configuring it. Replace the entry for this
Workbench after a restart changes its endpoint/token.

**Copy connection check** prepares a read-only task containing the project and
this window's exact incarnation. Send it in that external client. The **Connections** tab reports
the observed protocol session and whether Rho served this window's context.
Copying setup is not reported as connected. Read failures label old observations
as stale and disable credential/context copying until refreshed. **Another agent**
provides the same endpoint and Authorization header as generic connection details;
use the configuration format required by that MCP client. Editor and R settings
remain available in the settings rail. See the approved
[interaction design](RHO-DESIGN.md#12-agent-connection-experience).

## Discover and investigate through the shared Host

Use `host.overview` for project, session, execution and window summaries;
`host.catalog` filters modules/keywords with pagination; `host.describe` explains a
capability's arguments, result structure, prerequisites and related reads. In MCP
these are `rho.host.overview.v1`, `rho.host.catalog.v1` and
`rho.host.describe.v1`. Unavailable modules retain a reason. Overview components
have independent timestamps and completeness.

A standalone `query` opens a query-only observer. It reads project files and an
existing journal/output store without creating a database, acquiring a writer or
project lease, recovering unfinished operations, or starting R. A missing journal
is unavailable, not an empty history. This works while a live Host owns the project:

```sh
target/debug/rho --database /absolute/path/to/state.sqlite \
  --project /absolute/path/to/project query --capability host.overview
```

The observer does not attach to live R, Application state or Skill-read receipt
storage. Use `--connect-url-file`, the existing session or Workbench MCP for those
owners. Runtime/remote/Skill-source startup flags are rejected by standalone
`query`. Explicit Host startup still requires its own project lease. Keep returned native
identities, content hashes and continuation arguments together. `next_reads` points
to additional evidence, not commands to execute automatically. On expired/changed
observations, reopen deliberately; do not join pages from different versions.

| Investigation | Entry and continuation |
| --- | --- |
| Live objects | `workspace.list_objects` → `observe_object` / `read_object`; bind `expected_session`, retain directory/object reference and structured path |
| Saved project text | `project.read_text`, `project.search_text`; retain file identity/hash and returned continuation, including long-line fragments and scan pages with zero matches |
| Installed package copy | `workspace.packages`, then `workspace.package_index` with observation, native session, package and exact library path |
| Help evidence | Explicit `workspace.help`, then `output.read_text` using its `text_reference`; later pages do not render help again |
| Image evidence | MCP `rho.output.view` or shared `output.view`; crop in original pixel coordinates and keep the original reference |
| Execution/recovery | Original operation record, output events and owner-specific status/retention reads; accepted or cancellation-requested does not mean completed/stopped |

## Read and control a Studio window

Studio keeps the nonsecret `window` reference in its document URL. When resuming
that window after a Host port change, retain `?window=...` and use the new Host's
launch token. A plain new launch URL opens a separate window identity. Rho never
chooses another window's drafts implicitly; discover window identities with
`application.windows` when the original URL is unavailable.

`application.windows` lists explicit `{window_id, incarnation}` identities.
`application.context` returns document/selection versions, dirty state and current
object/package/plot selections; `application.read_document` reads versioned draft
or base text with its expected SHA-256. Disk files do not reveal unsaved drafts.
`allow_offline: true` opts into labeled synchronized history; it does not make an
offline window controllable.

`application.control` accepts a window, stable `request_id` and a typed action:
view activation/open/close, document open/create/edit/selection, scientific-item
selection, save, run selection or Run File. Obtain resource versions from context
and inspect `application.command_status` using the original request identity.
Pending, claimed, locally-applied-unsynced, awaiting-execution and scientific step
states have different meanings. Bridge registration/synchronization and captured
execution submission are Studio-internal requests, not credentials for Agent use.

Each window renews every five seconds and becomes offline after 15 seconds without
renewal. Unclaimed commands expire after 30 seconds. Edits use zero-based UTF-16
positions in normalized editor text; draft pages use UTF-8 byte offsets. Activation
selects a Studio view without promising OS foreground focus.

Save/run use immutable captured text and the original Agent identity. Run File
requires the saved hash to match the capture before submitting R. A verified
unchanged save can have no OperationId. Later typing remains dirty. After a lost
connection, inspect the receipt and accepted operation; an unsubmitted run step
will not automatically resume.

## Standard and native-host Skills

Local discovery uses `.agents/skills` between the explicit project-relative working
directory and project root, plus `~/.agents/skills`. `skill.list` returns metadata,
source-qualified references and digests; `skill.read` reads `SKILL.md`, a resource
manifest or exact text/byte pages. Non-body resources require their expected digest
from the manifest. Body/script changes invalidate the affected observation.

The supplied methods live in `.agents/skills/rho-*`. Projects can add standard
methods there without editing Rho core. There is no `.rho/skills` compatibility
reader, copying step or package conversion. Local standard packages use standard
frontmatter validation. Host-attested packages retain the originating platform's
names, directory conventions, optional metadata and enabled/disabled/rejected state.
`allowed-tools` remains host data and cannot grant Rho scopes.

An external platform launcher may provide its actual discovered roots using a
bounded JSON manifest. This is launch metadata, not a new Skill package format:

```json
{"provider_id":"native-client","skills":[{"source_key":"plugin/method-reference","root_path":"/absolute/original/skill-directory","source_kind":"plugin","enablement":"enabled","reason":null}]}
```

`source_kind` is `project`, `user`, `plugin`, `managed` or `builtin`. Only the listed
roots are read; Rho does not search all product directories. Project sources must
stay within the selected project, and resources within their package root. The
manifest itself is Host-private. Agent tools and method bindings cannot change
its source enablement.

```sh
target/debug/rho --database /absolute/path/to/state.sqlite \
  --project /absolute/path/to/project \
  --host-skills /absolute/path/to/native-skills.json mcp
```

Manifest syntax and declared resources are checked before replacing a Host. Invalid
sources are reported without renaming, repairing or substituting a method. Existing
Skills remain in their original location and later reads verify their current bytes.

Use `application.bind_method` for an explicit choice/exclusion, with a binding ID,
new version and the expected previous version (null for creation). The CLI
`bind-method --binding JSON [--expected-version VERSION]` reaches the same control.
`host.resolve_context` reports current bindings, their resource pins, external work
references, targets and unmet conditions. Clear an ancestor exclusion at its own
scope before selecting that method below it. Host-disabled sources cannot be
re-enabled through an alias. A binding declares method use; it does not certify
scientific correctness or schedule another Agent.

## Connect the CLI to an existing Workbench

Use the private URL file created by `workbench --url-file`:

```sh
target/debug/rho --connect-url-file /absolute/path/to/private-launch-url \
  --project /absolute/path/to/project query --capability host.overview
```

The CLI reads the existing Host's project identity from `/api/info` and includes
that identity in every `/api/host` request. A supplied `--project` must match; a
project change is rejected. The URL must use a literal loopback HTTP address and
its private token fragment. The credential remains outside command output. Proxies,
redirects and automatic request retries are disabled.

Connected `query`, `invoke`, `get-operation` and `bind-method` use the same Host
ports and native owners. Storage/runtime/source configuration belongs to the
running Host; startup flags cannot be combined with `--connect-url-file`. Connect
failures do not start a local Host. After a missing effectful acknowledgement,
retain the original request ID and inspect its receipt/operation: accepted work
continues under the existing Host.

For other shared controls, `request --json` accepts a typed `HostRequest`. Replace
window/incarnation/context placeholders below with current application observations:

```sh
target/debug/rho --connect-url-file /absolute/path/to/private-launch-url \
  --project /absolute/path/to/project request --json \
  '{"method":"application_control","params":{"window":{"window_id":"WINDOW_ID","incarnation":"INCARNATION"},"request_id":"open-console-1","action":{"kind":"open_view","view_type":"console","view_id":null,"expected_context_version":"CONTEXT_VERSION"}}}'
```

This request reaches the same Application owner as browser/MCP requests. It does
not edit layout/draft storage directly or introduce another scientific execution
path. HTTP replies are bounded to 8 MiB. Long work can set `return_after_acceptance: true` on the typed Invoke request, then
query the original operation.

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
line. After the run reply, replace `SESSION_ID` below with its actual output session
identity before listing bindings:

```json
{"id":"run","request":{"method":"invoke","params":{"client_request_id":"example-1","capability":{"id":"workspace.run_r","version":1},"arguments":{"code":"x <- 21; x * 2"},"preconditions":[]}}}
{"id":"objects","request":{"method":"query_snapshot","params":{"capability":{"id":"workspace.list_objects","version":1},"arguments":{"expected_session":"SESSION_ID","name_contains":"x","limit":20}}}}
```

Replies carry the transport ID and may arrive out of order. The methods are
`invoke`, `get_operation`, `request_cancellation`, `query_snapshot` and `subscribe`.
Get/cancel use `operation_id`; subscribe uses `after_sequence` and `limit`.
Shared `respond_input`, `application_control` and `bind_method` requests use their
own typed schemas. Studio uses `application_bridge` and `application_execute`.
End stdin to drain accepted work and close the session. Exact schemas are in the
ready frame/MCP discovery and [Rust contract](../crates/contract/src/lib.rs).

## Domain capabilities

Availability depends on the selected Host configuration. Use `host.catalog` and
`host.describe` for the current registered interfaces and schemas; a capability
does not imply a dedicated Studio control. The following bounds and native
preconditions apply across clients.

### Workspace and file bounds

Object directory/value pages contain at most 200 items. Tables contain at most
200 rows, 50 columns and 2,000 cells within 256 KiB. Ordinary lists, atomic matrices,
data frames/tibbles and supported base classes expose progressive reads. Other
classes remain metadata. References expire after 60 idle seconds or five minutes,
and scientific/tool execution invalidates them before it runs. The original
`snapshot`/`inspect_object` interfaces remain bounded shallow views.

File lines and R indices start at one. Object `text_start` counts one-based Unicode
characters; file/output/Skill text cursors count UTF-8 bytes. Do not substitute token
counts or editor UTF-16 positions for these units. Busy/unavailable observations
retain their source, time and completeness.

`workspace.help` accepts `topic`, optional `package` and bounded preview `max_chars`.
`library_path` plus `observation_id` selects an exact copy; `expected_index_files`
checks the index evidence. Full text is retained once as a separate text artifact.
Lint/format accept up to 64 KiB of code; lintr/styler must already be installed.
They do not evaluate the supplied program or edit files. Help avoids dynamic Rd
execution; lint avoids project `.lintr` configuration. Format output over 128 KiB
fails instead of returning a truncated program.

File pages contain exact byte arrays, at most 64 KiB per page, with optional
`expected_sha256`. Hashed file observations are bounded to 64 MiB. Snapshot requests
allow up to 64 paths and 200 entries. `project.list_directory` lists actual files
including ignored data and returns continuation for remaining entries. Text reads
return at most 200 lines/64 KiB, splitting long lines. Literal searches return at
most 100 matches/64 KiB and separate scan progress from result counts. Continue even
when a bounded scan page has no matches. Skip records identify binary, invalid
encoding, unreadable, oversized or disallowed inputs; they do not mean that content
was read.

Use `project.apply_patch` with a unified `patch` and native preconditions:

```json
{"kind":"file.sha256","subject":"analysis.R","expected":"sha256:<digest>"}
```

A null digest requires absence. `git.head` can name the expected project commit.
Host-owned data and disallowed/symlink-traversing paths are excluded. External
editors are not locked; partial or unconfirmed writes retain recovery observations.

Output logs are bounded to 1 MiB/4096 events per run; originals to 16 MiB per artifact
and 32 MiB per run. Native image previews default to a 1,600-pixel long edge, at most
2,400 pixels and 512 KiB encoded. Static SVG previews disclose rasterization/scaling
and cannot load external resources. MCP returns originals up to 4 MiB directly;
larger originals use a manifest with 64 KiB chunks. Verify the reassembled original
SHA-256. Reads and previews share verified originals; missing or changed content
produces explicit errors.

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


## Inspect R packages in Studio

Open **Panels → Packages** in a current Workbench build. The view joins Objects
when that group exists; it can be moved, closed and reopened normally.
The list groups installed copies by package name and shows purpose and version.
Use All, Loaded, Attached or Multiple copies; search names/purposes and page results.
Select a row for inline details in a narrow panel, or the adjacent inspector in a
wide panel. Source details can select each installed copy and show recorded
repository, ref/commit, provider/URL and evidence. Unrecorded source remains explicit.
The R/library button shows the active R installation and ordered library paths.

**Refresh** captures a new observation while idle. Index pages and copy details
continue the same captured observation; during R execution the cached index remains
searchable and is labeled with its scope and original time. A source observation
can expire after other refreshes; use Refresh instead of combining different views
of native state. Viewing never starts R.

The view has no installation, update, removal, loading or library-configuration
controls. It reports bounded observations and does not infer an environment
manager. If an older running Host lacks `workspace.packages`, restart Workbench
with the current binary when ready to end that R session; a browser asset refresh
alone cannot add a Host capability.
