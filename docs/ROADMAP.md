# Rho product direction

Rho connects projects, editable documents, scientific artifacts and external Agents
in a local browser workspace. Functional capabilities stay in Rho-plugins; managed
execution stays in Rho-core. The application makes those capabilities usable together.

The previous frontend milestone plans and designs were withdrawn on 2026-10-25.
They are not requirements for subsequent implementation. [Status](STATUS.md) records
current behavior and executed checks; [Frontend](FRONTEND.md) describes the rebuilt UI.

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
