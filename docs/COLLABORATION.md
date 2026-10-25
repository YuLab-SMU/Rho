# Headless collaboration

Rho's headless collaboration protocol is additive under `/api/v2`, the one served
contract. It is not browser or UI acceptance.
[Headless installation](HEADLESS.md), [Status](STATUS.md) and the
[execution boundary](EXECUTION.md) retain their separate scopes.

## Capabilities and shipped guidance

The finite service plugin allowlist still controls installed owner selection.
`capability.configure` persists a project selection using `expectedVersion`,
`changeId` and server-authenticated authorship. It installs nothing, starts no
Host and cancels no task. Two projects on one service can select different owners.
The catalog separates package presence, project enablement, dependency readiness,
method authorization and UI renderability. A missing UI does not disable reading
CSV data, editing a document or preparing a scatter plot.

Each owner ships versioned input/output declarations, dependencies, side-effect
categories and a digest-checked Skill in its npm entry. Rho's wire snapshot is
checked against those business declarations without importing optional owners.
`skill.list/read` exposes the application Skill and accessible enabled owner
Skills. Guidance never grants authority or changes global Agent configuration.

The shared stdio MCP adapter rereads the project catalog before listing or calling
tools. The intersection is the application protocol, project availability, session
grant and optional operator-provisioned `pluginFilter`. Filters only narrow grants;
a cached tools/list cannot bypass a later disablement. HTTP routes reach the same
functional owners. The project in the private connection descriptor is authoritative,
not a model-supplied argument. Redelivering a retained native intent returns its
original facts even after disabling its provider; new execution remains unavailable.

## Composition and selection

`composition.apply` writes `rho.composition/1`: a root group and stable-ID nodes.
Groups have ordered children. Views identify exact component versions, props and
resource/document bindings. Supported batch operations are `replace`, `insert`,
`remove`, `move`, `props` and `bind`. A replacement is the sole operation in its
batch and is the explicit migration path from legacy arbitrary `layout` data.
Every node must have one parent, be reachable, and form an acyclic tree. Registered
owners validate props/bindings; unknown rendering entries remain unavailable.
No pixel geometry, layout engine or new renderer is selected here.

Every transaction carries `expectedVersion` and `changeId`. A server-authored receipt
records its request digest, author, version and time. Conflicting writes return the
current version rather than overwriting it. Reuse the original identity after a
lost response. After receipt eviction, a stale original version still fails: receipt
absence is not permission to replay. A retained receipt can accompany newer current
state; its own `version` is the original commit version.

`composition.undo` undoes only the latest retained layout transaction and creates
a new version. It never changes buffers, resource bytes or native requests.
`view.protection.set` is a separately granted operation. Ordinary mutations cannot
close, move, replace or rebind protected views, including movement/reordering of an
ancestor. Protection survives layout undo; undo cannot unprotect a view. Legacy
`composition.put` cannot overwrite structured state. `view.close` needs a changeId
for structured compositions and releases only its rendering relationship.

