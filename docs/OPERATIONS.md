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
Unix URL files use mode 0600. Ctrl-C stops the server, drains accepted work and then
ends the R processes this Host started; an exiting Host cannot leave them reachable,
and they are not reattached by a later one. Closing a browser page cancels nothing and
leaves R running.

### Open the bundled demo

The welcome page's **Open Rho Demo** action materializes a writable copy of the
Gapminder example under the user's Rho data directory and opens it like any other
project. Existing files in that copy are preserved. The same path can be opened
from the command line:

```sh
target/debug/rho --demo-project workbench
```

Set `RHO_DEMO_PROJECT=/absolute/path/to/demo` to choose a development or test
materialization path. The project includes base-R scripts, provenance, an optional
Quarto source file and a generated HTML report workflow. Opening it does not run R,
install packages or contact an Agent; run `run_demo.R` explicitly to create live
objects, plot output and Viewer evidence.

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

Recovery copies need one more explicit acquisition: the private native component
built for the exact R that will use it. A launched Workbench discovers it at
`<ark directory>/recovery-components/<r_version>-<platform>/`, or accepts an absolute
path through `--checkpoint-helper`. Install it with
`node scripts/bootstrap-recovery-component.mjs --ark /absolute/path/to/ark [--r /absolute/path/to/R]`,
which builds through `scripts/test-r-checkpoints.mjs`, rewrites the manifest to the
installed location and publishes the component last so a partial copy is never
loadable. Without it no recovery copy is written, so a session that had activity
returns as `Needs attention` instead of continuing. Opening a catalog or capturing a
copy never invokes a compiler or installs anything.

A managed project Host owns one R binding per session, so selecting R here records
the default used by sessions created afterwards. It never drains or replaces the
running Host; running sessions keep their own binding and memory. Asking this
endpoint to end a session is refused and points at stopping that session
individually. An invalid candidate is rejected by probe before anything is recorded.

A Host without managed instances keeps the older behaviour: changing R requires an
explicit acknowledgement that session memory ends, active requests/work and attached
MCP sessions prevent switching, and failed startup retains its diagnostic while
providing a project without R where possible; it does not restore the ended memory.

CLI `invoke`, `session` and stdio `mcp` use explicit runtime flags. Omitting R flags
there selects Project/Process-only hosting; `--rscript /path/to/Rscript` adds
Environment capabilities without live R. `--demo` is a test-only fake runtime and
is not accepted by the workbench.

## Manage R sessions and recovery copies

Open **Session → R Sessions…**, or use the R status disclosure. Selecting a row
inspects that session without changing the execution target. Overview opens scoped
Console/Objects views; Runs separates active work from its waiting queue. A view can
follow the execution target or be pinned to one session. Closing management preserves
editor and Console drafts. Below 720 px, use the session list, detail and Back path.

**New R session…** uses an installed R and an existing environment, verifies the
launch, and changes the target only when ready. It also works after saving a default
R on a Host opened without a session; a Host restart is unnecessary. Choosing a
stopped execution target continues it before accepting new R work.

Recovery copies show exact counts, full object coverage from the original operation,
pinning and storage. **Restore in new session…** leaves the source session available.
An explicitly chosen matching installation still undergoes version, architecture
and package/environment validation. Unsupported graphs remain excluded. R's base
`deferred_string` storage is supported, including ordinary character/factor predictor
models; an unknown provider is not called during classification.

**Runtime & recovery** edits App, Project or Session settings per field. Reset removes
that scope's override and reveals the inherited value. Turning recovery off retains
existing copies. A session cannot raise a project or global storage limit.

**Restart R…** starts empty memory in the same binding and a new continuation lineage.
**Stop session…** normally saves a fresh copy first; partial coverage remains visible
and requires an explicit loss choice. **Quit Workbench…** first synchronizes drafts,
cancels waiting runs, waits for active work to end, saves supported objects and confirms
local R termination. A stopped Workbench can reopen and auto-continue its saved work.
Closing the window alone leaves the Host and R running. Raw Ctrl-C/server termination
still drains native processes without guaranteeing a fresh copy; use the Quit panel
when current object protection is required.

