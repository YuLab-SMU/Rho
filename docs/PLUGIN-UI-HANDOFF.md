# Plugin interfaces and browser UI handoff

The [U2 Documents handoff](U2-BACKEND-HANDOFF.md) adds mutation identities,
revision/receipt retention, pending saves and live-document bindings. U2 now integrates the owner Documents and Tables `./ui` entries with scoped
browser edit/history/page/selection grants; see [U2 UI acceptance](U2-UI-ACCEPTANCE.md).

## U1 browser entry

[Browser implementation](UI.md) now supplies scoped pairing, same-origin assets,
the typed `./browser` Fetch SDK, bounded snapshot/SSE reconciliation and the
observation-only shell based on Paper's Rho experience V0.1. `./ui-contract` is
`0.1-draft`; Documents and Tables now provide the U2 renderers. U3/U4 remain pending. The current
nine-owner headless extension is in [Collaboration](COLLABORATION.md): conditional
composition transactions/undo, protection, caller/view/shared selection,
Annotations feedback/replies, frozen Agent contexts and format-3 archives. The
inventory below retains the original eight-owner component boundary and calls out
the additive contracts; it does not supersede the versioned protocol.

The historical component baseline has **eight capability packages 0.4.0**, one action
(`r.execute` 0.2.0) and five component descriptors (0.2.0). Documents and Tables now report `ui:"./ui"`; the other three remain unavailable.
These are owner entries, independently selected for a browser build; the shell
does not supply a replacement functional implementation.

The provider-owned [Node API reference](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PUBLIC-INTERFACES.md)
lists every package entry, export, service port and capability limit. The selected
application contract is [protocol/index.json](../protocol/index.json), also returned by
`protocol.describe`. Its operation schemas are the authority for exact required
fields, bounds and response envelopes. Existing headless acceptance is recorded
in the [boundary review](PLUGIN-BOUNDARY-ACCEPTANCE.md).

## Which public boundary to consume

| Consumer | Public entry | What it owns |
| --- | --- | --- |
| Rho local service | Nine Node package roots and pure owner `./contract` entries | Select versions, inject ports, enforce scope and compose owner capabilities |
| Browser shell | `@rho-workspace/local/browser`, authenticated HTTP JSON/SSE | Observe owner facts within an explicitly narrowed browser grant |
| Node caller / headless acceptance | `RhoClient` from `@rho-workspace/local` | JSON calls, raw event stream and filesystem-backed original intent retention |
| External Agent | `rho-agent-mcp` with an operator-provisioned project descriptor | Expose granted operations as tools; external client retains model loop/chat |

The browser should not import Node owner implementations, read `.rho` files,
start Core directly or duplicate the unsaved-buffer owner. Owner schema subpaths
are implementation-free contracts, not verified browser packages. A future
browser adapter may use the published JSON schemas without moving format rules
into Contracts or reimplementing provider semantics.

`RhoClient` currently imports `node:crypto`, `node:fs/promises` and `node:path`.
`fromFile()` and `retainOperation(file,input)` require ordinary local files;
`call<T>()` accepts generic method/input values rather than generated per-method
types. `events()` returns a raw `ReadableStream`, without SSE parsing, reconnect
or reconciliation. The separate `./browser` export reuses `./observation` without
Node or DOM imports. `./server` and `./protocol` are
Node/application entries, not browser SDK promises.

## The owners and their HTTP consumers

All operations in this section take `projectId`. Slash-separated suffixes expand
to separate operations, for example `document.open/read` means `document.open`
and `document.read`. These are application routes to the owners, not nine
independent HTTP servers.

| Owner | UI-facing operations | Facts and conditions to retain |
| --- | --- | --- |
| Documents | `document.open/read/edit/undo/save` | One shared content/version/undo history; edit offsets and disk save conditions |
| Files | `resource.register/list/read`, `artifact.check` | Versioned bytes, provenance, partial availability and separate integrity evidence |
| R | `action.submit` with `r.execute`; `object.read` | Exact saved/buffer script selection; frozen arguments; exported object snapshot |
| Requirements | `requirements.check/prepare` | Explicit package requirements; present/missing/unknown probe; managed preparation identity |
| Tables | `data.page/compare`, `selection.set` | Declared types/nulls; stable keys and namespaces; both comparison input versions |
| Media | `media.describe`, `resource.read`; `context.create` for rectangles | Original bytes/ref, declared pages/dimensions; validated original coordinates |
| Charts | `data.plot` | Numeric scatter fields, stable entity keys, original count and sampling facts |
| Agent | `context.create/read`, `binding.open/close/list/activity` | Frozen context and fetch receipts; caller-scoped binding/activity facts |
| Annotations (additive extension) | `annotation.create/read/list/reply` | Exact document/entity anchors, Documents-owned drafts, submitted messages and explicit `replyTo` |

