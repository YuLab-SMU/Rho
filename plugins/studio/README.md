# Plugin Studio

An ordinary removable UI plugin using the public protocol and UI SDK. Open its
`studio` contribution with empty configuration. Management grants are explicit: scenario preparation, application, instance activation, test creation and view opening can delegate the standard declared scopes to selected packages; Studio has no direct scientific operation grant.
Choose an installed revision and an existing development branch, or create a new
branch. Source edits use the native immutable checkpoint ports and synchronized
8 MiB document drafts. No package install, build, runtime or scene change is
triggered by editing or checking source.

Canvas, declaration and source share 64 undo transactions (4 MiB history). Invalid
visual text retains the last valid canvas. Custom components remain opaque source.
The canvas renders fixture values only; events, subscriptions, custom code and
remote media never execute. The node inspector exposes properties, style tokens,
bindings, conditions and events through the public declaration. Drag nodes onto
another node to reparent them; Move up/down reorders siblings.

View definitions in the same inspector edit data-source capabilities, arguments
and subscription flags, plus custom source/export and properties/input/output
schemas. Apply changes the declaration in one shared Undo transaction. Renaming
rewrites node bindings, nested conditions, refresh/open-view bindings or custom
component references; it never rewrites opaque component code. Referenced
definitions cannot be removed. Add a custom source file to the package before
pointing a component at it. These forms do not query providers or execute events.

Unapplied form text, including invalid JSON, is kept in the synchronized Studio
draft. Apply or explicitly reset before selecting another definition. Editing the
same definition in source invalidates an older unapplied form's captured baseline;
reset it to the current declaration before applying. Pristine forms follow source
changes and Undo/Redo. Invalid declaration source is never overwritten by a form.
Runtime component registrations and provider observation/action adapters remain
the plugin's compiled code; declaring a source does not implement its adapter.

Files up to 128 KiB can be edited as UTF-8. Larger and binary files remain intact;
history restores them by immutable source reference. Checkpoints have the native
128-edit and 256 KiB request limits. Loaded text and history share a 6 MiB editor
budget within the document draft. Build instructions and declared lockfiles remain
source. They execute only through an explicit native build. New files update the manifest in the
same undo transaction. Removal is reversible until a checkpoint, and remains
recoverable through immutable source history afterward.

Source operations persist their exact request before dispatch, verify the original
Operation identity and receipt, and retain uncertainty. Reopening a saved draft
does not replay source requests. A replacement view may inspect the originating
request but cannot replay it. A branch-head conflict can be resolved by creating
a new branch from the captured baseline while retaining local edits. Source history
restore creates a new checkpoint on the selected branch, never changing running instances or scientific state.

Build & preview opens the approved preview/diagnostics surface. Build checkpoint
runs `plugins.build` for the exact saved revision; checkpoint unsaved edits first.
The timeout defaults to 10 minutes and is selectable from 1 to 60 minutes.
The original Operation and bounded stdout/stderr remain visible, including failed,
truncated and uncertain results. The original view may request a build stop;
only a terminal original Operation confirms its outcome. Missing tools/dependencies are reported without
installing them. A successful receipt selects only its exact artifact; it does not
activate a runtime or change a scenario.

Start preview creates a fixture instance and opens its selected view through the
ordinary window ports. Its editable configuration, initial view state and exact
query fixtures remain in the synchronized draft, including invalid JSON. The
native preview starts no backend, receives no scientific grants, and never falls
through to project reads. The shell labels fixture mode outside the iframe. It
can persist its own view state, cooperate with closure and copy explicit text.
Other invocations, native controls, resource downloads and external navigation
are refused. Fixture inputs are separate from the inert canvas's named data.

Development requests retain original identity before dispatch. Reload or a new
Studio view only inspects the originating Operation. A partly opened preview
remains visible and may be opened explicitly; no replacement instance is created.
Close preview view uses the ordinary flush handshake. Disconnected view recovery
requires an explicit Close with saved state action, retaining only acknowledged
state. Release is enabled after confirmed closure. The preview never becomes a
scenario runtime; existing runtime instances retain their versions.

