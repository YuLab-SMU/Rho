# Rho local backend 0.5.1

Rho selects nine independent capability packages: annotations plus documents, files, R,
requirements, tables, media, charts and Agent. Shared contracts contain generic envelopes/service ports and ordinary-file
primitives. Each resource/requirement/script schema belongs to its provider
through a pure `./contract` entry; contracts has no format registry, capability
state or catalog. Rho retains its selected schema snapshot and checks provider
parity without importing absent implementations. The reusable backend exposes `/api/v2` to calling clients and the project-scoped
stdio MCP adapter. Its sole registered execution action is `r.execute`: an
explicit project script, requirements, arguments and output declarations.
Agents normally use their native tools under existing permissions. Select managed
execution only for a concrete need for continuity or a retained application run.
`r.execute` accepts user-written R; the R action catalog does not restrict methods.
Activity observation remains independent of managed execution.
Analysis recipes and scientific checkers are external consumers, excluded from
the application and Plugins npm packages. The browser consumes the same public capabilities.
See [extraction](https://github.com/YuLab-SMU/Rho/blob/main/docs/PLUGIN-EXTRACTION.md)
and [extraction acceptance](EXTRACTION-ACCEPTANCE.md). The
[split acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) records the independent package boundary.
The [0.4 boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md) records the follow-up decoupling.
The public contract lists each owner’s HTTP operations. Current browser behavior
is documented in [Frontend](FRONTEND.md).

## Headless collaboration extension

[Collaboration](COLLABORATION.md) documents project capability configuration,
shipped Skills, live MCP filtering, conditional structured compositions and undo,
explicit view protection, caller/view/shared selections, document/table-anchored
feedback, explicit replies, context delivery facts, DOM-free snapshot/event
coordination and explicit format-3 archives. These are additive capabilities of
the single served contract. Workspace exports older than format 3 reject
collaboration state they cannot represent.
The new `annotations` owner requires Documents and optionally Tables for entities.
Service `--plugins` remains a finite allowlist; project configuration cannot expand
it. Missing browser renderers do not disable the headless protocol.

## Install and start

The selected baseline is macOS arm64, Node 22.22.3 (engine range
`>=22.22.0 <23`), npm 10.9.8, Python 3 with `fcntl`, and Rscript 4.5.2.
The unsigned local tarball contains Plugins and the selected digest-checked Core
binary. R and any project-selected packages are external prerequisites.
The service, documents, declared files and saved resource readers work without R.
An unavailable Rscript returns an unknown dependency probe and prevents managed R execution.
Other platforms and npm registry publication are unverified.

```sh
npm install --prefix /absolute/install /absolute/rho-workspace-local-0.5.1.tgz
/absolute/install/node_modules/.bin/rho \
  --root /absolute/projects --state-dir /absolute/service-state
```

Create the allowed projects directory first. Keep service state outside projects.
Startup prints the loopback URL and private connection-file location, never the
credential. Opening that URL in a browser on the same machine is the access: the
service answers a same-origin request from loopback as the local person, with the
reviewed browser scope, no link, no code and no expiry. `rho --pair` still mints a
one-time link when a tab must be narrower — one folder below the service root — or
must expire; that link is a credential and is only as good as its five-minute
window and single use. A credential that is present must still be valid, so an old
link never silently widens to local access; a same-origin request that carries no
credential is the machine's own. Host and Origin are checked on every request, and
a browser request marked as coming from another site is refused. `--port`, `--rscript`, `--core`, `--plugins` and `--limits` are explicit
operator selections; `RHO_RSCRIPT`, `RHO_CORE_BINARY` and `RHO_PYTHON` select
equivalent runtimes. A Core override is outside bundled digest verification.
A source checkout has no `vendor/rho-core`: packaging supplies it. Without a Core
binary on PATH, the workspace and native Agent tools still start. Explicit managed
operations and Host activity require `--core`/`RHO_CORE_BINARY` or a bundled Core.
An explicitly selected missing binary or invalid bundled artifact still fails
startup; no alternate executable silently replaces it. Execution acceptance needs
an explicit Core selection. General project diagnosis does not treat absent R as
a broken workspace; diagnosis for the managed `run-r` intent does.
Core uses the canonical project path plus `/.rho/host.sock`; macOS permits at
most 103 UTF-8 bytes. A longer path fails before Host startup.

`--plugins documents,files` selects only those owners; `--plugins ""` selects
none. The default selects all nine. The allowlisted package identities and exact
0.4.0 versions are checked before wiring their typed service ports. Files is required by R object reads and resource resolution; Requirements is
required only by the `r.execute` action. Buffer execution also requires Documents.
Files is required by Tables/Media; Tables by Charts. Agent
context requests need only the sources they actually use. Missing/incompatible
packages and missing required services report `unavailable`; nothing is installed
implicitly. `capability.list` returns selected package availability and only the
available owners' actions/entries. `unavailableActions` names missing action
providers. Selecting only Files/R retains `r-objects` and object reads without
Requirements, Documents or an R installation; managed R execution stays unavailable. Wire API 2.0 and action/view 0.2.0 remain stable.

Owner removal preserves retained request identities, bytes, drafts/undo and layout
references. Existing accepted intent delivery returns its original record;
new work requiring an absent owner is unavailable. Metadata snapshots and
workspace save retain persisted facts even with no plugin selected. Byte exports
need Files. Restores report each missing owner/conflict and retain the verified
source archive for an explicit later import; they do not install providers.
Typed readers validate their own semantics when selected; raw bytes stay usable.
Document/resource reads and provider reselection start neither R nor a Host.
An explicit `requirements.check` runs its bounded Rscript probe.

Exact Host and supplied Origin are checked. The bearer credential is project
scoped for external callers. CLI shutdown stops only Hosts started by this
service and reports confirmation separately. Existing Hosts keep their owner.

### Connect Claude Code

The running service's operator connection grants one project to one Agent session
and prints how Claude Code starts that session's MCP server:

```sh
rho --grant /absolute/service-state/connection.json --project PROJECT_FOLDER [--session NAME]
```

`--project` is the folder relative to `--root`; `--session` defaults to
`claude-code`. The JSON reply names the project, the private session connection
file, the number of granted methods (the server default), an `mcp` entry
(`name`, `command`, `args`) for an MCP configuration file, and the equivalent
`claude mcp add rho-<folder> -- … --mcp <file>` command. `rho --mcp FILE` serves
that grant on stdio with the four tools `rho_index`, `rho_resolve`, `rho_call` and
`rho_read`; nothing else writes to stdout in that mode. Every connection file is a
credential. `rho --help` prints the usage; an unknown option exits 2 with it.

Agent 0.4.11 provides persistent Claude and Codex ACP entries and retains each
tool step's human title, ACP category and one identifying input (command, file path,
pattern or query; bounded). Since 0.4.17 a command also keeps its exit code and the last
20 lines it printed (at most 2 KiB), and Rho records when each step started. Since 0.4.23
a command keeps the Agent's own few words on what it is for (`purpose`, from Claude
Code's Bash description; one line of at most 200 characters) when it gave them. Other tool
output is not kept, and a message that is full gives up a command's output first. The Agent panel
selects a backend for a new conversation; existing records retain their choice.
`--claude PATH` / `RHO_CLAUDE` selects the native CLI; its existing provider/model
configuration is used. The four Rho MCP tools retain a project grant, while native
tools follow the selected Agent's own permission policy. A native permission request displays
only its offered choices to this machine's browser. It adds no Rho approval to an
already authorized operation. `--agent-backend claude-cli` / `RHO_AGENT_BACKEND`
selects the old per-message driver for new conversations; existing records keep
their original backend and session identity. That driver now keeps native tools
and configured MCP servers, with native permission settings; it no longer disables
built-in tools or forces `dontAsk`. Rho MCP calls keep their existing grant. The
noninteractive CLI cannot answer a new native permission prompt; use ACP when
interactive permission choices are needed. Configuration changes do not migrate
sessions. See the [ACP episode](ACP-EPISODE.md) for limits and recovery semantics.

