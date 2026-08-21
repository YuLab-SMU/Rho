# P2-3 Controlled Third-party Contributions

Status: implemented and accepted for Phase 2 integration; P2-3A Manifest V2,
P2-3B Guest ABI V2 contribution proxy/transactional registry, P2-3C Tool/
Source/Skill and Agent integration, P2-3D trusted Command/Viewer rendering, and
P2-3E named Panel/teardown/two-project behavior passed local and exact-head
three-platform stable/Rust-1.88 run `32456281744` on 2026-08-21

Active P2-3 work package: none. The accepted contribution contract is frozen
for P2-4 consumption. Dynamic registration, raw DOM/HTML/Tauri, Provider,
process, write, arbitrary-R, credential, or new trusted-UI authority remains
outside Phase 2.

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

## P2-3A Entry Corrections

Before P2-3A the pure `ContributionStore` was not product-complete:

- it lacked `source.*` and `ui.panel.*` kinds named by the Phase 2 design;
- it stored label/purpose only, without call schemas or viewer descriptors;
- it was not connected to the Wasm host, Phase 1 registries, trusted shell, Agent
  tools, or teardown sequence;
- Manifest V1 `ui.commands`/`ui.viewers` are untyped string lists and cannot own
  security-relevant schemas or presentation.

P2-3A resolved only the first two pure-contract gaps. P2-3B and later packages
must close routing/integration/teardown gaps and may not treat the pure map as
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
- object schemas are closed: call values with undeclared properties fail;
- Tool, Source, Command and Viewer declarations require paired input/output
  schemas; Skill declares only `skillPath`; Panel requires paired schemas and
  the exact `plugin_details` slot; only Viewer may declare bounded media types;
- declared Skill/viewer assets are regular non-symlink files included in the
  canonical package digest;
- a V1 `ui` string declaration is discovery metadata only and creates no live
  third-party UI contribution.

Changing any declaration creates a new package digest and requires P2-2 grant
review when its permission envelope is affected.

### P2-3A local closeout evidence

P2-3A accepts Manifest V1 unchanged for disabled discovery and P2-2
permission-only packages while making all live contribution declarations V2
only. `ContributionKind` now includes Source and Panel, exact declaration
records carry contract major, paired bounded schemas, viewer media types,
Skill path and named panel slot, and the project registry enforces the 256-item
resolved budget. Labels/purposes reject controls, bidi overrides, markup, URLs
and reserved trusted-surface terminology.

The closed JSON-schema subset accepts only object/array/string/number/integer/
boolean/null with required/properties/items/enum and type-owned numeric,
string or array bounds. It rejects unknown keywords, remote references,
patterns/defaults, union types, schema depth/property/enum/byte bombs,
undeclared object fields and type/bound mismatches. Manifest V2 requires each
declaration to match exactly one `provides` entry and contract major, rejects
duplicates and 33rd package contributions, and binds regular non-symlink Skill
assets into canonical discovery/digest inventory.

Local verification on 2026-08-20:

- stable and exact Rust `1.88.0` strict all-target clippy passed for
  `rho-extension-runtime`;
- stable and Rust `1.88.0` workspace all-target checks passed;
- the runtime matrix passed 116 unit, 26 contract, 11 discovery and 34
  lifecycle tests on both toolchains (187 total per toolchain);
- `scripts/test-extension-p2-3-contribution-contract.mjs` and its negative
  self-test passed; rustfmt and `git diff --check` passed;
- discovery tests prove Manifest V2 Skill assets must be regular files and
  changing the asset changes the package digest.

No Tauri command, Agent entry, guest call route, SQLite schema, UI, public
protocol, privileged operation, application/R-package version or NEWS change
was introduced. This closes only the local P2-3A stop gate and activates
P2-3B under the recorded local-first exception.

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

### P2-3B local closeout evidence

