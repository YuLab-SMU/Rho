# Rho local backend 0.4

Rho selects eight independent capability packages: documents, files, R,
requirements, tables, media, charts and Agent. Shared contracts contain generic envelopes/service ports and ordinary-file
primitives. Each resource/requirement/script schema belongs to its provider
through a pure `./contract` entry; contracts has no format registry, capability
state or catalog. Rho retains its selected v2 schema snapshot and checks provider
parity without importing absent implementations. The reusable backend exposes `/api/v2` to calling clients and the project-scoped
stdio MCP adapter. Its sole registered execution action is `r.execute`: an
explicit project script, requirements, arguments and output declarations.
Analysis recipes and scientific checkers are external consumers, excluded from
the application and Plugins npm packages. Browser UI remains separate work.
See [extraction](https://github.com/YuLab-SMU/Rho/blob/main/docs/PLUGIN-EXTRACTION.md)
and [extraction acceptance](EXTRACTION-ACCEPTANCE.md). The
[split acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) records the independent package boundary.
The [0.4 boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md) records the follow-up decoupling.
The [UI handoff reference](PLUGIN-UI-HANDOFF.md) maps all eight owners to HTTP
operations and distinguishes implemented backend APIs from missing browser pieces.

## Install and start

The selected baseline is macOS arm64, Node 22.22.3 (engine range
`>=22.22.0 <23`), npm 10.9.8, Python 3 with `fcntl`, and Rscript 4.5.2.
The unsigned local tarball contains Plugins and the selected digest-checked Core
binary. R and any project-selected packages are external prerequisites.
The service, documents, declared files and saved resource readers work without R.
An unavailable Rscript returns an unknown dependency probe and prevents execution.
Other platforms and npm registry publication are unverified.

```sh
npm install --prefix /absolute/install /absolute/rho-workspace-local-0.4.0.tgz
/absolute/install/node_modules/.bin/rho \
  --root /absolute/projects --state-dir /absolute/service-state
```

Create the allowed projects directory first. Keep service state outside projects.
Startup prints the loopback URL and private connection-file location, never the
credential. `--port`, `--rscript`, `--core`, `--plugins` and `--limits` are explicit
operator selections; `RHO_RSCRIPT`, `RHO_CORE_BINARY` and `RHO_PYTHON` select
equivalent runtimes. A Core override is outside bundled digest verification.
Core uses the canonical project path plus `/.rho/host.sock`; macOS permits at
most 103 UTF-8 bytes. A longer path fails before Host startup.

`--plugins documents,files` selects only those owners; `--plugins ""` selects
none. The default selects all eight. The allowlisted package identities and exact
0.4.0 versions are checked before wiring their typed service ports. Files is required by R object reads and resource resolution; Requirements is
required only by the `r.execute` action. Buffer execution also requires Documents.
Files is required by Tables/Media; Tables by Charts. Agent
context requests need only the sources they actually use. Missing/incompatible
packages and missing required services report `unavailable`; nothing is installed
implicitly. `capability.list` returns selected package availability and only the
available owners' actions/entries. `unavailableActions` names missing action
providers. Selecting only Files/R retains `r-objects` and object reads without
Requirements, Documents or an R installation; execution stays unavailable. Wire API 2.0 and action/view 0.2.0 remain stable.

Owner removal preserves retained request identities, bytes, drafts/undo and layout
references. Existing accepted intent delivery returns its original record;
new work requiring an absent owner is unavailable. Metadata snapshots and
workspace save retain persisted facts even with no plugin selected. Byte exports
need Files, and restores need Documents and Files before applying mutations.
Typed readers validate their own semantics when selected; raw bytes stay usable.
Document/resource reads and provider reselection start neither R nor a Host.
An explicit `requirements.check` runs its bounded Rscript probe.

Exact Host and supplied Origin are checked. The bearer credential is project
scoped for external callers. CLI shutdown stops only Hosts started by this
service and reports confirmation separately. Existing Hosts keep their owner.

## Public contract and client

`RhoClient` is a Node caller: it uses filesystem-backed connection/intent files.
It has no browser entry or generated method-specific types. Its event method
returns a raw stream; SSE parsing and reconnect reconciliation belong to a future
browser adapter. Browser consumers should use the versioned HTTP/SSE boundary.

[protocol/v2.json](../protocol/v2.json) publishes requests, responses, typed
errors, events and resource declarations. `protocol.describe` returns the same
contract. Operations use authenticated `POST /api/v2/{operation}`, returning
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
| `action.submit/lookup/observe/retry/cancel/list/output` | Original durable caller intent, Core identity, delivery/native facts and bounded logs. |
| `document.open/read/edit/undo/save` | One shared UTF-8 buffer, UTF-16 offsets, conditional transactions, authors, undo, snapshots and disk conditions. |
| `resource.register/list/read`, `artifact.check` | Declared existing or produced bytes, independent digests, provenance, partial availability and byte-inventory checks. |
| `data.page/plot/compare`, `selection.set` | Explicit table types/null encodings, string entity keys/namespaces, numeric chart fields and two-input keyed joins. |
| `media.describe`, `object.read` | Original media reference and declared dimensions/pages; bounded exported JSON object snapshots. Neither starts R or decodes an interactive view. |
| `context.create/read` | Exact buffer/version/range, declared selected entities, or a media rectangle with page and pixels/points. |
| `session.grant`, `binding.open/close/list/activity` | Operator-selected method grant, external binding metadata and bounded tool receipts. |
| `composition.put/read`, `view.close` | Registered entry/version, props and binding checks. Uninstalled UI is explicitly unavailable. |
| `workspace.save/export/restore` | Drafts/undo, bytes/provenance, selections and composition intent; native execution is not replayed. |
| `observation.snapshot`, `GET /api/v2/events` | Current facts and finite event cursors. Gaps require a new snapshot. |

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

Registered unavailable UI entries are `rho.editor`, `rho.table`,
`rho.scatter`, `rho.media` and `rho.object`, version 0.2.0. Their owner
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

The [v1 contract](../protocol/v1.json), [v1 fixtures](../fixtures/v1/states.json)
and [accepted 0.1 candidate](https://github.com/YuLab-SMU/Rho/blob/main/docs/BACKEND-ACCEPTANCE.md)
are unchanged. The `/api/v1` bridge supports retained-request observation,
explicit retry/cancel and compatible raw-resource/document/context reads.
New writes use v2. Historical typed readers/checkers needing a removed provider
report unavailable; stored bytes, frozen plans and Core identities remain.
Schema-1 workspace exports remain readable; new exports use schema 2.
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
node scripts/install-acceptance.mjs /absolute/rho-workspace-local-0.4.0.tgz \
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
