# P2-3 Controlled Third-party Contributions

Status: active under the owner-approved local-first exception; P2-3A Manifest
V2 + pure Source/Panel contract slice activated 2026-08-20 after local P2-2
closeout; P2-1/P2-2 hosted and cross-platform installed acceptance remain open
and mandatory before final Phase 2 acceptance

Active work package: P2-3A only. P2-3B through P2-3E remain inactive until the
Manifest V2/schema/pure-contract stop gate passes. P2-3A creates no product
contribution route, Agent projection, trusted command/viewer UI, persistence,
or new privileged operation.

Change class: D3 capability graph, Agent tool, trusted UI, Wasm protocol, and
cross-project lifecycle behavior. Risk: R3.

## Purpose

P2-3 turns an enabled, permission-bounded Wasm package into useful project
capability without giving it DOM, Tauri, Agent, Store, Workspace R, filesystem,
network, process, credential, or policy authority. The initial contribution
set is:

- `tool.*`;
- `source.*`;
- `skill.*`;
- `ui.command.*`;
- `ui.viewer.*`;
- `ui.panel.*` only in named untrusted-content slots.

The trusted shell owns registration, placement, rendering, invocation,
consequence text, focus, accessibility, teardown, and all permission prompts.

## Authority And Cross-review

- Phase 1 owns capability graph, provider/consumer resolution, scope/
  generation, transactional effects, leases, quiesce/dispose, and candidate
  publication;
- P2-1 owns Wasm execution and no-import resource isolation;
- P2-2 owns Guest ABI V2 begin/resume, grant decisions/handles, and all
  privileged operations;
- existing Agent contracts own tool selection, model context, approvals, Runs,
  and file/environment mutations;
- WP4 project Skills owns instruction trust/containment conventions;
- Viewer/Artifact contracts own project file and output truth;
- P2-4 owns restart persistence, disable/uninstall/upgrade/rollback and final
  lifecycle audit;
- public CLI/MCP gains no execution or contribution interface;
- Phase 3 owns SDK distribution, marketplace, publisher trust, signing, and
  package update channels.

P2-3 introduces no SQLite schema. It consumes the P2-2 v13 grant/audit lane and
keeps live contribution routing in broker-owned memory. P2-4 later reconstructs
that state only from durably enabled exact packages.

## Current-contract Corrections

The existing pure `ContributionStore` is not product-complete:

- it lacks `source.*` and `ui.panel.*` kinds named by the Phase 2 design;
- it stores label/purpose only, without call schemas or viewer descriptors;
- it is not connected to the Wasm host, Phase 1 registries, trusted shell, Agent
  tools, or teardown sequence;
- Manifest V1 `ui.commands`/`ui.viewers` are untyped string lists and cannot own
  security-relevant schemas or presentation.

P2-3 must amend these gaps explicitly. It may not treat the current pure map as
evidence that contributions already work.

## Manifest V2

The host continues to accept Manifest V1 for disabled discovery and P2-2
permission-only packages. A package contributing product capability must use
`schemaVersion: 2`. Unknown fields still fail closed.

Manifest V2 adds:

```text
contributions: [ContributionDeclaration]

ContributionDeclaration {
  id
  kind
  contractMajor
  label
  purpose
  inputSchema?
  outputSchema?
  mediaTypes[]?
  skillPath?
  panelSlot?
}
```

Rules:

- `id` is a validated capability ID and must appear exactly once in `provides`
  with the same contract major;
- `kind` must match its namespace; no `provider.*`, `broker.*`, `policy.*`,
  `approval.*`, credential, process, write, arbitrary-R, or update namespace;
- label 128 bytes and purpose 1,024 bytes, nonempty UTF-8 without controls,
  bidi overrides, markup, URL, or system-dialog terminology;
- maximum 32 contributions/package and 256/project after dependency resolution;
- schemas use the bounded Rho JSON-schema subset: object/array/string/number/
  integer/boolean/null, required/properties/items/enum and numeric/string/array
  bounds only; no `$ref`, remote schema, regex, executable default, or unknown
  keyword;
- schema depth 8, properties 128, enum values 128, encoded schema 64 KiB;
- declared Skill/viewer assets are regular non-symlink files included in the
  canonical package digest;
- a V1 `ui` string declaration is discovery metadata only and creates no live
  third-party UI contribution.

Changing any declaration creates a new package digest and requires P2-2 grant
review when its permission envelope is affected.

## Guest ABI V2 Contribution Calls

Contribution invocation uses P2-2's no-import state machine. The broker calls:

