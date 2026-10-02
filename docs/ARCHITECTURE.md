# Rho architecture

This page describes current ownership and the invariants that implementation must
preserve. [Status](STATUS.md) records executed evidence and remaining gaps.
[Next Version](NEXT-VERSION.md) defines the target design; its headless interfaces,
external-Agent direction and faster development path are not all current features.

## Repository ownership

The application repository (Rho) owns ui/, examples/, dev.mjs and artifact assembly.
Rho-core owns crates/, public SDK source and generic CLI/HTTP/MCP transports.
Rho-plugins owns plugins/, native scientific code, Jet/patches and plugin builders.
Core and plugins each have a self-contained Cargo workspace. Consumers carry a
pinned public SDK snapshot; only core maintains its source. Application generation
uses that snapshot and produces external assets, never embedded core assets.

The HTTP adapter stays with core but accepts application assets and an existing
application-selected default project. It no longer embeds scientific example files
or the application shell. The application owns example preparation. Local dev
coordination does not create another runtime or scientific operation flow.

### Future release ownership

The agreed distribution boundary keeps these three source repositories. Rho owns
the product's component selection and application assembly. A future Rho-releases
repository will own promotion of an accepted combination into an official release,
signing/notarization, release assets and stable installation/update endpoints.
This release repository and its workflows are not implemented by the source split.

A release identifies immutable application/core commits, public SDK snapshots,
each selected plugin artifact and its source, target platform, and acceptance
evidence. Product release versions are independent of component versions. Branch
names and movable tags cannot substitute for resolved source and artifact identities.
The existing source lock and composition receipts are inputs to this record.

