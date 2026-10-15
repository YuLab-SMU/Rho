# Rho local backend 0.1

The backend implements BP-01–BP-06 of the [backend plan](https://github.com/YuLab-SMU/Rho/blob/main/docs/BACKEND-FIRST.md).
It exposes the same `/api/v1` contract to headless clients and a project-scoped
Claude Code MCP adapter. Browser views remain independent work. See the
[acceptance record](https://github.com/YuLab-SMU/Rho/blob/main/docs/BACKEND-ACCEPTANCE.md) for the exact verified scope.

## Install and start

The selected baseline is macOS arm64, Node 22.22.x (engine range
`>=22.22.0 <23`), npm 10.9.8, Python 3 with `fcntl`, and Rscript 4.5.2.
The assembled local tarball contains the selected Core binary and its digest;
R and scientific packages are external prerequisites for scientific actions.
The service and documents remain available without R; an unavailable selected
Rscript returns an unknown dependency probe and prevents execution. Other systems are unverified.
This is an unsigned local npm artifact; no npm registry publication is performed.

```sh
npm install --prefix /absolute/installation /absolute/rho-workspace-local-0.1.0.tgz
/absolute/installation/node_modules/.bin/rho \
  --root /absolute/projects --state-dir /absolute/service-state
```

Create the allowed projects directory first. Choose a service-state directory
outside every scientific project. Startup prints a local URL and a private
`connection.json` location, never its credential. The service uses loopback IPv4,
an unpredictable bearer credential and an ephemeral port by default. `--port`,
`--rscript`, `--core` and `--limits` are explicit operator selections.
`RHO_RSCRIPT`, `RHO_CORE_BINARY` and `RHO_PYTHON` provide equivalent runtime
selections. A Core override is operator supplied and outside the bundled digest
check. The selected Core must provide the recorded public CLI contract. Its Unix socket
uses the canonical project path plus `/.rho/host.sock`: at most 103 UTF-8 bytes
on macOS (107 on Linux, unverified here). Longer paths return a typed native
condition before Host startup; select a shorter project location.

The service verifies the exact Host header and, when present, its own Origin.
No browser frontend or CORS consumer is delivered here. CLI shutdown stops only
Hosts started by this service process and reports confirmed versus unknown
shutdown. An adopted existing Host remains under its original owner.

## Public contract and client

[protocol/v1.json](../protocol/v1.json) publishes all operation request schemas,
per-operation response schemas, common facts, event names and typed errors.
`protocol.describe` returns the same contract. Operations use authenticated
`POST /api/v1/{operation}` with JSON. Replies are
`{apiVersion:"1.0", ok:true, value:...}` or
`{apiVersion:"1.0", ok:false, error:{kind,message,details,continuation}}`.
An incompatible field or semantic change requires a new major API path;
consumers allow additive optional response fields. Resource, buffer, composition
and event versions are independent.

```js
import { RhoClient } from '@rho-workspace/local';
const rho = await RhoClient.fromFile('/absolute/service-state/connection.json');
const project = await rho.call('project.create', { name: 'airway-project' });
const capabilities = await rho.call('capability.list', { projectId: project.id });
const check = await rho.call('requirements.check', {
  projectId: project.id, action: 'airway.analyze'
});
```

| Operation family | Returned facts and conditions |
| --- | --- |
| `project.open/create/list`, `capability.list` | Allowed project roots and finite catalog. Opening observes Core; it does not start it. Internal `.rho`/`.git` directories and symlink traversal are rejected. |
| `requirements.check/prepare` | Selected action, actual Rscript/package libraries, timestamp, versions and missing/unknown state. Preparation is an explicit managed operation, installs only missing packages into the project library through BiocManager, then rechecks. |
| `action.submit/lookup/observe/retry/cancel/list/output` | Durable original intent and mapped Core caller/request, delivery and native facts; bounded original stdout/stderr. |
| `document.open/read/edit/undo/save` | One acknowledged UTF-8 buffer per normalized relative path, UTF-16 edit offsets, version, author, undo and disk write condition. |
| `resource.list/read`, `artifact.check` | Actual file/table/model/PDF bytes, independent resource digests, coverage, provenance, completion declaration and separate checks. |
| `data.page/plot/compare`, `selection.set` | Typed real rows, NA as null, sorting/filtering, stable gene IDs, marked downsampling and a two-input left join. |
| `session.grant`, `binding.open/close/list/activity` | Operator-created project credential, external session metadata and bounded tool receipts. No external conversation ownership. |
| `context.create/read` | Frozen explicit buffer/range or versioned selected entities. `tool-fetched` is a fetch receipt, not proof of proactive conversation delivery. |
| `composition.put/read`, `view.close` | Registered props/binding checks, stale checks and retained unavailable component intent. Closing a view does not cancel work. |
| `workspace.save/export/restore` | Acknowledged drafts/undo, actual artifact bytes, provenance, selection and layout intent, with per-item recovery reports. Native requests are never replayed. |
| `observation.snapshot`, `GET /api/v1/events` | Current owner facts and retained event cursors. Events notify changes; snapshots establish current facts. |

## Original managed request

Retain the operation ID and exact input **before the first delivery**:

```js
const intent = await rho.retainOperation('/absolute/caller/intent.json', {
  projectId: project.id, action: 'airway.analyze', actionVersion: '0.1.0',
  input: { bootstrapReplicates: 1 }
});
const accepted = await rho.call('action.submit', intent);
const observed = await rho.call('action.observe', {
  projectId: project.id, operationId: intent.operationId
});
```

The service durably records the caller/project/operation mapping and frozen code
before calling Core. Same identity plus identical input returns the retained
record; changed input conflicts. A transport timeout, HTTP failure or service
crash does not authorize a new identity. Read `action.lookup`, then explicitly
`action.retry` only when required. A retry reuses the original Core identity and
frozen bytes. An answered request returns its retained record. Only an accepted
`not-sent` request may start its missing owned Host during explicit retry.
A stale prior socket is preserved for operator inspection; reads never recover it.

Core CLI exit 0 is a successful reply, 1 a structured native rejection, 2 invalid
CLI usage, 3 an unavailable Host, and 4 uncertain reply delivery. Rho retains the
actual exit and reply. Execution, integrity, domain checks and model interpretation
are separate fields. A retained Running fact before Host loss does not establish
current activity. Partial data can coexist with `execution:"unknown"`.
Cancellation acknowledgement requires subsequent native observation to confirm
stop and process-group release. Shutdown has its own confirmation.

## Shared documents and real science

`document.edit` applies nonoverlapping UTF-16 ranges against `expectedVersion`.
It rejects surrogate splits, invalid UTF-8 and unpaired Unicode; adjacent ranges
are allowed, ambiguous same-position edits rejected. Human and Agent use one
buffer and undo groups. Acknowledgement follows file fsync, atomic rename and
directory fsync. Unacknowledged browser input has no persistence claim.

`document.save` requires `expectedVersion` and `expectedDiskDigest`; the actual
disk digest must still equal the buffer's base. A conflict preserves content and
undo. The digest is checked immediately before replacement; uncooperative external
writers do not participate in the service lease, so this is not a filesystem CAS.
A kernel advisory writer lock prevents two Rho services owning the same project.

`airway.analyze` consumes the packaged paired airway/GSE52778 recipe, a saved
project script with its digest, or an exact buffer/document version. Submission
freezes source and bytes; later edits cannot change accepted work. The reference
case uses donor-paired DESeq2 and four donor-omission fits. `bootstrapReplicates`
is 1–1000; acceptance used 1, while the earlier scientific record used 200.
This sample size is not a new biological validation claim.

`airway.shrink` requires the full model and matching baseline table from the same
accepted analysis. The component executes actual apeglm shrinkage for
`dex_trt_vs_untrt`, retains the original Wald p-values/padj and writes table,
model, manifest, completion declaration and MA PDF. `data.compare` joins by
`gene_id`, binds both immutable inputs and preserves absent Y as null.
`artifact.check` separately verifies byte manifests, independent arithmetic and
saved native model/export agreement. These checks do not validate all scientific
assumptions or establish clinical validity.

## External Agent

The selected adapter uses Claude Code 2.1.300 and MCP SDK 1.29.0 over stdio.
The caller's existing Claude authentication/provider stays with that client.
The operator calls `session.grant` with an explicit `externalSessionId` and method
list, then configures the returned private descriptor in the client's MCP entry:

```json
{"mcpServers":{"rho":{"command":"node","args":["/absolute/installation/node_modules/@rho-workspace/local/node_modules/@rho-workspace/headless/dist/mcp.js"],"env":{"RHO_AGENT_CONNECTION":"/absolute/service-state/agent-DIGEST.json"}}}}
```

Only granted methods become `rho_*` tools. Project identity is injected from the
credential; models cannot widen it or grant another credential. The default
programmatic grant excludes project management, session grants, dependency
preparation and workspace restore. Operator grants must follow existing user
authorization. Binding metadata neither starts a model loop nor resumes a
conversation. `binding.activity` reports only this principal's method receipts,
returned versions and typed rejections; it omits tool inputs and credentials.
Before a managed delivery, the adapter also fsyncs a write-once identity/input
record beside that descriptor. Concurrent changed-content reuse conflicts.
`RHO_MAX_AGENT_INTENTS` defaults to 256 per project/external session; a full
retention set rejects new identities and keeps prior intents. The external
conversation need not be persisted for that caller record to survive.

## Observation, budgets and recovery

Read a snapshot, then subscribe using its `cursor` as `after`. Snapshot/replay and
subscription registration are serialized with project mutations. A cursor outside
the retained window returns `event_gap`; obtain a new snapshot. Closing/cancelling
the stream releases observation only. Poll native facts through `action.observe`;
events do not promise native push completion notifications.

Supply a JSON object through `--limits`. Its scalar keys configure the service and
requests; nested `documents`, `resources` and `workspace` configure their owners.
[The implementation](https://github.com/YuLab-SMU/Rho/blob/main/src/server.ts) exports defaults. The snapshot reports
selected limits; protocol hard caps also remain in force.

| Protected resource | Default configuration | Exceeded-limit behavior |
| --- | --- | --- |
| HTTP input/project queue | `maxRequestBytes` 1 MiB; `maxQueue` 32 | Typed `limit`; no new work accepted; original identity retained. |
| Actions/intent retention | `maxConcurrentActions` 2; `maxOperations` 256; `maxCodeBytes` 1 MiB | Reject new intent; preserve earlier requests and uncertainty. Unknown native work conservatively occupies a concurrency slot. |
| Execution observation | `maxLogPageBytes` 64 KiB | Reject oversized page; Core retains its own bounded output facts. |
| Events/subscriptions | `eventRetention` 256; `maxSubscriptions` 8 per principal; `maxEventBytes` 64 KiB queued output | Old events evicted with cursor gap; excess subscription rejected; slow observer ends with a gap. |
| Agent metadata/context | `maxBindings` 64; `maxActivities` 256 retained receipts; `maxContexts` 128; `maxContextBytes` 1 MiB | Receipts evict oldest with retained cursor; other new metadata rejected. |
| Document buffers/undo | `documents.maxDocuments` 64; `maxBufferBytes` 1 MiB; `maxTotalBytes` 8 MiB; `maxUndoBytes` 8 MiB per document | Reject mutation and retain acknowledged content/undo. |
| Artifacts/data | `resources.maxFileBytes` 64 MiB; `maxResources` 1024; `maxArtifactBytes` 512 MiB; `maxRows` 100,000 | Stop new reads/registration beyond budget; previous bytes remain. Retained snapshot versions count toward storage. |
| Data pages/drawing input | `resources.maxPageRows` 1000; `maxPoints` 20,000; `maxReadBytes` 64 KiB | Oversized request rejected; plot responses explicitly mark deterministic sampling. |
| Composition/export metadata | `workspace.maxCompositions` 32; `maxMetadataBytes` 32 MiB | Reject additional metadata; keep owner records. A composition has at most 32 views. |

Core CLI calls have a 20 s / 2 MiB reply boundary; dependency probes use 20 s /
1 MiB, scientific checks 120 s and artifact inventories 128 files. Exhaustion
keeps obtained facts and reports uncertainty/failure; these limits do not bound
native R memory. Core has its own execution/output budgets. Native R/Python retain
the operator's OS authority, and Rho does not claim an execution sandbox.

Project state uses `.rho/rho` for coordination and `.rho/plugins` for component
state; Core owns its existing `.rho` files. Formats are version 1. Export requires
a new destination directory, writes real bytes and a digest inventory, then the
completion manifest last. Restore verifies the inventory first, preserves existing
buffer/resource conflicts and reports missing items individually. Unavailable views
retain references; scientific work is not rerun to restore a view.

## Development and assembly

```sh
# Run npm ci in Rho-plugins first, then Rho (the source dependency is a local override).
npm run build
RHO_CORE_BINARY=/absolute/rho-core npm test
RHO_CORE_BINARY=/absolute/rho-core npm run acceptance
RHO_CORE_BINARY=/absolute/rho-core npm run recovery
RHO_CORE_BINARY=/absolute/rho-core npm run agent
RHO_CORE_BINARY=/absolute/rho-core npm run repair
npm run pack:local -- --core /absolute/rho-core \
  --core-source /absolute/Rho-core --plugins /absolute/Rho-plugins
node scripts/install-acceptance.mjs /absolute/rho-workspace-local-0.1.0.tgz
```

Review scientific scripts before executing them. Acceptance scripts create new
disposable projects and owned Hosts; they never restart an existing user Host.
Raw transcripts, credentials and experiments remain ignored local evidence.
[Read-only fixtures](../fixtures/README.md) are captured responses for consumers;
they cannot be replayed as actions.

The packer rejects changed build inputs unless the operator explicitly selects
`--allow-dirty`, which records a development override. It builds the two Node
owners, packs Plugins, stages production dependencies and the selected Core,
then emits a tarball and sidecar composition record with source commits/trees,
input hashes, package/binary digests, lock hash and platform. It verifies required
entries and rejects archive traversal. It does not build Core, sign, publish or
claim a reproducible binary build. Direct packing of the source-linked development
root is rejected; use the assembled artifact.
