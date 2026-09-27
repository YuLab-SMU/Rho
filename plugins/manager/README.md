# Plugin manager

An ordinary, independently built UI plugin for installed revisions, retained
instances and per-window scenarios, following approved Paper PS01/02/06/07.
It uses only the public protocol and UI SDK, and the same Host ports as CLI/MCP.

Installed inspection exposes exact revision/artifact identities, contributions,
dependencies, requested scopes and protecting-reference counts. Branch creation
and removal use journaled operations. Instances distinguish a current Host
observation from a stored historical record; release remains explicit. Views
can be opened with explicit configuration and initial state.
The instance list explicitly includes fixture previews, labels their disabled
backend, and permits ordinary view closure/release. Previews never qualify as
runtime instances or reusable scenario views.

Scenarios are paged, immutable checkpoints. A retained JSON draft can edit exact
definitions, including aliases, provider bindings, resource context and layout.
Viewing an older checkpoint does not alter its branch. Saving it creates a new
checkpoint against the observed current head. Saving never applies a scene.

Review captures the current window layout version. Each alias explicitly chooses
a new instance or a compatible existing instance; each view explicitly chooses
checkpoint state or an observed compatible live view. Preparation opens missing
instances/views and validates the complete mapping. It does not switch the window.
Switching uses one native atomic operation. Failures retain the old composition
and all partially prepared instances/views. Reviewing a new switch does not
automatically release them. Native state/grants/dependencies are authoritative.

Every mutation persists its original intent before dispatch. Lost acknowledgements
remain inspectable by original request identity, including from a replacement
management view. Only the original view can explicitly retry that identical
request. Recovery does not start later preparation steps. Uncertain work stays
visible. Hiding this view retains its DOM; closing cooperatively saves its state.

This package is an implementation stage, not the completed Plugin Studio. Local
package import/export still use the CLI. Visual/source Studio editing, build and
preview workflows and default delivery remain separate unfinished work. The
manager does not add its own approval system, run scientific operations on read,
or claim OS-level isolation for native plugins.