Builds and acceptance run without signing or publication credentials. A separate
release stage verifies and promotes the selected candidate, preserving unsigned
and signed artifact digests; it does not rebuild source during promotion. Repository
separation alone does not establish this permission boundary. Release authorization
governs software distribution and adds no approval step to scientific Operations.
See [the future release design](RELEASE.md#future-official-release-boundary)
for ownership, sequencing and the implementation milestone.

## Authority and ownership

### Authorized unified plugin boundary

The generic Host composes plugin services, Operation/Query ports, application
presentation state and project ownership. Ordinary packages own scientific
semantics. Current source includes sixteen packages, including R, Files, Editor,
Environment, Process, Remote, Agent, Annotations, Manager and Studio.

| Owner | Responsibility |
| --- | --- |
| `rho-host` | Composition, canonical project lease, shared public ports and disposable test Hosts |
| `rho-plugins` | Immutable packages, instances, provider routing, grants, resources and plugin presentation/development lifecycle |
| `rho-operation` | Admission, idempotency, original-operation records, commit discipline and query routing |
| `rho-sqlite` | Operation journal and generic application persistence |
| Domain plugin | Native domain state, preconditions, execution, observations and recovery interpretation |
| CLI, Workbench and MCP | Transport and presentation edges over the same Host |

`NextHost::open_plugin_workspace` is the default composition. Opening a project
never discovers or starts R, silently installs packages, or falls back to fixed
scientific owners. The canonical project lease is independent of a scientific
plugin. A second database does not bypass an existing project's writer ownership.

The core has no direct dependency on R/Ark or the Agent execution libraries.
This is not a claim of complete semantic separation: current local caller defaults
still enumerate scientific scopes, and several context/document integrations carry
view identities. The next version must remove those dependencies deliberately.

## Packages and instances

Source revisions and built artifacts have separate content identities. A manifest
declares dependencies, capabilities, schemas, required scopes, views, contexts and
an optional backend. Display versions and package origin never grant authority.
Imports validate containment, inventories and hashes without building or executing
code. Execution uses immutable artifact bytes, never a mutable development tree.

Activation captures the exact project, principal, revision, artifact, configuration
and selected grants. Required dependencies are exact; optional requirements grant
nothing until explicitly selected. Declared requirements cannot widen the caller's
existing authority. Backend Initialize/Ready precedes capability publication.
Resolution returns an exact provider binding; ambiguous matches require selection.

View closure and instance release are different. Drain fences new calls and waits
for accepted work, retained resources and confirmed native cleanup. A missing
handle, disconnected transport or recorded lifecycle state is not proof of quiet.
Failed cleanup retains identity, diagnostics and source protections. Normal Host
shutdown suspends confirmed instances; reconnect/resume is explicit and does not
replay scientific work or restore R memory.

See [public protocol](../sdk/plugin-protocol/README.md) and
[backend SDK](../../Rho-core/crates/plugin-sdk/README.md) for exact fields, quotas and messages.
Other languages can implement this same protocol; a Python fixture demonstrates
that boundary, not a shipped Python product or a production TypeScript backend.

## Requests and results

Queries make bounded observations. They carry source, time, status, completeness
and continuation information, and never start a runtime or recover work merely
to read it. Busy, cached, partial, unavailable and empty results remain distinct.
Controls target declared existing state; they cannot manufacture scientific write
authority. Operations represent managed effects and retain their original identity.

An effectful request follows this path:

1. Validate caller, project, declared scope, schema, provider and native preconditions.
2. Admit one original Operation under a stable client request identity.
3. The selected owner performs the native action and returns a CommitPlan.
4. The gateway commits operation transition, domain facts and outbox events in
   one journal transaction. Native effects are not part of that SQLite transaction.

An idempotent retry must retain the original caller, target and exact request.
Cancellation requested, native cancellation confirmed, terminal outcome and rollback
are distinct. Disconnecting an HTTP/MCP wait does not cancel accepted work.
Results and emitted output must not be used interchangeably as completion proof.

A lost commit acknowledgement preserves the original candidate and recovery
material. `operation.commit_status` distinguishes retained volatile and durable
candidates. `operation.reconcile_commit` checks the original identity, scopes,
digest and size, then settles that candidate without executing it again. Missing
or uncertain evidence never becomes success or proof that no effect occurred.

Delegated calls keep the original parent, provider, arguments and caller scope.
Accepted children survive dropped observation waits. A parent cannot settle by
forgetting outstanding children. Agent-owned tool receipts are correlation records,
not a second scientific journal. Already-authorized work receives mechanical
validation without another Rho approval decision.

## Scientific state and observations

Native identities belong to their owners: filesystem bytes and file identities,
R native sessions and object references, Git revisions, environment realizations,
remote job IDs and document versions. There is no global scientific revision or
transactional rollback spanning these systems. External changes can occur outside
the managed Operation path.

Files reads retain normalized project roots, native identity, content hashes and
bounded continuations. Pages from changed files cannot be merged. Disk content
cannot substitute for an unsaved document draft. Source links never expand scope;
protected paths and symlink containment are checked at the actual read/write edge.

Editor actions retain the selected document, captured text, expected draft version
and disk base. Save-and-run verifies saved bytes before executing that capture;
later typing remains a newer draft. Delayed receipts cannot overwrite it. A source
run remains inspectable through its original child Operation after the Editor
provider disconnects. See [Editor source](../../Rho-plugins/plugins/editor/backend/src/actions.rs).

R owns its native session and serial execution queue. Admission precedes enqueue;
retries do not enqueue again. Reads respect the native lane. Read/control capacity
is separate from waiting execution so stdin and cancellation remain observable.
Input replies bind the original session/request and are never replayed as code.
Unsettled final commits retain the execution lane and uncertainty.

Object observation does not force promises, active bindings, unknown ALTREP or
user-defined print/accessor methods. Known storage readers expose bounded values;
unsupported objects remain metadata. Before native execution, the owner revokes
old observation references. Failed or uncertain execution cannot restore them.
Paged reads, table operations and clipboard publication retain one original
reference; changing sessions or expiring references prevents stale completion.

Installed package observations belong to the live R owner: library order, installed
copies, loaded namespaces and attached packages are different facts. Grouped counts
and copy details share an observation and native session. Inspection does not
install, load, attach, update or test loadability. Recorded source, delivery
repository and project URLs are separate; absent provenance stays unknown.

R/Viewer owners retain original output bytes and producing-run identities. Viewing
an artifact does not execute its generating code. Annotations retain source versions
and frozen evidence; captured screenshots are labeled user evidence, not original
scientific media or proof of all underlying data. Owner-supplied source lineage and
version checks govern continuation. Annotation access does not expand source access.

## Recovery and execution resources

R memory is private to a native session. Restart fences old requests with a new
native identity. A clean restart starts a new continuation lineage. Reconnecting
to a live process and starting a replacement process are different operations.

Recovery copies capture a supported object graph, with shared references, source
session, lineage, environment/version evidence, coverage, size and integrity hash.
They do not capture process stacks, queued code, stdin, live connections or Agent
instructions. Unsafe/unsupported roots are excluded whole. Capture never calls
unknown serializers merely to discover whether an object is safe.

Private staging is flushed, hashed and atomically published; only a committed
manifest becomes latest. Restore validates in a fresh candidate before publication.
Failures leave the original untouched. Automatic selection stays within one lineage;
retention preserves required, pinned and in-use copies and refuses unsafe cleanup
when reference accounting is incomplete. Maintenance yields to user work. Recovery
is not a promise to preserve arbitrary external resources.

Environment owns plans, realizations, verification, staging and native cleanup.
R recovery references keep required environments retained even when sessions stop.
Process and Remote own their execution resources; uncertain remote submission is
inspected by original native identity, never automatically resubmitted. Shared
process supervision handles bounded output, cancellation and cleanup evidence.

## Context and Agent boundaries

Public context contributions provide bounded search and preview. References capture
the exact provider plus owner-defined selectors/versions; preview revalidates the
source rather than silently refreshing historical input. Current references also
carry a window. A reference is neither source bytes nor authorization.

The current ordinary Agent package owns Native/Rho tasks, model execution, credentials,
attachments, handoff and captured input. Rig is confined to its engine; native
provider clients and its private MCP transport remain package-owned. Original Sends
retain source bytes/provenance and exact tool selections. New Sends do not inherit
ungranted targets; model output cannot expand scope or supply trusted provenance.
Private endpoint closure does not prove native process quiet or scientific cancellation.

Manual handoff appends reviewed material to an existing target draft under its
version/controller checks. It preserves attachments and permissions and does not
send or transfer scientific ownership. Credentials stay out of task/context logs.
Plugin storage has no independent scientific-journal writer.

The next-version target uses external Agents without requiring this package.
Current Studio Ask Agent still selects `org.rho.agent`; removing that dependency
is future implementation, not an accomplished consequence of this documentation.

Standard `.agents/skills` files are available to external clients. The fixed Skill
owner/catalog is removed; no replacement implicit catalog or private-product scan
is permitted. Future package methods must retain explicit source authority,
revision/resource identity, bounded reads and symlink containment. Content never
grants capabilities. Live discovery takes precedence over stale usage examples.

## UI and development lifecycle

The generic shell starts in `ui/src/app.ts`; ordinary plugins own scientific views
and document models through the public SDK. Views run in opaque sandboxed iframes;
credentials stay outside. Caller/window identity, message sequence, grants and
resource quotas are checked. Late results cannot overwrite newer observations or
reopen closed views. Closing preserves acknowledged drafts and accepted operations;
abrupt disposal cannot certify that unacknowledged edits were saved.

Plugin Studio uses public source/checkpoint/build/preview/test ports. A checkpoint
is immutable source, not a build. A build uses declared source and existing tools;
a successful artifact does not change a running instance or scenario. Branch
updates use expected heads. Invalid drafts remain editable without becoming valid
checkpoints. Scenario restoration creates a new checkpoint and never rewinds
scientific effects or credentials.

Fixture previews start no backend and have no scientific grants. Real backend tests
use disposable projects with independent journals and exact dependency selections.
Test reads cannot create/recover a child. Stop requires confirmed cleanup; retained
journals and original-operation links survive. Source editing, preview, test and
application remain separate outcomes. See [Plugin Studio](../../Rho-plugins/plugins/studio/README.md).

The next-version development unit is a headless capability and its contracts.
Frontend delivery remains a separate consumer milestone. Existing window-bound
flows remain until explicitly replaced; document/view identity checks must not be
removed merely to make an API appear headless.

## Source map and trust boundary

Locations below are relative to their owning repository.

| Location | Current implementation |
| --- | --- |
| `crates/plugin-protocol`, `crates/plugin-sdk`, `sdk/` | Public wire types, backend and UI SDKs |
| `crates/contract`, `crates/operation`, `crates/host` | Shared ports, execution records and composition |
| `crates/plugins`, `crates/adapters/sqlite` | Package/presentation lifecycle and persistence |
| `crates/process-engine` | Generic native process supervision |
| `plugins/r/backend/engine`, `vendor/jet-core` | Sole Ark/R engine and pinned upstream dependency |
| `plugins/files`, `plugins/environment`, `plugins/process`, `plugins/remote` | Domain APIs, owners and native implementations |
| `plugins/agent/backend/{owner,store,native,client,engine}` | Current Agent state, persistence, transports and model driver |
| `plugins/annotations`, `plugins/editor` | Evidence/notes and document-linked actions |
| `crates/cli`, `crates/mcp`, `crates/workbench`, `ui/src` | Edges and generic shell |

Owner READMEs and [Development](DEVELOPMENT.md) identify focused verification. Jet is maintained
through [ordered patches](../../Rho-plugins/patches/jet/README.md); preserve upstream notices.

Workbench uses loopback, bearer and Host/Origin checks, bounded requests and
contained assets. Native backends, R and build scripts run as trusted local code
with the user's OS privileges. Protocol/iframe boundaries are not an OS sandbox.
See [Security](../SECURITY.md), [Privacy](../PRIVACY.md) and
[Release](RELEASE.md) for the corresponding operational and delivery limits.