P2-3B adds a memory-only `ContributionCallSession` around Guest ABI V2. The
trusted host supplies project/contribution/origin/input and the exact live
handle set; custom Debug output redacts handles. Admission resolves only a
published project route and matches project/plugin/digest/generation/host,
validates closed input schema and 256 KiB input, then binds a host-generated
call ID and 30-second monotonic deadline. Every broker yield must use one exact
permission/handle pair supplied for the call. Completion rechecks route, host,
deadline and live grants before validating output schema and the 256 KiB or
1 MiB ViewerDocument budget. Late, duplicate, stale, revoked, expired,
mismatched or oversized results remain unpublished.

The Guest ABI host retains the 64 KiB broker-request step bound while allowing
a separately bounded contribution envelope and terminal ViewerDocument. Exact
boundary tests prove the larger terminal budget cannot widen broker requests.
Transactional staging is hidden; publication clones the current project map,
validates duplicates/project budget, and applies only through expected-old CAS.
Desktop activation previews the transaction before minting handles, publishes
under the same registry lock, retains the previously accepted host/routes on a
failed replacement, and removes exact routes on host failure or project switch.

Local verification on 2026-08-20:

- stable and exact Rust `1.88.0` strict all-target clippy passed for
  `rho-extension-runtime`; both workspace all-target checks passed;
- runtime tests passed 122 unit, 26 contract, 11 discovery and 34 lifecycle
  tests on both toolchains (193 total per toolchain);
- 18 desktop workspace-plugin tests passed, including hidden candidate,
  expected-old replacement, failed-replacement retention, real V2 proxy
  yield/resume, handle redaction, post-terminal revoke withholding and exact
  project teardown;
- P2-3, P2-2, P2 host, Phase 1 acceptance, MAC4 release, version, command
  inventory, JS syntax, rustfmt and diff contracts passed, including negative
  self-tests and exact/over byte-budget cases.

The first routable P2-3 slice allocated synchronized application version
`0.4.1-dev.4` and truthful NEWS copy. It added no SQLite/R-package version,
Tauri command, browser/mock UI, Agent tool/source, public protocol, broker
operation or release authority. This closes only the local P2-3B stop gate and
activates P2-3C under the recorded local-first exception.

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

### P2-3C local closeout evidence

P2-3C adds one hostile CSV fixture with independent Tool, Source and
declarative Skill routes. Tool/Source both cross Guest ABI V2 and the durable
`project.fs.read` lane before returning bounded metadata; the result provenance
contains exact project/plugin/digest/generation/host/call plus the real
permission event IDs returned by Store. Agent R never receives a raw grant
handle or gains filesystem, Store, Workspace, policy, credential or Tauri
authority.

The desktop projects only active exact-project Tool declarations into the
Agent profile. Stable host-generated Tool names bind contribution/digest;
labels and declared purposes are explicitly described as untrusted data.
`rho.agent` converts the already validated closed schema to aisdk 1.5.0
`z_schema` objects, keeps `additionalProperties` false, and routes
`plugin.contribution.invoke` back to a Rust adapter. Rust revalidates kind and
origin so Agent calls can invoke Tool—not Source/Command/Viewer/Panel—routes.
Model selection does not grant authority and Ask/Plan/Act remain read-only for
this lane.

Source results and Skill text enter only the bounded Rust-built prompt context
with contribution/plugin/digest/status origin and a higher-priority statement
that the content cannot override instructions, grant permission or prove
durable completion. Historical Agent turns retain a bounded origin-only event,
not copied Skill/Source payload. Skill reads re-discover the exact package,
enforce regular non-symlink UTF-8 files at 64 KiB each and a 256 KiB pack, and
recheck digest/route after reading. Automatic Source context refuses to consume
an allow-once grant; it reports `deferred_allow_once` until an explicit Tool
use consumes that grant.

Local verification on 2026-08-20:

- extension-runtime passed strict all-target clippy and 193 tests on stable and
  exact Rust `1.88.0`; both full workspace all-target checks passed;