`--agent-backend codex-acp` selects Codex as the service default; `--codex PATH` /
`RHO_CODEX` optionally selects its native CLI. Otherwise the pinned official
`@agentclientprotocol/codex-acp` 2.3.0 uses its bundled Codex 0.164.0. Native provider
configuration stays with Codex (`CODEX_CONFIG` and its native config); Rho does not
copy Claude credentials to Codex. The Westlake acceptance harness supplies an
isolated native configuration with `tools.update_plan.enabled=true` and
`features.apply_patch_freeform=true`. This enables real tools, not synthetic plans.
`maxAgentTurns` is Claude's native step cap; Codex remains bounded by the application
wall/output/record limits. ACP cancellation confirms the turn, not every native job.

For an external ACP client, select this command as that client's Agent executable:

```sh
rho --acp /absolute/project --acp-agent codex
# Use --acp-agent claude for Claude Code.
```

The external client sends `session/new` or loads its existing `sessionId` with
`session/load`. The relay forwards unchanged stdio bytes and records selected
updates in `.rho/agent/acp/`; prompts and permission choices stay in that client.
`project.work.read` reads the projection without starting a runtime or taking over
input. It shows up to eight external sessions, prioritizing connected sessions and
then recency, and counts omissions. Rho restart/closing a view does not stop the
external client. ACP v1 has no generic passive attach to an uninstrumented live
client; native transcript collection remains the explicit fallback.

## Named workspaces and selected source folders

The browser can create a named workspace from one or more natively selected
source folders. Its random ID and private owner-state/working directory are
independent of the display name and source locations. Source content stays in
place. `project.source.pick` returns a caller-bound receipt; `project.createWorkspace`
consumes receipts with a retained change identity; `project.source.add` adds a
further native choice to an authorized project. Legacy single-directory APIs and
original managed operations retain their identities and behavior.

Source entries have stable IDs and canonical roots. Files resolves references
`@<sourceId>/<relative-path>` inside the chosen folders; Documents uses that port
for its existing buffers and actual write conditions. Saved R script snapshots
can use the same resolver. `project.entries` lists the project's own directory
together with those source folders as `@<sourceId>` entries, so a project made from
source folders is not an empty listing; descending one of them lists that folder
under the same reference, and `project.openFile` accepts it. A source that moved or
disappeared is reported instead of followed. Plain relative paths and generated
outputs belong to the workspace directory; no implicit union, file copying, symlinks
or change of native working directory is performed. Callers must choose explicit
sources and inputs. The existing macOS socket-path bound still applies to an actual
execution. Native folder selection is platform-specific; source references do not
expand scope.

## Public contract and client

`RhoClient` is a Node caller: it uses filesystem-backed connection/intent files.
It has no generated method-specific types. Its event method returns a raw stream.
The separate `@rho-workspace/local/observation` transport entry provides DOM-free
HTTP/SSE parsing and snapshot-first reconnect reconciliation without Node files. Browser consumers should use the versioned HTTP/SSE boundary.

[protocol/index.json](../protocol/index.json) publishes requests, responses, typed
errors, events and resource declarations, one hashed file per operation under
`protocol/operations/`. `protocol.describe` returns the same contract. Operations
use authenticated `POST /api/v2/{operation}`, returning
`{apiVersion:"2.0",ok:true,value}` or `{apiVersion:"2.0",ok:false,error}`.
Documents, resources, compositions and event cursors have independent versions.

```js
import { RhoClient } from '@rho-workspace/local';
const rho = await RhoClient.fromFile('/absolute/service-state/connection.json');
const project = await rho.call('project.create', { name: 'my-project' });
const check = await rho.call('requirements.check', {
  projectId: project.id, requirements: []
});
```

