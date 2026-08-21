# Plugin-Native Surface Runtime

Status: proposed architecture; implementation is not authorized

Date: 2026-08-21

Change class: D3 because this introduces a shared UI contribution protocol,
command-routing boundary, focus model, and durable layout schema. Future
implementation risk is R3 because plugin lifecycle, project switching,
revisioned persistence, focus authority, and trusted security surfaces meet at
this boundary. This proposal itself changes documentation only.

Working name: **Rho Surface Runtime (RSR)**.

## Decision Summary

Rho should stop treating Editor, Agent, Environment, Evidence, Git, Help,
Console, Problems, Viewer, and Check project as hard-coded panes in one IDE
grid. They should become registered **Surfaces** hosted by a trusted UI kernel.

The trusted kernel owns:

- project and plugin identity;
- surface registration and teardown;
- the user-owned layout graph;
- command resolution and consequence text;
- focus, keyboard, accessibility, theme, and responsive behavior;
- trusted approvals, credentials, updates, permissions, and destructive
  confirmation;
- persistence, revision checks, project isolation, and recovery.

A plugin may contribute a typed Surface and typed Commands. It may not mutate
the root DOM, inject global CSS, imitate trusted UI, choose screen geometry, or
persist layout directly. The user can place any available Surface into any
compatible location in a Scene. This is the intended meaning of “free layout”.

The new product vocabulary is:

```text
Capability   what the component can do
Surface      one visual, focusable projection of that capability
Command      one typed user intent with availability and consequence
Scene        a user-owned arrangement of Surface instances
Context      the current project, selection, task, artifact, run, or finding
```

Agent is a Surface, not a second top-level application mode. Ask/Plan/Act remain
broker policy inside the Agent Surface and are not layout concepts.

## Evidence From The Current UI

The annotated 2026-08-21 screenshot exposes one structural cause behind many
local visual problems:

1. the top bar mixes brand, menus, project, branch, posture, layout preset,
   restart, interrupt, Run, and Check project at nearly equal weight;
2. `Human / Agent` and `Code / Analyze / Agent` duplicate the word Agent while
   describing different state machines;
3. the editor toolbar reserves permanent width for many low-frequency actions;
4. the right column uses a long first-level tab row for unrelated domains;
5. the Agent timeline renders many visible state and deletion controls inside
   every conversation object;
6. attachments, model, Agent mode, submission, and status compete around one
   composer;
7. almost every available operation becomes a visible button instead of a
   contextual command;
8. the major regions are understandable, but each region accumulates its own
   independent navigation and action grammar.

The implementation confirms the problem is architectural rather than cosmetic:

- `index.html` contains a fixed top bar, left sidebar, center workspace, bottom
  Dock, and right context panel;
- layout is controlled through CSS classes and hard-coded functions such as
  `applyWorkbenchLayout`, `switchDockTab`, `switchContextTab`, and
  `applyAgentSurface`;
- project session persistence stores only three pane sizes while additional
  posture/surface state also exists in frontend-local emergency state;
- existing plugin UI can enter a Command palette, Viewer, or the single
  `plugin_details` Panel slot, but cannot become an ordinary work surface;
- first-party UI and plugin UI therefore use different composition systems.

Adding another tab, mode button, or fixed panel will make this worse. The next
frontend foundation must remove fixed placement as a component concern.

## Product Model

### Minimal trusted shell

The permanent window chrome contains only four conceptual controls:

1. **Project** — current project and project switching;
2. **Scene** — current user layout and saved alternatives;
3. **Command** — search, navigation, and the complete contextual command set;
4. **Status / primary action** — one current primary action plus interrupt or
   attention state when required.

Menus may remain as native discoverability and keyboard compatibility, but they
are projections of the same Command Registry. They are not a second command
implementation.

The default wide layout is intentionally quiet:

```text
+-----------------------------------------------------------------------+
| Project ▾   Scene: Work ▾       Search or command…      Status · Run  |
+-----------------------------------------------------------------------+
|                                                                       |
|                 user-owned Scene / Surface Graph                      |
|                                                                       |
|       +----------------------+  +--------------------------------+    |
|       | Editor               |  | Agent / Check / Viewer         |    |
|       | surface-local title  |  | selected contextual Surface   |    |
|       | and 1-2 actions  ··· |  | title · origin · 1 action ··· |    |
|       +----------------------+  +--------------------------------+    |
|                                                                       |
+-----------------------------------------------------------------------+
| optional utility tray: Console / Logs / Problems, collapsed by default |
+-----------------------------------------------------------------------+
```

