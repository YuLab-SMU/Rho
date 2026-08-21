# Local Plugin Authoring Foundation

Status: active local-development contract; the project owner authorized rapid
local iteration on 2026-08-21 and explicitly excluded CI and multi-platform
work from the current development loop

Date: 2026-08-21
Issue: [#104](https://github.com/YuLab-SMU/Rho/issues/104)
Owning implementation baseline:
`docs/design/implemented-2026-08-14-plugin-runtime-phase-2-workspace-third-party-design.md`

Change class: D3 because the work exposes the accepted plugin package and Guest
ABI contracts to developers. Current-slice risk: R1 because it adds only a
repository-local developer tool, fixture package, diagnostics, and tests. It
does not change runtime authority, persistence, desktop routing, permissions,
or application behavior.

## Authorization And Stop Point

The owner direction for this workstream is to iterate quickly against the local
machine and not spend the current loop on CI or multi-platform gates. This is
not a waiver that converts local evidence into release, public SDK, or
multi-platform acceptance.

Only F1 is active:

- add an Ark/Tauri-independent `rho-plugin-dev` command;
- add one real project-local Manifest V2 example with a zero-permission Command;
- prove build, package validation, dynamic-call-ID Guest ABI V2 activation, and
  Command result validation locally;
- cover focused rejection paths locally;
- stop for review before adding Tool, Viewer, permissions, desktop UI,
  distribution, or compatibility promises.

The broader #104 outcome remains intact. F2 will extend the same package and
harness with Agent Tool and controlled Viewer contributions. F3 will add the
read-only grant/revoke path and the real desktop workflow. Those packages are
not authorized implicitly by F1.

## Evidence And Problem

The accepted Phase 2 implementation already contains the required runtime
primitives, but the author path is not usable:

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
developer-only crate rather than route author validation through the desktop.

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
7. add one checked-in example project that can be built, checked, and smoked
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
  distribution behavior;
- Agent-authored or self-evolving plugins;
- a second manifest, digest, schema, Wasm, or policy implementation.

## Commands And Contracts

The local interface is:

```text
cargo run -p rho-plugin-dev -- build <project-root>
cargo run -p rho-plugin-dev -- check <project-root>
cargo run -p rho-plugin-dev -- smoke-command <project-root> <plugin-id> <contribution-id>
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

### `smoke-command`

- first performs `check`;
- selects one exact plugin ID and one declared Command contribution;
- rejects packages that request permissions or Commands whose input schema does
  not accept `{}`;
- instantiates the exact snapshotted entry with the accepted no-import Wasm
  host, negotiates the current host protocol, and activates Guest ABI V2;
- invokes with the ordinary host call-ID source, not a fixed test ID;
- accepts only a terminal Complete step;
- validates the result with the declared output schema and
  `PluginCommandResultV1`;
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
- non-Command, permission-bearing, or non-empty-input smoke request;
- guest broker request, guest error, invalid output schema, or invalid trusted
  Command result.

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
Tool, Viewer, read-only permission, and real application author workflow
packages. F1 creates no release or public-distribution decision.

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
active because F2 Tool/Viewer and F3 read-only permission/application workflow
are still open.

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

Next stop: F2 may extend this same local example and harness with one Agent Tool
and one trusted Viewer only after a separate local package activation. F3
permission and real-application work remains later and separately gated.