| Operations | Contract |
| --- | --- |
| `project.open/create/list`, `capability.list` | Scoped projects and versioned action/component catalog. Reads do not start a Host. |
| `requirements.check/prepare` | Explicit unique package declarations: `{package,source:"cran"\|"bioconductor",minimumVersion?}`. Base-R probe, environment/timestamp and present/missing/unknown facts. Explicit preparation installs missing packages into the project library and rechecks. |
| `action.submit/lookup/observe/retry/cancel/list/output` | Original durable caller intent, Core identity, delivery/native facts and bounded logs. Any principal of the project reads a run by `operationId` (lookup, observe, output, `artifact.check`); a missing, guessed or other project's ID gets one `not_found`. Only the submitter retries. The submitter cancels, and so may a browser tab whose access includes the project; `cancellation.requestedBy` names who asked. `repairOf` names the failed or unknown run a new submission repairs. While no Host answers, a read reports `execution: "unknown"` and leaves the stored facts unchanged. |
| `document.open/read/edit/undo/save` | One shared UTF-8 buffer, UTF-16 offsets, conditional transactions, authors, undo, snapshots and disk conditions. |
| `resource.register/list/read`, `artifact.check` | Declared existing or produced bytes, independent digests, provenance, partial availability and byte-inventory checks. |
| `data.page/plot/compare`, `selection.set` | Explicit table types/null encodings, string entity keys/namespaces, numeric chart fields and two-input keyed joins. |
| `media.describe`, `object.read` | Original media reference and declared dimensions/pages; bounded exported JSON object snapshots. Neither starts R or decodes an interactive view. |
| `context.create/read` | Exact buffer/version/range, declared selected entities, a media rectangle with page and pixels/points, or one run (`run: {operationId}`): its state, exit, stop, the last 8 KiB of retained stderr with its byte offset and Core's truncation flag, the script reference, args and declared files. |
| `session.grant`, `binding.open/close/list/activity` | Operator-selected method grant, external binding metadata and bounded tool receipts. Agent grants include the read-only `project.entries` and no other `project.*` method. |
| `session.connect` | The person at this machine only: grants Claude Code or Codex access to one project and runs that Agent's own `mcp add` (`claude mcp add -s local` in the project folder, `codex mcp add`) with the project-scoped connection. A grant that still reaches this service is kept; a new one the Agent refuses is removed. Each CLI call: 20 s and 8 KiB of output, then stopped with what it printed. |
| `conversation.start/send/stop/read/permission` | Only the browser on this machine. Original message identities, retained text/tool steps and one selected Agent session. New conversations use the selected Claude or Codex ACP connection. Cancel is confirmed by the original prompt response; lost transport keeps an unknown outcome. Reads and reconnect never replay a prompt. Native permission choices are scoped to the original pending request. Limits are in `conversationLimits` and `--limits`. |
| `composition.put/read/apply/undo`, `view.close` | Registered entry/version, props and binding checks; `apply`/`undo` are conditional tree transactions with receipts ([Collaboration](COLLABORATION.md#composition-and-selection)). Uninstalled UI is explicitly unavailable. `rho.action` (version `1`, no bindings) is Rho's own form for one proposed action: props `{title, action, actionVersion, operationId, input, repairOf?}`, and the action must be registered at that version. |
| `workspace.save/export/restore` | Drafts/undo, bytes/provenance, selections and composition intent; native execution is not replayed. |
| `action.export` | One run as ordinary files in a new project folder (default `exports/<operationId>`): `script/` holds the code that ran, from the run's own record; `outputs/` holds each declared file as the run left it; `provenance.json` and `PROVENANCE.md` give the run, script digest, arguments, inputs, each file's SHA-256 and whether it matches the inventory the run wrote. A declared file that was not written, or no longer matches that inventory, is named and left out, and the export says `partial`. When the script has unsaved changes the call must say `unsaved: "include"` (written as `<name>.unsaved.<ext>`, marked as never run) or `"leave"`. Runs nothing; never writes into an existing folder. |
| `observation.snapshot`, `GET /api/v2/events` | Current facts and finite event cursors. Gaps require a new snapshot. `activity` holds the recorded calls of Agents granted on the project (method, time, outcome, refusal kind, recorded ids; no inputs), and each recorded call emits `activity.changed`, including reads and requests the schema refused. `agents` lists the Agent sessions with access (label, granted methods, expiry, latest recorded call); no token. `conversations` lists the conversations started in Rho, for the browser on this machine only. `project.runs` adds `stop` (`requested`, `signalled`, `stopped`, `finished-first`, `unconfirmed`, with who asked and Core's exit) and `repairOf`. |

## Execute an explicit project

Retain the exact input and identity before delivery. A saved script uses
`{kind:"disk",path,digest}`; an unsaved script uses the exact buffer version.

```js
const document = await rho.call('document.open', {
  projectId: project.id, path: 'analysis.R'
});
const intent = await rho.retainOperation('/absolute/caller/intent.json', {
  projectId: project.id, action: 'r.execute', actionVersion: '0.2.0',
  input: {
    script: { kind: 'buffer', documentId: document.id, version: document.version },
    args: [], requirements: [], artifacts: [], completion: null
  }
});
const accepted = await rho.call('action.submit', intent);
const observed = await rho.call('action.observe', {
  projectId: project.id, operationId: intent.operationId
});
```

The first R argument is a new output-directory path; the script creates it.
Further arguments are literal strings or `{resource:{id,version}}`, resolved to
frozen resource bytes after project/freshness checks. The code snapshot, arguments,
requirements and artifact declarations stay with the original request.
Literal R arguments retain the native program's OS authority.

Artifact declarations contain `path`, `kind` and `format`. Paths stay inside
that run's output directory. A completion filename is relative to the run
directory, beside its `artifacts` directory; the public plan returns the full
project-relative `plan.completion`. This keeps transport evidence outside a
producer's immutable artifact inventory. Its optional JSON shape is:

```json
{"schemaVersion":1,"complete":true,"artifacts":[
  {"path":"output.txt","bytes":3,"sha256":"<64 hexadecimal characters>"}
]}
```

The producer or explicit project consumer writes that declaration. Registration
can expose partial files before it exists. `artifact.check` verifies exactly the
declared files and their bytes. It never runs scientific checkers or interprets
their results. A project may run its checker through another `r.execute` and
publish a separate report resource.

Same operation ID and identical input return the retained record; changed input
conflicts. On lost delivery, look up the original identity. Explicit retry uses
the original frozen code/Core identity; only a retained `not-sent` request may
start its missing owned Host. Observation never recovers a runtime.
Core CLI exit 0/1/2/3/4 retains its documented success/rejection/usage/unavailable/
uncertain-delivery meaning. Completion, byte integrity, domain checks and model
judgment stay separate. Cancel acknowledgement is followed by native observation
before confirmed stop/process-group release.

## Resources, shared buffers and entries

A CSV or JSON-row table declares its columns, each type and CSV null encodings.
Declare a unique nonempty string key and namespace for entity interaction, or
`key:null` for ordinary unkeyed reading. `001` and literal `NA` remain strings
unless that column explicitly declares them missing. Sorting and filtering never
create entity IDs. `data.plot` takes numeric `x`/`y` field names and reports
deterministic sampling. Comparisons require both versions, keys, namespaces,
numeric fields, `mapping:"equal-string"` and `join:"left"|"inner"|"full"`.
The project owns whether that mapping is scientifically meaningful.

Media is explicitly PNG/JPEG/SVG/PDF with provider-declared page/dimension facts.
Original bytes and versions remain readable; rectangle context validates page,
units and bounds. Rendering, raster decoding, zoom and accessibility are UI work.
An object is an explicit JSON `exported-snapshot` with classes/provenance.
Batch Rscript supplies no live R variables or R-memory recovery.

Registered UI contracts include `rho.editor`, `rho.table`,
`rho.scatter`, `rho.media` and `rho.object`, version 0.2.0. Availability is
reported by the selected owner entry; `rho.object` currently has no browser renderer.
The owner
validates props and resource roles; scatter requires explicit numeric `x`/`y`
and an entity key. Rho persists the chosen bindings and layout intent.

Document edits reject stale versions, surrogate splits and invalid Unicode.
Human and Agent share content and undo. Save checks the expected buffer version
and actual base disk digest immediately before replacement; this is not a
filesystem CAS against outside writers. A kernel writer lease protects each
project. Acknowledgement follows fsync, rename and directory fsync.

## External Agent and compatibility

The stdio MCP entry exposes only granted methods and injects the credential's
project. The private descriptor includes `apiVersion:"2.0"`. Before managed
delivery it fsyncs a write-once original identity/input record; changed reuse
conflicts. `RHO_MAX_AGENT_INTENTS` defaults to 256 per project/session; exhaustion
preserves prior intents. The external client owns its model loop, provider and
conversation. Explicit context fetch is a tool receipt; proactive external-chat
delivery remains unsupported.

Retained operations stay observable through the one served contract: lookup,
observation, explicit retry/cancel, retained resource bytes, documents and context
reads all use the same authenticated operations as new work. A retired version
path is not served. Historical typed readers/checkers needing a removed provider
report unavailable; stored bytes, frozen plans and Core identities remain.
Schema-1/2 workspace exports remain readable. Choose format 3 explicitly for
collaboration state; format 2 remains the default and rejects lossy exports.
Restoration preserves missing entries without installing or executing them.

<a id="observation-budgets-and-recovery"></a>
<a id="development-and-assembly"></a>

## Budgets, verification and assembly

Configure scalar service/request limits and nested `documents`, `resources`,
`r` and `workspace` objects through `--limits`. Snapshots expose selected limits.

| Protected resource | Default limit | Exhaustion |
| --- | --- | --- |
| HTTP/queue | `maxRequestBytes` 1 MiB; `maxQueue` 32 | Reject new input; retain original identity. |
| Managed intents/code | `maxConcurrentActions` 2; `maxOperations` 256; `maxCodeBytes` 1 MiB | Reject additional work; unknown native work occupies a slot. |
| R script snapshots | `r.maxScriptBytes` 1 MiB, independent of Documents | Reject planning for oversized disk/buffer code before dispatch. |
| Logs/events | `maxLogPageBytes` 64 KiB; `eventRetention` 256; `maxSubscriptions` 8; `maxEventBytes` 64 KiB | Reject oversized pages/subscriptions; slow or old observers receive a gap. |
| Context/Agent | `maxContexts` 128; `maxContextBytes` 1 MiB; `maxBindings` 64; `maxActivities` 256 | Reject new context/bindings; evict oldest receipts with cursor facts. |
| Documents | 64 buffers; 1 MiB each; 8 MiB total and undo per buffer | Reject mutation; preserve acknowledged content/undo. |
| Artifacts/rows | 64 MiB/file; 1024 resources; 512 MiB retained bytes; 100,000 rows | Reject over-budget reads/registration; preserve prior bytes. |
| Pages/previews | 1000 rows/page; 20,000 chart points; 64 KiB byte/object/completion reads | Reject oversized requests; declare chart sampling. |
| Retained owner metadata | `maxRetainedMetadataBytes` 32 MiB and document count limit | Reject oversized observations; keep owner files. |
| Composition/export | 32 compositions, 32 views each; 32 MiB metadata | Reject additional metadata; keep owner state. |

Core CLI observation uses 20 s/2 MiB; base-R dependency probes use 20 s/1 MiB.
Artifact inventories allow 128 files. Native execution retains Core's own
budgets and OS authority; these limits do not constrain R memory or provide
an OS sandbox. Closing observers/views does not cancel tasks.

```sh
# npm ci in Rho-plugins first, then Rho
npm run build
RHO_CORE_BINARY=/absolute/rho-core npm test
RHO_CORE_BINARY=/absolute/rho-core npm run acceptance -- \
  /absolute/trial /absolute/explicit-project
RHO_CORE_BINARY=/absolute/rho-core npm run recovery
RHO_CORE_BINARY=/absolute/rho-core npm run agent
npm run pack:local -- --core /absolute/rho-core \
  --core-source /absolute/Rho-core --plugins /absolute/Rho-plugins
node scripts/install-acceptance.mjs /absolute/rho-workspace-local-0.5.1.tgz \
  /absolute/ordinary-project /absolute/paired-project
```

The same packaged acceptance runner reads an explicit project specification and
scripts. Neither example is bundled. Trial outputs use disposable projects and
owned Hosts. [Read-only fixtures](../fixtures/README.md) cannot be replayed.

The packer rejects dirty selected build inputs unless explicitly recording
`--allow-dirty`, builds the Node owners, stages production dependencies and
Core, and checks that project recipes/native R scripts and the old aggregate
package are absent. `--select-plugins documents,files` builds a reduced artifact
with other capability packages physically absent. A separate
`--select-plugins files,r` artifact exercises exported object reads with no editor
or dependency checker installed. `scripts/plugin-install-acceptance.mjs` accepts
either reduced tarball and checks its physical dependency inventory and no-Host
behavior. Only Tables installs csv-parse;
only Agent installs the MCP SDK. The sidecar
records source commits/trees, build-input and lock hashes, binary/package digests
and platform, plus each selected plugin tarball identity. It does not build Core, sign or publish to a registry. Direct
packing of the development source-linked root is rejected.


## Native artifact intake (phase 1)

The phase-1 source candidate selects Agent 0.4.1 independently; unchanged owners
stay at 0.4.0. Core, Files, Tables and Documents need no source changes. This is
native artifact intake, not the later automatic layout or feedback queue.
The inert application wire snapshot remains usable without an installed Agent.

The trusted embedding integration observes a real Claude Code init/session ID,
provisions separate business/adapter credentials with existing `agentConnection`,
and calls `RhoService.registerNativeAdapter`. This Node control-plane method is
not an HTTP/MCP tool and does not start the CLI. Its selected capabilities remain
pull context only, with no native deduplication or consumption acknowledgement.

`binding.open` accepts the frozen optional attachment. Existing IDs and legacy
calls remain unchanged. Only the control plane uses conditional
`task.routing.put`; the selected profile allows one task and one business binding
per project. Two projects may share one Rho service. Extra same-project tasks and
presentation assignments are refused in this phase. An ordinary default Agent
session receives neither routing control nor observation-append authority.

`binding.activity.append` accepts the frozen native source/epoch/sequence batch
only from the separately registered adapter. Existing tool-return association is
required for an artifact hint. MCP excludes this method even for an explicitly
provisioned adapter descriptor. `binding.activity` with `source: native` reads
complete bounded objects; its old profile remains the principal-filtered API log.
Event invalidation reuses SSE, with no new event bus. Layered discovery is later
work; these real business sessions used native tools and no Rho MCP tools.

The integration passes an `artifact.ready` event ID to the internal
`RhoService.observeNativeOutput(projectId, eventId)`. It reuses Files registration
and Tables paging, checks current project capability selection and returns
separate source, registration and validation facts. Only `typed-ready` returns a
consumer resource reference. It supports declared tables in this selected flow;
other format policies remain unimplemented. The first page validates the entire
bounded table; it is not a domain correctness or teacher-adoption receipt.

Existing matching Files metadata supplies the resource identity; re-observation
does not register it again. Changed output bytes require a new versioned path.
An invalid hint stays in activity history; rejection retains prior valid files
and references. A valid CSV prefix with an incorrect completion claim still
requires the recipe's expected-row/domain check. Generic readers do not know
class sizes. Completion discovery and arithmetic remain project recipe concerns.
There is no resident file watcher in this phase.

Native history uses the existing project kernel lease/serializer and atomic JSON,
not a second queue/lock/database. Its defaults under `agentNativeActivity` are:
16 KiB per event, 64 events / 256 KiB per batch, 256 retained events / 4 MiB,
and 128 source epochs. Epoch exhaustion rejects; event eviction exposes gaps and
retains watermarks. Expired original sequences reject without replay. A complete
object too large for its requested page returns `limit`; no object is truncated.
Fresh routing explicitly initializes history; missing/corrupt retained history
fails closed. Read operations do not initialize or recover a native runtime.
Routing receipts reuse `capabilityLimits.maxReceipts` (256) and the existing
`maxRetainedMetadataBytes` bound. Native registrations reuse `maxBindings` (64).
Existing workspace archive/restore formats reject active native tasks because
they omit routing/history; they must not silently claim a complete checkpoint.

Run the explicit synthetic recipe from this source checkout after building owners
and Rho sequentially:

```sh
RHO_NATIVE_MODEL=1 RHO_NATIVE_EVIDENCE=work/your-new-trial \
  node scripts/native-artifact-acceptance.mjs
```

It uses the existing private Claude environment, explicitly selects
`westlakehpc/deepseek-v4.1-flash[1m]`, and confirms the actual client/model/session.
The protected process defaults are 25 CLI turns, 900 seconds, 16 MiB stdout,
256 KiB stderr, 1 MiB per line and 2,048 observed tool IDs. A zero-model wrapper
preflight runs first. On limits, retained output/usage and uncertainty survive;
there is no hard provider-token cap or global OS sandbox claim.

The 2026-10-21 trial used Claude Code 2.1.306. A was accepted directly; B placed
its ready manifest in the wrong directory. An explicit original-session resume,
limited to Read/Write/Edit, corrected that path without rerunning Python. This
was not delivery through a Rho queue. The successful run plus repair used 31 model
tool calls, 225,883 input tokens including cache and 12,761 output tokens. An
initial instrumentation failure used 25 calls / 185,286 input / 18,941 output
and remains in the denominator. These CLI usage figures are not provider billing.
The independent expected-row/key/value/arithmetic checks stay separate from model
conclusions. Two designated Python computations entered once each; one extra
read-only Python hash check is separately recorded.

Source checks cover native provenance, concurrent original retries, target
isolation, typed/digest rejection, retention/cursor gaps and missing/corrupt state.
This phase does not accept automatic side-by-side UI, DOM visibility, reliable
feedback delivery, queue/ACK recovery, same-project multi-task isolation, native
execution exactly-once or an independently installed application composition.

## Automatic base presentation and DOM receipts (phase 2)

The phase-2 source candidate selected Agent 0.4.1 and Tables 0.4.1; other owners
remained at 0.4.0. This continuation authorizes the scoped phase 2–5 implementation.
The recorded scenario used a source and candidate side by side. This is historical
verification context, not a requirement for frontend layout.

After original resources and task routing exist, a trusted embedding integration
calls `RhoService.configurePresentation(projectId, policy)`. The complete
`BasicPolicy` profile is the inert application snapshot in
[src/presentation-contracts.ts](../src/presentation-contracts.ts). Its canonical
SHA-256 must equal the route's `policyRef`. It declares the source resource,
exact candidate declaration, two view IDs, table component version, equal-string
key/namespace mapping and horizontal split weights. It starts no runtime and is
not an HTTP/MCP tool. Fresh setup precedes native observations; missing prior
presentation/history cannot be silently initialized after work has begun. Each policy
configuration is immutable; phase 3 adds explicit conditional selection of a new
configuration ID, described below.

A registered adapter's `artifact.ready` append now triggers the deterministic
internal controller immediately: Files registration, typed Tables read, then the
existing conditional composition transaction. No presentation model call or later
poll is required. The accepted native-source receipt, integrity/shape result,
layout commit and DOM receipt remain separate. A failed or incompatible placement
keeps the registered output and current layout, with a bounded pending notice.
The existing Files page remains reachable. It never silently replaces unrelated
views or adopts a candidate as a domain decision.

The controller persists the original layout transaction before commit. The same
source/candidate retries its original changeId, input and expectedVersion. Original
receipts remain readable at the composition count limit. A binding witness names
exact layout version, source event, policy, view/component versions and resources;
a write does not claim visibility. Post-commit witness failure returns pending and
can reconcile the original transaction. A lost historical layout snapshot returns
expired. Existing protected views/ancestors retain their geometry. Background
binding/metadata updates preserve owner input and focus. The browser consumes
structured split groups as actual Dockview groups; below 768 it retains the
selected single-view/tab adaptation.

`view.observe` accepts the frozen `VisibilityInput` only from a scoped browser
principal whose `clientId` matches that principal. `rendererBuild` identifies the
selected source build and is associated with asset hashes in the web manifest.
This is authenticated client evidence, not compositor or human-perception attestation.
Tables supplies the optional `renderObservation` UI callback and its exact
`tableDomCoverageSchema`. It waits two animation frames after data, checks actual
DOM cell text, viewport bounds and element hit tests, and hashes the exact typed
owner values in visible row/column order. Buffered, clipped and header-covered
rows are excluded. Scrolled/filtered pages name their actual query; coverage never
stands for an entire virtual table. Native hidden events report immediately,
because background pages suspend animation frames.

Rho rechecks the witness, assignment, selected renderer, current Tables availability,
page keys/columns/namespace and the typed digest. Identical observation IDs return
original receipts; changed reuse conflicts. Resource-first and layout-first facts
are independent of latest observations and survive refresh/epoch changes. Old
layout observations are retained as historical and cannot advance current indexes.
`view.observations.read` pages complete records with caller/query/snapshot-pinned
cursors. A changed snapshot is stale; reads neither mount views nor start runtimes.

| Protected metadata | Configuration / defaults | At the limit |
| --- | --- | --- |
| Binding witnesses and original layout intents | `presentationWitness`: 256 records / 4 MiB | Keep layout/output; pending or expired witness remains explicit. |
| DOM records | `visibility`: 256 records, 16 KiB/record, 4 MiB total | Refuse a new receipt; keep rendered data, previous receipts and original first facts. |
| First/latest indexes | `visibility`: 512 entries / 2 MiB | Refuse new retained metadata; never reset first facts or silently evict them. |

All writes reuse the project lease/serializer and atomic JSON. Missing or corrupt
configured visibility storage fails closed. No new database, event bus, managed
execution journal or queue is introduced. Format-3 native-state export guards
remain in force. Service shutdown rejects new observations before draining, so
SSE reconnection cannot keep an owned closing service alive.

Source verification: four new application suites plus the existing suite total
48/48; Plugins total 43/43. Disposable real-browser checks cover two grade fixtures,
wide/narrow rendering, exact cells, refresh, service restart, input/focus retention,
virtual paging/filtering, pending placement, genuine native hidden tabs and an
occluding overlay. These are zero-model display checks; they do not repeat the
Claude business experiment or accept reliable feedback, optional enhancement or
outside-checkout installation. The remaining phases must repeat those actual
flows with Claude Code and the selected Westlake HPC model.


## Original-session feedback and durable delivery (phase 3)

`configureFeedback(projectId, { draftPath, relatedDocumentId })` is an explicit
Node control-plane selection after task routing. Documents opens the ordinary
question draft; the application stores only its task/draft pointers. The browser
uses the existing table selection and contextual Annotations `rho.feedback`
entry. It reuses Documents' one logical live buffer and own undo. Pending edits
and native composition disable submission; a confirmed version is checked again
before freezing. Browser storage retains only a bounded original submission
intent (16 KiB), scoped to project/task/view/principal. The original text remains
with Documents/Annotations. Reload observes that intent before offering a retry.

`feedback.submit` is browser-only and retains its original input, authenticated
author and responsibility snapshot before calling owners. Annotations owns the
committed message/source and explicit replies; Agent prepares that exact committed
message even if the thread advances. Agent then writes the frozen delivery.
Retrying an original submission never replaces its source, target or identity.
Changed draft/source conditions without a retained receipt need reconciliation.
`feedback.read` is only for the original business binding and returns one whole
frozen object plus `relatedDocumentId`; that pointer requires a current Documents
read and conditional edit/save to preserve human changes. Legacy `context.read`
cannot bypass a selected feedback delivery's target/fetch ledger. Ordinary
unselected projects retain their legacy behavior without initializing a queue.

`feedback.status` is a read for its submitting browser, original business or
operator. It distinguishes committed message, queued envelope, durable inbox,
observed enqueue ACK, emission attempt, hook stdout acknowledgement, owner-served
fetch, actual native MCP-tool return and an explicit `replyTo` response from the
assigned business principal. None proves model consumption, understanding or
scientific correctness. Whole-item paging pins caller/query/delivery/thread
versions; stale continuation requires rereading. Reads start no model, tool or Host.

Agent's sole `.rho/plugins/agent/delivery.json` uses the exact private
`deliveryStoreSchema`, `rho.agent-delivery/1` plus `coordinationVersion: 1`.
The frozen public profiles stay unchanged. The private refinement retains only
ACK-observation time and original hook boundary/emission times; the phase-0 draft
had no fields for those concrete coordination facts. No second queue, database
or execution journal is introduced. All writes reuse Rho's project serializer,
writer lease and atomic files. Schema and cross-reference/digest corruption or a
missing activated store fail closed; reading/retrying never recreates it.

The trusted integration can select a transport with `selectFeedbackTransport`.
`stepFeedback` persists its sole attempt before acceptance; every later step only
looks up that original inbox receipt. Lost ACK, missing receipt or client loss
retains uncertainty without re-enqueue, new delivery IDs or automatic native
resume. The private authenticated adapter ports `feedback.pending/step/next/emitted`
are transport endpoints, absent from public MCP. They verify the registered
project, adapter and native session. `next` requires an actual retained original
native tool boundary and persists emission intent before helper stdout. After
an ambiguous crash it never emits the reference again. This intentionally does
not guarantee native computation deduplication or model-consumption ACKs.

The optional Agent package exports `./claude-feedback-worker` and
`./claude-feedback-hook`; the embedding harness explicitly starts its bounded
worker and configures Claude's PostToolUse hook. The worker may share at most 16
selected project/session descriptors. It never starts/resumes Claude. Stopping
it stops coordination only. The hook sends a small original fetch reference;
questions are fetched by the assigned Agent, and the presenter receives no body.

| Protected resource | Configuration / default | Exceeded-limit behavior |
| --- | --- | --- |
| Durable submissions | `agentDelivery.maxRecords`: 128 maximum; `maxBytes`: 4 MiB | Refuse new intent/stage; keep draft, completed owner receipts and original identities. |
| Fetch receipts | `maxFetchReceiptsPerDelivery`: 128 maximum | Refuse new receipt/fetch; retain earlier facts. |
| Whole selected feedback | `maxFeedbackObjectBytes`: 12 KiB maximum; request page maximum 64 KiB | Refuse before serving a partial object; report required size. |
| Hook input / HTTP | 64 KiB stdin / 5-second requests | Keep original emission uncertainty; never re-emit automatically. |
| Worker observations | 16 connections; 1,200 cycles / 600,000 ms by default; each request at most 6 seconds and remaining time | Stop coordination at the selected bound; preserve owner state. |
| Policy configurations | `presentationWitness.maxConfigurations`: 32 / existing 4 MiB aggregate file | Refuse a new configuration; preserve policies, layout and artifacts. |

A new candidate path selects a new immutable BasicPolicy ID using conditional
`task.routing.put`, then `configurePresentation`. Prior configurations and binding
witnesses remain. A known source/candidate pair updates only the candidate binding,
preserving manual titles, extra views, geometry and protection checks. Incompatible
or protected placement remains pending. A late old artifact can only observe its
original registered resource/transaction; it cannot switch the UI back. This is
an explicit per-task policy change, not same-project multi-task support.

Verification: Rho 57/57 and Plugins 44/44 source regressions; eight targeted feedback
suites include killed worker restart after durable acceptance, lost ACK lookup,
hook helper crashes before/after stdout, isolation, original-message recovery,
whole fetch limits, stale pages and corrupt/missing/full stores. Actual Chrome
checks exercise two separate grade fixtures, native Unicode input held pending,
lost submit/save responses, current human edits, original-business linked replies
and 1600/390 widths. Native event metadata is fixture evidence here. No Claude or
provider request ran in this phase, so subject model calls/input/output tokens are
0/0/0. Actual live-Claude consumption and native computation counts, optional
presentation enhancement and outside-checkout installation remain phases 4–5.

## Optional presentation and layered MCP (phase 4)

The selected Agent source candidate is 0.4.3; Documents/Tables/Annotations keep
0.4.1/0.4.2/0.4.1 and Core is unchanged. `session.grant` or the trusted Node
`agentConnection(..., pluginFilter, profile)` explicitly chooses
`layered-business` or `layered-presentation`. Existing descriptors without a
profile retain compatibility behavior. A layered descriptor has at most
`layeredGrantLimits.maxMethods` methods (96 since the Notebook; 64 before), and a
default business grant that would exceed this is refused, never cut. The Agent pages
through its methods 20 at a time, so the limit bounds the grant rather than the Agent's
context. In the current composition the default business grant has 68. Its authenticated principal retains the profile and plugin filter;
changing a model argument or local tool request cannot widen that grant.

A presentation grant supplies only index/resolve, `workspace.observe/enhance`
and `binding.open` for trusted bootstrap. The two display methods alone appear
in its small index; the harness opens its native-evidenced binding. Rho assigns
one business binding and at most one presentation binding to the selected one
task per project. It computes a monotonic presenter generation on replacement,
including removal/reassignment. Original feedback ownership remains separate.
P gets no full catalog/protocol, `observation.snapshot`, business documents,
feedback, raw native trace, raw composition writes or protection authority.
These are Rho capability boundaries, not an OS sandbox; the external harness
must also select the presentation client's native tools. Live-Claude harness
selection/consumption remains part of phase 5.

`workspace.observe` is the assigned presenter's bounded projection: current
layout identity/version, retained binding witness, latest exact-layout visibility
identity, typed owner summary and gap. It contains no question body or full table
rows. Complete witness/visibility/summary objects may page; cursors pin caller,
query and snapshot. One object that cannot fit returns a size refusal. The owner
rechecks current Tables availability; reads start no model, renderer or Host.

`workspace.enhance` accepts only emphasis, an optional title and a plain note of
at most 600 Unicode characters. A new write requires the current assignment
and generation, conditional layout version, exact binding witness and a real
visible observation for that layout. It retains the original enhancement intent
in the existing presentation file before translating to `composition.apply`.
Protected views/ancestors and manual layout/input remain with their existing
owners. A note can be placed below the unprotected target while the original
view stays in place. Rho writes its author binding and basis; raw layout writes
cannot create or modify a forged note. Normal layout undo may restore authentic
retained note history. A duplicate uses the exact original body/receipt, even
after layout/generation advances, only while the principal remains the assigned
presenter. Replacement presenters cannot use an old principal's assignment.
A commit never claims visibility; old commit and current versions are separate.

Agent supplies optional read-only `rho.agent-note` 0.2.0 via `./ui`: plain React
text, the existing type/color system, and author/basis details. It has no document
buffer, chat loop, arbitrary code or feedback state. Rho consumes the frozen
optional view `presentation.emphasis` metadata in wide/narrow tabs. Missing or
disabled UI owners remain unavailable; no domain result is inferred from a note.
Formal DOM coverage remains the selected Tables port. Note visibility is checked
by the real browser acceptance, not represented as fabricated table coverage.

`capability.index` projects the current authorized/enabled descriptor sources,
short summaries, scope hints and immutable Skill/contract hashes. A requested
role can only match/narrow its authenticated role. `capability.resolve` combines
relevant shipped Skills and full public owner contracts, stripping only the
privately injected project field and including the complete schema dependency
closure. It does not duplicate a second capability registry. A contract records
its effect, provider/version and current public conditions. Pagination keeps whole
objects and pins the catalog/bundle/caller/query; each page rechecks availability
and authorization. Immutable content cannot substitute for current task, resource
or permission state. A stale catalog requires a fresh small index.

The default MCP entry exposes `rho_index`, `rho_resolve`, `rho_call`, `rho_read`.
Its tools/list has small fixed input schemas and no initial full protocol/catalog
fetch. Resolve returns one JSON text body without a structuredContent mirror.
`rho_call` requires a complete cached contract and relevant guidance, checks its
closed input schema, preserves existing managed intents, and sends a contract
precondition on the ordinary operation request. Rho rechecks that precondition
under the same project serializer immediately before dispatch. Missing/partial
schemas, changed contracts, revoked scope and unavailable providers do not run.
`rho_index` starts with owner summaries. Select an owner or search before fetching
operation contracts. `rho_call` returns replies up to 16 KiB by default (64 KiB
maximum); larger replies carry a scoped immutable reference. `rho_read` selects
JSON-pointer fields, container pages or Unicode-safe UTF-16 text ranges and can
explicitly release the retained result. It never invokes the original operation.
Result retention defaults to 16 MiB per reply, 64 MiB total and 64 replies, set by
`RHO_MAX_RESULT_BYTES`, `RHO_MAX_RETAINED_RESULT_BYTES`, `RHO_MAX_RESULTS`.
Capacity is checked before a new call; exhaustion preserves retained results and
refuses dispatch. Process loss preserves results but requires refetching contracts.
New descriptors use this entry by default; old per-operation MCP tools are removed.
Runtime `protocol.describe` also pages summaries or selects one complete contract.
The static `protocol/index.json` is an index of hashed operation files.

| Protected knowledge resource | Limit / configuration | Exceeded or changed state |
| --- | --- | --- |
| Selected entries / known references | Frozen profile: 16 / 128 | Reject the request before expanding it. |
| Knowledge response | Default convention 16 KiB; maximum 64 KiB | Page whole objects. A first object that does not fit yields requiredBytes and complete=false; over 64 KiB refuses rather than splitting a schema. |
| Complete cached immutable bodies | `RHO_KNOWLEDGE_CACHE_ENTRIES`: 128 maximum; `RHO_KNOWLEDGE_CACHE_BYTES`: 4 MiB default | Evict complete least-recently-used bodies. Fetched outputs are still returned; missing proof requires refetch, never execution from half a body. This bounds serialized bodies/count, not a hard OS heap budget. |
| Projection / enhancement metadata | Existing query limits and `presentationWitness` record/byte caps | Refuse new state or expose pending witness; preserve layout, prior receipts and original intents. |

Known references are omitted only for currently selected/available immutable
bodies. The MCP adapter advertises only references it actually retained complete.
After model context loss, omit missing knownRefs to get their bodies again. A new MCP
process under the same private connection keeps the bodies that connection retained,
so the next message of one conversation begins with them rather than refetching;
another connection, an evicted body, a body over the budget and a superseded contract
all force refetch, and the service rechecks the current contract reference on every
call. Availability/configuration/role changes invalidate catalog and
continuation state. Cached content never restarts a task or native session.
Actual native `rho_call` feedback.read results now carry the same exact fetch
attribution as the compatibility tool; other operations/prose cannot assert it.

Source verification: Rho 63/63, Plugins 45/45. Real SDK subprocess checks cover
partial/oversized first objects, complete schemas, knownRefs, context/process loss,
revocation, stale selection and bounded cache refusal. Two-project Chrome checks
show base tables before P calls, separate presentation sessions, real DOM bases,
visible emphasis and notes, retained unconfirmed filter/focus, resource-first
receipts and 1600/390 widths. These use fixture native metadata and SDK clients,
with zero model requests/tokens. The following phase-5 evidence covers the selected
real model and installed consumer; same-project multi-task remains unselected.

## Installed native grades acceptance (phase 5)

The darwin-arm64 local candidate was packed with the explicit dirty-source override
and installed offline outside all three source checkouts. Its 3,887 installed
files and selected Core binary match the recorded SHA-256 inventory. Application
0.4.0 selects Agent 0.4.3, Documents 0.4.1, Files 0.4.0, Tables 0.4.2 and
Annotations 0.4.1; unselected owners have no runtime authority. Documentation
updated after acceptance is separate from the immutable package build inputs.

Claude Code 2.1.306 with Westlake HPC `westlakehpc/deepseek-v4.1-flash[1m]`
completed two grade projects with distinct original business sessions and two
restricted presentation sessions. Both base tables were actually visible before
their presenter started. Native-ready to server-received DOM-visible evidence was
2,391/296 ms for initial A/B and 328/271 ms for updated A/B. These same-host
measurements include rendering and receipt processing; they are not calibrated
browser frame times or a general performance result.

The successful trial used 77 model tool calls: 50 native and 27 MCP. Input tokens
including cache were 1,098,713; output tokens were 29,705. Each presenter used four
MCP calls. Three native command permission refusals recovered, no MCP schema or
cross-task misuse occurred, and one deliberately lost save response returned
unknown before the original document receipt was read. An earlier selector-failed
trial retains 23 tool calls and observed usage of at least 125,099 input/9,491
output tokens; its aborted in-flight usage is unavailable, not zero. These trials
do not establish a matched token-saving comparison with earlier shorter tasks.

Actual teacher questions stayed with their original business sessions. A shared
worker was killed after durable B acceptance and lost ACK; its replacement only
looked up the original receipt. Accept counts were one per project, B lookup one.
Each business entered Python analysis once per intended initial/feedback phase,
preserved teacher buffer edits, saved v3 and linked an explicit original-author
reply. Core Host starts and managed submissions were both zero. The native review
wait is explicit test coordination, separate from computation and throughput.

Acceptance records 32 unique installed checks, a stronger pending-save rerun,
34 real-model assertions, 14 installed browser/restart checks and 95 independent
domain/identity assertions mapped to frozen AC01–AC21. Contract paging, knownRefs,
context/process loss, stale authorization, hook crashes and expired-receipt cases
use installed SDK/fault fixtures; native automatic compaction was not forced.
Local evidence is `work/phase5-installed-dual-agent-20261021/results.html` with
requirements, exact identities, filtered actual traces and failure accounting.
The 900px view retains internal scrolling/column ellipsis. Human usability, accessibility, same-project multi-task, OS execution deduplication
and official distribution are not accepted by this bounded flow. No registry
publication or signing was performed.


## Retained review evidence

`resource.capture` copies a project file into Files' independent immutable store;
`resource.register` retains its existing semantics. A Documents snapshot records
its confirmed buffer version/dirty state separately from disk. `annotation.decide`
is browser-person-only and records accepted, needs-changes (reason required) or a
withdrawal/correction against an exact Agent reply and result refs. Agent grants do
not include this operation. New results never inherit decisions. `data.compare`
accepts `fields: [{leftField,rightField}, ...]` while preserving old single-field
requests; stable keys, namespaces and an explicit mapping remain required.

`conversation.start/send` accept optional `contexts` containing frozen context IDs.
Those IDs join the original message digest. Only turns started by Rho automatically
capture explicit file locations and final identified changes; reads do not backfill.
`conversation.read.evidence` records captures, pending/interrupted/unavailable states
and omissions. Buffer and disk bytes have separate provenance. A capture is an
observation, not proof of process input/output. The browser Review/Graph and offline
export share the Graph derivation of retained reported/named/observed relationships.

Local-browser-only `evidence.preview` takes an annotation ID; `evidence.export`
also requires the preview's digest and an original `exportId`. It writes a new
`exports/ID` directory with static `index.html`, original selected bytes and the
final `evidence.json`. It does not include full conversation/tool output or discover
unstated dependencies. `rho --verify-evidence PATH` checks it without starting Rho.
A complete package can contain explicit missing analysis evidence. This read-only
format does not restore a workspace or run an analysis.

| Protected resource | Configuration and default | Exhaustion |
| --- | --- | --- |
| Automatic file capture | `conversations.maxSnapshotBytes` 8 MiB | Keep a gap, no partial file. |
| Turn captures | `maxCaptureFiles` 64, `maxCaptureBytes` 32 MiB in `conversations` | Keep obtained versions/output; count omissions. |
| Project capture workers | `conversations.maxCaptureConcurrent` 2 (initial collector serializes) | Queue only bounded turn candidates. |
| Project Files store | `resources.maxArtifactBytes` 512 MiB, `maxResources` 1024 | Refuse new versions, preserve earlier data. |
| Offline package | `evidence.maxBytes` 512 MiB, `maxFiles` 128, `maxMetadataBytes` 4 MiB | Refuse expansion; retain incomplete directory without final success. |

New capture/export limits can be lowered through `--limits`; observation diagnostics
expose them. Table/text previews are bounded to 200 rows, 20 columns and 64 KiB.
See the [episode](REVIEW-EVIDENCE-EPISODE.md) for actual trials and open user observation.

### File descriptions while a message runs

While a message started in Rho runs, its project is compared with the start every
`describe.everyMs`; each changed file that has rested `settleMs` is read for facts and
recorded in `conversation.read` as the message's `descriptions`, bound to the digest of
the bytes read (the same digest Files gives a kept version). Each file is then
described in one sentence by the person's own Claude Code with no tools (Agent's
`describeFile`), using the model the conversation uses. A text file is described from
its facts and first lines. A PNG, JPEG, GIF or WebP figure is sent as an image when
[models.dev](https://models.dev) lists the model as taking images; otherwise, and for a
PDF or another binary file, it is described from what made it: the command that wrote it, the lines of the scripts that
command ran around where the figure is named, and the Agent's last words before it
(`strategy` `context`, with `from` naming the scripts and `why` saying why the image
was not sent). A model that refuses the image is given that context once, and the
message's later figures are not sent as images. A binary file with nothing in the
record that made it keeps its facts. A later version with the same facts keeps its
sentence.

Each sentence names its model, the version it read, its strategy and its `cost`:
Claude Code's own figure when it knows the model's list price (`reported`), else the
tokens it reports at the price models.dev lists (`estimated`, naming the listing used),
else `unknown` with Claude Code's guess named. The message's `descriptionSpend` counts
its calls, their dollars and how many were estimated or unknown; it is not part of the
session cost the Agent reports. Rho keeps the models.dev catalog in `models-dev.json`
in its state folder and reads it again once a day.

`conversation.settings.update` with `describe: { enabled: false }` switches describing
off for every conversation of the person: facts are still read, and no model is asked.
Codex sessions and a service started without a named Claude binary record facts only.
A description still being written when Rho stops reads back as `unknown`. Facts are
observations; a sentence is generated and checks nothing.

| Protected resource | Configuration and default | Exhaustion |
| --- | --- | --- |
| Disk comparison while a message runs | `describe.everyMs` 5 s, `settleMs` 2 s, `conversations.maxComparedFiles` | A file still being written waits for the next check. |
| File reads for facts | `describe.maxFactBytes` 4 MiB, `maxDigestBytes` 256 MiB | Facts say "at least"; a larger file is not described. |
| Files described per message | `describe.maxPerMessage` 24 | Further files are counted in `descriptionsOmitted`. |
| The person's model budget | `describe.maxCalls` 24 per message, `againMs` 60 s per file, Agent `describeLimits` | Keep the facts and say the limit was reached. |
| Memory for a figure sent as an image | `describe.maxImageBytes` 3.5 MiB | Describe it from what made it. |
| Memory for what made a figure | file-describer `contextLimits`: 6 KiB of context, scripts up to 256 KiB, 25 lines before and 3 after | Cut the context; a larger script is not read. |
| Network and disk for the model catalog | `modelsDev` in the service configuration; Agent `modelCatalogLimits`: 16 MiB, 20 s, once a day, 10 min after a failure | Keep the last catalog; without one, figures are described from what made them and costs Claude Code does not know are `unknown`. |

### Decisions on an answer and the Console

`conversation.decide` is local-browser-only. It records `accepted` or `needs-changes`
(a note is required) on one finished message of a conversation started in Rho. The
decision holds the exact resource versions that message kept (`results`); a file
changed later is not covered by it. A request is retried under its `changeId`.
A different intent under the same identity is a conflict. A later decision names the
one it `supersedes`, and every earlier decision is retained. Agent grants exclude it.

Console 0.1.0 runs a person's shell commands in the project folder. `console.run`
and `console.stop` accept only the local browser principal. An operator credential
or Agent grant cannot use them, while `console.list` and `console.output` can be
granted to read the record. Each command keeps its text, folder, `changeId`, who ran
it, pid, start/end, exit code or signal and bounded output in
`.rho/plugins/console/` in the project. Stop signals the command's process group,
then kills it after a grace period. After a restart, a command still alive reads
`continuing` and a vanished one `unknown`. Neither is run again.

| Protected resource | `console` in `--limits`, default | Exhaustion |
| --- | --- | --- |
| Command records | `maxRecords` 200 | The oldest finished record and its output make room; running ones stay. |
| Running commands | `maxRunning` 4 | Refuse to start another (`limit`, named). |
| Kept output | `maxOutputBytes` 1 MiB, then `tailBytes` 64 KiB | Keep head and tail, count the bytes between. |
| Output reads | `maxReadBytes` 64 KiB per page | Refuse a larger page. |
| Stop | `stopGraceMs` 3000 | SIGKILL the process group. |

### Live R and Python sessions (Notebook)

Notebook 0.1.0 (`@rho-workspace/plugin-kernel`) keeps one live R session and one
live Python session per project, in the project folder, shared by the person and
their Agent. `kernel.run` queues a cell in its language's session and starts the
session when none is live; `waitMs` waits up to `maxWaitMs` for it to end.
`kernel.read` returns the sessions, their variables and the cells, and never starts
a session. `kernel.inspect` returns one value of a live session as its session
describes it: its kind (table, model, vector, list, function, value or other), class,
size and facts, a page of its rows, elements or parts, the code that reaches it and
each part (`path` names parts by position), and the cell it was read after. A table
sorts by a column on request; a model gives its fit and coefficients. It answers
`none` without a live session, `busy` while a cell runs or waits, `missing`, `timeout`,
`failed` or `ended`, and never starts, waits for or changes a session; a cell asked
for during a reading waits for it. `kernel.plot` returns one kept plot as PNG bytes. `kernel.interrupt` names
a cell: a running cell is stopped with SIGINT and its session and values stay; a
waiting cell is not run; an ended cell is returned unchanged. `kernel.stop` names a
session and ends it (SIGTERM, then SIGKILL after `stopGraceMs`); its running cell
ends with an error and its waiting cells are not run. Agent grants receive run, read,
inspect, plot and interrupt; `kernel.stop` accepts only the local browser principal. These
operations do not wait in the project's request queue (only their activity record
does), so a run waiting for a long cell holds no read and no interrupt.

A cell keeps its `changeId` per caller: the same identity returns the same cell and
never runs it twice. Cells run one at a time per session, in the order they came,
and record who ran them (`by`), their purpose, code, printed output, messages,
warnings and error in the order printed, plots, and how they ended: `done`,
`error`, `interrupted` (with who asked and when), `not-run` or `unknown`. R output
reaches Rho as it is printed; each answer about a cell follows a numbered mark on
standard output, so it lands after the text printed before it. After each cell the
session lists its variables (type, size, one-line summary; Python leaves out modules
and imported classes and functions), and the cell names the values it made or changed
(`defined`) and, when neither list was cut, removed (`removed`). R draws on one device
that stays open for the session, as the console's does: a later cell can draw over an
earlier cell's plot and reports the plot it changed, and each page a cell starts is kept
(a sourced script with two plots has both). Python closes its figures after each cell.
State lives in `.rho/plugins/kernel/` in the
project. Variables live only in their process: when Rho closes, its sessions end,
and the next start records each as `rho-closed`, a running cell as `unknown` and a
waiting one as `not-run`. Nothing runs again. Rho-started sessions are told to run
exploratory code there and to keep the code results rest on in scripts.

| Protected resource | `kernel` in `--limits`, default | Exhaustion |
| --- | --- | --- |
| Processes | One session per language per project | A cell joins its language's session. |
| Waiting cells | `maxQueued` 16 per session | Refuse the cell (`limit`, named). |
| Code | `maxCodeBytes` 64 KiB | Refuse the cell (`invalid`). |
| Kept output | `maxOutputBytes` 256 KiB per cell | Keep the first bytes, count the rest, mark the cell `cut`. |
| Plots | `maxPlots` 8 per cell, `maxPlotBytes` 4 MiB each | Keep the first plots; a larger file is dropped with a note in the cell. |
| Cell records | `maxCells` 500 | The oldest ended cell and its plots make room. |
| Variables listed | `maxVariables` 200 | List the first, count the rest (`variablesOmitted`). |
| A value read | `inspectRows` 50 (up to 200 asked), `inspectColumns` 50, `inspectChildren` 200, `inspectCellChars` 120, `inspectTextBytes` 16 KiB | Return the page; count the rest (`columnsTotal`, `total`); cut text is marked `cut`. |
| Sorting a table | `inspectSortRows` 1,000,000 rows | Return the rows unsorted with the reason (`sortRefused`). |
| Reading time | `inspectTimeoutMs` 10 s, then `inspectGiveUpMs` 5 s | Interrupt the reading (SIGINT), answer `timeout`; the session and its values stay. |
| Waiting for a cell | `maxWaitMs` 10 min | Return the cell as it stands; read it later. |
| Start | `startTimeoutMs` 30 s | Kill the process; waiting cells are not run, with what it printed. |
| Stop | `stopGraceMs` 3000 | SIGKILL the process group. |
| Ended sessions kept | `maxEndedSessions` 20 | The oldest ended session record goes. |
| Places | `maxPlaces` 16 | Refuse another (`limit`, named). |
| Start on a server | `remoteStartTimeoutMs` 90 s | End its ssh; waiting cells are not run, with what ssh and the login printed. |
| A place's check, listing, signal | `remoteCheckTimeoutMs` 60 s, `remoteListTimeoutMs` 30 s, `remoteSignalTimeoutMs` 15 s | End that ssh; say it took too long. |
| A listing | `remoteEntries` 500 from `remoteListBytes` 1 MiB | List the first, count the rest (`omitted`), mark a cut listing (`cut`). |
| A copy from a server | `remoteCopyBytes` 64 MiB, `remoteCopyTimeoutMs` 10 min; `maxCopies` 500 records | Refuse a larger file (`limit`, named) before it is sent; a file that changed while copied is refused. |

Memory and time used by a cell's own code are not bounded. `--python` (or
`RHO_PYTHON`) names Python; R is `--rscript` and needs the `jsonlite` package. `--ssh`
(or `RHO_SSH`) names the ssh program sessions on a server use; it is `ssh`, with the
person's own config, unless named. The Notebook's operations `kernel.places`,
`kernel.place.set`, `kernel.place.check`, `kernel.place.list` and `kernel.place.copy` name
and check places, choose where each language runs, and list and copy a place's files; the
[remote episode](REMOTE-EPISODE.md) records how a session runs there and ends.