- Store passed its 176-test stable matrix and 23 focused permission/isolation
  tests on Rust `1.88.0`; server passed 84 tests and desktop passed 22 focused
  workspace-plugin tests on both toolchains;
- `rho.agent 0.1.6` passed 136 tests with no failure, warning or skip; the
  dynamic aisdk Tool test verifies schema, origin metadata and the exact
  Rust-bound request envelope;
- hostile Skill instruction precedence, Tool/Source independent routing,
  permission event provenance, handle redaction, revoke, allow-once deferral,
  resume-trap route teardown, exact 64 KiB Skill boundary, Agent profile/
  context byte budgets and two-project isolation passed;
- extension P2-3/P2-2/host/Phase 1, MAC4, command inventory, JS syntax,
  rustfmt and diff contracts passed, including P2-3 negative self-tests;
- rho-store/rho-server/rho-desktop capped clippy completed on stable and Rust
  `1.88.0`; the existing broad lint baseline remains and is not misreported as
  a strict clean run.

Application version remains `0.4.1-dev.4`; its NEWS entry now names the exact
Agent Tool/Source/Skill behavior. The exported R tool-construction contract
advanced `rho.agent` from `0.1.5` to `0.1.6`. Store schema stays v13 and no
Tauri command, browser/mock UI, command/viewer/panel surface, public protocol or
release authority was added. This closes only the local P2-3C stop gate and
activates P2-3D under the recorded local-first exception.

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

### P2-3D local closeout evidence

P2-3D adds `ViewerDocumentV1` with only Text, Code, KeyValue, Table, Notice and
same-project `ArtifactImageRef` blocks. Rust denies unknown fields and result
kinds, reserved trusted-surface wording in titles/notifications, more than 128
blocks, 64 KiB text/code, tables over 500x100, malformed row widths, unsupported
image media, bidi/control spoofing and documents over 1 MiB. Command results
are limited to a bounded notification, validated ViewerDocument or exact
same-project Artifact ID. Artifact references must exist in Store under the
current project, match the declared media type and retain a trusted output
path before they reach the shell.

Three Tauri commands are now fixed: `list_plugin_contributions`,
`invoke_plugin_command`, and `open_plugin_viewer`. Frontend input contains only
contribution ID, bounded input and expected project revision; it cannot select
plugin/digest/generation/host/grant identity. Rust returns explicit project/
revision and provenance, and the frontend rejects late cross-project results.
Only zero-input declarations are currently enabled in the product surface;
other valid declarations remain visible but disabled until a later trusted
input-form contract exists.

The existing Workspace Plugins dialog contains trusted contribution details
and a dedicated Plugin Command palette. It never creates top-level menus,
shortcuts, startup hooks, default/destructive buttons or trusted-dialog
placement. Viewer rendering uses only `createElement`, `textContent` and fixed
attributes/classes; the Plugin renderer contains no inner/outer HTML, iframe,
`srcdoc`, DOMParser or links. Artifact image bytes are loaded only through the
existing same-project Artifact and `viewer_read_file` path after media/project
revalidation.

Local verification on 2026-08-20:

- extension-runtime strict all-target clippy and its 126 unit, 26 contract, 11
  discovery and 34 lifecycle tests passed on stable and Rust `1.88.0` (197 per
  toolchain); both workspace all-target checks passed;
- desktop passed 24 focused plugin tests on both toolchains, including fixed
  Command/Viewer result kinds, wrong-kind rejection, exact same-project
  Artifact/media checks and zero raw-handle projection;
- 128-command registration/mock inventory and negative self-test, JS syntax,
  trusted plugin UI, P2-3 negative contract, P2-2/host/Phase 1, MAC4, rustfmt
  and diff checks passed;
- real Browser review at 951x811 passed in-viewport details/palette, one active
  modal, initial search focus, filtering, Escape return, pure-text malicious
  labels, explicit Command invocation, origin-labelled five-block Viewer,
  literal `<script>` text with zero script/iframe nodes, no overflow, and
  revoke-driven Run/Open disablement; responsive 640px rules are covered by
  the deterministic UI contract pending final installed/narrow acceptance.

