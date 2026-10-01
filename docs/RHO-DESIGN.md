# Rho UI design

This page retains current interaction principles and the approved Paper references.
It is not a runtime acceptance report; [Status](STATUS.md) owns that evidence.
[Next Version](NEXT-VERSION.md#前端分离) separates capability delivery from frontend
work. These designs apply when their UI is changed, not as a prerequisite for a
headless capability or a requirement to keep the built-in Agent product.

## Principles

Give code, data, plots and research work the main reading area. Put internal IDs,
full paths and diagnostics in inspection details. Keep view lifetime separate from
files, sessions, tasks and output. Show observations with their freshness and scope;
keep unknown, partial, cached, stopped and never-started states distinct.

Use progressive disclosure, inline errors and stable focus. Background output
must not steal the user's current work. Explicit scope and consequences precede
mutations; already-authorized Agent operations do not gain a second Rho approval.
Product-authored text and accessible names use English; user content and native
output retain Unicode and their original language.

## Paper decisions

All pages below belong to **Rho · 工作台交互草稿**. Read JSX/computed styles for exact
implementation values. Screenshots establish composition; live behavior and data
need their own checks. Previously approved scope requires no repeat design approval.

| Area | Paper source | Decision boundary |
| --- | --- | --- |
| Packages | [Packages 查看体验设计评审](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0) | Approved 2026-09-08, including Source |
| Agent connection | [Connection review](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/5-0) | Existing UI reference; not a next-version internal Agent commitment |
| Agent tasks and handoff | [Agent 工作区任务设计评审](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/6-2) | Existing task interaction and A20 handoff approved; component examples remain fixtures |
| Objects | [O01–O10](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0) | O01–O06 and O07–O10 follow-up approved 2026-09-09 |
| Shell | [S01–S04](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/8-0) | First version approved 2026-09-09; current generic shell differs from retired fixed composition |
| Runtime | [Runtime 会话与运行管理探索](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/9-0) | R04–R10 approved 2026-09-10; R01–R03 remain proposals |
| Help and Viewer | [HV01–HV07](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/B-0) | Interaction refinement proposals, still pending review |
| Annotations | [AN01–AN06](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/C-0) | Reviewed scope confirmed 2026-09-30 |
| Plugins and Studio | [PS01–PS07](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/p-D-0) | Approved 2026-09-23 |

Substantial new layout/component redesign uses Paper and user review. A new
technical capability, earlier functional pass or approval of another page does
not approve an unrelated interface. Pending proposals are not implementation scope.

## Interaction baseline

The established scientific layout is Files beside Editor/Console and Objects/Plots.
Existing saved layouts take precedence over new defaults. The earlier baseline
uses 220/360 px side columns at 1440×900 and 200/320 px at 1280×800; Editor/Console
split 60/40 and Objects/Plots 35/65. These are reference defaults, not a fixed Host
module composition or a promise that every current scene uses them.

| Foundation | Value |
| --- | --- |
| App bar / status bar / group tabs | 48 / 30 / 38 px |
| Outer gap / splitter | 8 / 6 px |
| Regular control / icon | 28 / 16 px |
| UI / auxiliary / code | Local Inter 13 / 12 px; monospace 14 px at 21 px leading |
| Surface / canvas | `#FFFFFF` / `#F6F8FA` |
| Text / secondary / accent | `#202936` / `#65717D` / `#2863D6` |
| Panel / control / menu radius | 6 / 4 / 8 px |
| Expanded minimum with group chrome | Editor/Console 240×96; Objects/Plots 200×96; Files 180×96 |

Text needs 4.5:1 contrast; state has a text/icon cue as well as color. Reduced motion
removes animated emphasis. Insufficient space allows scrolling rather than closing
views or overwriting saved weights. Pointer actions track the pointer directly.

Close View preserves drafts, output and accepted work; Close Group states its
scope. Discard Draft is separate. Full-column collapse uses a 38 px side rail;
stacked collapse leaves the tab bar without shrinking the cross axis. Restore uses
retained placement. Layout undo is separate from text undo; one resize is one step.
Late file reads cannot reopen a view closed while the read was pending.

Drag previews identify the complete destination region, including shared regions,
and match final placement. Move To provides a keyboard alternative. Escape or an
invalid target discards the preview. Background refresh preserves focus, selection,
scroll, local edits and independent view state.

## Packages

The approved Packages page prioritizes purpose and version. Full paths and detailed
provenance belong in an inspector. It observes an existing R session and never
installs, updates, removes, loads/attaches packages, changes library paths or tests
loadability. Environment management is a separate capability and product scope.

Show actual R version/home/platform and library order. Installed DESCRIPTION copies,
loaded namespaces and attached packages are distinct; the loaded copy can differ
from the first installed copy. Group copies with an explicit count and keep
unavailable/partial observations visible. Busy reads retain their original time.
A new session clears old observations; late responses cannot replace newer searches.

Recorded source belongs to an installed copy. Keep it separate from delivery
repository/provider, environment manager and project homepage. A grouped row uses
the identified loaded copy, otherwise the first observed copy, and flags differing
sources. `Repository` and `Remote*` fields are evidence, not complete installation
history. Current repos, a GitHub homepage, directory names or an unmatched lockfile
cannot prove origin. Missing provenance is **Not recorded**; omit credentials in URLs.

At panel widths of at least 1000 px, use a 360 px adjacent inspector; smaller panels
expand in place. Wide rows are 44 px and compact rows 54 px. Align version, source,
status and copy columns; purpose sits below name. Tiny panels move mode selection
into the search toolbar. Low heights retain name/version before purpose.

All/Loaded/Attached/Multiple copies use the same observed index. Counts describe
that bounded observation, not currently loaded rows. Native pages and copy details
retain observation and session identity; expired reads require a fresh observation.
Relevant limits include 10,000 library entries, 8 MiB scanned metadata and 512
namespaces. Source inspection reads installed metadata without package-manager work.

## Objects

Default directory content answers value or shape before type/size diagnostics.
O07–O08 keep Name first and visible; Content, Size and Type can be reordered,
resized or hidden with keyboard alternatives and retained per-view preferences.
Compact panels preserve useful values/shapes beneath the name.

Disclosure stays local and permits several open objects. Open in New Tab is
explicit and retains the source view. Tables use bounded native-reference pages,
original row indices and supported sorting/filtering; a loaded fragment is never
the whole dataset. Grid navigation, resizing, pinning and TSV copy preserve selection.

Distinguish NA, literal "NA", empty text, NULL and empty vectors. Factor labels
retain inspectable codes. Colors remain original character values and use R's
interpretation, not CSS names. A palette needs sufficient observed values; names
or four samples alone do not establish one. O09 presents complete small palettes
together, retaining mixed/NA/transparent positions and explicit original/hex copy.
O10 distinguishes shown, selected and whole-vector copy; copying obtains complete
values within the 1 MiB / 100,000-value budget before publishing clipboard text.

Unsupported storage remains metadata; safe native readers must not force promises
or dispatch unknown methods. Busy views retain timestamps. Expired references or
changed sessions cannot complete stale pages/copies. Render plot is an explicit
execution, separate from browsing. Paper fixtures are not runtime observations.

## Console and editing

Console presents a continuous selectable transcript and independent command draft.
Keep code input separate from transient stdin. Preserve ordering and distinguish
queued, running, waiting-input, paused followers and unconfirmed cancellation.
Clear View hides observed transcript positions; it does not erase original records
or execute work. A failed run does not silently discard the waiting queue.

Editor distinguishes disk files, synchronized drafts and captured execution text.
Primary actions are Save, Run Line/Selection and Run File. A file run verifies its
saved capture; subsequent typing stays independent. Save conflicts retain local
text. Layout changes, polling and delayed receipts preserve selection/undo and do
not execute code. Respect IME composition when interpreting Enter or shortcuts.

Plots presents retained output history and explicit comparison/export. Original
media, user capture and live interactive Viewer state are distinct. Viewing old
output must not require rerunning analysis. An export is not a new rendering at
arbitrary dimensions. Help/Viewer refinements remain separately proposed below.

## Navigation

S01–S04 approved a 48 px compact rail, 168 px expanded rail, 36 px targets with
18–19 px icons and a 30 px footer. Navigation focuses/restores existing views and
uses a chooser for multiple instances. Full-column collapse preserves workspace
height; narrow layouts preserve user-selected metrics and important input/error text.

Resource observations identify actual processes and storage scope. R CPU/memory
refer to the observed Ark process; project disk refers to the filesystem containing
the project, not directory size. Draft sync is distinct from file saving.
The current generic shell has its own delivered navigation; these references do
not authorize restoring deleted fixed settings/footer owners.

## Sessions and recovery

R04–R10 distinguish the logical session, native execution process, installed runtime,
environment and recovery copy. Selecting an inspected session does not silently
retarget accepted work. One session stays visually quiet; multiple sessions make
the target explicit. Closing management preserves editor and Console drafts.

| Board | Required distinction |
| --- | --- |
| R04 | One-session simplicity and explicit multi-session target |
| R05 | Version/environment, active runs and waiting queue belong to their actual session |
| R06 | Recovery coverage and unprotected objects remain visible |
| R07 | Continue uses valid recovery evidence; real choices explain consequences |
| R08 | Restart, Stop and Quit have different effects |
| R09 | App/Project/Session settings show effective value and inheritance |
| R10 | Narrow list/detail/Back navigation and minimal new-session input |

Shared measurements: controls 30 px with 8 px horizontal padding; small actions
24 px, focus outlines 2 px with 2 px offset; inspector cards 8 px radius and 16 px
padding. Session menu/list/copy-list/settings-navigation widths are 340/256/310/214 px;
status columns are 64 px. Main padding is 24 px. Below 720 px use one-column
navigation. Read the approved Paper styles for remaining exact values.

Restart starts empty memory in a new lineage. Restore coverage is not arbitrary
process recovery. Stopping/quitting must explain remaining work and actual protection;
a lost connection is unknown. These are interaction constraints, not proof that
the current generic workbench exposes every former fixed session panel.

## Agent interactions in the current version

The existing unified Agent panel keeps source selection, scope, task context and
unconfirmed results visible; new input and attachments survive delayed replies.
Chinese preedit must not be submitted as a message. Context sources remain
inspectable/removable and cannot silently retarget an accepted run.

A20 handoff previews Goal/Confirmed/Next and original references, then appends to
an existing draft without sending. It preserves target text, attachments and
permissions under version/controller checks; unknown acknowledgements retain the
original request. Model assertions are not automatically confirmed science.

These references preserve existing behavior during maintenance. The next version
uses external Agents and does not require another chat surface or built-in engine.

## Annotations

AN01–AN06 cover quoted text, captured images/marks, constrained layouts, historical
versions/conflicts, shared entry/anchors, and empty/filtered/deleted/unavailable
states. Approved scope may proceed without a repeat design review; implementation
and real-model quality still need separate evidence.

Notes belong to an ordinary plugin. Sources retain ownership and versions. A saved
note records identity/revision, author, source/version, anchor, text and necessary
capture references. Viewing a note does not expand access to its source.

Every supported component has an accessible whole-item entry; precise selections
are used where the owner can provide them. Files/Editor retain text identity and
quotation; Objects retains native observation/coordinates; Packages retains the
installed copy; Console/Plots retain producing-run/output identity; Help retains
copy/topic; Viewer captures are explicitly labeled when underlying interaction/data
cannot be captured. Agent task items retain exact item revisions where available.

Marking controls stay hidden during normal reading. Pen, Rectangle, Arrow and Text
share notes and local Undo. Source changes do not rewrite frozen evidence; current
availability remains unknown until checked. Continue creates a deliberate new
version. Adding to an Agent draft does not send a message or change permissions.
Inspect keyboard paths and the reviewed 600 px editor / 320 px inclusion layouts.

## Plugin management and Studio

PS01–PS07 retain these boundaries:

- List purpose/revision/use first; show exact artifacts, dependencies and protecting
  references in inspection. Delivered packages have no special permissions.
- Scenarios pin exact revisions. Prepare before switching one window; other windows,
  retained drafts and accepted work keep their original targets.
- Studio distinguishes Editing, Scenario and Running revisions. Checkpoint, build,
  preview and application have separate outcomes. Canvas inspection never runs science.
- History is immutable. Restore creates a new checkpoint; it does not rewind files,
  R memory or credentials. Applying a revision does not replace old running instances.
- Fixture preview has no scientific grants. Real backend tests use disposable projects.
  Failed builds preserve applied versions; invalid drafts retain the last valid canvas.
- View closure and instance release are distinct; cleanup failure remains visible.
- At 390 px, detail replaces the list with Back preserving selection/scroll. Identifiers
  wrap in details; source/history use their own full-width views.

The next version can develop these capabilities without building their frontend
first. Existing Studio's Agent handoff is an implementation to decouple, not a
requirement for a specific Agent provider in the future design.

## Pending proposals and visual verification

R01–R03 remain investigation/proposal boards. HV01–HV07 propose Help/interactive
Viewer refinements, system-browser opening, Help anchors and lighter controls.
Existing HTML/runtime capability does not mark those interaction proposals approved.
Annotation approval does not expand their scope.

For UI work, inspect real content at normal, wide and constrained sizes. Verify
focus, keyboard, drag, clipboard, persistence and applicable system IME. Reuse valid
unchanged evidence; a synthetic event is not a native input-method test.
[Feedback](STUDIO-FEEDBACK.md) preserves user concerns; only new observations can
close a usability issue. Exact Paper fixtures remain design sources, not live data.
