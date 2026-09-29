# Plugin manager

An ordinary, independently built UI plugin for installed revisions, retained
instances and per-window scenarios, following approved Paper PS01/02/06/07.
It uses only the public protocol and UI SDK, and the same Host ports as CLI/MCP.

Installed inspection exposes exact revision/artifact identities, contributions,
dependencies, requested scopes and protecting-reference counts. Branch creation
and removal use journaled operations. Instances distinguish a current Host
observation from a stored historical record; release remains explicit. Views
can be opened with explicit configuration and initial state.
Confirmed Host suspensions expose **Restore instance**, including backends with
no view of their own. It retains the original identity, artifact, configuration
and data, using the observed suspension token. It neither starts dependencies
nor reconnects views or replays scientific work. A missing reply retains the
original request for inspection or an explicit identical retry. Released,
unconfirmed and fixture-preview instances cannot use this path.
The instance list explicitly includes fixture previews, labels their disabled
backend, and permits ordinary view closure/release. Previews never qualify as
runtime instances or reusable scenario views.

Import package captures a user-selected `.rho-plugin` file and saves its exact
digest/length reference before transferring bounded chunks. Upload and inspection
are separate from the explicit Import revision action. A refreshed view can
inspect retained progress and reselect the exact bytes to resume; a changed file
is refused. The original filename, last observation, package metadata and successful
import request remain saved. Lost import replies use the same original-operation
recovery as other management actions, including read-only recovery from a
replacement view. An uncertain Operation remains pending. Import never builds,
activates, changes a scenario or replaces the current selection. Explicit discard
removes only unheld transfer bytes, preserving imported revisions and receipts.

Export revision retains the inspected source and an explicit sorted artifact
selection; clearing all artifacts prepares source only. Prepare archive uses a
normal original Operation, while Download archive is a separate gesture checked
by the containing browser. A lost preparation reply is recovered without opening
a download. The retained receipt, request identity and filename survive reload;
export does not checkpoint edits, activate code or change a scenario. Discard
export removes only unheld transfer bytes and leaves source/history intact.

Scenarios are paged, immutable checkpoints. A retained JSON draft can edit exact
definitions, including aliases, provider bindings, resource context and layout.
Viewing an older checkpoint does not alter its branch. Saving it creates a new
checkpoint against the observed current head. Saving never applies a scene.

**New R workspace** selects installed R, Files, Editor, Console, Objects, Plots,
Viewer, Packages and Help revisions, plus existing Ark/R paths. The Manager recipe
uses normal activation and view ports, captures exact identities for cross-view
bindings, and saves a scientific scenario. It retains the current Manager view.
When the selected R revision contributes saved Viewer context, preparation selects
its original-operation and resource read grants and retains them in the scenario.
Missing declared read contracts are reported before activating any instance.
Preparation does not switch the window or start R; use the existing Switch action,
then Start R in Console. Missing packages are never installed automatically.
Choices and partial preparation survive view reload. Each original request is
recovered separately; continuing is explicit, and unavailable prepared instances
are not silently replaced. This starter runs in the ordinary default workbench;
the final default package delivery mechanism remains under development.
With no unconfirmed request, **Keep instances and start over** resets the setup
form so paths and selections can be corrected; created instances, views and
checkpoints remain available through their normal inspection and cleanup controls.

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

This package is an implementation stage, not the completed Plugin Studio. Visual/source editing, build, preview
and scenario application are provided by the separate ordinary Studio package;
remaining Studio archive/Agent workflows and default delivery are ongoing work. The
manager does not add its own approval system, run scientific operations on read,
or claim OS-level isolation for native plugins. See the repository Status page for
executed checks; implementation alone does not establish browser acceptance.