Dependencies are service ports, not sibling implementation imports. Documents,
Files and Requirements have no required capability provider. Tables/Media need
Files; Charts needs Tables. R needs Files for exported objects and additionally
Requirements for its execution action; buffer scripts additionally need Documents.
Agent requests use only the document/file/table/media providers their context needs.
All nine depend on the generic Contracts package; only Tables installs csv-parse,
only Agent installs the MCP SDK. Rho and Core retain assembly and managed execution.

### Documents and execution inputs

`document.open` takes a project-relative `path`; `read` takes `documentId`.
`edit` takes `documentId`, `expectedVersion`, `edits:[{from,to,insert}]` and
`undoGroup`. Offsets are UTF-16 code units; stale content, split surrogates and
invalid Unicode are rejected. Undo needs `expectedVersion`. Save additionally
requires `expectedDiskDigest`, including `null` for a file not yet on disk.
Use the returned `content`, `version`, `dirty`, `diskDigest` and author facts;
multiple views and the Agent operate on this same logical buffer.

`requirements.check` takes an explicit array of
`{package,source:"cran"|"bioconductor",minimumVersion?}`. It runs a bounded R probe;
it does not execute project analysis or start a Host. Preparation is an explicit
managed operation with its own `operationId`, not a render-time side effect.

`action.submit` requires `operationId`, `action:"r.execute"`,
`actionVersion:"0.2.0"` and `input:{script,args,requirements,artifacts,completion}`.
Disk script selection is `{kind:"disk",path,digest}`; an unsaved snapshot is
`{kind:"buffer",documentId,version}`. Arguments are literal strings or
`{resource:{id,version}}`. The first native argument is the new output directory;
the explicit project script owns its contents and analysis. See
[execution details](HEADLESS.md#execute-an-explicit-project).

### Resources, plots and selection

Use resource `{id,version}` refs throughout; their version is an independent
SHA-256 digest. `resource.register` needs a typed `declaration` and
`expectedDigest` for an existing project file. `resource.list` takes an
`operationId` and collects that operation's declared artifacts; it is not a
filesystem browser or a project-wide catalog. Project-wide retained resource
metadata comes from `observation.snapshot`. `resource.read` takes `offset` and
optional `maxBytes`, returning base64 bytes and continuation facts.

`data.page` needs a resource ref, `offset`, `limit`, optional single-column sort
and filter. It returns declared columns/types, total/filtered counts, rows,
`entityKey` and `namespace`. `selection.set` uses stable string `entities`, never
visible row numbers. Unkeyed tables are readable but not entity-interactive.

`data.plot` needs a table ref and numeric `x`/`y` field names; optional `maxPoints`
is bounded. Returned scatter data includes keys and explicit stride sampling.
`data.compare` needs `left`, `right` refs and options naming both keys,
namespaces, numeric fields, `mapping:"equal-string"` and a left/inner/full join.
It creates a new table resource with both inputs/provenance; no scientific
identifier mapping is inferred.

`media.describe` returns original ref/MIME type and producer-declared metadata,
with `rendering:"unavailable"`. Read original bytes through `resource.read`.
`context.create` can pass a `resource` and
`region:{page,x,y,width,height,units}`: page starts at 1, units are pixels for
images and points for PDF, and declared bounds must contain the rectangle.
The owner does not decode or rasterize it. `object.read` returns bounded JSON
with `observation:"exported-snapshot"`; it is not a live R variable.

### Agent handoff

`context.create` requires an explicit document range/version or resource ref;
table context also requires selected stable entities. `context.read` records
`tool-fetched`, not model understanding or use. Non-table resource context is a
bounded first byte page with continuation facts, not automatically the whole file.

`session.grant` is Rho's operator-only provisioning operation. It selects an
external session and allowed methods, returning a private connection-file path.
The Agent plugin exposes only those methods as stdio tools and injects project
scope. `binding.open` records the supported `claude-code-mcp` adapter; list/activity
are scoped to the caller. An operator snapshot is not a global external-session
activity feed. Binding metadata is not a transport liveness check; closing a
binding does not cancel work. No active push into an external chat is implemented.

## Application-owned interfaces

| Operations | UI consumer responsibility |
| --- | --- |
| `protocol.describe`, `project.list/open/create`, `capability.list` | Discover the actual contract, project and selected providers; distinguish package availability, action availability and missing UI |
| `action.lookup/observe/retry/cancel/list/output` | Track the original caller/project operation and Core identity, delivery/native outcome, cancellation and bounded output offsets |
| `composition.put/read`, `view.close` | Store versioned component references, bindings and layout intent; closing a view releases the view, not its task |
| `workspace.save/export/restore` | Preserve drafts/undo, bytes/provenance, selection and unavailable view references; present conflicts/missing resources without replay |
| `observation.snapshot`, `GET /api/v2/events` | Reconcile current owner facts with finite event cursors and release observation independently |

`capability.list` exposes actual package availability, available actions,
`unavailableActions`, component descriptors and Host observations. It does not
implicitly install a missing provider. Read `components[].ui` and persisted
composition `availability`; registration does not imply renderability.

### Five registered entries

All entries below have version **0.2.0**, require exactly the listed bindings and
retain their component contracts. Documents and Tables have optional UI entries;
the other three remain unavailable. Required props are closed schemas; extra props fail.
Rho validates the selected entry/version, props and binding roles before saving.

| Component / owner package | Required props | Binding |
| --- | --- | --- |
| `rho.editor` / Documents | `title` | `document`: exact version or explicit live-document; see [U2](U2-BACKEND-HANDOFF.md) |
| `rho.object` / R | `title` | `data:{id,version}` of kind `object` |
| `rho.table` / Tables | `title` | `data:{id,version}` of kind `table` |
| `rho.media` / Media | `title` | `data:{id,version}` of kind `media` |
| `rho.scatter` / Charts | `title,x,y` | `data:{id,version}` of kind `table`, with key and numeric x/y columns |

A `composition.put` includes `compositionId`, `expectedVersion`, `views`, `layout`.
Each view has `id`, `component`, `version`, `props`, `bindings`, optional entity
`selection`. New compositions use `expectedVersion:0`; updates use the returned
integer version. Unknown/uninstalled entries remain unavailable references.
The legacy `layout` object is opaque. The additive `composition.apply/undo` path
uses validated group/view nodes, stable IDs, conditional versions and receipts;
see [Collaboration](COLLABORATION.md#composition-and-selection).
U1 incrementally observes view IDs as read-only tabs. Dockview geometry conversion,
owner renderers and browser layout writes remain U2-U3 work.
Documents, resources and compositions have separate versions; there is no global
scientific revision or atomic cross-owner snapshot.

## Observation, errors and request lifetime

Start from `observation.snapshot` and its `cursor`, then subscribe to
`GET /api/v2/events?projectId=...&after=...` with bearer authorization. Events carry
`{cursor,type,subject,projectId,at}`, not full state. Current event types are:
`operation.accepted`, `operation.delivery`, `operation.cancel-requested`,
`document.changed`, `selection.changed`, `composition.changed`, `binding.changed`.
After an event, reread its owner. Read a fresh snapshot on `event_gap` or an SSE
`gap` event, and resume from that snapshot's cursor.

This is not a complete change feed: native completion/output, document opening,
resource registration/comparison and several workspace mutations do not emit
their own events. Observe active operations explicitly with `action.observe`,
read bounded output with `action.output`, and refresh facts after acknowledged
mutations. Reads and reconnects do not start or recover a Host. Closing the event
reader and `view.close` must not imply task cancellation.

JSON replies are `{apiVersion:"2.0",ok:true,value}` or
`{apiVersion:"2.0",ok:false,error:{kind,message,details,continuation}}`.
Published kinds are `invalid`, `unauthorized`, `origin`, `scope`, `stale`,
`conflict`, `condition`, `unavailable`, `limit`, `not_found`, `event_gap`, `storage`,
`native`. Use kind/condition facts rather than matching human message text.
Stale/conflicting writes require rereading and reconciling the owner; limit
exhaustion preserves earlier acknowledged state. Limits are exposed in snapshots.

Before `action.submit` or `requirements.prepare`, retain the exact original input
and `operationId` durably. Missing replies, timeouts and storage uncertainty mean
lookup of that identity, not a replacement submission. Explicit `action.retry`
uses the frozen identity/input; only retained `not-sent` delivery may start an
owned Host. Keep `delivery`, `execution`, `native`, `integrity`, `domain` and
`interpretation` separate. Cancel acknowledgement is not confirmed native stop.

## What remains unimplemented

| Area | Current limit / remaining capability |
| --- | --- |
| Browser transport | Typed U2 SDK, bounded SSE and identified document retries exist; durable native intents remain separate |
| UI bootstrap | Same-origin static build and scoped one-time pairing exist; no separate Vite-origin CORS support |
| UI plugin runtime | Documents/Tables render in the shell; three other renderers and conditional geometry remain pending; no marketplace/dynamic loader |
| Editing and files | Backend edit/undo/save works; redo, file watcher, language service, project file tree and upload/rename/delete routes are absent |
| R/environment | Batch Rscript/exported objects only; no persistent interpreter/live variables/memory recovery, R installer or lockfile environment provisioning |
| Data and visualization | Bounded whole-resource parsing, single scatter projection and equal-string comparison; no table-cell write, general query/mapping engine, other chart types, chart rendering/export, image/PDF decoding or annotations UI |
| Agent | Scoped MCP and explicit context fetch work; no embedded chat, proactive external-chat delivery, hosted model loop or conversation synchronization |
| Product acceptance | U1 and U2 runners/evidence are separately scoped; physical IME, full accessibility/performance and U3/U4 closure remain pending |

These are capability limits, not additions to this task. Fixed scientific
workflows stay in ordinary projects/examples and external checkers. They must not
be reintroduced as base plugins, render-time execution or bundled demo pipelines.
The existing [headless fixtures](../fixtures/README.md) are inert test inputs;
their passing states do not establish browser behavior. Local package installation,
source publication and future signed distribution retain separate evidence.