```text
rho_begin(call_ptr, call_len) -> GuestStep
rho_resume(result_ptr, result_len) -> GuestStep
rho_cancel(call_id) -> status
```

The initial `call` envelope binds host-generated call ID, exact contribution
ID/contract major, project/plugin/digest/generation/host, invocation origin,
bounded input, granted-handle set, and deadline. Guest `broker_request` steps
can use only P2-2 handles supplied for that exact call. A final `complete` value
must validate against the declared output schema and byte budget before it is
routable or visible.

Limits:

- one active contribution call/plugin; existing global Workspace scheduling
  remains authoritative;
- eight broker steps, 64 KiB each, 1 MiB cumulative broker results;
- input/output 256 KiB for tools/sources/commands, 1 MiB for ViewerDocument;
- 30-second contribution deadline in addition to P2-1 per-step fuel/epoch;
- cancellation, trap, stale generation, revoke, project switch, Workspace
  restart, output mismatch, duplicate completion, or late result cannot publish
  a contribution result.

No guest can register a new contribution at runtime, change schemas/labels,
select a project, add a handle, or mutate the capability graph. All live
registrations derive from the exact validated manifest.

## Transactional Registration

Enablement sequence:

1. validate package/digest, Manifest V2, dependencies and permission envelope;
2. create P2-1/P2-2 exact host session and activate Guest ABI V2;
3. build all contribution proxies hidden from routing;
4. validate every schema, Skill asset, viewer media/slot and shell descriptor;
5. register all effects into a candidate project generation;
6. publish with expected-old CAS;
7. only after publication expose commands/viewers/panels and Agent tools/sources.

Any failure rolls back every contribution, handle and host. Duplicate
capability, partial UI registration, stale project/generation, shell rejection,
or guest activation failure leaves the old accepted generation unchanged.

Every record binds exact project, plugin, package digest, contract major,
activation generation and host instance. Quiesce closes routing before waiting;
dispose removes Agent entries, sources, commands, viewers, panels, event
listeners, timers, payload leases and handles in reverse effect order.

## Tool Contributions

A `tool.*` declaration becomes an Agent-visible typed proxy, not a Rust trait or
Wasm function pointer exposed directly to the model.

- tool name, input schema, purpose and plugin origin/digest are trusted
  projections of the manifest;
- the Agent sees it only for the active project and mode/policy that already
  permits read-only tool use;
- model selection never grants permission; each broker request still uses the
  exact P2-2 handle and existing approval/execution policy;
- no tool may emit direct file/environment mutation, arbitrary R, process,
  credential, Provider, runtime or hidden network request;
- result includes bounded typed data plus provenance: plugin/digest/call,
  permission event IDs, Workspace/run/artifact references and truncation;
- tool failure is one Agent event with stable redacted code; it cannot fabricate
  Run/Artifact/Evidence completion.

The first fixture tool reads one granted CSV and returns bounded column/row
metadata. It never parses or executes project code.

## Source Contributions

`ContributionKind::Source` and a reversible external source proxy are added.
A source is a read-only, bounded project context provider called by trusted Rho
code. It is not a Provider credential source or arbitrary prompt injector.

- source input/output schemas are required;
- result maximum 256 KiB and every field is treated as untrusted project data;
- Agent context labels plugin/package origin and applies existing injection/
  truncation boundaries;
- source calls cannot mutate, prompt for permission invisibly, or run on project
  open merely because they exist;
- candidate error never falls back to a different digest or legacy source.

The fixture source exposes metadata from the same granted CSV independently of
the fixture tool, proving source/tool routing and teardown separately.

## Skill Contributions

`skill.*` is declarative only. `skillPath` resolves inside the exact package
root using the same symlink/reparse/root validation as discovery. The Skill:

- is UTF-8 plain Markdown with manifest-declared files, 64 KiB/file and 256 KiB
  pack budget;
- carries project/plugin/version/digest/capability origin;
- is added only to future exact-project Agent context while the contribution is
  active;
- cannot override system/developer/user instructions, grant/policy decisions,
  evidence truth, approval consequences, or tool schemas;
- cannot read referenced files by itself; references require existing bounded
  context or P2-2 handles;
- disappears after quiesce/disable/project switch while historical turns retain
  truthful origin metadata.

The fixture Skill explains how to invoke the fixture tool/source and contains
adversarial instruction text used to prove precedence and origin labelling.

## Trusted Command Contributions

