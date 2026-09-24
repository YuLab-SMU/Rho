# Rho plugin protocol v1

This package contains public TypeScript definitions and JSON Schemas. It has no
runtime dependency on Rho, React, a Studio singleton or a project database. The
Rust source of these definitions is the independently packageable
`rho-plugin-protocol` crate. Other languages can implement the same JSON protocol.

`schema/manifest.json`, `schema/archive.json`, `schema/rpc.json`,
`schema/scenario.json`, `schema/visual-document.json`, and the two
`schema/resource-transfer-*.json` documents define the wire shapes.
Semantic checks (identity formats, references, scope, schema compilation, digests,
limits and lifecycle) also run in the receiving owner. JSON Schema alone does not
grant authority or establish runtime availability.

## Package identity

`plugin.json` declares purpose, display version, exact dependencies, required
capabilities, views, context readers and the optional native entrypoint. There is
no bundled/trusted/origin permission flag. All entrypoints live in `dist/`.
First-party source paths, dependency lockfiles and build instructions are required.
An explicit build command is an executable plus literal arguments; import never
executes it or installs a toolchain.

A `PluginRevision` hashes its parent, manifest and source inventory. A
`BuildArtifact` separately hashes its source revision, target and artifact
inventory. Display versions are labels, never binding keys. `PluginInstance`
fixes the revision, artifact, project, principal and configuration. Several
instances of the same plugin may use different revisions concurrently.

The local `.rho-plugin` archive is UTF-8 JSON with format version 1. It includes
one immutable source revision, zero or more build artifacts and content-addressed
base64 blobs. Paths are normalized relative POSIX paths, and symlinks, special
files, traversal, case collisions, undeclared blobs and digest mismatches are
rejected. Limits are 8,192 file entries and 256 MiB decoded package bytes.
Archives can be unbuilt source checkpoints; activation needs a complete artifact.

## Host lifecycle ports

Active Hosts expose package/lifecycle DTOs from this package through their ordinary
Query and Operation ports. `plugins.repository` identifies the store and backend
target; `plugins.list`/`plugins.inspect` describe immutable installed content.
`plugins.activate` takes `ActivatePlugin`, and `plugins.resolve` returns the exact
`ProviderBinding` used in `PluginRequest`. `plugins.release` drains that selected
instance. A stored `PluginInstanceObservation` does not establish process liveness;
check `observed_in_this_host` together with its lifecycle state. Instance pages
are scoped to the current project and original principal before pagination.

The recovery CLI and active Host use `plugins-v1` beside the configured database,
with an explicit CLI `--store` override. Importing or observing a revision never
activates it. Lifecycle operations use stable caller request identities and the
same authoritative Operation journal as contributed capabilities. The official
MCP connection updates its tool catalog after provider publication or failure;
page cursors cannot cross changed catalogs. The UI SDK remains separate from
these public type definitions.

## Runtime protocol

Each control message is one UTF-8 JSON `RpcFrame` of at most 1 MiB. A connection
has a Host-issued identity and an independent monotonically increasing sequence
in each direction, starting at one. Messages bind an instance and request. A
reconnected process receives a new connection identity; old messages are stale.
Stdout is reserved for control frames, stderr for logs. Large bytes travel through
bounded owner-scoped `ResourceReference` reads, never inline control payloads.

Initialization must finish before contributions become visible. A process may
return a proposed `PluginCommitPlan`; only the core Operation owner may validate
and commit it. Accepted calls retain their exact provider and native target.
An unavailable process, closed connection or cancellation acknowledgement with
`confirmed:false` cannot mean success or confirmed cancellation. Reconnection
does not authorize replay. Reverse calls require the delegated instance grants.

Each capability declares 1–16 valid scientific input `examples` for discovery.
Host callers submit `PluginRequest`: `binding`, `arguments`, and owner-defined
`preconditions`. A binding names the capability version, exact instance/revision/
artifact, project and optional native target. The Host derives the authenticated
principal and scopes; a backend cannot supply or expand them.

