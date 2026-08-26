# Plugin-Native Settings Surface

Status: implemented SETTINGS-PLUG-1

Date: 2026-08-26
Authorization: the project owner explicitly requested on 2026-08-26 that the
Settings interface be optimized by extending Rho's modular, plugin-native
architecture and making Settings a plugin
Change class: D3 because the work joins the application-plugin registry,
Surface/Command contracts, global Agent settings, and credential-adjacent
presentation
Risk: R3 because settings revisions, credential-source projection, durable
global configuration, project switching, and trusted UI boundaries meet in one
workflow
Authorized work package: SETTINGS-PLUG-1 only
Mandatory stop: after the trusted Settings host, Models module, read-only
Components module, focused/broad verification, contract review, version/NEWS
synchronization, and one exact debug-app workflow

## Problem And Goal

The Rho Surface Runtime made Editor, Agent, Environment, Console, History, and
other workbench capabilities application-plugin Surfaces, but the current React
shell has no Settings Surface. The previous Model settings experience belonged
to the deleted legacy frontend. The Studio Agent Surface currently exposes only
a narrow model-capacity control, while Provider/model/route truth remains in
the established Rust settings authority.

SETTINGS-PLUG-1 establishes Settings as a first-party application plugin:

```text
internal application plugin
  -> registers rho.settings factory
  -> Surface Runtime creates one trusted-host Settings instance
  -> Settings host registers bounded trusted modules
     -> Models (global Agent model settings)
     -> Components (current project catalog, read-only)
```

The goal is an independently placeable, command-addressable Settings Surface
that follows the same lifecycle, layout, focus, and recovery contracts as other
Rho components without transferring settings authority into layout state or a
workspace plugin.

## Security And Ownership Boundary

- `rho.settings` is contributed by the compiled first-party application plugin
  with `renderer_kind = trusted_host`, `scope = application`, and
  `instance_policy = singleton`. The current Surface Runtime still binds its
  instance lifecycle to the active project snapshot; switching projects closes
  the prior projection instead of carrying project UI state across identities.
- Workspace plugins cannot register Settings modules, imitate a trusted
  Settings page, read global settings, receive credential status, or invoke
  credential/settings mutations through this contract. A future third-party
  Settings contribution protocol requires a separate D3 authority and
  permission design.
- The Rust Agent LLM settings file, V4 schema, monotonic revision, migrations,
  validation, Keychain/system-store/session/environment/file-fallback policy,
  audit log, model compatibility, and no-fallback rules remain authoritative.
- The Settings Surface stores only its selected module ID in bounded
  `view_state`. It never stores a Provider/model settings snapshot, credential
  status, endpoint, API-key value, draft key, or operation result in layout,
  localStorage, sessionStorage, project files, diagnostics, or DOM attributes.
- Credential values are not accepted in SETTINGS-PLUG-1. Provider/model CRUD,
  discovery, connection tests, credential set/delete, destructive workflows,
  and Linux fallback opt-in remain owned by the active CRED-UX and CRED-SEC
  contracts and are deferred to separately reviewed modules.

## Module Contract

The trusted frontend Settings host owns a typed, closed module registry:

```text
SettingsModuleDefinition {
  module_id             // bounded stable application ID
  label
  description
  render                // compiled trusted React renderer
}
```

SETTINGS-PLUG-1 registers exactly two modules:

### Models

- loads one presentation-safe `AgentLlmSettingsView` on mount and on explicit
  retry/refresh;
- shows the effective `agent.chat` assignment, Providers and their configured
  credential source/status, model readiness and capacity, and all projected
  capability routes;
- assigns Chat only through the existing `agent_llm_select_model` command with
  the currently displayed `expected_revision`;
- edits context/max-output capacity only through the existing
  `agent_llm_set_context_capacity` revision-checked command;
- applies success only from the fresh returned view. A stale or failed mutation
  reloads durable truth, keeps the prior assignment visible until that reload
  completes, and reports one bounded actionable error; and