The graph may contain one Surface. A two- or three-region layout appears only
because the user opened or arranged those Surfaces, not because the shell has
three permanent columns.

### Scene replaces duplicated mode controls

`Human / Agent` and `Code / Analyze / Agent` should converge into one Scene
concept after migration:

- a Scene changes placement and visual priority only;
- it does not start work, grant authority, select Ask/Plan/Act, or create a new
  Workspace R session;
- selecting or focusing a Surface determines which commands are contextual;
- built-in starting Scenes may include Work, Analyze, Review, and Agent, but
  their names are ordinary user-editable presentation presets;
- a plugin may make Surfaces available, but it cannot silently replace the
  current Scene or focus itself.

During compatibility migration, existing Human/Agent posture and Code/Analyze/
Agent presets are projected as legacy Scenes. Their context-preservation and
execution-policy semantics remain intact until an authorized cutover removes
the old controls.

### Surface-local action budget

Every Surface has:

- title, state, and origin;
- zero or one primary action;
- at most two visible secondary actions at ordinary desktop width;
- one overflow menu containing the rest of its contextual commands.

The shell has at most one ordinary primary action. A running operation may add
one persistent stop/interrupt action. This is a presentation budget, not a
reduction of available commands.

The Command Registry remains the complete and searchable interface. Toolbar,
menu, context menu, keyboard shortcut, command palette, Agent tool projection,
and accessibility action all resolve the same command identity rather than
implementing parallel handlers.

## Architecture

```mermaid
flowchart TB
    SHELL[Trusted Shell\nproject · scene · command · status]
    KERNEL[UI Kernel\ncontext · focus · command routing]
    REGISTRY[Surface Registry\nidentity · lifecycle · provenance]
    LAYOUT[Scene Graph\nrevision · placement · recovery]
    RENDER[Trusted Renderers\nhost components · typed documents]
    CORE[Application plugin Surfaces]
    WORKSPACE[Workspace plugin Surfaces]
    BROKER[Rust broker\nproject · plugin · revisions · grants]

    SHELL --> KERNEL
    KERNEL --> REGISTRY
    KERNEL --> LAYOUT
    REGISTRY --> RENDER
    LAYOUT --> RENDER
    CORE --> REGISTRY
    WORKSPACE --> REGISTRY
    KERNEL --> BROKER
    REGISTRY --> BROKER
    LAYOUT --> BROKER
```

### 1. UI Kernel

The UI Kernel owns the current `UiContext`:

```text
UiContextV1 {
  project_id
  project_revision
  scene_id
  focused_surface_instance_id?
  selection?: file | range | run | artifact | object | finding | task
  workspace_health
  agent_health
  active_operations[]
}
```

Commands and Surfaces observe only bounded typed context fields. They do not
read another component's DOM or mutable frontend store.

### 2. Surface Registry

The registry separates definitions from open instances:

```text
SurfaceDefinitionV1 {
  surface_id
  contract_major
  label
  purpose
  renderer_kind
  scope                     // application | project
  cardinality               // singleton | multiple
  accepted_contexts[]
  commands[]
  origin
}

SurfaceInstanceV1 {
  instance_id
  surface_id
  project_id
  plugin_id
  package_digest
  activation_generation
  surface_revision
  context_ref?
  lifecycle_state
}
```

Registration is transactional and reversible. A disabled, failed, replaced, or
stale plugin loses its Surface routes before its host is disposed. An open
layout node then shows a trusted unavailable placeholder with Remove and, when
valid, Repair/Enable actions; it never routes to a different plugin silently.

### 3. Scene Graph

The first layout contract is a bounded tiling graph, not free-form absolute
coordinates:

```text
LayoutNodeV1 =
  Split { axis, ratio, first, second }
  Stack { active_instance_id, instances[] }
  Surface { instance_id }

SceneStateV1 {
  scene_id
  label
  root: LayoutNodeV1
  focused_surface_instance_id?
  utility_tray?: Stack
}
```

Rules:

- maximum depth 8, 32 nodes, and 24 open Surface instances per Scene;
- split ratios are clamped and minimum Surface sizes are host policy;
- move, split, stack, close, and focus are revisioned layout transactions;
- a plugin may request `open(surface_id, context)` after an explicit user or
  authorized Agent action, but the host chooses placement from user policy;