`interaction.selection.read/set` distinguishes `{kind:"caller"}`,
`{kind:"view",id}` (also caller-isolated), and `{kind:"shared",id}` channels.
Selections carry exact document UTF-16 ranges or immutable table entity references.
They have independent conditional versions and receipts; one Agent's private
selection never replaces the human's selection. Legacy `selection.set` is retained.
The workspace shell links views of one table version through one shared channel,
`linked:<id>@<version>`; see [plugin UI](PLUGIN-UI-HANDOFF.md#five-registered-entries).

## Feedback and explicit response

The ninth owner, `annotations`, requires Documents and optionally consumes Tables
for table anchors. `annotation.create/read/list/reply` keeps immutable submitted
messages, anchors and explicit reply relationships, not another mutable buffer.
Feedback and response drafts are ordinary shared Documents buffers.

Document anchors name an exact buffer version and complete UTF-16 range; the
Documents owner rejects ranges splitting a surrogate pair. Table anchors name an
exact resource version and declared stable entity keys; Tables verifies uniqueness,
namespace and membership. Submission freezes the source excerpt/entities and draft
content/source/digest. Later source edits produce `version-differs`, not an automatic
rebase. Missing sources leave the acknowledged snapshot intact.

Prepare selected feedback versions with `context.create`, `expectedVersion:0` and
a stable changeId. Context freezes those messages and their original object snapshots.
`context.read` records the fetching identity and separately reports whether explicit
linked replies exist. Prepared, tool-fetched and explicitly replied are distinct
facts. None proves understanding or task completion. Agent explanations and shared
outputs remain ordinary documents, and can be checked independently of chat text.

## Observation and recovery

Events are invalidation hints, never another state owner. Capability, composition,
view closure, scoped selections, annotations and context transitions invalidate their
facts. Private selection/context events are caller-scoped. A failed event publication
interrupts affected observers with a gap; it does not roll back persisted owner state.
Slow subscriptions are interrupted at the configured writable-byte limit.

The `@rho-workspace/local/observation` entry has no Node filesystem or DOM imports.
`ObservationClient` accepts an injected transport; `httpObservation` supplies Fetch
HTTP/SSE. Each initial connection/reconnect starts with a snapshot, and invalidation
or an event gap causes another snapshot. Reconnect and frame budgets are explicit;
exhaustion stops observation without changing owner state. The Node connection and
native-intent file client remains a separate entry.

Choose `format:3` explicitly for `workspace.save/export` to preserve capability
selection, structured compositions/history/receipts/protection, shared selections,
annotations and necessary context snapshots, alongside existing drafts/resources.
Formats 1/2 remain readable. Older exports reject new state they cannot represent,
rather than silently omitting feedback/protection. Private selections, credentials,
session grants, bindings and native task replay are not imported.

Restore verifies manifest coverage and file digests before applying owner imports.
Each missing owner or conflict is reported and the verified source archive remains
in place as `retainedArchive`. Missing owner content is not deleted or installed;
reselect the owner and explicitly restore again. Imported capability selections do
not enlarge the service allowlist or import permissions. Restored source references
retain their original provenance and independent versions.

## Budgets

Budgets reject new writes and preserve confirmed content. Configure service budgets
through `--limits` JSON or the corresponding `ServiceConfig` fields.

| Resource | Configuration | Default | Exceeded behavior |
| --- | --- | --- | --- |
| Annotation threads/messages | `annotations.maxThreads/maxMessages` | 128 / 256 | Reject new submissions |
| Annotation metadata | `annotations.maxAnnotationBytes` | 32 MiB | Reject new submissions/restores |
| Agent contexts | `maxContexts/maxContextBytes` | 128 / 1 MiB each | Reject new preparation |
| Composition nodes/history/receipts | `workspace.maxNodes/maxUndo/maxReceipts` | 256 / 32 / 256 | Reject nodes; expose evicted history/receipt boundaries |
| Composition bytes | `workspace.maxBytes` | 32 MiB | Reject transaction, retain previous version |
| Interaction channels/bytes | `interactions.maxSelections/maxSelectionBytes` | 128 / 1 MiB | Reject new write |
| Interaction receipts | `interactions.maxSelectionReceipts` | 256 per channel | Evict oldest, expose retained-from version |
| Capability receipts | `capabilityLimits.maxReceipts` | 256 | Expose retained-from version; stale replay fails |
| Workspace metadata | `workspace.maxMetadataBytes` | 32 MiB | Reject export/restore |
| Observation reconnects/frame | `observationLimits` | 8 / 64 KiB | Stop observer and retain facts |

Document, file, context and event budgets also remain in [Headless](HEADLESS.md).
There is no global scientific revision and no second native execution journal.

## Executable acceptance

```sh
npm run build
RHO_CORE_BINARY=/absolute/accepted/rho-core npm test
RHO_CORE_BINARY=/absolute/accepted/rho-core npm run acceptance:collaboration
RHO_CORE_BINARY=/absolute/accepted/rho-core npm run acceptance:collaboration:agent
```

The deterministic scenario uses a real SDK stdio MCP transport plus an independent
HTTP human. The actual Agent variant invokes Claude Code twice: discover delivered
Skills and build the composition, then consume anchored feedback, conditionally
edit the shared artifact and submit explicitly linked replies. It asserts owner
state, delivered Skill fetches and context receipts, not model success prose.
Model failure/unavailability is failure, never replaced with deterministic output.
Both variants restart, reconcile two observers and restore a format-3 archive.
Bridge instrumentation requires exactly zero Host starts and native dispatches.

`test/native-collaboration.test.mjs` separately executes an explicit disposable R
script with an owned Host: close does not cancel; duplicate submit adds no dispatch;
owned Host loss stays unknown under the original identity. The previously accepted
public Core binary is reused by digest, not rebuilt from the current Core checkout.
The packer accepts `--core-composition` to preserve that recorded source/artifact
association. Package installation must be outside all three source checkouts.

Source and real-model checks have passed in development. Installed candidate
identities/results are recorded separately after checking fixed source commits;
this document alone is not installation evidence. The conclusion is limited to
headless collaboration, not browser input, visual experience, accessibility,
remote collaboration, native windowing, registry publication or signed release.