Explicit backend test uses the selected checkpoint and artifact in a new disposable
project. Use selected build prepares an editable subject selection; additional
exact dependency instances can be declared by alias. New disposable test project
calls the native lifecycle owner. It does not reuse the current analysis session.
Open test view uses the selected contribution, view configuration and initial state;
Open test workspace is a separate explicit browser action. The containing shell
keeps credentials private. Close test view flushes that original child view; Stop
test project requires native cleanup, without deleting the retained journal.
Refresh distinguishes live native state from recorded unavailable state.

Creation, opening, closure and stop retain their original request and exact target
before dispatch. Lost receipts can be inspected after reload without replay. Only
the original Studio view can retry the original request. Child Operation IDs remain
inspectable through the parent journal port after stop. Failed activation and
uncertain cleanup retain their original evidence; no replacement is automatic.
The fixture preview and backend test have separate instances and state.

The inert editing canvas is separate from executable fixture preview. Default
delivery remains unfinished.

Ask Agent captures a saved development branch and its exact checkpoint. Source
edits must be checkpointed first. Choose a current active ordinary Agent instance
with the optional management grants enabled; Studio does not activate one or
restore a suspended instance. The branch head is checked before opening the view.
The opened Agent view receives a reviewed text request and six scoped tools:
checkpoint inspection, source listing/read, branch-head observation, source check
and checkpoint creation. Source reads stay on the captured revision; check and
checkpoint also fix the branch and expected head. A later branch change requires
a newly prepared request. Build, preview and scenario application stay in Studio.

Opening only creates an ordinary Agent view. In that view, choose or create a
native task and explicitly add the request to its draft, then review and Send.
Insertion preserves existing text, assets and references, selects only those
Studio tools, and persists a marker with the draft to prevent duplicate insertion
after reload. Rho's management-tool input is not yet composed. The original view
opening request is saved before dispatch; lost replies can be inspected without
opening another view. Source edits and Agent task state keep their own owners.

Apply to scenario reads named scenario heads and their immutable parent history.
Choose the source checkpoint, its exact built artifact and an alias of the same
plugin. Preview that build or create its explicit backend test first. Closing a
preview retains this evidence. Initial states for the alias's new views must be
provided by view ID; Studio does not convert state between revisions. Other
configuration, dependencies, provider selections and layout stay in the captured
scenario definition and remain subject to native validation. Use Plugins to edit
those definitions or create a named scenario.

Staging only changes the synchronized draft. Saving creates a checkpoint using the
captured named head. Preparing reuses exact active runtime instances and live views,
or creates new ones without changing the window layout. Apply to this window is a
separate atomic selection using its captured layout version. Refresh preparation
captures a new window version while retaining partially prepared identities. Each
mutation persists and verifies its own original Operation. Inspection after a lost
reply never proceeds to the next step; a replacement view cannot replay it.

Scenario history can be compared with its parent and restored as a new checkpoint
on the captured head, followed by explicit preparation and application. Hidden
views retain current unsaved state when reused. Existing instances, accepted work
and other windows retain their versions. Restoration does not rewind files, R
memory, credentials or scientific outputs. Partial preparations stay retained and
can be inspected and managed through Plugins; Studio never releases them as an
implicit rollback. These UI flows use the public ports and declared scopes only.

Import / export keeps package transfers alongside the synchronized source draft.
A chosen local file is captured before its first chunk leaves the view. After a
refresh, inspect the retained upload and reselect identical bytes to resume.
Import revision installs the inspected source/artifacts without selecting, building
or activating them. Open imported source is a separate action; checkpoint current
edits first. The current branch and source remain intact throughout transfer.

Use current checkpoint captures that immutable revision, excluding uncheckpointed
editor changes. Export includes source plus the exact checked artifact identities;
Select source only excludes all artifacts. Prepare archive saves the original
Operation before dispatch. Download archive then explicitly asks the containing
browser to read and verify those bytes. Its acknowledgement means a browser request,
not that the user saved the file. A plain Unicode filename is supported.

Lost import/export acknowledgements retain the original request in the document.
Inspection never replays a mutation or starts a download. A replacement view can
inspect but cannot retry another view's request. Uncertain results stay unresolved.
Discard transfer/export frees transient bytes after native confirmation; installed
revisions, source checkpoints and running instances remain available. Downloads
require a container advertising `archive_download_v1` and a rebuilt archive-capable
Host. See the repository Status for executed browser acceptance.