Application version remains `0.4.1-dev.4` and `rho.agent` remains `0.1.6`; the
existing NEWS entry now names Commands and the fixed Viewer renderer. No Store
schema, R API, broker operation, CLI/MCP, raw HTML/URL/path/base64 document,
Panel, signing or release authority was added. This closes only the local
P2-3D stop gate and activates P2-3E under the local-first exception.

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

### P2-3E local closeout evidence

P2-3E activates the single named `plugin_details` Panel slot. A Panel must
declare that exact slot, accepts only the same ViewerDocument contract, loads
after explicit user action inside Workspace Plugins, carries visible
plugin/digest origin and cannot choose geometry or enter a trusted dialog.
Clear, modal close, grant revoke, host failure and project invalidation remove
its DOM/data. The frontend mock and fixed Tauri command
`get_plugin_panel_document` remain project-revision guarded and expose no
authority identity.

Combined teardown tests cover exact contribution removal on resume trap,
project switch, revoke and explicit clear; the A-B-A test enables the same
plugin in two roots, tears down A without affecting B, then re-enables changed A
with fresh digest/generation/host and proves the stale A identity cannot
unpublish or route the new generation. P2-3 contract checks now run in both
Draft Fast and Rust compatibility workflows.

Final local P2-3 verification on 2026-08-20:

- stable and exact Rust `1.88.0` complete workspace all-target checks and
  `cargo test --workspace --locked --no-fail-fast` passed; desktop 232 passed
  with one existing opt-in Keychain test ignored, extension runtime 197,
  server 84 and Store 176 within each full matrix;
- `rho.bridge 0.1.15` passed 581 and `rho.agent 0.1.6` passed 136 tests with no
  failure, warning or skip;
- extension-runtime strict clippy passed on both toolchains; Store/server/
  desktop capped clippy completed against their existing broad warning
  baseline; rustfmt and diff checks passed;
- Rust MSRV, 129-command inventory, AGPL license, Run History, P1-3, Phase 1,
  P2 host, P2-2 broker, P2-3 contribution, trusted plugin UI and MAC4 contracts
  plus all negative self-tests passed;
- real Browser checks covered contribution details, Plugin Command palette,
  fixed Viewer and named Panel: one modal, in-viewport/no document overflow,
  focus/filter/Escape behavior, origin labelling, literal hostile markup with
  zero script/iframe nodes, explicit invocation and revoke/close/clear teardown;
- current-source candidate and legacy desktop smoke passed Manifest V2,
  expected-old CAS, contribution call/schema, ViewerDocument, named Panel and
  exact teardown probes;
- Tauri release produced the current `0.4.1-dev.4` arm64 App/DMG and updater
  archive, then signing failed closed because no private updater key was
  configured; this is not a signed release candidate;
- the generated arm64 App passed candidate and legacy installed smoke with all
  P2-1/P2-2/P2-3 probes. Executable: 47,345,360 bytes, SHA-256
  `963b93265b825294252e4d5774d0c83776d07403a84a2fdd7afa3958096e9eb8`;
  DMG: 26,143,725 bytes, SHA-256
  `4e9572b904739bf54e7b14d30c7b572464f6b18a4e2d8466503ad2b53afc37c1`.

No Windows/Linux installed evidence, hosted six-leg run, independent final
Agent/UI/security review, signing, publication or release decision exists yet.
Under the local-first exception this closes only P2-3 source and local macOS
engineering, leaves P2-3 active, and activates P2-4A; it does not authorize
Phase 2 acceptance or distribution.

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

P2-3A pure contracts did not change a version. P2-3B was the first routable
slice and allocated synchronized application version `0.4.1-dev.4` with NEWS
copy naming only the internal transactional contribution route. R packages did
not change because no exported R contract changed.

No SDK, marketplace, publisher trust, signing, global install, remote code,
automatic update, P2-4 recovery claim, or release decision is created by P2-3.