## Work with scripts and outputs

| Action | Current behavior |
| --- | --- |
| Open | Browse the real project filesystem, including Git-ignored data, or enter a relative file path |
| Save | Apply a bounded patch with the original file digest and verify the resulting bytes; no Git commit |
| Run selection/current line | Execute selected text, or the current line when selection is empty; no automatic save |
| Run File | Capture the text, save and verify it, then execute that snapshot; later edits remain dirty |
| Format | Invoke native R tooling; apply only if the document still matches, otherwise offer comparison |
| Inspect objects through Host | Read immediate values/shapes, expand containers, or open a dedicated grid in the editor area; page and sort/filter supported tables against one observation; unsupported classes remain metadata only |
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
Execution outcome still comes from the Operation record. CPU and memory metrics cover
known Ark/R processes, not every descendant or inferred UI activity. The status
bar's customization button (or Local R menu) can pin R CPU, R memory and Project
disk individually. Disk usage describes the filesystem containing the project;
its details include capacity and available space. Preferences survive refresh.
Unavailable or stale measurements remain unknown. Older running Hosts without the
storage capability need a separately authorized restart before they can supply it. The current
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

Full-column groups collapse to a side rail; stacked groups collapse to their tab bar. Restoring a window preserves that state.

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
MCP schemas omit Rust numeric-width `format` annotations (such as `uint16` and
`uint64`) that JSON Schema clients can report as unknown. Types, numeric bounds,
references and required fields are preserved; Host validation uses the original
capability contracts. This avoids schema-warning floods during Kimi startup.
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
`operation.commit_status`, `operation.reconcile_commit`, `workspace.respond_input`
and `operation.events`. Existing bare MCP aliases use
the same contracts and owners. `operation.events` returns an explicit continuation
page; the legacy `rho.events.poll` projects that page to its original event list.
Events are cursor pages, not a push-delivery guarantee.

If a command reports `CommitPending`, keep its original OperationId. Query
`operation.commit_status@1` with `{"operation_id":"..."}`. `volatile` means the
result is retained only by the current Host; `durable` means its exact candidate
is stored, while scientific facts are still uncommitted. A normal close remains
blocked while a live result needs reconciliation. Do not replay the calculation.
After the storage issue is resolved, submit the returned `reference` through the
Host request `{"method":"reconcile_commit","params":{"reference":...}}`
(or the MCP tool `rho.operation.reconcile_commit.v1`). This checks the original
project, principal and capability scopes and returns the original terminal record.
An exact repeated reconciliation does not execute native work or write another
terminal event. `committed` confirms that digest's terminal receipt; `unavailable`
means a terminal record has no retained commit receipt, not that replay is safe.
Standalone query-only observers expose status, but no reconciliation control and
no visibility into another Host's volatile memory. A surviving durable candidate
can be reconciled after a Host restart even when its plugin provider is absent.

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

Open **Agents** in the Studio app bar, Panels menu or command palette. The singleton
panel opens on the right, or joins the inspection group in a narrower window.
**New task** selects a runtime; model and reasoning controls stay with the message
input. For a native Agent, its first Send creates the native session. Each task has its own draft,
model choice and connection. A running task accepts a next draft, with no send queue.
Closing, moving or refreshing the panel does not stop the Agent.

Permission modes reflect the chosen Agent's actual catalog. Action-specific requests
appear immediately above the input; their native options stay in order. Top-bar badges
remain while the panel is closed. **+**, attachments and **@** add images, UTF-8 files
or previewed component information. Choose the inclusion scope before adding it;
changed or expired sources require another preview. Native task limits are 8 MiB per
attachment and 32 MiB/64 attachments per task; Rho has the smaller text/image input
limits described below. Unsupported inputs get an explicit error.

