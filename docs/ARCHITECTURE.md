# Rho architecture

Rho is the application container for an intelligent workspace. Functional
components provide what users and Agents do; Rho connects their interfaces and
resources to a shared workspace. Rho-core provides the execution foundation.

This document defines the design boundary. [Status](STATUS.md) records
implementation; [Technology stack](TECHSTACK.md) records the selected libraries.

## Source owners

| Owner | Responsibility |
| --- | --- |
| [Rho-core](https://github.com/YuLab-SMU/Rho-core) | Managed execution, original request identity, retained execution facts, resident Host and public CLI |
| [Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/ARCHITECTURE.md) | Actual functionality, native conditions, resource semantics and results; optional CLI, Skills, MCP and UI entries |
| Rho | Component selection and assembly, desktop windows, layout, shared interaction routing and presentation |

A functional component may be an Agent, editor, file tool, table, plot, scientific
method, evaluation or another capability. It can use maintained R, Python, Rust,
TypeScript, native tools or ordinary files. Components expose the entries their
consumers need, with the same implementation and conditions across those entries.
Managed execution entries preserve the original request identity.

A headless caller uses the component's supported entry. Rho assembles its views
and actions; selected native execution uses Core's public capability. An Agent
component owns its model loop and context. Core remains independent of UI bundles
and model interaction. Each repository delivers and verifies its own boundary.

## Interaction model

Four concepts connect components to the container. Their public schemas and host
adapters will be implemented with the first concrete consumer flow.

| Concept | Meaning |
| --- | --- |
| Action | Component/action identity, typed inputs, preconditions, effects, results and cancellation semantics; managed identity where applicable |
| Resource | Owner-provided reference to a file, buffer, table, plot, model or task, with provenance and the content version or digest it needs |
| Selection | Stable entities or ranges in a particular resource version, with explicit project/view context |
| View | Presentation of resources, registered actions and observation subscriptions, with an explicit release lifecycle |

Agent tools, UI controls and CLI adapters reach the same component action.
The invocation boundary checks existing authorization, caller/project visibility,
resource validity and native preconditions. A resource reference does not grant
access to its parent directory. Models and retrieved content cannot expand scope;
already authorized actions do not receive an additional container approval.

Tables and plots use stable domain identity. Sorting and filtering do not turn
visible row positions into entity identifiers. Stale selections are rejected or
explained before they affect data or execution.

## State and lifecycle ownership

| State or fact | Owner |
| --- | --- |
| Managed request, native execution identity, partial/unknown outcomes and retained execution facts | Core within its documented contract |
| Functional resources, provenance, domain identities, conditions and checks | Actual functional component |
| Unsaved document, local content version, undo and write-conflict checks | Editing component's document service |
| Selection/filter meaning | Participating component; Rho routes the explicit context |
| Window arrangement, active view and component availability | Rho |
| Cursor, scrolling and rendering resources | Individual view as appropriate |
| Agent session and model context | Agent component |

Multiple views of a document share one logical unsaved-buffer owner. Moving a
view between windows preserves content and undo. Saving checks external writes;
disk files and Git history do not substitute for the current buffer. Versions and
provenance belong to individual resources, with no global scientific revision.

## Execution continuity

A resident Host is held independently of observing windows and renderers. Closing
a view releases its subscriptions and drawing resources. Agent-session closure,
task cancellation, confirmed native stop and Host shutdown are distinct events.
The application makes their effects explicit.

After a missing submission acknowledgement, retain the original caller/request
identity and query or retry that identity through the public boundary. Reconnect
observes the original task rather than automatically submitting another execution.
Partial results and unknown outcomes remain visible. Bounded reads do not start or
recover a Host or native session.

Execution completion, artifact integrity, domain checking and model explanation
are separate facts. Components interpret their own outputs and expose the scope
and freshness of checks. Core output streams serve bounded observation; scientific
artifacts use the component's declared files, manifests and checkers.

## Interface composition

Trusted first-party React views are built with the application at explicit
component versions. Rho supplies theme, commands, layout and interaction routing.
An Agent describes a composition using a typed catalog of registered components,
properties and scoped action/resource/selection references. The container validates
that description, then routes actions to their actual owner.

Generated descriptions do not load privileged JavaScript. Schema validity does
not establish authorization, resource freshness or scientific correctness.
Independent HTML views can use isolated MCP Apps with a controlled message/tool
bridge, validated origin/CSP and explicit teardown. UI isolation does not sandbox
the OS authority of native tools; Core caller namespaces are not authenticated
principals. See [Security](../SECURITY.md) and [Product design](DESIGN.md).

## Application composition

An accepted combination records immutable source/artifact identities, dependency
versions, third-party origins/licenses, explicit local overrides and the observed
results of the [integrated flow](ROADMAP.md#first-integrated-flow).

A missing or upgraded component retains enough version and provenance information
to inspect existing runs and outputs. Layout restore preserves references and
reports unavailable content without claiming that a buffer was saved or a task
recovered. View failure does not replay actions.

Source publication, composition acceptance and signed distribution have their own
evidence. The [release boundary](RELEASE.md#official-distribution) promotes an
accepted candidate when an official delivery milestone is selected.