- plugins cannot write Scene state, create overlays, force focus, or reserve a
  permanent rail;
- trusted approval, credential, permission, updater, privacy, and destructive
  confirmation UI is outside the Scene Graph.

This gives users layout freedom while keeping security, accessibility, narrow
viewport behavior, and recovery deterministic.

### 4. Renderer lanes

RSR supports two initial renderer lanes:

1. **Trusted host component adapter** for application plugins such as Editor,
   Console, Agent, Environment, Git, and Check project. Existing DOM and state
   can be mounted through adapters during migration.
2. **Declarative plugin Surface document** for workspace plugins. This extends
   the accepted trusted-renderer principle without granting HTML/DOM access.

The existing `ViewerDocumentV1` remains unchanged for read-only results. A new
interactive contract is additive:

```text
SurfaceDocumentV1 {
  title
  revision
  blocks[]
}

SurfaceBlockV1 =
  Row | Column | Grid | Tabs |
  Text | Code | KeyValue | Table | Notice | ArtifactImageRef |
  Field | Select | List | Group | CommandButton

SurfaceEventV1 {
  instance_id
  expected_surface_revision
  control_id
  event_kind
  bounded_value?
  expected_project_revision
}
```

The trusted renderer owns element creation, labels, keyboard order, validation
display, theme, and disabled/busy states. `CommandButton` names a declared
Command; it contains no callback or script. An event returns either a new
bounded document or a typed command result after stale identity is rechecked.
The plugin owns bounded content grouping and interaction semantics inside its
Surface through Row/Column/Grid/Tabs descriptors; the renderer owns actual CSS,
minimum sizes, responsive collapse, focus order, and accessible roles.

Raw HTML, JavaScript, CSS, SVG events, iframe/WebView custom applications, and
remote UI resources remain out of the initial contract. A future sandboxed
custom-renderer lane requires a separate threat model and authorization; it is
not implied by “plugin has its own UI”.

### 5. Command Registry

```text
CommandDefinitionV1 {
  command_id
  label
  purpose
  input_schema
  consequence
  availability_predicate_id
  placement_tags[]          // palette, surface-local, primary-candidate
  origin
}
```

Placement tags are host-reviewed hints, not authority. The UI Kernel evaluates
availability against typed current context and chooses visible placement under
the action budget. Destructive, credential, approval, permission, update, and
Workspace mutation commands retain their existing trusted admission and
confirmation contracts.

No plugin command gets a top-level button, default status, global shortcut, or
automatic invocation merely by declaring a tag.

## State And Persistence Ownership

Layout is local user preference, not project scientific truth and not plugin
state. The broker owns a versioned, project-scoped UI profile:

```text
ProjectUiProfileV1 {
  schema_version
  project_id
  revision
  active_scene_id
  scenes[]
  last_focused_surface_instance_id?
}
```

Requirements:

- state lives in Rho's application data, not `.rho/plugins`, project files,
  Workspace R, Agent R, or browser-only local storage;
- project A and B cannot share instances, context references, revisions, or
  plugin generation identity even when paths and plugin IDs match;
- a plugin package update never rewrites layout state directly;
- missing/disabled Surface instances become explicit placeholders;
- stale or failed persistence leaves the last durable Scene truthful and does
  not claim a move/close/save completed;
- application crash/reopen reconstructs only current enabled exact plugin
  routes and validates every referenced instance;
- a layout export/import or project-shared Scene file is deferred. It must not
  be guessed from local state or silently committed to a project.

Current `PanelSizes` may be migrated once into a `Legacy Workbench` Scene. The
migration may map only known built-in panels. Unknown or inconsistent state
falls back to a default Scene while preserving the old session snapshot for
recovery; it must not guess historical plugin ownership.

## Plugin Lifecycle And Layout

### Enable

1. validate and activate the exact plugin package under existing Phase 2 rules;
2. transactionally register Commands and Surface definitions hidden;
3. publish routes with exact project/digest/generation identity;
4. show the Surface in the command/search interface;
5. open it only after explicit user action or an already-authorized typed
   workflow requests it.

### Disable, failure, and project switch

1. close contribution routing before host teardown;
2. cancel or reject pending Surface events;
3. replace open instances with origin-labelled unavailable placeholders;
4. preserve the user's Scene structure until they remove or repair the
   placeholder;