All project windows share tasks; only the controlling window edits or sends.
Use **Take over** for an idle task. If its operating window is gone while work is
running, **Stop Agent and take over** waits for confirmed native quiet. Unconfirmed
stops preserve the previous owner and block another writing connection.

Host restart leaves tasks disconnected. **Resume** restores the same native session
explicitly, refreshes its Host MCP configuration and sends no prompt. Read prior
uncertain receipts before issuing a fresh instruction. Draft and history survive;
R memory does not. Codex provides native history pages; Kimi replays native context
history with possible omissions; DeepSeek shows the bounded Rho observation cache.
**Session details** identifies the native session and history source. A missing
native session/capability never causes automatic creation of a replacement.

The gear opens **Agent Settings** for CLI discovery, model catalogs, explicit setup,
manual MCP details and independent **Test** diagnostics. Test never uses a task's
analysis session or adds a task. CLIs must already be installed/authenticated.
Opening the Agent panel performs no discovery, installation or model request.
**Stop Agent** and **Disconnect** concern native work only; they do not establish
cancellation or rollback of scientific operations already accepted by Rho.

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
| Read-only package help | `workspace.read_help` with the same observation/copy and index file identities; follow its UTF-8 continuation and help-file identities without creating an Operation |
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
For a read-only query use `workspace.read_help`: provide `expected_session`,
`observation_id`, `package`, `library_path`, `topic` and `expected_index_files` from
the package index. Its `limit_bytes` is 4–32768; `next_reads` retains UTF-8 offsets
and `expected_help_files` for continuation. Missing resident help providers stay
unavailable, and changing package/help files invalidate the read.
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

The ordinary Environment package exposes the same material actions at version 2
through an exact provider binding. Select its optional reference-read capabilities
when activating the instance; see the [package instructions](../plugins/environment/README.md).
An ordinary R provider must be available when selecting `r.session` and `r.snapshot`
grants, but activation need not start its R session. Missing grants or incomplete
reference coverage keep materials retained. Re-query after R work settles or a
namespace is explicitly unloaded; removing a directory from `.libPaths()` does not
unload its namespaces. A previous instance's material is accessible only through
its original authorized operation and the same native storage context. An
unconfirmed quarantine must be inspected by its original cleanup ID before any
further action. Recovery contracts not yet migrated to ordinary plugins remain
unknown and retain their materials.

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

## Built-in component assistant

Use **New task → Rho** in the shared **Agent** panel, or **Ask about…** from
Objects, Packages, Plots, an open document, Console, Files or R Sessions. Rho and
native Agents share the task list, active/archive navigation, conversation layout
and composer. Ask adds previewable context without switching an existing task's
Agent or changing an accepted run's target.

Configure the project connection under **Settings → Agents → Rho**. Enable Rho,
choose Anthropic Messages or OpenAI Chat Completions, and enter the service base URL,
model ID and API key. HTTPS is required except for HTTP loopback services. **Save**
retains the key across restarts and the UI shows its saved availability without
returning the raw value. The key can be replaced or removed. Environment-variable
references remain optional; the variable must exist in the Host's environment.
Existing Session references keep their older memory-only behavior and may need a
new saved key after the Host restarts.

