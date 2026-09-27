# Plugin Studio

An ordinary removable UI plugin using the public protocol and UI SDK. Open its
`studio` contribution with empty configuration. It has no scientific grants.
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

Files up to 128 KiB can be edited as UTF-8. Larger and binary files remain intact;
history restores them by immutable source reference. Checkpoints have the native
128-edit and 256 KiB request limits. Loaded text and history share a 6 MiB editor
budget within the document draft. Build instructions and declared lockfiles remain
source, and are not executed by this editor. New files update the manifest in the
same undo transaction. Removal is reversible until a checkpoint, and remains
recoverable through immutable source history afterward.

Source operations persist their exact request before dispatch, verify the original
Operation identity and receipt, and retain uncertainty. Reopening a saved draft
does not replay source requests. A replacement view may inspect the originating
request but cannot replay it. A branch-head conflict can be resolved by creating
a new branch from the captured baseline while retaining local edits. Source history
restore creates a new checkpoint on the selected branch, never changing running instances or scientific state.

This editor slice does not yet expose native builds, isolated executable previews,
archive import/export, Agent tasks or scenario application. Its inert editing
canvas is not an executable plugin preview. Default delivery is not yet changed.