An operation may name a same-package query as `preflight`. That query receives
`PluginPreflightRequest` and must return a complete `PluginPreflightResult` with
normalized arguments, native target and owner qualification. It must not start
work or perform effects. A supplied target cannot be changed by preflight. The
Host freezes the result before Operation admission and sends the qualification
as `PluginCall.owner_context` along with the original Operation ID. Queries carry
no Operation ID. Duplicate original requests read their saved record without
running preflight again.

`kind: "control"` contributes a transient handler for an existing owner request.
Use `Control` / `ControlResult` frames with no new `operation_id`; Host callers
use the same `PluginRequest` binding envelope through the Control port. Native
request/answer identities and preconditions remain owner-defined. The Host limits
arguments/results to 256 KiB, redacts validation/native errors, and creates no
Operation, receipt, event, recovery candidate or resource-transfer parent. Only
explicitly selected queries and controls can reach a draining instance. Read the
pending native request after an unacknowledged answer; never replay automatically.

The core bridge wraps native recovery as `plugin_owner_recovery`; transport and
contract failures retain their original candidate under a distinct boundary
recovery. Proposed resource evidence is accepted only after the resource owner
verifies its identity, visibility and digest. Active Hosts compose this resource
owner; a standalone bridge with `NoPluginResources` deliberately rejects evidence.
No verifier fetches arbitrary remote data to satisfy a plugin's claim.

The optional initialization `resource_channel` is an ephemeral per-instance Unix
socket and credential. Data headers are BE u32 lengths plus at most 16 KiB JSON;
`ResourceTransferRequest` and `ResourceTransferResponse` define the language-neutral
protocol. Raw upload/read bytes use this separate socket, not control/stdout.
Uploads inherit the active parent's exact instance/project/principal, verify the
declared length and SHA-256, and become visible only after complete atomic retention.
A query may retain observation bytes without committing scientific facts. Backend
channels read only their own instance's resources; cross-owner reads require a
granted Host query. See the public [backend SDK](../../crates/plugin-sdk/README.md)
for framing and streaming examples.

`resources.list` takes `ResourceList` and returns a scoped `ResourcePage`;
`resources.inspect` takes `ResourceInspect` and verifies the full reference;
`resources.read` takes `ResourceRead` and returns `ResourceChunk`. Host queries
require `resources.read` plus original project/principal visibility, even after
a provider is released. Read offsets and cursors count bytes, not characters.
Limits are 256 MiB per upload, 256 KiB per read, four concurrent transfers per Host,
512 MiB retained per instance and 2 GiB / 16,384 entries per store. A failed or
partial upload is not evidence; lost acknowledgement does not delete complete
retained bytes. Identical uploads resolve to the same immutable resource identity.

UI views use isolated iframes and an instance-bound message channel. They receive
public theme, menu, focus, shortcut, view and resource services, never the Host's
general credential or parent DOM access. Native backends and build scripts are
trusted local code: this is UI, failure and lifetime isolation, not an OS sandbox.

## Scenarios and visual source

Scenarios pin instance aliases, dependencies, configuration, layouts and unique
default providers. A window selects its own scenario; switching does not end
analysis processes. View state carries the revision that authored its schema.
Opening defaults under another revision is explicit; old state is retained.

`VisualDocument` stores a node map with stable identities. Containers, splits,
tabs, text, buttons, forms, lists, tables, media and custom components share this
structure. Data bindings use property paths without `eval`. Operations are only
event actions; render/mount is not an allowed action trigger. Custom source is
referenced by path, never reverse-engineered from the rendered tree. A data-source
capability must additionally resolve to a query when the document is mounted.

Checkpoint configuration uses public values and credential references. Actual
credential bytes remain with the credential owner, outside revision and scenario
storage. History is not a rollback mechanism for scientific effects or R memory.

Regenerate these artifacts from the repository with `npm run generate --prefix ui`.

Public types are emitted as `.d.ts` declarations with ESM `.js` specifiers. They
contain no runtime implementation and do not force a consumer to widen its
TypeScript source root. The external conformance check pins a separate `rootDir`.
