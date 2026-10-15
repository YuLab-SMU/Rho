# Rho product design

Rho makes functional components feel like one workspace. People describe intent,
edit directly, inspect actual data and arrange views. Agents use the same actions
and resources and can compose further interfaces from registered components.
The [first release](WEBUI-FIRST.md) is an npm-distributed local WebUI, with tabs
and split views in one browser window. A later desktop client extends that
workspace across native windows. Scientific workbench, workspace composition and
Agent interaction are evaluated together through the
[first integrated flow](ROADMAP.md#first-integrated-flow).

## Workspace behavior

Give code, data, graphics and actual results the main reading area. Use progressive
disclosure for provenance, internal identities, full paths and diagnostics.
Make the active project, resource, selection and view context clear. Selection
propagates through stable component/domain identifiers, including after sorting
or filtering.

Docking, tab changes and split-view changes preserve the current work. Each
document has one logical buffer across its views, with unsaved content, undo and
external-write checks. Background updates do not steal focus, reset the cursor or reconstruct
an active editing view. Layout persistence describes arrangement; document and
task owners retain their content and facts.

Product-authored labels and accessible names use English. User content, native
outputs and input methods preserve Unicode and their original language. Commands
are reachable without dragging; graphics have suitable text/table alternatives.

## Agent interaction

The first release provides a real Agent connection and session path. Configuration,
connection testing, available capabilities and project binding have visible states
and a continuation after failure. A provider list or a chat mockup does not
establish a working Agent. Agent components retain their model loop and context;
Rho assembles their entries and routes shared interaction.

An Agent can open typed parameter forms, bind selected resources and arrange
registered views. The user can continue direct editing and inspecting those same
resources. Composition uses a small catalog with typed properties and scoped
actions; validation checks both the description and the action boundary.

Show proposed inputs and their resource context clearly. Existing authorization is
checked mechanically at invocation. Models and retrieved content cannot enlarge
scope; an already authorized action does not acquire another Rho approval.
Generated explanations remain distinguishable from component results and checks.

The user can see which project, resource, selection and unsaved buffer content an
Agent is using, and return from an action or result reference to that resource.
Agent edits to an open document use the same logical buffer, undo and write
conditions as direct user edits. Direct file actions retain their actual write
conditions. Context handoff does not lock the workspace; the user can continue
working, inspect the change and take over at the point of interest.

## Reviewable interaction journeys

Design the following as independently reviewable sequences, then connect them
through the same real analysis case. Each sequence names its entry, participants,
resource context, action, visible feedback, next step and failure continuation.
Static screen states alone do not establish that the sequence works.

- First use proceeds from installation and local startup to project selection,
  dependency checks, Agent connection and the first inspectable analysis result.
  Missing dependencies or an unreachable local service have a clear next step.
- Agent connection proceeds from configuration to an actual connection test,
  project-bound session and first resource-aware request. Unconfigured, connecting,
  available, failed and disconnected states remain distinguishable.
- Human-to-Agent handoff proceeds from a code range, table entity or plot selection
  to an explicit context reference, a shared component action, its observed result
  and direct human continuation. Stale context and concurrent writes have a
  recoverable path; already authorized edits do not gain another approval gate.
- Run continuation proceeds from submission to execution and result inspection,
  with separate paths for failure, partial output and a missing acknowledgement.
  An error can enter Agent repair with its actual resource and error context;
  a deliberately new execution after repair remains distinct from finding the
  original request.
- Workspace composition proceeds from a real resource to linked code/table/plot
  views, tab or split changes and an Agent-added registered view. Returning to a
  view preserves its logical resource and work; unavailable components offer an
  inspectable fallback without replaying actions.

The [design delivery checklist](DESIGN-PRIORITIES.md) records required prototype
coverage and pending corrections. Prototype review, implementation and observed
application acceptance are separate evidence.

## Visible state and continuity

Distinguish running, execution complete, artifact checked, domain checked, partial
and unknown outcomes, including check scope and freshness. Missing acknowledgement
preserves the original request identity. Reconnection observes the same task;
browser refresh, view closure or failure releases observation without replaying
execution. Closing a browser page is distinct from stopping the local service or
Host. Restored views report which content is available; layout persistence alone
does not establish that an unsaved buffer survived a refresh.

Cancellation, confirmed stop and Host shutdown have explicit effects. A failed
view transition or unavailable component preserves drafts and result references
and offers a recoverable presentation. A restored layout does not claim
unavailable content saved, restored or scientifically valid.

## Interaction constraints

These follow from observed use of the earlier application and constrain the
selected flow.

- Review follows the action, it does not gate it. An action the user takes writes
  through; the resulting change is reviewable and can be reverted afterwards.
  Approval before the write and a review after it are not both applied to the same
  edit.
- A settled review collapses. Once a change is accepted or reverted, its diff is
  dismissed, and an edit control that can no longer take effect (such as undo after
  a settled accept) is hidden rather than shown inert.
- Work is not single-threaded. A task in progress does not block starting another
  session or another action; sessions, views and execution have independent
  lifetimes.
- Direct manipulation stays at the point of interest. A contextual operation acts
  on the element under the cursor or the current selection, instead of requiring a
  distant control and a modal round trip.
- A failure offers its continuation. A failing script presents a direct entry to
  the Agent repair path carrying the actual error and the resource reference, in
  addition to the problem/diagnostics view. The Agent applies the fix through the
  same buffer and write conditions as a user edit.

## Design and acceptance

Substantial layout or component design uses Paper and user review for the selected
flow. Record its purpose, source and scope; reuse approval within that scope.
Inspect the actual component/styles during implementation. Mockups communicate
intent; live resources and observed behavior establish acceptance.

Inspect normal, wide and constrained widths with representative data. Test native
Chinese IME, keyboard navigation, focus, clipboard, drag/drop, undo and concurrent
writes as applicable in the supported browser. Cover empty, loading, error,
unavailable and partial-result states, accessible names, non-drag layout commands
and suitable text/table alternatives for graphics. Switch tabs and split views,
close an observer, refresh the browser and find the original task from another
view. Keep draft availability, selection and task continuity visible.

The later desktop milestone adds native window movement, menus and integration.
Move views across actual native windows without losing buffer ownership, undo or
task observation, and verify window close/crash behavior there. These checks are
additional desktop evidence, not first-release WebUI requirements or claims.

Measure interaction latency, retained memory and rendering work on the actual
composition. Use bounded pages and resource references for large data. Limits
name their protected resource and behavior; exhausted view resources retain
obtained results and do not silently stop a user Host or replay a task.
