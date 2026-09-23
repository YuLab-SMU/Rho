# Rho plugin protocol v1

This package contains public TypeScript definitions and JSON Schemas. It has no
runtime dependency on Rho, React, a Studio singleton or a project database. The
Rust source of these definitions is the independently packageable
`rho-plugin-protocol` crate. Other languages can implement the same JSON protocol.

`schema/manifest.json`, `schema/archive.json`, `schema/rpc.json`,
`schema/scenario.json` and `schema/visual-document.json` define the wire shapes.
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

The core bridge wraps native recovery as `plugin_owner_recovery`; transport and
contract failures retain their original candidate under a distinct boundary
recovery. Proposed resource evidence is accepted only after the resource owner
verifies its identity, visibility and digest. The default bridge configuration
rejects resource references until that owner is configured. It does not fetch
arbitrary remote data to satisfy a plugin's claim.

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