5. never move focus to Editor, Console, body, or another plugin implicitly;
6. reject late results by project, digest, generation, instance, Surface
   revision, and project revision.

### Update and rollback

An accepted exact package update keeps a Surface instance only when the new
package declares a compatible `surface_id` and contract major. Otherwise the
instance becomes a placeholder. Cached rollback reconstructs fresh routes and
revalidates the Scene; it never revives an old live host or focus handle.

## Mapping The Annotated UI To RSR

| Screenshot area | Current problem | RSR outcome |
| --- | --- | --- |
| 1 top bar | unrelated controls have equal weight | Project, Scene, command search, one primary action/status |
| 2 mode groups | Human/Agent and Code/Analyze/Agent overlap | one Scene switcher; Agent policy remains inside Agent Surface |
| 3 editor toolbar | many permanent icon buttons | one primary action, up to two secondary actions, overflow and command search |
| 4 right tabs | unrelated domains share one crowded level | ordinary Surfaces in a user-owned Stack; no permanent domain rail |
| 5 conversation card | status and destructive actions stay exposed | typed activity summary; destructive/rare commands in overflow |
| 6 composer | five control families compete | text/attachment/send remain visible; model and policy move to one context disclosure |
| 7 overall density | every operation becomes a button | one Command Registry with contextual projection and action budgets |
| 8 region clarity | good macro-regions, excessive local chrome | preserve visual regions but make them instances in one Scene Graph |

## First Component And Migration Plan

The first component remains **Check project**, because its rule engine and
result UI have clear typed boundaries and low ambient authority. RSR should be
proven with one real vertical component rather than an empty framework rewrite.

No work package below is active until the owner authorizes it.

### RSR-0 — Pure contracts and compatibility adapter

- define bounded Surface, Command, Scene, and event contracts in a module that
  is independent of the frontend renderer;
- add validators, projection fixtures, and lifecycle simulations;
- wrap the existing fixed workbench as one `Legacy Workbench` Scene with no
  visible behavior change;
- register existing first-party commands through one compatibility Command
  Registry while retaining current handlers;
- stop before persistence migration or new plugin UI.

### RSR-1 — First usable Surface: Check project

- register `project.check` as one typed Command;
- register `project.check.results` as an application-plugin Surface;
- move the current Check project trigger out of permanent top chrome and make
  it the primary contextual command only when the project context permits;
- open findings as the dominant Surface, with source/evidence actions routed
  through Commands;
- keep the trusted check orchestrator, project snapshot, execution admission,
  and finding renderer authoritative;
- allow workspace plugins to contribute bounded check rules, not layout or
  trusted result claims;
- prove disable/update/rollback, stale result, project A/B isolation, and
  unavailable placeholder behavior;
- stop before migrating Agent, Editor, or the full shell.

### RSR-2 — Scene host and shell reduction

- make Split/Stack/Surface layout interactive and revisioned;
- reduce permanent chrome to Project, Scene, command search, and status/primary
  action;
- project legacy panes through adapters so the application remains usable at
  every checkpoint;
- retain a one-command fallback to the exact legacy Scene.

### RSR-3 — Agent Surface

- mount Agent timeline and composer as one Surface;
- remove duplicate Agent posture/layout controls only after state and focus
  compatibility tests pass;
- keep Ask/Plan/Act, approvals, Agent dependency health, cancellation, and
  model routing unchanged;
- reduce the composer to attachment, text, and send, with model/policy in one
  disclosure.

### RSR-4 — First-party surface migration

- migrate Editor/Viewer, Console/Logs/Problems, Environment, Evidence, Git,
  Help, and Runs one vertical slice at a time;
- delete fixed grid/tab code only after the equivalent Surface passes exact
  behavior, focus, narrow-layout, restart, and project-switch acceptance;
- never keep two persistent authorities for the same layout state.

## Verification And Failure Matrix

Pure contract tests must cover:

- normal, empty, maximum, just-over-limit, malformed, duplicate, cyclic, and
  excessive-depth Scene graphs;
- unknown Surface, wrong project, stale project/layout/Surface revision,
  changed digest/generation, missing plugin, and incompatible contract major;
- project A/B/A with identical plugin and Surface IDs;
- transactional registration failure, persistence failure, crash/reopen,
  disable, uninstall, update failure, accepted update, and rollback;