`ui.command.*` appears only in a Plugins section of the command palette and an
optional trusted plugin-details surface. The shell renders a fixed plugin icon,
origin badge, label, purpose and exact project.

- no top-level menu, global shortcut, automatic invocation, startup hook,
  default button, destructive styling, or trusted-dialog placement;
- label/purpose remain text, never HTML/Markdown/URL;
- disabled/unavailable states explain missing grant/host/stale project;
- invocation requires explicit user action and uses the declared input schema;
- a command cannot call arbitrary Tauri commands or synthesize keyboard/menu
  events;
- result is a bounded notification, Artifact reference, or ViewerDocument; the
  shell decides rendering and follow-up actions.

The fixture command invokes the fixture tool with a user-selected project CSV.

## Viewer And Panel Contributions

The authorization choice is host-rendered descriptors only. No iframe,
sandboxed plugin page, WebView, arbitrary HTML, CSS, JavaScript, SVG event,
remote image/font, `data:` document, or direct DOM node is accepted.

```text
ViewerDocumentV1 {
  title
  blocks[]: Text | Code | KeyValue | Table | Notice | ArtifactImageRef
}
```

Bounds: 128 blocks, text/code 64 KiB each, table 500x100, total JSON 1 MiB.
Every string is inserted with text APIs. Code is display-only. Image uses an
existing same-project Artifact ID/media type and trusted viewer path; raw file
paths/URLs/base64 are rejected. Links are absent in V1.

`ui.viewer.*` opens only after a user/Agent action with a typed same-project
input. `ui.panel.*` may render the same descriptor in the single named
`plugin_details` slot; plugins cannot choose geometry, overlay dialogs, hide
origin, persist global layout, or imitate Approval/Credential/Updater/
Environment/Git/destructive surfaces.

The fixture viewer renders CSV metadata and one same-project Artifact image
reference. The panel remains optional but, if implemented for Phase 2
acceptance, uses the same renderer and teardown tests.

## Public Commands And Mock Contract

Proposed trusted commands:

```text
list_plugin_contributions
invoke_plugin_command
invoke_plugin_tool
query_plugin_source
open_plugin_viewer
get_plugin_panel_document
```

Names become fixed only at activation. Requests include the currently selected
normalized project and host-generated contribution call identity; the frontend
cannot supply plugin/digest/generation/permission authority. Browser/mock mode
implements deterministic disabled/loading/ready/permission/stale/trap/oversize/
disposed states without pretending to execute untrusted code.

## Work Packages And Stop Points

Ordinarily P2-3 activates only after P2-2 acceptance. The owner-approved
local-first exception permits sequential local engineering after the recorded
P2-2F local stop gate, while hosted/cross-platform evidence remains mandatory
before final acceptance:

1. **P2-3A — Manifest V2 + schema bounds + Source/Panel pure contracts**;
2. **P2-3B — Guest ABI V2 contribution-call proxy + transactional registry**;
3. **P2-3C — fixture Tool/Source/Skill and Agent integration**;
4. **P2-3D — trusted Command/Viewer descriptor renderer**;
5. **P2-3E — optional named panel, teardown, two-project and installed review**.

Stop after each slice. No UI may precede its routing/teardown truth, and no
Agent contribution may precede project/digest/grant isolation.

## Verification Matrix

Required negative/boundary coverage includes Manifest V1/V2 compatibility,
unknown fields, mismatched provide/declaration, schema bombs, Unicode/control/
bidi/markup labels, duplicate IDs, contribution/project limits, transactional
rollback at every registration, stale A-B-A generations, changed digest, wrong
host/project, grant revoke during call, Guest ABI loops/traps/duplicate/late/
malformed results, Agent prompt injection/precedence, Tool/Source isolation,
Skill symlink/size/origin, ViewerDocument schema/size/Artifact ownership,
command focus/keyboard/narrow UI/spoofing, teardown/re-enable/restart, and exact
candidate/legacy behavior.

Full evidence includes stable/MSRV Rust, affected R suites, desktop unit/
command inventory, browser/mock/three viewport review, all three packaged
platform smokes with hostile fixture packages, independent Agent/UI/security
review, version/NEWS agreement, and no public protocol/release authority drift.

## Version, NEWS, And Release

P2-3A pure contracts do not change a version. The first routable P2-3 slice
requires a fresh application development version after `0.4.1-dev.3` and NEWS
copy that names only the exact accepted contributions. R packages change only
if their exported contracts change.

No SDK, marketplace, publisher trust, signing, global install, remote code,
automatic update, P2-4 recovery claim, or release decision is created by P2-3.