- renders empty, loading, unavailable, invalid-settings, mutation-working,
  success, and failure states without inventing Provider/model readiness.

### Components

- projects the current Surface factory catalog grouped as Rho application
  components or project workspace-plugin components;
- shows stable Surface ID, label, scope, instance policy, and origin;
- performs no enable, disable, install, uninstall, permission, lifecycle,
  project-file, or layout mutation; and
- refreshes naturally with the project projection so one project's workspace
  plugin identities never appear as another project's settings state.

Module navigation is keyboard-operable, uses one selected state, restores from
a valid instance `view_state`, and falls back to Models for missing, malformed,
or unknown state. A module failure is isolated to its content and does not make
the Surface Runtime, project, Workspace R, Agent, or sibling components
unavailable.

## Entry And Presentation

- The application plugin registers `rho.settings` with label `Settings`, one
  interactive `settings` mode, standard sizing hints, and no resource/runtime
  binding.
- `rho.surface.open.settings` is an ordinary application Command available from
  the palette. The Rho menu exposes `Settings…` as a projection of the same
  Surface opening behavior.
- Opening focuses the existing placed singleton when present, restores the
  same singleton when it exists but has been removed from the layout, and
  otherwise creates and places one instance. Duplicate creation is not
  exposed.
- The Surface uses the design-token CSS suite only. At ordinary width it uses a
  compact module rail plus detail; at narrow width it becomes one vertical
  flow without horizontal page scrolling. Loading/error/empty content retains
  a reachable Retry action and visible focus indication.

## Compatibility And Non-Goals

- No settings schema, data path, migration, credential account, Store table,
  Tauri command name, public plugin manifest/ABI, permission, network,
  filesystem, execution, approval, project-transition, or release authority
  changes.
- The additive TypeScript binding for `agent_llm_select_model` exposes an
  already registered Tauri command; Rust mutation semantics do not change.
- The existing Agent model-capacity control remains compatible in this slice.
- Default Studio/Vibe layouts do not gain a permanently open Settings pane.
- Toolbar customization, theme, update, R runtime selection, plugin lifecycle
  management, full Connections/Model library management, and credential input
  are deferred. They may become future trusted modules but are not placeholders
  that claim unavailable behavior is implemented.

## Cross-Review

- `accepted-2026-08-21-plugin-native-surface-runtime-design.md` owns trusted
  application-plugin registration, Surface identity/lifecycle/layout, Command
  projection, and the rule that trusted credentials/settings cannot be hosted
  by untrusted Vibe/plugin documents.
- `active-2026-08-05-system-credential-and-simple-llm-settings-spec.md` remains
  the sole owner of Model routing, Connections, Model library, revisions,
  destructive workflows, recovery, and presentation truth.
- `active-2026-08-26-llm-credential-sources-and-store-hardening-spec.md` remains
  the sole owner of configured credential sources, store behavior, validation,
  overwrite confirmation, audit, and redaction.
- `active-2026-08-22-studio-design-language-and-ux-overhaul-design.md` owns
  design tokens, minimal shell hierarchy, responsive behavior, and visual
  acceptance expectations.

No schema, persistence, permission, credential, layout, or sequencing conflict
was found. This contract changes only the trusted projection and the additive
application Surface/Command registration needed to reach it.

## Acceptance Gate

Focused evidence must cover:

- Rust/application registry: exact trusted origin, application scope,
  singleton policy, stable capability, and additive open command;
- frontend host: Models/Components module registration, valid restoration,
  unknown-state fallback, keyboard selection, and bounded view-state write;
- Models: loading, configured, empty, invalid, refresh, chat-assignment success,
  stale/failure reload, capacity success/failure, and no password/secret
  persistence surface;
- Components: application/workspace-plugin grouping and project-A/project-B
  catalog isolation through independent projections;
