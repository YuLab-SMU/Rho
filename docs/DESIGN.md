# Rho product design

Rho makes functional components feel like one workspace. People describe intent,
edit directly, inspect actual data and arrange views across windows. Agents use
the same actions and resources and can compose further interfaces from registered
components. Scientific workbench, workspace composition and Agent interaction
are evaluated together through the [first integrated flow](ROADMAP.md#first-integrated-flow).

## Workspace behavior

Give code, data, graphics and actual results the main reading area. Use progressive
disclosure for provenance, internal identities, full paths and diagnostics.
Make the active resource, selection and window context clear. Selection propagates
through stable component/domain identifiers, including after sorting or filtering.

Docking, tab changes and popout preserve the current work. Each document has one
logical buffer across its views, with unsaved content, undo and external-write
checks. Background updates do not steal focus, reset the cursor or reconstruct
an active editing view. Layout persistence describes arrangement; document and
task owners retain their content and facts.

Product-authored labels and accessible names use English. User content, native
outputs and input methods preserve Unicode and their original language. Commands
are reachable without dragging; graphics have suitable text/table alternatives.

## Agent interaction

An Agent can open typed parameter forms, bind selected resources and arrange
registered views. The user can continue direct editing and inspecting those same
resources. Composition uses a small catalog with typed properties and scoped
actions; validation checks both the description and the action boundary.

Show proposed inputs and their resource context clearly. Existing authorization is
checked mechanically at invocation. Models and retrieved content cannot enlarge
scope; an already authorized action does not acquire another Rho approval.
Generated explanations remain distinguishable from component results and checks.

## Visible state and continuity

Distinguish running, execution complete, artifact checked, domain checked, partial
and unknown outcomes, including check scope and freshness. Missing acknowledgement
preserves the original request identity. Reconnection observes the same task;
view closure or failure releases observation without replaying execution.

Cancellation, confirmed stop and Host shutdown have explicit effects. A failed
popout or unavailable component preserves drafts and result references and offers
a recoverable presentation. A restored layout does not claim unavailable content
saved, restored or scientifically valid.

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
writes as applicable. Move views across windows, close an observer and observe
from another window. Keep draft state, selection and task continuity visible.

Measure interaction latency, retained memory and rendering work on the actual
composition. Use bounded pages and resource references for large data. Limits
name their protected resource and behavior; exhausted view resources retain
obtained results and do not silently stop a user Host or replay a task.
