# Studio usability feedback

This records user problems and review criteria, not a second progress ledger.
Current implementation and evidence belong in [Status](STATUS.md); approved
interactions and pending proposals belong in [Design](RHO-DESIGN.md).
Functional tests and design approval do not by themselves close usability issues.

## Origin and scope

The initial seven-point review and screenshot were provided on 2026-09-07.
The original delivered baseline is `d5a970b1559c9bd85567073108d05bca21886de4`, tagged
`studio-round1-baseline-2026-09-07`. The supplied RStudio tutorial is a workflow
reference, not a statement of supported Rho features or authorization to reproduce
all RStudio functionality. Later feedback extends this list.

The next version separates headless capability delivery from frontend work and
uses external Agents. Existing Agent feedback remains useful for maintained UI
and external integration; it does not authorize a new internal Agent product.
See [Next Version](NEXT-VERSION.md).

## Workspace and scientific interaction

| ID | Reported need | Concrete review criterion |
| --- | --- | --- |
| F01 | Components cannot be removed conveniently. | Close and reopen views, recover empty-group space, retain drafts and support layout Undo without executing work. |
| F02 | Docking relative to a group is unclear. | Place Plots beside Editor and Console together; show the target area, match preview and result, and allow cancellation. |
| F03 | Product UI should use English. | Labels, menus, errors and hints are English; Chinese paths, content, columns and native output remain intact. |
| F04 | R syntax highlighting is weak. | Distinguish representative R constructs; retain selection, Undo and plain text through polling/layout/settings. This alone does not scope a debugger or language server. |
| F05 | Console does not feel like a command line. | Predictable prompt, history, multiline input, stdin, queue failure/resume and return to input; execution metadata must not overwhelm the transcript. |
| F06 | Quick object inspection unexpectedly changes tabs. | Expand bounded details in place, permit several expanded rows, and require an explicit action to open a dedicated viewer. |
| F07 | Plot viewing is rough. | Review history, fit/zoom/pan, resizing, comparison, original-byte export and unavailable output in a real workflow. Viewing never reruns R. |
| F08 | Package lists are unattractive and uninformative. | Show purpose/version first, inspect each installed copy and its recorded source, distinguish loaded/attached state, and keep all viewing read-only. |
| F14 Objects | Basic object content is hidden and table browsing is inadequate. | Immediately show size, content, strings and colors; use a capable grid for approved bounded classes. O01–O06 were approved. |
| F15 | Collapsing a full-height column shrinks neighboring panels vertically. | Collapse along the actual parent split; preserve cross-axis space, prior size, drafts, Undo and refresh behavior. |
| F16 | Object fields and palette browsing do not match analysis priorities. | Configurable directory fields, content-first summaries, complete small palettes, explicit long-vector ranges and vector-level copying. O07–O10 were approved. |
| F17 | Bottom status and missing navigation feel unfinished. | Give projects/resources a clear navigation home and show compact truthful runtime state. Preserve the distinction between prior fixed-shell approval and today's generic plugin workspace. |
| F18 | Runtime foundations are hard to manage. | Make session, connection, environment and recovery states understandable without resetting work. R04–R10 are approved; R01–R03 remain proposals. |
| F20 | R help and interactive outputs lack a usable viewing experience. | Review navigation, anchors, browser opening and lightweight controls. Current Help/Viewer capability does not imply approval of pending HV01–HV07 refinements. |
| F21 | Frames and controls overwhelm narrow panels. | Prefer content, reveal secondary controls on demand, and keep actions reachable at constrained widths. Exact Help/Viewer treatment remains proposed. |
| F22 | Every component needs a way to express thoughts about its content. | Shared text/whole-item/image annotation entry, original source/version, marks and explanations, and accurate Agent inclusion. AN01–AN06 foundation is approved and has scoped evidence. |

The source document assigned **F14 twice**. The labels “F14 Objects” and
“F14 Agent” preserve both references without silently renumbering them.

## Agent interaction and context

| ID | Reported need | Concrete review criterion |
| --- | --- | --- |
| F09 | Setup resembles an instructional modal. | A coherent settings surface, selected connection expanded in place, aligned fields and one primary action; technical evidence on demand. Revised Paper design was approved. |
| F10 | Connecting an installed Agent takes too long and requires manual copies. | Discover the available runtime, expose supported choices, connect to this workspace and accept a task. Distinguish provider quotas, permission waits and setup failures; bound verification waits. |
| F11 | Task work is crowded with configuration cards. | New task leads directly to composition; readable messages and relevant actions lead. Verify that Paper boards belong to the intended page. |
| F12 | Native permissions and context controls are scattered. | Keep native pending requests near input, preserve native option lists/modes, and offer previewable/removable source references and attachments. Do not impose a second Rho approval or assume every provider supports identical inputs. |
| F13 | Chinese preedit is committed prematurely. | Polling/draft acknowledgements never replace marked text; candidate-selection Enter does not send. Retain local committed text on takeover conflicts. Separate synthetic composition from actual OS IME evidence. |
| F14 Agent | Agent activity and scientific results feel disconnected. | Relate a task to exact source content, original operations and outputs; navigating between them preserves the researcher's work. |
| F19 | The former built-in assistant should not become a second Agent interface. | Preserve a coherent interaction for existing code. The next-version decision supersedes the built-in expansion route: compatible external Agents use the same public capabilities. |

For F13, the user confirmed the corrected test page on 2026-09-09; this is distinct
from the later Annotations-only macOS/Edge IME result in Status. Neither proves all
current Agent/Editor controls on all operating systems.

## Annotation review boundary

F22 includes selection comments, freehand drawing, rectangles and written
explanations. Use precise text/data/image anchors when supported and whole-item
comments otherwise. Changed sources or ended sessions must not silently move a
note to new content. Captured interactive views remain distinguishable from live
state and original media. Save/read/navigation do not send Agent work or expand
scientific authority. Unavailable images and uncaptured data remain explicit.

The approved foundation covers eight source entries and bounded text/image
records. Its scoped browser, native-owner and IME evidence is in Status. Further
annotation interactions require their own scope; a foundation pass is not proof
of full-product usability or real-model image understanding.

## Workflow reference

Use the fixed local fixture in `ui/e2e/fixtures/gapminder/` and a prepared dependency
environment. Reusable logic belongs in scripts; Console supports exploration.
Do not install dependencies implicitly as part of an interaction review.

1. Open a project; locate files, arrange Editor/Console together, close and reopen views.
2. Edit and save a project-relative script; execute a line, selection or captured file.
3. Inspect vectors, lists and tables in place; distinguish busy/cached observations.
4. Transform data, save processed results and follow changed files and R objects.
5. Produce several plots; compare an older output and export its original bytes.
6. Extract reusable functions and inspect a model without unwanted focus changes.
7. Explicitly restart R and replay scripts; distinguish retained documents/history
   from reset memory. Restart requires the relevant authorization.

Record intention, action, focus/layout/output and the actual point of friction.
Include wrong paths, unsaved edits, R errors, interruption and old-output selection.
Current browser suites are `ui/e2e/scientific-workspace.spec.ts` and plugin suites;
the fixed `studio.spec.ts` suite was retired with the fixed client.

The tutorial does not independently authorize `.Rproj` associations, package
management UI, import wizards, code navigation/debugging, Quarto, every RStudio
shortcut or full previews of arbitrary classes. Existing separately authorized
features remain governed by their actual contracts and acceptance scope.
