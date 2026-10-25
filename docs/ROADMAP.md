# Rho product direction

Rho is an adaptive research workspace: people and external Agents collaborate on
the same projects, documents and scientific artifacts while views adapt within
predictable rules. Functional capabilities stay in Rho-plugins; managed execution
stays in Rho-core. The application connects them while preserving the person's
attention, control and continuity.

The previous frontend milestone plans and designs were withdrawn on 2026-10-25.
They are not requirements for subsequent implementation. [Status](STATUS.md) records
current behavior and executed checks; [Frontend](FRONTEND.md) describes the rebuilt UI.
The current [interaction guidance](INTERACTION.md) selects shared objects,
constrained workspace changes and continuous episodes as the development direction.

## First integrated flow

A person opens a project, gives an external Agent a task, inspects or changes the
proposed work and opens its real outputs. They can edit code, inspect a table or
figure, ask about an exact selection and continue from an explicitly linked reply.
Workspaces arrange those objects without changing who owns their content.

When execution fails, the actual error can be handed to the Agent for a new repair
run. When a reply is lost, the original request remains the one to observe. Closing
views, returning to a project or reconnecting must preserve acknowledged work and
must not silently rerun it. Exports contain actual artifacts and provenance.

Current code and behavioral tests implement this flow. A new frontend must establish
its own browser evidence against these real capabilities; old screenshots, numeric
style rules and prototype review do not provide that evidence.

## Interaction system validation

Progress through the smallest useful episode, extending existing contracts when
an observed gap requires it. These are work priorities and completion conditions,
not claims that the new direction has passed. Reuse the current composition tree,
owner views, expression rules and exact collaboration receipts; do not reinstate
withdrawn W7 plans or add another layout/Agent engine.

| Step | Deliverable | Completion condition |
| --- | --- | --- |
| A: shared grammar | Map Point, Inspect, Ask, Propose, Act, Compare, Decide and Return onto actual owner contracts. | Each selected transition names real inputs, conditions, evidence and missing capability; no invented API is presented as implemented. |
| B: constrained views | Exercise suggestions, local extension, protection, focus and version following through existing layout writes. | Related views can be accepted/dismissed without disrupting current input or protected content; stale/unavailable changes explain their outcome. |
| C: real collaboration | Complete the base-R table/figure episode with an external Agent, anchored question, conditional edit, new run and linked result. | The person and Agent use the same references; owner facts prove the modification, reply and versions. Fixtures cannot stand in for a real Agent. |
| D: failure and return | Add external-write conflict, unconsumed feedback, lost replies, disconnect and unknown execution. | Preserve acknowledged work and original identities; recover the workspace separately from observing execution. |
| E: domain pressure | Repeat with a real DESeq2 project, multiple views/versions and independent domain checks. | The same interaction rules hold without domain branches in the Shell; biological claims retain their own limits. |
| F: user observation | Have target researchers independently complete the episode and recover from a selected failure. | Record completion, misinterpretations, focus loss, assistance and recovery effort; revise from observed problems. |

B and C should develop together where their evidence depends on each other.
Begin F with the first usable episode and repeat it as the work grows. A and B
do not justify postponing real use until a complete interface system exists.
The [six experiments](INTERACTION.md#experiments-and-acceptance-evidence) supply
concrete checks; [Development](DEVELOPMENT.md#write-an-interaction-episode) defines
the brief and evidence record. Current results and remaining gaps belong only in
[Status](STATUS.md), rather than a second progress ledger here.

## Remaining product work

Future changes should follow a concrete user need. Project Notebook would need a
real content/structure owner and stable page identities before its interface can
claim those capabilities. A native Agent conversation needs an actual transport
and session owner. Neither is supplied by a frontend text field.

The current delivery is an unsigned local npm package and WebUI. Registry publication
requires an explicit release selection. Native desktop windows, cross-window movement,
additional platforms and signed distribution remain later scope. The separate
[release process](RELEASE.md#official-distribution) defines promotion and signing;
scientific actions do not inherit release approval requirements.
