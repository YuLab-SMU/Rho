# Local Plugin Engineering Loop

Status: implemented and locally accepted on 2026-08-21; F1 build/check,
F2 same-component UI/Agent/Viewer, F3A immutable baseline/candidate comparison,
and exact-debug F3B Update/Rollback manual acceptance are complete; the owner
explicitly excluded CI and multi-platform work and clarified that the product
goal is freely evolving, project-shaped software components rather than a
traditional distribution/marketplace ecosystem

Date: 2026-08-21
Issue: [#104](https://github.com/YuLab-SMU/Rho/issues/104)
Owning implementation baseline:
`docs/design/implemented-2026-08-14-plugin-runtime-phase-2-workspace-third-party-design.md`

Change class: D3 because the work exposes the accepted plugin package and Guest
ABI contracts to the local component engineering loop. Current-slice risk: R1
because it adds only a repository-local tool, fixture component, diagnostics, and tests. It
does not change runtime authority, persistence, desktop routing, permissions,
or application behavior.

## Authorization And Stop Point

The owner direction for this workstream is to iterate quickly against the local
machine and not spend the current loop on CI or multi-platform gates. This is
not a waiver that converts local evidence into release, public SDK, or
multi-platform acceptance.

F1 is locally accepted. F2 is now active:

- keep the Ark/Tauri-independent `rho-plugin-dev` loop from F1;
- evolve the same exact Manifest V2 package from one zero-permission Command to
  Command + Agent Tool + controlled Viewer;
- make the one Wasm component dispatch the three contribution identities under
  the same package digest and Guest ABI V2 instance;
- add local smoke commands that validate Tool output schema and trusted
  ViewerDocument output without broadening authority;
- prove that a source change produces a new digest and that the rebuilt exact
  package remains locally checkable and callable;
- stop for review before permission-bearing calls or application integration.

F3 will connect this locally evolved component to the existing exact-digest
update/rollback lifecycle and then add the minimum read-only grant/revoke path.
It is not authorized implicitly by F2.

## Product Direction

Rho pluginization is not currently optimized for a public store, publisher
network, or traditional third-party distribution funnel. Its nearer purpose is
“千人千面”: stable trusted infrastructure underneath project-shaped components
that can be recomposed and evolved without editing the kernel for every user or
workflow.

The engineering loop is therefore:

```text
component source -> local build -> authoritative check -> isolated smoke
                 -> exact digest -> UI / Agent / Viewer contribution
                 -> changed source -> new candidate digest -> review / rollback
```

Marketplace, signing, publisher identity, catalog, and global distribution are
not prerequisites for this loop and are not current milestones.

## Evidence And Problem

The accepted Phase 2 implementation already contains the required runtime
primitives, but the component engineering loop was not usable:

- WAT packages and Manifest V2 examples exist only as private test helpers in
  `desktop/src-tauri/src/workspace_plugins.rs`;
- the private fixtures use a deterministic call ID and therefore are not a
  product-ready example for the ordinary host call-ID source;
- a direct `cargo test -p rho-desktop ...` on the local machine fails in the
  Tauri build script before the focused test because the Ark sidecar is not
  staged;
- a temporary external probe proved that `rho-extension-runtime` alone can
  discover, snapshot, activate, and call a package without Tauri or Ark;
- that probe also showed that `HostProtocolError` does not implement the
  standard error traits, forcing external callers to write avoidable adapters;
- there is no checked-in example project or local package checker.

The shortest path is to expose the already accepted contracts through a small
local engineering crate rather than route component validation through the desktop.

## Goals

F1 will:

1. add a workspace-local `rho-plugin-dev` binary that has no Tauri, Ark, R,
   network, credential, Store, or desktop dependency;
2. compile checked-in WAT source to the manifest-declared Wasm entry without
   following a symlinked output path;
3. validate a project root through the authoritative
   `discover_workspace_plugins` and exact snapshot functions;
4. smoke one zero-permission, empty-input Command through an ordinary
   non-deterministic Guest ABI V2 call ID;
5. validate the returned value against the manifest output schema and the
   trusted `PluginCommandResultV1` contract;
6. emit concise plugin ID, digest, ABI, contribution, and result evidence while
   never printing capability handles or project file contents;
7. add one checked-in component project that can be built, checked, and smoked
   using three short local commands;
8. make `HostProtocolError` usable through ordinary Rust error propagation
   without changing its serialized shape or stable codes.

## Non-Goals

F1 does not add or authorize:

- CI workflow edits, remote runs, CI waiting, or multi-platform validation;
- application, Tauri command, browser/mock, Ark, R, Agent, UI, or installer
  changes;
- a public or stable plugin SDK compatibility promise;
- Tool, Source, Skill, Viewer, Panel, or permission-bearing example calls;
- filesystem, Workspace R, network, write, process, arbitrary R, Provider, or
  credential authority;
- install, catalog, marketplace, signing, publisher, global plugin, or update
  distribution behavior; these are not needed for the current product goal;
- automatic component evolution in F1/F2; these slices build the deterministic
  substrate that a later evolution controller must reuse;
- a second manifest, digest, schema, Wasm, or policy implementation.

## Commands And Contracts

The local interface is:

```text
cargo run -p rho-plugin-dev -- build <project-root>
cargo run -p rho-plugin-dev -- check <project-root>
cargo run -p rho-plugin-dev -- smoke-command <project-root> <plugin-id> <contribution-id>
cargo run -p rho-plugin-dev -- smoke-tool <project-root> <plugin-id> <contribution-id>
cargo run -p rho-plugin-dev -- smoke-viewer <project-root> <plugin-id> <contribution-id>
```

### `build`

- scans only `<project-root>/.rho/plugins/<directory>/rho-plugin.json`;
- parses each manifest through `WorkspacePluginManifest::parse`;
- when `<plugin>/src/plugin.wat` exists, compiles it to the exact validated
  `runtime.entry` path;
- refuses symlinked plugin roots, source files, existing output directories, or
  output files;
- performs a full `check` after writing and reports the resulting package
  digest;
- does not download a toolchain, dependency, runtime, or source file.

### `check`

- calls `discover_workspace_plugins` on the exact supplied project root;
- fails if the plugin root exists and any package has a discovery failure;
- snapshots every discovered exact digest through
  `snapshot_workspace_plugin_package`;
- validates package structure and manifest declarations without executing the
  guest;
- reports `check_ok`, plugin ID, version, digest, runtime kind, and contribution
  count.

### `smoke-command`, `smoke-tool`, And `smoke-viewer`

- first performs `check`;
- selects one exact plugin ID and one declared contribution of the requested
  kind;
- rejects packages that request permissions, kind mismatches, or contributions
  whose input schema does not accept `{}`;
- instantiates the exact snapshotted entry with the accepted no-import Wasm
  host, negotiates the current host protocol, and activates Guest ABI V2;
- invokes with the ordinary host call-ID source, not a fixed test ID;
- accepts only a terminal Complete step;
- validates every result with its declared output schema;
- additionally validates Commands with `PluginCommandResultV1` and Viewers with
  `ViewerDocumentV1`; Tool output remains bound to its declared closed schema;
- disposes the host before returning `smoke_ok`.

The checked-in WAT example must copy the call ID from the actual host envelope;
a hard-coded call ID is a regression and must fail the smoke test.

## Failure Contract

The binary exits non-zero and prints one bounded `plugin_dev_error:` line for:

- missing or non-directory project root;
- absent plugin root or zero valid plugins;
- malformed or unknown manifest fields;
- path traversal, symlink, bounds, digest, or package inventory failure;
- missing WAT source during build;
- unsafe output containment;
- malformed, imported/WASI, missing-export, wrong-export, trapping, rejected,
  or non-V2 Wasm during smoke;
- unknown plugin or contribution;
- contribution-kind mismatch, permission-bearing, or non-empty-input smoke
  request;
- guest broker request, guest error, invalid output schema, invalid trusted
  Command result, or invalid trusted ViewerDocument.

Debug output must not include handles, source contents, arbitrary guest output,
or unbounded project paths.

## Local Verification Matrix

Focused local evidence for F1:

- build the checked-in WAT example in a temporary copied project;
- compare generated Wasm bytes with the checked-in entry;
- `check` accepts the example and returns a stable digest;
- `smoke-command` succeeds with the ordinary call-ID source;
- unknown manifest field fails;
- symlinked plugin root or output path fails where supported locally;
- missing WAT source fails build;
- malformed Wasm and a Wasm module with an import fail smoke;
- changed package bytes change the digest;
- an unknown/non-Command contribution and a permission-bearing package fail
  smoke;
- `cargo fmt --all -- --check` for changed Rust;
- `cargo test -p rho-plugin-dev`;
- focused affected `rho-extension-runtime` tests;
- `git diff --check`.

No CI, remote check, Windows, Linux, other macOS architecture, installed app,
or release check belongs to this local stop point. Those checks are unrun, not
passed.

## Version, NEWS, And Release

F1 is repository-local developer tooling and an example. It changes no shipped
application behavior or R package contract, so it does not bump the application
or R package versions and does not add a `NEWS.md` entry.

The document remains active after local F1 completion because #104 still owns
Tool, Viewer, exact-digest evolution, read-only permission, and real application
component workflow packages. F1 creates no release or public-distribution decision.

## F1 Definition Of Done

F1 is locally complete when:

- the three commands above work from a clean copy of the example project;
- the example uses a runtime call ID and passes exact manifest/schema/Command
  validation;
- focused positive and rejection tests pass locally without Ark/Tauri;
- no runtime authority, persistence, desktop, version, NEWS, CI, or
  multi-platform file changes are present;
- the implementation is reviewed against this contract and deviations are
  recorded before the next package activates.

## F1 Local Checkpoint — 2026-08-21

F1 is implemented and passes its local stop gate. The broader document remains
active because F2 multi-surface components and F3 exact-digest evolution plus
read-only permission/application workflow are still open.

Implemented:

- added the non-publishable `rho-plugin-dev` workspace crate with `build`,
  `check`, and `smoke-command`;
- reused `WorkspacePluginManifest::parse`, broker-owned discovery, exact package
  snapshot/digest, the accepted no-import `WasmPluginHost`, bounded schemas, and
  `PluginCommandResultV1`; no parallel parser or policy was added;
- added `examples/workspace-plugin-minimal` as a real project root with one
  Manifest V2 zero-permission Command, checked-in WAT source, and deterministic
  446-byte Wasm entry;
- the WAT guest copies the ordinary host-generated call ID from the exact input
  envelope and therefore works without the fixed test call-ID source;
- `build` skips valid binary-only packages, compiles source packages, refuses
  symlinked output parents, preserves an existing entry when compilation fails,
  and uses a same-directory partial file for per-entry replacement/recovery;
- diagnostics are single-line and capped at 1024 bytes; successful smoke output
  reports only the validated result kind, not arbitrary guest output;
- `HostProtocolErrorCode` now has stable snake-case display text and
  `HostProtocolError` implements standard Rust error propagation without
  changing serialization or runtime behavior.

Local evidence:

- the three documented commands pass against the checked-in example with
  digest `69424c2468f6bd07eadd56678ce6cd32ff0226dd7d0ab5277c5c2db1d59fc4f1`;
- `cargo test -p rho-plugin-dev --no-fail-fast`: 1 unit and 7 integration tests
  pass;
- positive coverage proves deterministic WAT build, byte equality with the
  checked-in Wasm, exact check/snapshot, repeated ordinary-call-ID smoke, CLI
  redaction, digest sensitivity, and binary-only package coexistence;
- rejection/recovery coverage proves unknown manifest field, malformed Wasm,
  WASI/import, missing source, permission-bearing smoke, unknown/non-Command
  contribution, symlinked output directory, failed compilation preserving the
  old entry, stale partial detection, and recovery after removing the partial;
- `cargo test -p rho-extension-runtime --no-fail-fast`: 127 unit, 26 contract,
  13 discovery, and 34 lifecycle tests pass;
- strict all-target clippy passes for `rho-plugin-dev` and
  `rho-extension-runtime`;
- `cargo fmt --all -- --check` and `git diff --check` pass.

Contract review:

- no authority, Store schema, permission lane, desktop command, mock handler,
  Tauri, Ark, R, Agent, application version, R package version, `NEWS.md`, CI,
  installer, release, or multi-platform file changed;
- the only contract refinement is that `build` ignores valid binary-only
  packages and fails with `no_wat_sources` only when the project has no WAT
  source package. This is narrower mutation and matches the stated “when source
  exists” behavior;
- multiple source packages are built as independent per-entry replacements,
  not one project-wide transaction. F1 makes no all-packages atomicity claim;
- the checked-in WAT uses the current host-envelope prefix to copy a dynamic
  call ID. That is appropriate for a versioned developer preview, not a stable
  long-term SDK promise.

Explicitly unrun: every CI/remote check, every non-local platform check, full
workspace/desktop/Tauri/Ark/R suite, installed application, UI/manual workflow,
installer, signing, publication, and release gate. None is claimed passing.

Next stop: F2 extends this same component and harness with one Agent Tool and one
trusted Viewer under the same digest. F3 exact-digest update/rollback,
permission, and real-application work remains later and separately gated.

## F2 Local Contract — Active 2026-08-21

Owner clarification: the purpose of this stream is a freely evolving local
component system, not an author marketplace. F2 therefore validates one package
as a multi-surface component:

- `ui.command.local_hello` proves direct trusted-shell invocation semantics;
- `tool.local_status` proves the same component can project a bounded Agent
  capability;
- `ui.viewer.local_status` proves the same component can produce a controlled
  ViewerDocument;
- all three declarations share one manifest, one Wasm entry, one package
  digest, and one no-import Guest ABI V2 boundary;
- changing checked-in component source must change the authoritative digest;
  after rebuild, all three smokes must bind to and pass under the new digest.

F2 may add `smoke-tool` and `smoke-viewer` wrappers plus contribution-aware
dispatch inside the example WAT. It may not add a second runtime entry,
permission, Store state, desktop route, Agent implementation change, arbitrary
UI, or distribution concept.

F2 local acceptance requires:

- build/check reports exactly three contributions for the example;
- Command, Tool, and Viewer smokes all pass with the same digest and ordinary
  host call IDs;
- Tool output passes its closed schema and Viewer output passes both its closed
  schema and `ViewerDocumentV1`;
- CLI success output reports only kind/contract evidence and no guest payload;
- wrong-kind selection and stale Tool output schema fail with stable codes;
- a source-only change changes the digest, rebuild succeeds, and all three
  surfaces pass under the new digest;
- focused local tests, strict clippy, rustfmt, and diff checks pass without any
  CI, multi-platform, desktop, Ark, R, version, or NEWS work.

## F2 Local Checkpoint — 2026-08-21

F2 is implemented and passes its local stop gate.

Implemented:

- the same `org.yulab.rho.local-hello` package now declares Command
  `ui.command.local_hello`, Agent Tool `tool.local_status`, and Viewer
  `ui.viewer.local_status` under one Manifest V2 and one package digest;
- the no-import WAT component uses bounded core-Wasm byte loops to recognize
  the requested contribution ID, copy the ordinary host-generated call ID, and
  return the contribution-specific terminal result without bulk memory, WASI,
  imports, or multiple runtime entries;
- `rho-plugin-dev` now exposes `smoke-command`, `smoke-tool`, and
  `smoke-viewer` over one shared admission/activation/disposal path;
- all three paths require zero permissions, `{}` input acceptance, exact
  snapshot identity, Guest ABI V2, a terminal Complete result, and declared
  output-schema validation;
- Command additionally passes `PluginCommandResultV1`; Viewer additionally
  passes `ViewerDocumentV1`; Tool remains constrained by its closed schema;
- successful CLI output reports contribution kind and validated result contract
  only, never the guest payload.

Local evidence:

- the rebuilt 1,138-byte Wasm entry has SHA-256
  `44a615034567ed855b5357cf3187b5d5466d5dfa87c691c2c0df64ada9d1fb4e`;
- authoritative package check reports digest
  `de293a98e0bd24c08ebe75c4e4a7d09e3410fb19e7dd26a104eca45ea364fa3d`
  and exactly three contributions;
- all three documented smoke commands pass with that same digest and ABI 2;
- `cargo test -p rho-plugin-dev --no-fail-fast` passes 1 unit and 7 expanded
  integration tests, including all-three-surface same-digest behavior,
  source-change digest evolution, rebuild and all-three re-smoke;
- wrong-kind selection and a stale Tool output schema fail with stable errors;
- strict `rho-plugin-dev` clippy, rustfmt, and diff checks pass locally.

Contract review:

- F2 changed only the local engineering crate, fixture component, active
  contract, cross-review row, and generated example Wasm;
- no authority, permission, Store, application, desktop, Agent implementation,
  Viewer renderer, Tauri, Ark, R, version, NEWS, CI, platform, installer,
  release, marketplace, author, publisher, or signature surface changed;
- the fixture's contribution-ID dispatch is deliberately a minimal versioned
  component example, not a general guest SDK or long-term ABI promise;
- F2 proves component recomposition across UI/Agent/Viewer and digest evolution;
  it does not yet publish a candidate into the application's durable
  update/rollback lifecycle.

Explicitly unrun remains unchanged: every CI/remote, multi-platform,
desktop/Tauri/Ark/R, installed-app, packaging, signing, publication, and release
check. None is claimed passing.

Next engineering stop: F3 should compose a locally checked candidate with the
already implemented exact-digest update/rollback lifecycle without creating a
second cache, second state machine, or any marketplace/distribution layer.

## F3A Immutable Baseline And Candidate Contract — Active 2026-08-21

F3 is split so the local loop can reuse accepted lifecycle primitives without
pulling application state forward prematurely. Only F3A is active.

F3A adds two local commands:

```text
cargo run -p rho-plugin-dev -- snapshot <project-root> <plugin-id> <cache-root>
cargo run -p rho-plugin-dev -- compare <project-root> <plugin-id> <cache-root> <baseline-digest>
```

`snapshot` must:

- perform authoritative project check and select one exact plugin digest;
- require a real existing cache root outside the mutable project root;
- call the existing broker-owned `PluginPackageCache::prepare_exact` rather
  than copy files or invent a developer cache;
- return the exact cached digest without changing Store lifecycle state,
  manifest source, or application enablement.

`compare` must:

- fail when current source still has the baseline digest;
- load the immutable baseline through `PluginPackageCache::load_exact` without
  consulting mutable source for its bytes;
- snapshot the exact current candidate through the accepted discovery path;
- require the baseline and candidate to expose the same F3A Command/Tool/Viewer
  identities and kinds;
- smoke every baseline and candidate surface independently through the same
  schema/trusted-result validators used by F2;
- report only baseline digest, candidate digest, and validated surface count;
- leave the candidate unaccepted and leave both source and cached baseline
  unchanged.

F3A may depend on `rho-server` only to use its existing immutable package cache.
It may not import desktop orchestration, duplicate cache layout/key/digest
logic, write Store lifecycle state, auto-publish a candidate, or claim that the
application rolled back.

F3A local acceptance requires:

- snapshot caches the original F2 component and read-back bytes/digest match;
- a source change plus rebuild produces a distinct candidate digest;
- compare proves all three baseline surfaces and all three candidate surfaces
  pass independently;
- mutable source changes after snapshot cannot alter cached baseline bytes;
- unchanged candidate, unknown baseline, surface-kind/identity drift, cache
  containment failure, and invalid candidate smoke fail with stable errors;
- local tests, strict clippy, rustfmt, and diff checks pass without CI,
  multi-platform, desktop, Ark, R, Store mutation, version, or NEWS work.

F3B remains separately gated: it will compose a passed candidate with the
already implemented durable expected-old update/rollback transition. F3A is
immutable evaluation evidence, not acceptance authority.

## F3A Local Checkpoint — 2026-08-21

F3A is implemented and passes its local stop gate.

Implemented:

- `rho-plugin-dev snapshot` selects the exact checked component and delegates
  storage/read-back to `rho_server::plugin_package_cache::PluginPackageCache`;
- `rho-plugin-dev compare` loads the immutable cached baseline, snapshots the
  mutable current candidate, rejects an unchanged digest or surface drift, and
  independently smokes every Command/Tool/Viewer surface on both snapshots;
- comparison reports only component ID, baseline digest, candidate digest, and
  validated surface count; it does not emit guest payloads or accept the
  candidate;
- the tool depends on `rho-server` solely to reuse the existing cache owner. It
  adds no cache path/key/digest implementation and writes no Store lifecycle
  row.

Local evidence:

- `cargo test -p rho-plugin-dev --no-fail-fast` passes 1 unit and 10 integration
  tests;
- the positive evolution test caches the original three-surface component,
  changes source, rebuilds to a distinct digest, compares baseline/candidate,
  runs six independent smokes, and reloads the original cached Wasm/source
  bytes after mutable source changed;
- the CLI test performs the same `snapshot -> source edit -> build -> compare`
  loop and reports `surfaces=3` without payload or handles;
- rejection tests cover unchanged digest, unknown baseline, surface drift,
  unsupported Source/Skill/Panel evolution, malformed candidate Wasm, a cache
  inside the project, and a symlinked broker cache root with no write outside
  containment;
- `cargo clippy -p rho-plugin-dev --all-targets --no-deps -- -D warnings`,
  `cargo fmt --all -- --check`, and `git diff --check` pass locally.

Clippy scope note: dependency-inclusive `-D warnings` was intentionally not
reported as passing. It reaches the preserved broad `rho-store` warning
baseline and reports 286 unrelated existing lints. The new crate itself passes
strict all-target clippy with `--no-deps`; tests compile and execute the real
`rho-server` cache path.

Contract review:

- no second cache, lifecycle state machine, permission lane, Store mutation,
  desktop/Tauri/Ark/R/Agent implementation, application version, NEWS, CI,
  platform, distribution, marketplace, publisher, or signing surface exists in
  the F3A diff;
- cached baseline bytes remain immutable and source-independent; candidate
  bytes remain unaccepted mutable project content;
- surface identity must remain stable in F3A. Adding/removing/retyping a
  contribution is treated as `surface_drift` and requires a later explicit
  compatibility contract;
- F3A proves evaluable rollback bytes, not application rollback completion.

Explicitly unrun remains every CI/remote and multi-platform check, full
workspace/desktop/Tauri/Ark/R suite, Store lifecycle transition, installed app,
packaging, signing, publication, and release gate. None is claimed passing.

Next engineering stop: F3B may feed an F3A-passed candidate into the existing
durable expected-old update/rollback transition. It must reuse the accepted
Store and desktop lifecycle owner rather than granting `rho-plugin-dev` direct
acceptance authority.

## F3B Existing Lifecycle Composition Audit — 2026-08-21

The audit found no missing product-code seam. The existing application already
composes an edited local package with the durable lifecycle required by this
engineering loop:

- discovery records a changed source digest as `update_pending` while the old
  accepted route remains active;
- trusted Update submits exact `expected_old_digest`, `candidate_digest`, and
  project revision;
- Update re-discovers the exact candidate, verifies durable pending pointers,
  prepares it through the same broker cache, activates behind expected-old CAS,
  revokes old digest grants, and records the old digest as rollback target;
- trusted Rollback requires exact current/rollback pointers, loads only the
  verified cached target, creates a fresh host/generation and fresh permission
  review where needed, and never rewrites mutable project source;
- project A/B isolation and restart reconstruction already use those same
  identities.

No F3B runtime or UI code was added because doing so would duplicate an accepted
owner. The local engineering handoff is the digest pair already emitted by
`compare`; the trusted shell, not `rho-plugin-dev`, supplies acceptance intent
and current project revision.

Local source evidence:

- trusted Update, trusted Rollback, replacement-foundation, and exact-package-
  cache JavaScript contract checks pass;
- with local test-only `TAURI_CONFIG` clearing bundle `externalBin` and
  `resources`, the focused desktop tests
  `trusted_update_accepts_only_current_candidate_and_revokes_old_digest_grants`,
  `manifest_v2_changed_package_stays_update_pending_and_keeps_old_route`,
  `update_rejects_stale_revision_digest_and_foreign_project_before_cas`,
  `exact_update_isolates_two_projects_with_same_plugin_id`, and
  `exact_cached_rollback_is_fresh_and_restart_reconstructs_accepted_cache` pass;
- the Tauri override affects test bundling only and is not a repository or
  application configuration change.

Remaining local acceptance: the actual desktop UI flow has not been opened
because this checkout has no staged Ark/runtime bundle resources. That manual
observation remains unrun, not failed. It does not justify more lifecycle code.

At this point the source-level engineering loop is closed:

```text
edit -> build -> check -> smoke UI/Agent/Viewer -> immutable baseline compare
     -> app detects update_pending -> exact Update -> cached Rollback
```

The next implementation stream should address component evolution policy and
automation only if it composes these accepted identities. Marketplace, author,
publisher, signing, and distribution work remains unnecessary.

## F3B Local UI Wording Repair — Implemented 2026-08-21

Exact-debug manual review reproduced one stale phase-era message: an
`update_pending` plugin displayed an enabled Update button while its message
claimed Update review was unavailable until a future trusted slice. The trusted
Update slice is already implemented, so the message contradicted the available
action.

Defect invariant: whenever `update_pending` exposes the trusted Update action,
the message must direct the user to review the exact local candidate and must
not claim the action is unavailable. Real Tauri projection and browser/mock
projection must use the same truthful copy.

This is a D1/R1 wording correction with no state, authority, protocol, schema,
permission, or sequencing change. Add a deterministic trusted-Update contract
assertion that rejects the obsolete sentence. Application version and NEWS are
deferred to the next named integration candidate; this local branch must not be
distributed under the existing candidate identity.

## Exact-Debug Manual Acceptance — 2026-08-21

The actual local application workflow passed using the exact checkout debug
executable at `target/debug/rho-desktop`.

To avoid Computer Use selecting another installed Rho with the same bundle ID,
the exact executable was launched through a temporary uniquely identified
`.app` whose only executable was a symlink to that path. Process inspection
resolved the running command to the exact requested debug binary; no installed
or release Rho desktop process was running during acceptance.

Local prerequisites and observations:

- repository-pinned Ark `0.1.252` was downloaded, checksum-verified, and staged
  by `scripts/bootstrap-ark-macos.sh`; R 4.5.2 arm64 started successfully;
- the debug application restored Workspace R, opened
  `examples/workspace-plugin-minimal`, discovered `Local Hello` disabled at
  digest `de293a98e0bd...`, and enabled it to desired-enabled/observed-active;
- Command invocation displayed `Rho local plugin is running` in the real shell;
- Viewer invocation rendered `Rho local viewer is running` through the trusted
  Viewer block renderer with exact plugin/digest origin;
- the Agent layout opened with project R ready. No Provider request was sent;
  Tool execution remained verified by the local ABI/schema smoke and existing
  Agent projection tests, avoiding any external data transmission;
- a reversible WAT source comment plus local build produced candidate digest
  `432f6e9a5e49...`; the real UI showed `update_pending` while contributions
  remained routed to baseline `de293a98e0bd...`;
- the trusted Update review displayed the full accepted and candidate digests,
  then expected-old Update activated `432f6e9a5e49...`; its Command route passed;
- trusted Rollback displayed current `432f6e9a5e49...` and cached target
  `de293a98e0bd...`, then reactivated the cached baseline while leaving mutable
  candidate source visible as designed;
- the temporary source comment was removed and the component rebuilt to exact
  digest `de293a98e0bd...`; Refresh returned the real UI to Enabled/active and
  the Git worktree returned to the committed component bytes;
- after the wording repair was rebuilt, a second reversible candidate
  `f72421f0640b...` showed the truthful message “Review the exact local Update
  before replacing the accepted runtime.” The obsolete unavailable-review text
  did not appear. Source and generated Wasm were then restored again.

The app data retains the enabled example component and verified rollback cache
as local development state. Project source and repository-tracked generated
bytes are clean.

## Final Local Handoff

The local engineering loop is implemented:

```text
edit -> build -> authoritative check -> UI/Agent/Viewer smoke
     -> immutable baseline/candidate comparison
     -> real update_pending -> exact Update -> cached Rollback
```

No CI, remote check, multi-platform validation, marketplace, author/publisher,
signature, catalog, global distribution, or release action was performed.

Version/NEWS decision: no application candidate is created by this local
handoff. The user-visible wording fix and any decision to distribute these
local engineering capabilities require the next unused synchronized
application version and NEWS update in a separately authorized integration
candidate. Until then this branch is local-development-only.