New keys live in `rho/model-credentials.json` under the user's configuration directory:
`~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and
`$XDG_CONFIG_HOME` or `~/.config` on Linux. This ordinary local JSON file is outside
the project. Project settings and conversation records store a reference. Removing
or replacing the key affects new submissions; already accepted work retains its
captured key. Disabling Rho is the separate control for stopping its active work.

Save the connection before explicitly testing it. **Test connection** and **Test
image input** use synthetic content. Chat and Test share at most 10 admitted requests
and 2 executing requests; only one Test can be admitted at a time. Opening the panel,
viewing settings, uploading a file or inspecting a test result sends no model prompt.

Preview selected sources from their chips and use **@** to add owner-backed context.
Objects retain their native observation; scientific plot images retain their original
media reference. Image input requires a successful image test for the exact saved
connection. A plot's summary sends metadata instead. Rho also accepts actual uploaded
UTF-8 text files (up to 32 KiB), PNG and JPEG images (up to 2 MiB each), including
clipboard images. Attachment and scientific-source identities stay distinct. A request
allows at most 16 sources/attachments in total and 2 images; text context remains
bounded. Removing a chip from the next draft does not change an accepted request.

The composer selects **Ask**, **Auto approval** or **Full access**. Rho decides what
to explain, edit or execute from the request. Ask reuses explicitly requested work;
new additional actions require a concrete decision. Auto also permits its stated
rules for project document work and execution in the bound R session. Full access
permits other supported actions within the same project, document and session
checks. No separate model reviews approvals, and the scientific owners do not ask
again after authorization. Explain/Edit/Run and per-document Allow saving are not
front-end work modes.

A task can open an existing project script or create a new one without first adding
it as context. Its exact path and native document reference are recorded through
the document owner before edits or saves. Execution uses the accepted R-session
binding, independently of the currently selected Console; missing or changed native
sessions are not silently replaced. Package inspection stays read-only, while
requested R analysis may use already installed packages. Package installation and
environment-management boundaries still apply.

**Scientific work** shows the original Operation status and target, independently
of Agent Ready or response completion. Original plot links use owner-verified media.
Native task views request a bounded recent observation; older shared-caller tasks
show unknown attribution. Usage displays only reported source/scope values; missing
counts stay Unknown and totals are not added together across repeated observations.

**Stop** requests cancellation; **Check status** reconciles original work. Once
original actions are resolved, enter a follow-up and explicitly **Continue** within
the recorded task scope. Continue retains the frozen original intent and reuses
confirmed results. Applied document Open/Create commands can recover their owner
references even if the component result acknowledgement was lost. Unrelated later
document changes require a fresh request. An unknown submission retains its original
identity; checking it does not replay it automatically.

Ordinary follow-ups use bounded saved conversation text and owner references; they
do not automatically inherit prior authorization. Full drafts retain text, sources,
attachment IDs, permission choice and R-session selection across panel navigation. Another window is read-only until **Take control**;
conflicting drafts remain available for comparison. Archived tasks need unarchiving
before new input/configuration work; accepted runs retain Stop and permission
responses. The shared panel supports narrow, normal and wide layouts.

Use the task menu's **Prepare handoff** to review a Goal/Confirmed/Next draft and
its original references, then choose another task in the same project. **Add to
draft** appends the reviewed text and merges references while retaining the target's
existing text, attachments and permission settings. It does not send to a model.
A source task can be archived or controlled by another window; the target must be
editable in the current window. Uploaded source attachments stay in the source;
add any needed files separately to the target task.

If the target draft changed, review the fresh draft before adding again. Refreshing
the source/target keeps edited handoff text and deliberate reference removals.
If confirmation is lost, **Check receipt** reads the original request's result;
only an explicit retry uses that same request. Stale or incompatible source
references must be refreshed in their original source, removed, or used with a
compatible target. Handoff never rewrites window/session identities to bypass a
reader check.

## Plugin package recovery CLI

The new plugin repository is separate from scientific project storage. Core
package recovery does not require a project, an R installation, or the plugin
management interface. No command below starts a scientific Host or loads plugin
code. The default store is `plugins-v1` beside the configured `--database`,
matching active Host composition. With the default database on macOS this is
`$HOME/Library/Application Support/rho/plugins-v1`; `--store` overrides it.
Use an explicit disposable store for development:

```sh
rho plugins --store /tmp/rho-plugin-test list
rho plugins --store /tmp/rho-plugin-test instances --limit 20
rho plugins --store /tmp/rho-plugin-test snapshot /path/to/plugin --target ui-web
rho plugins --store /tmp/rho-plugin-test inspect sha256:EXACT_REVISION_DIGEST
rho plugins --store /tmp/rho-plugin-test export sha256:EXACT_REVISION_DIGEST /tmp/example.rho-plugin
rho plugins --store /tmp/rho-plugin-test validate /tmp/example.rho-plugin
rho plugins --store /tmp/rho-plugin-test import /tmp/example.rho-plugin
rho plugins --store /tmp/rho-plugin-test branch sha256:EXACT_REVISION_DIGEST my-controls
```

`instances` reads retained lifecycle records, including failed initialization,
disconnect and cleanup diagnostics. Its `live_verified: false` explicitly means
that stored state is not a live process observation. It does not reconnect, reuse
an old PID, restart a backend, release an uncertain reference or replay work.

Replace the digest placeholder with the full identity returned by Snapshot or
List. Snapshot captures declared source plus existing `dist/` output; it does not
run the declared build command. An unbuilt checkpoint can be stored but cannot
be activated. Export refuses to overwrite an existing destination. Import is
idempotent for identical immutable content and does not grant additional scopes.
List leaves an absent repository absent. The repository never reads an old Rho
project database or automatically reinstalls removed delivered packages.

`remove REVISION` lists protecting instance, operation, management, document, scenario,
checkpoint, dependency and branch references instead of deleting a used revision.
`branch-head BRANCH` reads a branch; `advance-branch BRANCH EXPECTED NEXT` uses
compare-and-swap and requires NEXT's parent to be EXPECTED. This changes a branch
pointer, not a running instance or selected scenario. Builds, scenario application
and full Plugin Studio integration are tracked separately in Status.

Active Hosts expose `plugins.repository`, `plugins.list`, `plugins.inspect`,
`plugins.instances`, `plugins.instance`, `plugins.resolve`, `plugins.branch_head`
and `plugins.compare` as bounded queries. The repository query reports the exact
store and native artifact target. Package viewing does not start code. Instance
lists show only the caller's project/principal; `observed_in_this_host` must be
read together with lifecycle state, and does not itself establish process liveness.

Source development uses the same ports. `plugins.source_tree` accepts an exact
`revision`, exclusive `after` path and `limit` of 1–100. `plugins.read_source`
accepts `revision`, `path`, byte `offset` and `limit` of 1–65,536; it returns the
file metadata, base64 bytes and `next_offset`. It checks the full file digest
before returning any slice, so repeated pages of a large file repeat that
verification. These source ports cannot read `dist/` artifacts. `plugins.branches`
takes a `plugin`, optional exclusive branch cursor and a 1–100 limit; origins
without recorded evidence stay null.

`plugins.check_source` and `plugins.checkpoint` take `CheckpointPlugin`: a branch,
its `expected_head`, and a map of path edits. `put` supplies `content_base64` and
an explicit executable flag; `remove` deletes an existing source path; `copy`
reuses a source `revision`/`path`, including binary or larger retained files.
One request allows 128 edits and 128 KiB of decoded inline bytes, within the
256 KiB argument limit. The resulting tree must match the manifest declarations
and satisfy package/schema/visual-document validation. This check does not
compile TypeScript or run a build. `check_source` only reports a proposed identity;
`checkpoint` saves a source-only child and advances the expected head in one
transaction. Failed validation or a stale head preserves the old branch. Retain
a stable request ID and recover the original Operation after an unconfirmed
save. Neither operation copies old artifacts onto the new source or applies it.

`plugins.activate` accepts an installed revision, artifact, target, alias and
configuration through the normal Operation port. It validates configuration and
all declared grants against existing caller authority before admission, waits
for exact readiness, then publishes the backend's complete capability batch.
A UI-only manifest uses target `ui-web` and creates no native process.
Use `plugins.resolve` to select a provider and pass the returned `binding`,
scientific `arguments` and native `preconditions` to that capability. Multiple
matching instances require explicit selection. No package origin gains extra scope.

`plugins.release`, `plugins.remove`, `plugins.branch`, `plugins.advance_branch`
and `plugins.reconcile_references` also use normal Operations and stable
`client_request_id` values. Release drains accepted work; an error does not prove
cleanup. Reconciliation takes the original terminal `operation_id`. For a live
backend it resends only the original journal's terminal settlement and awaits an
exact acknowledgement before retiring protections. A pending acknowledgement does
not change an already committed scientific result. Retain the original operation
ID; after observing a completed but unsuccessful reconciliation attempt, use a new
client request ID for another explicit attempt. No scientific execution is repeated
and no disconnected backend is restarted. The CLI recovery interface still
handles archive import/export and source snapshots; active Host build/import
flows remain part of the ongoing Plugin Studio work.

The ordinary management UI is assembled with
`node scripts/build-manager-plugin.mjs DEST`, using a new directory outside the
checkout and existing build tools. Snapshot/import it through the same package
CLI, activate its exact `ui-web` artifact, and open contribution `manager` with
configuration/state `{}` through `windows.open_view`. For an existing window,
provide an observed tab-group ID and layout version. The manager has no private
Host token, database access or delivery privilege; its explicit delegation scopes
must fit the activating caller's authority.

In Scenarios, Review captures the current window version. Choose an exact existing
instance or create a new one for each alias, and choose live view state or saved
checkpoint state for each view. Prepare creates missing instances/views and
validates the complete mapping; Switch applies it atomically. Failed preparation
does not release what it already prepared or replace the current composition.
Review a new switch after an intervening layout edit. Hidden views observed by
this manager remain reusable (up to 256 retained view identities); selecting a
checkpoint does not implicitly recreate a missing provider or release old work.
Saving a checkpoint advances only its expected scenario head. Edit an older
checkpoint and save to create a new child of the observed current head.

Original unresolved management requests remain visible and block a second mutation
in that view. Inspect the original request to refresh its outcome; recovery never
continues later preparation steps automatically. Only the original view can retry
the same captured request. A replacement manager can inspect the original record
but cannot reissue it under a new identity. Read-only inspection and navigation
remain available. Package import/export and full Studio development still use
the CLI or remain tracked implementation work; see Status.

The ordinary R package exposes `r.console` for current/pending original operations,
pause identity and `awaiting_commit`. Copy `r.session.queue_target` into the query's
`expected_session`. Queue controls `r.pause_queue` and `r.resume_queue` take that
same identity as binding target and `session_id`, the observed `pause_id` (null
when unpaused), and optionally every affected `only_operation_ids`. Pause does
not interrupt a running evaluation. Failed or cancelled work leaves a fresh pause;
inspect its original result before resuming. A pending native item can be cancelled
without execution. A result awaiting journal commit must use original commit
recovery first; resume cannot confirm it. These controls also work before R exists
and during draining. No query/control creates or reconnects a session.

Use the shared `operation.request_cancellation@1` Control with the original
`operation_id` and `only_if_pending: true` to cancel a queued native run. A backend
that supports this first reserves the still-waiting invocation, then the Host records
the request and signals cancellation. An already-running run is refused; use an
explicit Interrupt (`only_if_pending: false`) if intended. A lost preparation reply
or journal write failure leaves `r.console.pending_cancellations` visible. Retry
that same original cancellation; queue resume cannot clear its fence. A cancellation
receipt still does not prove native completion or rollback.

The ordinary Console package is assembled with
`node scripts/build-console-plugin.mjs DEST`, using existing locked dependencies.
Its `console` contribution takes `{"source": InstanceRef}`. The view reads that exact
R instance and retains its own command draft/history; it never creates R while
reading. Start R is an explicit action. Stdin answers remain transient and separate
from the next command. Full integration and acceptance status are recorded in Status.

Use `r.execute@2` for code with an optional source label and Console output mode:
its arguments are `{"expected_session": SESSION, "run": {"code": CODE,
"output_mode": "console", "source": {"view_id": VIEW, "label": LABEL,
"kind": "console"}}}`. Resolve version 2 explicitly. Console mode prints each
visible expression through the native output stream; source labels are retained
with the original request/result and do not prove a synchronized document capture.
Version 1 keeps its code-only input. `r.check_code` takes the exact session and code
and refuses to compete with queued or unsettled work. `r.output_events` takes the
exact session, original `operation_id`, `after_sequence` and `limit` (1–100).
Continue from the returned sequence; a page may stop earlier at its encoded-byte
budget. While R runs, an empty current page is not completion. Read original
Operations and retained resources after backend release, without recreating R.

The JSON session edge admits up to 32 execution, 16 query and 16 control requests
concurrently. Saturating one pool does not consume another pool's capacity.
Duplicate in-flight request IDs and pool overflow are rejected before dispatch.
EOF stops admission and drains every accepted request.

`views.open` takes an exact `instance`, declared `contribution`, `window`,
`configuration` and schema-valid initial `state`. It returns a durable view ID.
`views.inspect` reads it, and `views.connection` returns only an already-live
connection. The generic standalone container opens through the private Workbench
URL with `window=WINDOW_ID&plugin-view=VIEW_ID` query parameters; keep the launch
credential only in the normal private URL fragment. This is also the conformance
surface for the public UI SDK. The returned view must belong to that window.
`views.update` uses `expected_version`. `views.close` defaults to waiting for each
registered document to flush and acknowledge the same final view-state version.
It then atomically closes the record, removes its tab and releases only its view
reference. A refused or unanswered preparation leaves the view open; accepted
backend work continues. Do not remove its iframe until the original close
Operation confirms success. A lost reply is not a confirmed close.

For a document lost to reload/navigation or a view with no handler, inspect
`views.inspect` and explicitly close with
`{"view":"VIEW_ID","mode":{"kind":"retain_acknowledged","expected_version":N}}`.
This checks and retains version N; it does not save a disconnected document's
local edits. Do not automatically substitute this recovery mode for a failed
flush. Close retained views before releasing an instance. After a Host restart,
historical closed records and layout placeholders retain acknowledged state;
reading them never reconnects them. Management and Studio interfaces remain
pending ordinary plugins.

These ports are shared by connected CLI, HTTP and official MCP. An existing MCP
connection receives tool-list change notifications when providers appear,
disappear or fail. A changed catalog invalidates its old page cursor; restart
listing without a cursor. Existing accepted records retain their original contract
and remain readable using `operation.get` after their provider is removed.

Retained plugin output bytes are available through `resources.list`,
`resources.inspect` and `resources.read` on the same Query port. All require
`resources.read` scope and the original project/principal; possession of a
reference is insufficient. Lists accept an optional exact `owner`, optional
`after` resource ID and a `limit` of 1–100. They expose completed retained bytes,
including uploads whose acknowledgement was lost. Inspection takes `reference`
and verifies its complete content. Reads take `reference`, a byte `offset` and
`limit` of 1–262144, returning base64 bytes and the next offset or null at EOF.
These reads work after provider release and Host restart without activating code.

The ordinary Viewer package can be assembled outside the checkout with
`node scripts/build-viewer-plugin.mjs DEST`. It includes only its source and public
SDKs and uses an existing TypeScript compiler. Snapshot the resulting directory
under target `ui-web`, activate the exact revision/artifact, then open contribution
`viewer` with configuration `{"source": INSTANCE_REF}` for the producing R owner.
Different views can retain different source instances and revisions. History,
refresh and source inspection read original terminal Operations and verified
resources; they never start R. A nested sandboxed frame displays saved HTML,
including retained local widget dependencies. Selection is stored in the view's
normal versioned state. Presentation is limited to 16 MiB per document and 200
outputs per view, with explicit paging for earlier runs. Live web services are
not recreated. The standalone container is available; scenario/layout integration
and the complete Studio workflows remain under implementation.

Backend initialization includes an instance-only resource channel for uploading
bytes independently of control messages. Files are limited to 256 MiB, with four
simultaneous transfers per Host; retained limits are 512 MiB per instance and
2 GiB / 16,384 resources per store. Quotas preserve existing bytes and report
rejection. There is no automatic eviction of historical evidence. Immutable UI
asset delivery uses the separate generic view container; disposable development
previews and the complete approved Studio interactions remain under implementation.
