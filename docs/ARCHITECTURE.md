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
| Rho | Component selection and assembly, local service, layout, shared interaction routing and presentation; native windows in a later client |

A functional component may be an Agent bridge, editor, file tool, runtime/object
adapter, table, media/chart view or reusable native operation. It can use maintained
R, Python, Rust, TypeScript, native tools or ordinary files. Components expose the entries their
consumers need, with the same implementation and conditions across those entries.
Managed execution entries preserve the original request identity.

The [Plugins capability model](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-MODEL.md)
defines reusable plugin ownership and optional entries. A plugin may contribute
several views over one state owner. Specific analysis workflows remain project
scripts/recipes or acceptance examples; their dataset, design, contrast and
sequencing do not belong in the base catalog or application routing. The
[extraction plan](PLUGIN-EXTRACTION.md) records removal of the 0.1 coupling and
the gates before plugin UI integration. The 0.2 headless contracts are implemented;
[extraction acceptance](EXTRACTION-ACCEPTANCE.md) records their actual consumers.

A headless caller uses the component's supported entry. Rho assembles its views
and actions; selected native execution uses Core's public capability. An Agent
component owns its model loop and context. Core remains independent of UI bundles
and model interaction. Each repository delivers and verifies its own boundary.

The [first release](WEBUI-FIRST.md) is an npm-distributed local service and browser
WebUI. The browser reaches scoped application operations through that service;
it does not invoke Core or native tools directly. The service uses Core's public
CLI. A later desktop client reuses these component and execution boundaries and
adds native window and system integration.

## Interaction model

Four concepts connect components to the container. The finite 0.2 backend exposes
their concrete [v2 schemas](../protocol/v2.json), HTTP/SSE service and client.
Plugins supplies the headless functional owners; UI entries remain unavailable.
[Headless backend](HEADLESS.md) records the actual boundary and persistence rules.
Scripts, requirements, typed fields, keys, entity namespaces and two-input joins
are explicit declarations. Frozen v1 schemas/fixtures and a retained observation
bridge preserve earlier records without registering their workflow for new work.

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

Tables and charts use provider-declared stable keys and explicit field mappings.
Linking different resource versions or entity spaces requires an owner-validated
mapping. Sorting and filtering do not turn visible row positions into identifiers.
Stale selections are rejected or explained before they affect data or execution.
Image coordinates have their own contract; image viewing does not imply data
entity selection. R objects require actual runtime-owned descriptors/snapshots;
a resident Core Host alone does not establish a live R session.

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

Multiple views of a document share one logical unsaved-buffer owner. Switching
tabs or moving a view between splits preserves content and undo; the later desktop
client extends this to native windows. Saving checks external writes;
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

The application side of the Core boundary, namely request identity, the exit-code
state machine, Host lifetime and bounded observation, is owned by the
[execution bridge](EXECUTION.md).

## Interface composition

A functional component owns its UI entry source: the view implementation, its
typed properties and its action bindings live with the component in the component
owner's repository. Rho builds those views into the application at explicit
component versions and supplies theme, commands, layout and interaction routing.
Rho does not hold a second implementation of a component's behavior. The selected
editor, table and plot UI components are not implemented yet; [Status](STATUS.md)
records that boundary.

Trusted first-party React views are built with the application at explicit
component versions.
An Agent describes a composition using a typed catalog of registered components,
properties and scoped action/resource/selection references. The container validates
that description, then routes actions to their actual owner.

Generated descriptions do not load privileged JavaScript. Schema validity does
not establish authorization, resource freshness or scientific correctness.
Independent HTML views can use isolated MCP Apps with a controlled message/tool
bridge, validated origin/CSP and explicit teardown. UI isolation does not sandbox
the OS authority of native tools; Core caller namespaces are not authenticated
principals. See [Security](../SECURITY.md) and [Product design](DESIGN.md).

## Resource limits

Rho bounds the resources it actually owns and names the exceeded-limit behavior.
The headless owners expose the selected defaults and exceeded-limit behavior in
[backend budgets](HEADLESS.md#observation-budgets-and-recovery). Browser drawing
and rendering budgets still need their actual UI implementation; the application
does not invent a global quota for the user's environment.

| Protected resource | Configuration | Exceeded-limit behavior |
| --- | --- | --- |
| Retained process output rendered per view | Bounded log-view budget | Stop appending, keep the retained prefix visible and mark the stream truncated |
| Table rows/pages requested per view | Page size | Fetch bounded pages on demand; keep the pages already obtained |
| Plot points/series drawn per view | Drawing budget | Reduce drawn marks within the budget and mark the reduction |
| Concurrent component actions | Action-concurrency limit | Queue or reject explicitly; never start work under a new identity |
| Observation subscriptions per view | Subscription limit | Refuse the extra subscription and explain the limit |
| Retained Agent-composed message bytes | Message budget | Reject an oversized description before rendering |

Exhausting a view resource preserves obtained output and uncertainty. It does not
stop unrelated execution, stop a user Host or replay a task.

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
