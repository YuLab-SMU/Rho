# Objects plugin source

The Objects migration is in progress. Its viewing model now consumes the public
R inspection envelopes and declarations, without a private Host or Studio import.
Directories, native references, table/vector pages, bounded copying and display
semantics retain their existing owner rules. Busy and expired observations preserve
the previous display without presenting it as fresh evidence. The existing React
directory, grid, vector, field controls and summary components now live here too.
Their connection-local services accept public clipboard cooperation, navigation and
explicit execution; no private Studio context is imported. Vector/table copies
reserve the browser gesture before collecting pages and retain their observation
fence until all text is available.

The connection source pins its R provider and first native session through the
public UI SDK. On mount, the `objects` directory discovers the current session of
that exact provider before requesting any object data. Persisted session IDs are
not live evidence after a Host restart; `object` detail views retain their original
session fence. It observes `r.inspection_state`, invalidates caches on owner changes
and keeps busy retries bounded. Presentation state is acknowledged through the
view owner, with explicit save errors and a flush method for container cooperation.
The package now has `objects` and `object` contributions and an independent build
entrypoint. Both use an exact R `source`; `object_group` identifies the containing
window's destination tab group; null uses the view's own observed group, or the
first group in an empty window. A missing configured group is an explicit error.
An object view also carries its exact name/path.
Open in New Tab uses the public atomic `windows.open_view` operation. It never
infers a fixed Editor panel in core. The container window must load saved layouts
to display newly opened views.

Explicit Render plot captures the original request, view, source, native session
and code before invoking `r.execute@2`. Failed capture prevents submission; a lost
reply retains that request for explicit retry. A copied pending action cannot
replay from another view. Acknowledged actions retain their original Operation ID
and can be inspected. A reopened view can find a retained request through bounded
Operation reads, verifying its original caller, input and provider without replay.
An absent observation remains unconfirmed. Browsing and mounting never execute R.
The close-time handler pauses observations, drains local capture and saves final
presentation choices without waiting for or cancelling accepted R work. Failed
capture refuses closure and leaves its diagnostic visible.
The existing workbench remains in place until the ordinary package replaces it.

From the repository, `node scripts/test-objects-plugin.mjs` copies these sources,
their tests and the public R/plugin declarations outside the checkout. It compiles
and tests that independent copy with existing locked dependencies. It does not
install tools, start R or connect to a user workspace. To build an independently
importable package, run `node scripts/build-objects-plugin.mjs` with a new absolute
directory outside the checkout. The package's `BUILD.md` describes the standalone
build using existing dependencies; no core binary is rebuilt.

The navigation grant includes the target Objects view's read/run/operation scopes.
Host checks this explicit delegation against the opening call and the containing
parent's current authority; a `plugins.run`-only call cannot create a more capable
view.