- bounded document/event payloads and hostile text/markup/bidi/control input;
- no raw handle, credential, root DOM, Tauri, Workspace, process, or path
  projection.

Frontend/browser tests must cover:

- loading, empty, ready, busy, warning, failure, stale, unavailable, and
  placeholder states;
- open, split, stack, move, focus, close, undo or truthful non-undo recovery;
- keyboard-only surface navigation and command invocation;
- focus and scroll survival across background refresh and plugin teardown;
- action-budget enforcement and complete command-palette discoverability;
- 1440x900, 1280x720, 1024x700, and 900x700 without page overflow;
- long Unicode project/plugin/surface names and text overflow;
- trusted approval/credential/update/permission UI remaining outside plugin
  layout and visibly distinct;
- exact debug-app workflow before any installed candidate.

State mutation requires success, rejection, stale/conflict, persistence
failure, cancellation, restart/recovery, and two-project isolation evidence.

## Authority And Cross-Review

- the accepted Phase 2 and P2-3 contracts remain authoritative for plugin
  identity, activation, permission, Guest ABI, lifecycle, origin labelling,
  typed ViewerDocument rendering, and prohibition of raw DOM/global CSS/trusted
  UI spoofing;
- RSR adds a future `ui.surface.*` contract. It does not reinterpret existing
  `ui.panel.*` or `ui.viewer.*`, and cannot be implemented by silently widening
  their accepted contract;
- Phase 2.5 owns Agent-authored plugin evolution. It may produce a candidate
  Surface declaration later but cannot activate it, mutate a Scene, or bypass
  RSR review and existing plugin grants;
- the Human/Agent posture design and Agent-first adaptive work surface retain
  current presentation authority until an RSR cutover is explicitly
  authorized. RSR proposes that their layout-only state become legacy Scenes;
  Agent policy and context-preservation invariants survive;
- interface modernization retains visual tokens, accessibility styling, and
  current installed acceptance obligations. RSR owns future composition, not a
  competing theme;
- workbench focus stability remains authoritative: background truth updates
  never acquire focus or replace the user's reading position;
- project session/store contracts own durable project identity. RSR requires a
  separately reviewed versioned UI-profile owner and migration before durable
  Scene writes;
- Workspace R, Agent R, Runs, Artifacts, Environment, Git, Evidence, approvals,
  credentials, update, and file mutation keep their existing authorities.

## Non-Goals

This proposal does not authorize:

- a React, Vue, Lit, or other framework rewrite as the plugin ABI;
- arbitrary plugin web applications, remote code, iframe/WebView UI, root DOM,
  CSS, or direct Monaco access;
- plugin-controlled geometry, automatic focus, top-level buttons, global
  shortcuts, trusted dialogs, security wording, or destructive styling;
- marketplace, publisher, signature, catalog, or distribution work;
- Agent-authored activation, autonomous layout mutation, or UI self-repair;
- a second project/session/layout persistence authority;
- changing scientific execution, approval, credential, or Provider policy;
- removing the legacy layout before equivalent Surfaces are accepted;
- version, NEWS, installed-app, release, CI, or multi-platform claims from this
  proposal alone.

The host implementation may move from the current monolithic JavaScript toward
TypeScript/ES modules and component boundaries, but the Surface and Command
protocol must remain implementation-library independent. Choosing a rendering
library is a later engineering detail, not the foundation contract.

## Product Decisions Recommended For Authorization

1. adopt Surface and Scene as the only future composition vocabulary;
2. treat Agent as a Surface and retain Ask/Plan/Act only as policy;
3. define free layout as user-owned bounded Split/Stack composition, never
   plugin-owned geometry;
4. keep declarative trusted rendering as the initial workspace-plugin UI lane;
5. make Check project the first real Surface and pluginized rule component;
6. keep layout local and project-scoped initially; defer sharing/export;
7. preserve a complete legacy Scene until the migrated surface set is accepted.

Implementation begins only after the owner approves one bounded work package,
the proposal is renamed or handed off to an active contract, and cross-review
conflicts are resolved at that exact slice.

## Version, NEWS, And Release

The proposal changes no implementation, application version, R package
version, schema, or `NEWS.md`. Any user-visible RSR implementation requires a
fresh named development candidate before distribution. Any durable UI-profile
schema requires its own migration/recovery evidence. CI, multi-platform,
installed-app, signing, publication, and release acceptance remain separately
gated.