- Workbench/mock: menu and command entry, create/focus singleton behavior,
  close/reopen, project switch, normal/narrow layout, and existing Agent
  capacity compatibility; and
- generated binding, Tauri/mock command inventory, TypeScript, ESLint, Rust
  formatting/tests, RSR contract fixtures, browser/mock interaction, production
  frontend build, `git diff --check`, and the complete affected validation
  matrix at integration.

The exact checkout debug build must open Settings from the Rho menu, switch
between both modules, render current model/component truth, close and reopen,
and leave Workspace R plus the active project healthy. No real credential or
live Provider request is used in screenshots or evidence.

## Version, NEWS, And Completion

The plugin-native Settings workflow is user-visible and enters a new
development candidate. After verification and review, all application version
authorities advance from `0.4.1-dev.19` to `0.4.1-dev.20` and `NEWS.md` records
the new Settings Surface. R package versions remain unchanged because no R
package contract or contents change.

This document became `implemented-` after SETTINGS-PLUG-1 passed its focused
and complete affected gates, the exact debug workflow was accepted, and the
final contract/diff review found no unresolved blocking deviation. Installer
construction, signing, publication, and release GO/NO-GO are outside this work
package.

## Implementation And Verification Record

SETTINGS-PLUG-1 completed on 2026-08-26 at application version
`0.4.1-dev.20`:

- the compiled application plugin registers `rho.settings` with trusted-host
  origin, application scope, singleton policy, one `settings` mode, and the
  additive `rho.surface.open.settings` command;
- the trusted React host registers only Models and Components. Models uses the
  generated presentation-safe settings transport and the existing
  revision-checked Chat/capacity commands. Components reads only the current
  Surface factory projection;
- workspace plugins receive no Settings registration, settings transport,
  credential value, or mutation authority. No settings schema, command
  semantics, credential persistence, network, filesystem, approval, or
  project-transition authority changed; and
- the Rho menu and automation entry focus a placed singleton or restore the
  same unplaced singleton. Exact-app review exposed the unplaced-singleton
  recovery gap before completion; the implementation and regression test were
  corrected before the final matrix.

Final automated evidence:

- `cargo test -p rho-ui-contract -p rho-desktop --locked`: desktop `390`
  passed / `22` intentionally ignored, UI contract `53` passed;
- the complete `rsr:check` command matrix passed: every generated-binding,
  fixture, TypeScript, ESLint, architecture, and contract gate passed; the
  final resource-isolated frontend run passed `51` files and `329` tests; and
  production build, browser smoke, interaction acceptance, asset/cutover,
  development-lane, and visual-acceptance harness checks passed;
- `cargo check -p rho-desktop --release --locked`,
  `cargo fmt --all -- --check`, and `git diff --check`: passed; and
- the exact dev.20 debug executable and bundle executable matched SHA-256
  `7d7381b0c6ec6e8bedf872c6774b3649b49a672a0dcb242d5137b4fffd41433b`.

The exact dev.20 macOS debug application opened the Settings singleton with the
durable Models module state, switched to the Components catalog, rendered the
application-scoped Settings identity and current project grouping at the
narrow window size, removed the Settings placement, and restored the same
singleton from the Rho menu with the selected Components module intact. One
Settings tab remained, and Workspace R plus the Agent runtime stayed ready.
Command search also invoked `rho.surface.open.settings` against the already
placed singleton without creating a duplicate.
No Chat model, capacity, Provider, credential, or project setting was mutated
during this installed-app review.

The final contract/diff review found no unresolved deviation. The credential
surface remains presentation-only, the module registry remains closed, project
catalog isolation is tested, stale mutations reload durable truth, and the
only additional opening behavior is the required restoration of an existing
unplaced singleton. Provider/model library CRUD, credential entry/discovery,
theme/update/runtime/plugin lifecycle modules, installers, signing,
publication, and release GO/NO-GO remain deferred.
