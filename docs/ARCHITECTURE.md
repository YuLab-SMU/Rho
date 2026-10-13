# Rho application architecture

Selected: 2026-10-13. Rho-core is the completed execution foundation for this
application design. Rho is the application container; Rho-plugins owns actual
functional components. Scientific work, freely composed views/multiple windows
and Agent-driven dynamic interfaces evolve in one flow.

There is no rebuilt executable application, plugin host, exported application SDK,
composition lock or assembly tooling yet. See [Status](STATUS.md) for evidence and
[Technology stack](TECHSTACK.md) for the selected implementation direction.

## Three source owners

| Owner | Responsibility | Application relationship |
| --- | --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Generic managed execution, original request identity, durable facts, resident Host and public CLI | Reuse its supported public capabilities and declared guarantees |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/ARCHITECTURE.md) | Functional components: Agent, editing, files, data, graphics, scientific methods, evaluation or other selected capabilities; their native conditions, resources and results | Supply functionality and optional UI contributions; keep semantics with their actual owner |
| Rho | Application selection, assembly, window/layout coordination and presentation | Connect selected components and present their facts without taking their semantics |

Scientific recipes and evaluation are the currently verified plugin consumers,
not the definition or exhaustive list of plugins. Core's deterministic regressions
remain in Core. Model trials, scoring and candidate improvement belong to the
evaluation component; scientific checkers remain with the domain component.

The current Core has no new SDK, HTTP/MCP edge or former plugin-package contract.
Existing consumers use its public CLI without a UI prerequisite. Their success
does not implement application assembly or a universal plugin loader.

## One function, optional entries

A component owns its actual implementation and can expose CLI, Skills, MCP and UI
entries when useful. No component must supply every entry, a native process or an
Agent loop. An editor, visualization or file capability is a functional component
even when it performs no managed scientific task.

Headless callers can use the component's supported function/executable entry;
Core can manage selected native execution. Rho assembles the component's views
and interactions. UI adapters do not implement a second analysis path, and
headless use does not require a window. Dual-side use does not mean Core renders
React, loads UI bundles or acquires a new plugin framework.

## Shared interaction semantics

The first consumer flow needs a small typed boundary, not a universal state model.
These are design concepts; no published schema or host API is implemented yet.

| Concept | Required meaning |
| --- | --- |
| Action | Stable component/action identity, explicit inputs, native preconditions, existing authorization, result/cancellation semantics and original request identity when managed |
| Resource | Owner-provided reference to a file, table, plot, model, task or editing buffer, with provenance and the necessary content version/digest |
| Selection | Resource reference plus stable entity/range identifiers and view/window context; reject or explain stale selections |
| View | Presentation of resources and access to registered actions; its lifetime is independent of native execution |

Agent tools, buttons and CLI adapters reach the same component capability. A
resource reference does not grant access to its containing directory. Table row
positions after sorting are not scientific entity identity. Models and retrieved
content cannot expand scope; existing Agent authorization receives mechanical
identity, project/resource and native-condition checks without another Rho approval.

## State and lifecycle ownership

| State or fact | Owner |
| --- | --- |
| Original managed request, execution identity/facts and partial/unknown outcomes | Core, within its documented guarantees |
| Scientific objects, artifact provenance, stable domain IDs and checks | Functional/domain component |
| Unsaved content, document-local version, undo and concurrent-write conditions | Editing component's document service |
| Shared selection/filter meaning | Component; Rho routes context within the selected project/resource |
| Window layout, component availability and active view | Rho |
| Focus, cursor, scrolling and drawing resources | Individual view where appropriate |
| Agent session and model interaction | Agent component |

Each open document needs one logical buffer owner across its views. Disk content
or Git history cannot stand in for unsaved content or a concurrent-write check.
There is no global scientific revision, mandatory Editor identity for direct file
edits, or promise to undo native side effects through event replay.

The resident Core Host must be held independently of the UI when continued
execution is selected. Panel/window closure, an Agent session ending, a plugin
view unloading, waiting interruption, task cancellation, confirmed stop and Host
shutdown are separate events. Closing a view releases its resources and observation,
not the original task. Upgrading a component must retain the version and artifact
interpretation needed to inspect an existing run.

After a missing submission acknowledgement, retain the original caller/request
identity and query or retry that identity through the public boundary; do not
create a new request to replay the effect. Queries are bounded observations and
do not start or recover a Host or native session. If observation is unavailable,
present that limitation rather than infer completion or recovery.

## UI and Agent composition

Trusted first-party UI contributions are React components assembled at explicit
versions. Rho coordinates theme, commands, focus and layout. Independently supplied
HTML can use an isolated MCP Apps View when a real consumer needs it; it does not
receive direct native filesystem, shell or Core management access.

An Agent can describe a composition from registered components with validated
properties and scoped action/resource/selection references. The host validates the
description and routes actions to their actual owner. Generated JavaScript is not
loaded into the privileged application. Schema validation does not establish
authorization, resource freshness or scientific truth. See
[UI principles](RHO-DESIGN.md) and [Technology stack](TECHSTACK.md).

## Execution and scientific truth

Rho does not implement another scientific execution path. Domain owners interpret
R models, input conditions, numerical results and recovery. Execution completion,
artifact integrity and scientific checking are separate facts. Preserve partial
results, unknown outcomes, failures and the scope/freshness of checks; an exit code
or model answer cannot establish all of them. The real R consumer supplies existing
[acceptance and limits](https://github.com/YuLab-SMU/Rho-plugins/blob/main/examples/real-r-analysis/ACCEPTANCE.md).

The first selected application flow combines natural-language action, script/table/
plot context, selection-linked views, window movement and observation of the same
task after disconnect. It is design, not a researcher-facing acceptance result.
Its completion conditions are in
[joint acceptance](TECHSTACK.md#joint-acceptance-flow).

## Composition and distribution

Keep three independent source repositories, with Rho as application development
and composition entry. No root Cargo workspace or alternate maintenance copy is
introduced. Other owners can remain incompatible while bounded work proceeds.
An implemented integration records immutable source/artifact identities, explicit
local overrides, public dependencies and acceptance of the actual combination.
Version labels or an old copied SDK cannot establish that acceptance.

Reuse mature native tools, ordinary files and Git. New transport, installation,
discovery, shared state or compatibility machinery needs a selected consumer gap.
Former subsystem maps do not select all old panels or content migration.

A source push does not build, install or prove an application. The future
Rho-releases owner handles promotion and signed distribution of an accepted
composition only at the selected official release milestone. See
[Release](RELEASE.md#future-official-release-boundary).
