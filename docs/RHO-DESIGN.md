# Rho product design philosophy

Version: 0.3 — Calm Precision interaction specification, 2026-09-08.

This document defines the product principles and accepted Studio interaction
contract. Section 10 specifies this implementation round. Runtime evidence and
remaining verification limits are reported separately; this document alone does
not establish that an interaction has been verified. User feedback remains in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md); implementation decisions, milestones and
verification remain in [STATUS.md](STATUS.md).

The Studio regression baseline is `studio-round1-baseline-2026-09-07`. This round retains React, FlexLayout and CodeMirror. Additional tutorial features
and replacement libraries remain outside its scope. Existing scientific and Agent ownership
constraints remain authoritative.

## 1. Product purpose

**Rho is a scientific workspace in which people can understand what they are
working with, act precisely, and trust what happened.**

Its design should support the recurring cycle of writing, running, inspecting,
comparing and revising. The workspace must accommodate both a quick question and
hours of concentrated analysis. Files, code, live objects and outputs need distinct
identities and useful relationships.

The proposed design character is **Calm Precision**:

- **Calm:** stable spatial relationships, restrained chrome, few unnecessary
  interruptions, and continuity of focus.
- **Precise:** explicit action scope, readable scientific content, accurate state,
  and predictable consequences.

Professional quality is demonstrated by dependable behavior over an entire task.
It is not established by visual resemblance to another product or by a successful
smoke test. For Rho, delight should come from control, orientation and confidence
during real analysis. A physically responsive interface still has to report
scientific results truthfully.

## 2. Principles

### P1. Give the work the strongest visual presence

Code, data and figures deserve the primary reading surface. Navigation and controls
should help people act on that content, with a clear distinction between primary
commands, secondary commands and supporting information.

**Consequences:** A plot gets an unobstructed canvas. Console preserves a readable
transcript. Operation identifiers and technical diagnostics remain accessible in
context, with detailed records available on demand. Necessary warnings remain
visible; reducing chrome must not conceal uncertainty or unavailable functionality.

**Failure signal:** Someone must scan repeated status cards and metadata to find
the latest R output, or cannot see enough of a figure to interpret it.

### P2. Keep scientific identity stable while views remain flexible

A file, a live R object, an execution and a plot output are different things.
A panel or tab is a view of something, not the thing itself.

**Consequences:** Closing a view preserves its underlying document. Collapsing a
group changes its presentation. Discarding a draft, deleting a file and removing
an R object need distinct verbs and explicit targets. Reopening a view must not
rerun code. Several views of one output must identify the same original.

Layout flexibility must support analysis relationships. Docking should clearly
identify whether it targets a panel, a group, or the whole workspace. The preview
must match the resulting arrangement; a user should not need to discover invisible
drop zones through repeated failed attempts.

**Failure signal:** Moving or closing a panel changes scientific state, loses an
edit, or makes the user unsure which result they are viewing.

### P3. Reveal detail without taking away context

Inspection has different depths: recognize an item, take a quick look, then work
with it in a dedicated view. The first action should usually answer the immediate
question where it arose.

**Consequences:** Object details expand in the existing objects panel by default,
following the user's explicit feedback. A separate tab requires **Open in New Tab**
or another clearly named action. Basic inspection retains selection, scroll
position and neighboring objects. Expanded details remain bounded and describe
what is omitted.

Selecting, expanding, opening a view and executing are different actions. A
single click must not ambiguously combine them. Background outputs must not steal
editor focus or silently replace a deliberately selected historical plot.

**Failure signal:** Checking the dimensions of a data frame forces the user into
a different tab and then makes them reconstruct their previous place.

### P4. Make scope and consequences understandable before action

Controls should use familiar verbs, identify their target, and behave consistently
across mouse, keyboard and command entry. Direct manipulation needs understandable
feedback and a reliable alternative for people who cannot use the gesture.

**Consequences:** A drop preview outlines the complete affected region. Commands
identify the panel or group they affect. **Run File** has a consistent save policy
and executes the captured, verified content. **Stop** reports a stop request until
the runtime confirms an outcome. Disabled commands explain the relevant reason
without requiring someone to trigger an error to learn it.

Use reversible actions where possible, and make recovery local to the mistake.
Restoring one collapsed group should not reset unrelated layout work. Routine
view changes should not require confirmation; meaningful loss of unsaved work
requires an appropriate recovery or explicit choice. Agent permissions remain
with the external Agent platform; this principle does not create Rho approvals.

**Failure signal:** A user discovers the action's real scope only after clicking,
or must reset the entire workspace to correct one placement mistake.

### P5. Support fluent expert work with discoverable entry points

Professional tools need both an understandable starting point and a fast repeated
interaction. Defaults should make ordinary work comfortable without requiring
workspace configuration first.

**Consequences:** Common commands have visible entry points and consistent
shortcuts. Console is designed around a prompt, editing input, command history
and continuous output. Multiline input and return-to-prompt behavior need explicit
semantics. A dark background by itself does not establish terminal behavior.

Editor highlighting must reflect R syntax and remain legible across real scripts.
Control density should reflect task frequency; shrinking content or hiding core
commands is not an acceptable way to fit a narrow panel. Advanced options may be
disclosed progressively, but ordinary tasks must not depend on undocumented gestures.

**Failure signal:** Every short exploratory command takes several unnecessary
clicks, or a new user needs memorized shortcuts to discover basic functionality.

### P6. Show observed truth with proportionate feedback

The interface should communicate what is known, what is still happening, and what
cannot yet be confirmed. Feedback must be noticeable enough for its consequence
without continuously demanding attention.

**Consequences:** Differentiate in-memory edits, synchronized drafts and saved
project files. Show when an object observation was taken and whether it is stale.
Distinguish accepted, running and terminal execution states. Missing metrics are
unknown. Missing output stays missing, with an explanation and an appropriate
recovery action.

Use quiet, local feedback for routine success; clear inline explanations for
recoverable problems; and interruptions when a consequential user choice is
needed. Important information must not rely on color or a disappearing toast alone.
Detailed diagnostics support investigation without replacing the main work surface.

**Failure signal:** A green check appears before a save is confirmed, or normal
polling repeatedly interrupts typing and overwhelms meaningful warnings.

### P7. Help exploration become reproducible work

A session contains temporary working state. A project contains assets that should
make the analysis understandable and repeatable. The interface should help people
understand this distinction while supporting natural exploration.

**Consequences:** Scripts remain easy to return to after Console exploration.
Execution input, its source when known, and its outputs remain related without
inventing provenance that was not observed. Interactive image export clearly
states what original output it saves; script-controlled export makes dimensions
and rendering choices repeatable. These are different operations.

Restarting R must clearly separate the loss of live memory from retained files,
drafts and recorded outputs. A clean restart and script replay is an important
workflow review, not a promise that every possible analysis or external dependency
can be reproduced automatically.

**Failure signal:** A figure can be seen but its producing action cannot be
identified, or essential analysis steps exist only in a forgotten interactive session.

## 3. Shared interaction vocabulary

These proposed distinctions apply across Studio, rather than being reinvented by
each panel. Precise labels and gestures still need design and scenario validation.

| Action | Meaning | Expected continuity |
| --- | --- | --- |
| Select | Choose the current item | No implicit execution or new tab |
| Expand / Collapse Details | Reveal or hide a bounded inline inspection | Preserve the surrounding list and selection |
| Open in New Tab | Create or activate a dedicated view through an explicit action | Retain the source context; do not duplicate execution |
| Close View | Remove this view from the layout | Preserve its document, output and running work |
| Collapse Panel Group | Reduce the group's visible area | Preserve its tabs, content and recoverable size |
| Move / Dock | Change a view or group's placement | Show the full target and preserve scientific state |
| Save | Confirm project-file content through its owner | Keep later edits dirty; do not imply draft sync is file save |
| Run | Submit the stated code scope | Retain input/output correlation and the active editing context |
| Stop | Request interruption | Wait for the runtime's actual result |
| Export Original | Save the selected output's original bytes | Preserve output identity; do not imply new render settings |
| Discard Draft / Delete File / Remove Object | Change the named underlying entity | Make the different targets and consequences explicit |

A consistent vocabulary does not mean identical panel bodies. An editor benefits
from a continuous code surface, Console from a transcript, objects from a
hierarchical list, and plots from a navigable canvas. Shared interaction semantics
and common chrome should connect these different working surfaces.

## 4. Visual and language foundations

The visual expression should be precise, quiet and durable: clear typographic
hierarchy, deliberate alignment, restrained borders and purposeful accent color.
Existing Paper variables are a starting point, not proof of an adequate design.

- Give scientific content enough contrast and room to read. Use monospace where
  code or aligned numeric information benefits from it, and readable UI type for
  navigation, labels and explanations.
- Use spacing to explain relationships. Keep related controls together and align
  repeated icon, label and action positions.
- Use accent color for selection and primary action, with distinct and accessible
  state cues. A chart's scientific colors belong to the plot, not the UI theme.
- Preserve content size when a container shrinks. Adapt secondary controls and
  metadata first; retain essential actions and clear overflow access.
- Use motion to explain state and spatial relationships. Direct pointer tracking
  and released-state transitions have different roles; see section 5. Keep scientific
  content legible during movement and provide reduced-motion alternatives.
- Use English for product-authored UI and consistent domain terminology. Preserve
  the original language of user content, paths and native runtime output.

Accessibility is a foundation, not an optional expert mode: keyboard navigation,
visible focus, readable text, sufficient contrast, meaningful labels, adequately
sized targets and alternatives to dragging must be considered from the start.
The current browser host must respect browser and OS conventions; adopting a
professional desktop interaction model does not justify claiming native features
that the delivery surface does not provide.

The accepted values in section 10 give representative interaction work a concrete
starting point. Changes to them should follow measured use. Blur and
translucency are optional treatments, not identity requirements. Keep code, tables
and plot interpretation surfaces stable and high-contrast; test any layered chrome
against realistic content and accessibility preferences.

## 5. Interaction mechanics for Studio

Apple's [fluid-interface work](https://developer.apple.com/videos/play/wwdc2018/803/)
emphasizes prompt response, redirection and spatial continuity. Its
[drag-and-drop guidance](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop)
requires feedback throughout a drag, including destination validity and failure.
The following are proposed Rho-specific consequences, not implemented features.

### Direct tracking and deliberate placement

- Preserve the grab offset when a panel or plot is picked up. During free dragging,
  preview displacement follows pointer displacement; do not insert spring lag
  between the pointer and the representation being held. At constraints, explain
  the boundary rather than making the interface appear unresponsive.
- Distinguish an individual panel, a containing group and a workspace-edge target.
  Highlight the complete proposed destination and communicate what will move.
  Stabilize adjacent target selection so tiny pointer movements do not cause flicker.
- Treat press feedback, drag recognition, preview and drop commitment separately.
  Pressing a close control must not begin a panel drag. A cancelled drag must not
  become a click, close, scientific operation or silent layout commit.
- Provide an explicit placement command and keyboard path alongside dragging.
  Pointer release outside a valid destination, Escape, lost capture and focus loss
  need defined cleanup behavior. Retain the last committed layout when abandoning
  an uncommitted preview.

### Motion can be redirected

A new interaction takes over from the visible presentation, not from an unseen
animation target. Avoid queues that require one transition to finish before the
next input can act. For motion with inertia, preserve an appropriate velocity
handoff; Apple's [SwiftUI animation explanation](https://developer.apple.com/videos/play/wwdc2023/10156/)
shows how springs merge prior animation state to retarget continuously.

Rho should select behavior by the task:

| Interaction | Proposed motion behavior |
| --- | --- |
| Splitter resize or panel placement | Track input precisely; respect size limits; do not throw a panel into another group based on release speed |
| Panel maximize/restore | Preserve a recognizable origin and return destination; allow a new request to retarget the visual transition |
| Inline object details | Expand from the source row, preserving its position and selection as far as available space allows |
| Plot pan/zoom | Preserve the inspected location or pointer anchor, aspect ratio and output identity; validate any inertia before adopting it |
| New output arriving | Update without stealing focus, changing a chosen historical plot, or pulling a user away from scrolled-back output |

Use springs when settling or momentum is useful, with little or no visible bounce
for precision work. Simple state feedback can use CSS transitions. A spring library
alone does not guarantee correct cancellation, velocity transfer or input ownership.
Community timing constants are examples, not universal Apple or Rho parameters.
Never animate scientific values between unrelated results or distort plot geometry
to make a transition feel physical.

### Feedback describes the right event

Apple's [audio-haptic design principles](https://developer.apple.com/videos/play/wwdc2019/810/)
connect feedback to a recognizable cause, compatible sensory qualities and actual
user benefit. They support restraint, not adding another signal to every action.
For the browser Studio, visual/text feedback and accessible state carry the meaning.
Sound is optional; native haptics are not a dependency or a current capability.

| Event | Proposed feedback |
| --- | --- |
| Press / drag / destination change | Immediate local response showing what input was recognized and where it applies |
| Save or execution request sent | Show pending/accepted state; do not imply that bytes were saved or R completed |
| Owner confirms a result | Update the relevant state and result; reserve attention-grabbing feedback for meaningful events |
| Conflict / unavailable original / uncertain outcome | Keep an understandable explanation and recovery path available; do not rely on a transient animation or sound |

A reversible visual transition and a native execution have different lifecycles.
Taking control of an animation does not reverse an R effect; an immediate Stop
button response still waits for the owner's actual cancellation outcome.

### Web translation and accessibility

Use the existing layout and editor owners before introducing custom gesture logic.
For a custom interaction, [Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)
provide pointer capture to retain event targeting outside an element, with release
and cancellation events to handle. Capture is not a guarantee of input outside
the browser, nor a substitute for drop-target detection and cleanup. Limit any
`touch-action` restriction to the relevant surface and preserve native scrolling,
text selection and browser zoom elsewhere.

When motion needs velocity, use timestamped recent samples rather than one pointer
position. Keep coordinate spaces and velocity units consistent. Schedule custom
painting through [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame),
use its time information, and handle background-tab suspension without a jump.
Do not put network waits, SQLite synchronization or whole-workbench rendering on
the pointer-tracking path. No refresh-rate or latency guarantee is claimed without
measurement on the actual input device and workload.

Honor [reduced-motion preferences](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
with restrained/static transitions while retaining tracking, focus, target cues
and result feedback. Keyboard operation, silent use, larger text and readable
contrast must remain complete experiences. Apple's [motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion)
adapts to input method; touch-oriented effects need not be copied onto a mouse-driven
scientific workbench.

## 6. Make quality repeatable

Reuse interaction semantics as well as colors and spacing. Shared controls should
specify hover, focus, pressed, disabled, busy and error behavior, including keyboard
activation and focus return. Panel chrome, disclosure, menus and plot controls
should follow these contracts across components. Code written by people or generated
during development receives the same review and tests.

Truthful results, preservation of user work and execution boundaries constrain every
design choice. Within them, favor context, discoverability, low repeated effort and
legibility. Quiet styling must not hide an unconfirmed save; compactness must not
remove Stop; an overflow menu must not become the only discoverable working model.

Build confidence through shared primitives, interaction tests, accessibility review
and sustained scenarios. This is a product engineering convention, not another
runtime approval system. Library behavior still needs observation; adopting a
component package does not establish that Rho's complete interaction is correct.

## 7. Apply the philosophy to the reported issues

| Feedback | Relevant principles | Design question to answer |
| --- | --- | --- |
| F01: cannot remove components | P2, P4, P5 | Can a person deliberately close the intended view or group and recover it without losing work? |
| F02: docking around several panels | P2, P4 | Does the interaction clearly target an individual panel, a parent group or the workspace edge? |
| F03: English interface | P5; language and accessibility foundations | Is terminology consistent across visible UI and accessibility labels, with user content preserved? |
| F04: weak highlighting | P1, P5 | Can someone read actual R syntax accurately, beyond a short demonstration snippet? |
| F05: Console feels unlike a command line | P1, P5, P6 | Can someone explore rapidly through a continuous prompt/transcript without metadata overwhelming it? |
| F06: object clicks create tabs | P2, P3 | Can someone inspect in place, with dedicated views opened only deliberately? |
| F07: rough plot experience | P1, P2, P3, P7 | Can someone identify, inspect, compare and export a plot while retaining context and original identity? |

## 8. Validate through a sustained scientific workflow

Use the supplied gapminder tutorial as a scenario source, as described in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md). Follow the same project through scripts,
Console exploration, object inspection, repeated plotting and restart/replay.
Keep realistic accumulated files, objects, history and layout changes between steps.
Tutorial features outside the current scope remain separate decisions.

Observe task completion, mistaken actions, forced navigation, focus loss, hidden
controls, recovery effort and uncertainty about scientific state. Include both
first-use discovery and repeated keyboard-heavy work, with normal, narrow, short
and maximized views. Review press, drag, reversal, release, cancellation, rapid
repetition and return of focus—not just the final screenshot. Include slow owner
responses, heavy output, reduced motion, and a background/foreground transition.
Check perceived response and frame behavior separately from total execution time.

Functional tests, accessibility inspection, scenario observation and visual review
provide different evidence. None is a substitute for the others. Do not claim
universal correctness, an arbitrary usability score, or measured performance
without observations. Refine these proposed principles when real work exposes a
conflict. Keep current decisions and evidence in [STATUS.md](STATUS.md).

## 9. Reading Apple accurately

The current [HIG design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles),
updated in June 2026, name Purpose, Agency, Responsibility, Familiarity, Flexibility,
Simplicity, Craft and Delight. They are tools for weighing decisions, not a visual
recipe. [Principles of great design](https://developer.apple.com/videos/play/wwdc2026/250/)
distinguishes simplicity from minimizing controls and treats delight as an outcome
of a coherent experience. Rho's seven principles adapt that perspective to scientific
identity, concentrated work and reproducibility.

Keep these distinctions when interpreting secondary articles and community skills:

- The preference for indirect gestures on common controls is in the **visionOS**
  section of [Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures).
  It concerns gaze/hand input versus reaching to virtual objects; it is not a
  universal classification of an iPhone tap or a desktop mouse action.
- Apple does not define all haptics as four vibration levels. Current
  [Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)
  describes notification, impact and selection feedback on iPhone, five impact
  styles, and transient/continuous custom events. Native Mac trackpad feedback
  has its own patterns. These do not establish portable browser haptic support.
- [App Review](https://developer.apple.com/app-store/review/guidelines/#design)
  publishes approval requirements, some of which refer to HIG. This is different
  from claiming that every HIG recommendation is universally mandatory or that
  third-party apps must share one appearance. Standard components and their default
  behaviors also support consistency.
- The supplied [community apple-design skill](https://mcpservers.org/zh-TW/agent-skills/emilkowalski/apple-design)
  is a useful discovery aid, not Apple documentation. Its web techniques, timing
  values, blanket animation rules and material treatments require independent
  validation. No new dependency or skill installation follows from reviewing it.

Additional foundations remain [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/),
[Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls),
[Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback),
and [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).
Sources inform the proposal; they do not certify Rho's implementation. The current
browser delivery, scientific owners and open user feedback remain the basis for
choosing and validating each interaction.

## 10. Studio interaction contract

The default workspace is `Files | [Editor / Console] | [Objects / Plots]`.
At 1440 × 900, Files occupies 220 CSS pixels and the inspection column 360;
at 1280 × 800 these become 200 and 320. The editing column receives the remainder.
Editor/Console split 60/40, Objects/Plots 35/65. These defaults apply to new
workspaces and explicit **Reset Layout**. Existing layouts remain valid.

| Foundation | Value |
| --- | --- |
| App bar / status bar / group tab bar | 48 / 30 / 38 px |
| Outer gap / splitter | 8 / 6 px |
| Regular control / icon | 28 / 16 px |
| UI / auxiliary / code type | Local Inter 13 / 12 px; monospace 14 px with 21 px line height |
| Surface / canvas | `#FFFFFF` / `#F6F8FA` |
| Text / secondary / accent | `#202936` / `#65717D` / `#2863D6` |
| Panel / control / menu radius | 6 / 4 / 8 px |
| Expanded minimum including group chrome | Editor/Console 240 × 96; Objects/Plots 200 × 96; Files 180 × 96 |

Use English for all product-authored text and accessible names. User content and
native output keep their original language. Code, text and status remain readable
at 4.5:1 contrast. State has a text or icon cue as well as color. Small groups
retain essential controls and a global reopening entry; insufficient workspace
size permits scrolling instead of automatically closing views. Direct dragging,
resizing and panning track the pointer. Controls use brief feedback and inline
inspection uses 120 ms emphasis; reduced motion removes animated feedback.

### Views and placement

**Close View** removes a view and keeps its draft, recorded output and accepted
runs. **Close Group** names its scope and closes every view in that group. Empty
groups release their space. An entirely empty workspace offers Open File, New R
File and Show Panels. Discard Draft is a separate document action.

Collapse follows the parent split: a full column becomes a 38 px side rail;
a vertically stacked group leaves its 38 px tab bar. The cross axis stays
unconstrained so neighboring groups retain the workspace height or width.
Restore uses the retained weight and original group/tab limits within
available space. Maximize/Restore returns to the corresponding group state.
Startup reconciliation restores view membership without expanding collapsed
groups; only an explicit Show/Activate/Restore action expands them.
**Undo Layout Change** retains twenty committed changes and never shares the
editor's undo history. A resize gesture contributes one history entry. Reopening
uses a surviving original group or neighbor before choosing a current destination.
A late file read cannot reopen a view closed while the read was in flight.

Native FlexLayout tab and workspace-edge dragging remain available. Shared-region
targets name the remaining panels, for example **Editor + Console**.
During a drag, small parent-region targets sit at the shared child boundary:
left/right of stacked panels and above/below panels arranged side by side.
Hover names the remaining panels, outlines the full region and previews the actual
result. Drop targets stay above the native drag overlay. The global matrix of
parent-direction buttons is removed; the source is excluded from destination names.
Moving a view frees its original space, so validity uses the layout engine's
redistribution rather than a fixed threshold on the target's previous dimensions.
**Move To…** supplies a keyboard path through region and direction, including
Join as Tab for a group. Previews use a separate model and show both the complete
region and the resulting occupied area. Release commits one public move action;
Escape, invalid destinations and cancellation discard the preview. Shared-boundary
targets remain stationary during preview; the native drag image retains its grab offset.

### Editing and files

The file tree reads real directories on demand, including Git-ignored data.
Selection, expansion and opening remain separate: Enter or double-click opens a
file, while repeated opens locate the same document. Hidden files default off.
Directory filtering applies only to observed entries in the named directory.
Project search has explicit limits of 200 results, 200 directories and 10,000
entries and reports incomplete searches. Neither path treats an omitted result
as evidence that a file does not exist.

The editor hub is replaced by document tabs when a file opens. Primary actions are
Run Line/Selection, Run File and Save. Secondary actions include formatting, Save
As, disk comparison and discard. Buttons and shortcuts use the same document
conditions; code execution requires an R document. Other text files use plain text.
CodeMirror state belongs to the document and configuration uses Compartments.
Layout changes and observations preserve selection and undo.

R syntax support is pinned to `@codincod/codemirror-lang-r@0.1.1` through Rho's
adapter. Ordinary names retain body text color; function definitions/calls,
parameters, namespaces, literals, comments and operators have distinct treatments.
Keyword, document-word and last-observed object suggestions are bounded editing
aids. R remains the execution parser; no LSP or runtime-completeness claim is made
for cached suggestions or the local completeness fallback.

Run File captures its text at the click, saves it and verifies the returned file
digest, then submits that exact capture. Later edits stay dirty. A new file first
uses Save As. Conflict, unconfirmed save, size failure or page closure before
submission cannot schedule a deferred replay. Saving a file and synchronizing a
draft have distinct status. BOM, line endings, Unicode and patch/request bounds
remain part of save correctness. Formatting applies automatically only when the
request text is still current; otherwise comparison preserves newer edits.

### Console, queue and input

One project has one shared local R session. Multiple Console views have independent
input/selection/scroll state and share execution history and the Workspace queue.
Closing a Console never cancels accepted work. The status bar keeps a path to an
active run or input request when its originating view is closed.

Console is a continuous, selectable CodeMirror transcript with compact plot links
and thumbnails. File runs identify their actual source; Run Details exposes full
captured code, operation identity and diagnostics. Console mode prints each visible
R expression through native R dispatch, including S3/S4 and ggplot values. Ordered
stream events are not appended again at completion. Terminal controls are
interpreted as bounded text/color changes; HTML is never inserted as live markup.
Clear View changes only that view's display range. Scrolling back suspends following;
New Output returns to the bottom.

Enter submits complete input and continues incomplete input. Shift+Enter always
inserts a line; Command+Enter explicitly submits the buffer. Up/Down browse history
at visual boundaries and Escape restores the prior draft or dismisses completion.
Pasting never executes, and composition keys never submit. Browser reload, tab-close
and zoom shortcuts retain browser behavior. Idle completeness uses Ark's
`is_complete`; busy fallback is explicitly an editing aid before native parsing.

The Workspace queue accepts at most 32 pending runs and serializes all R sources.
Accepted entries remain Queued until execution qualification is acquired; the
qualification lasts through final operation commit. Pause Queue leaves the active
run alone. Resume is bound to the observed pause identity. Pending cancellation
arbitrates atomically with execution start; a started run requires an explicit
Interrupt. Failure, interruption or an unconfirmed result/commit pauses followers.
Queued code is immutable; Copy to Console starts a separate edit and submission.
Host restart never replays the queue.

Jupyter stdin is a separate control channel to the running R request. Identity
binds session, operation, native input request and reply. An answer field does not
replace the next command draft. Another Console can explicitly Answer Here.
Only a focused origin without later edits may transfer focus automatically.
Password answers are masked, transient and absent from drafts/history/logs.
Input waiting suspends execution timeout while interruption remains available.
Reconnect observes the request first; an answer is never blindly resent. Submitted
is distinct from R having continued.

### Objects and plots

Object disclosure expands bounded content in place, with multiple simultaneous
expansions and Collapse All. **Open in New Tab** is explicit. Standard data frames
and ordinary tibbles use at most 20 rows × 10 columns; base vectors use at most 20
items. NA, NaN, infinity and non-previewed values remain distinguishable. The
object list contains at most 200 entries and states the observed total/truncation.
Unsupported classed/opaque values and active/lazy bindings retain the safe
metadata-only boundary. Section 14 extends inspection for named native storage
layouts without calling their methods.
Busy observations show their age. Refresh after execution covers the list and
visible expanded previews; caches cannot cross a native session identity.

Plots have a fitted canvas with 16 px padding, original-size view, pointer-anchored
wheel zoom, center-anchored controls and bounded direct panning. Manual zoom spans
1%–800%; Fit derives its scale from available space. Resizing preserves a manual
view's inspected center. Each original has an independent transform in each view.

Follow Latest is initially on. Selecting history or inspecting a plot pauses it;
new output gets a count and Go to Latest restores following. A new comparison view
pins the selected original and opens beside the existing workspace. History uses
operation/output identities and an independent bounded media query, including
when live R is unavailable. Visible thumbnails and the selected original share a
byte-budgeted cache. Details report known source/time/format/dimensions/size and
operation association; unknown values remain unknown. Export Original saves the
verified original bytes with operation/output identifiers in its filename. Missing,
checksum and decode failures retain separate explanations and recovery actions.
SVG stays in an image element; HTML/widgets remain descriptive output.

The ongoing acceptance project uses the fixed gapminder CSV and local R libraries.
Its provenance is in `ui/e2e/fixtures/gapminder/source.json`. The required review
covers editing, queue/error/input transitions, simultaneous object inspection,
plot history/comparison/export and recovery in one analysis. Performance evidence
must state workload, machine and measurement method independently of functional
acceptance. Independent R sessions, LSP/DAP, package/data management, Quarto,
plugins and distribution remain outside this round.


## 11. Read-only package inspection

Packages is an optional Studio view opened from **Panels → Packages**, initially
joining the Objects group. It follows the same close, reopen and docking behavior.
Existing layouts are preserved. Package inspection answers what the current R
session observes, rather than selecting an installation strategy.

- Show the actual R version, R home, platform and ordered `.libPaths()` from the
  connected session. Do not infer conda, renv or another manager from a path name.
- Distinguish installed DESCRIPTION metadata, loaded namespaces and packages
  attached to the search path. Show all observed copies of a package, their
  versions and libraries, the first installed copy in library order, and the
  separate version/path of any already loaded namespace. A loaded namespace can
  continue using a different copy from the one first in the current library paths.
- Search names/titles, page results, and expand details in place. Bound each page
  to 100 rows (API maximum 200), library paths to 128, scanned entries to 10,000,
  namespaces to 512 and a DESCRIPTION file to 256 KiB. State incomplete reads;
  absence from an incomplete observation is not proof a package is missing.
- Query only an existing R session. Visible observations refresh after execution;
  Refresh also covers external library changes. While busy, keep the last
  observation and its timestamp. Clear observations on session/project changes
  and reject late responses from the former session or an earlier search.
- Inspection never installs, updates, removes, loads or attaches a package,
  changes `.libPaths()`, executes startup files, or tests loadability. Package
  installation and environment-management decisions belong to a future separate
  plugin, including runtime, OS, library configuration and R-version choices.

The user scoped this view on 2026-09-08. Existing scientific Environment capabilities
remain available through their owner; this view adds no installation workflow.


### Paper-approved visual refinement

The [Paper Packages proposal](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0)
responds to the user's rejection of the first implementation's visual hierarchy.
The user approved this direction and its Source addition for implementation on
2026-09-08. Runtime verification is recorded in STATUS.md.

The interface puts package purpose under the name and aligns version/session/copy
information in stable columns. It groups a package's installations behind an
explicit copy count, uses inline disclosure in narrow panels and an adjacent
inspector in wide panels, and keeps full paths in details or the R/library summary.
Observation scope, loaded-versus-first-copy differences, missing results and busy
state remain visible. Complete unique counts and grouping require an appropriate
bounded observation from the owner; they cannot be inferred from a partially
loaded text page. Busy filtering must identify the cached observation it covers.
The design introduces no install, update, load, detach or runtime-switch action.


### Package source presentation

The user endorsed the Paper direction and requested a Source location. The design
includes a Source column in wide lists, a scoped Source row in compact details,
and a source inspector for each installed copy. The fourth Paper artboard shows
actual local ggplot2 GitHub/CRAN metadata alongside clearly marked example states.

Keep the recorded source (CRAN, Bioconductor, R-universe, GitHub/GitLab/Bitbucket,
Git/SVN, R-Forge, another repository, URL, local file/directory, or known R-provided
base package) separate from the distribution provider/repository and environment
manager. A CRAN package may be delivered by Posit Package Manager; an R-universe
package can also have a Git upstream. Conda channels or a system package manager
are distribution evidence when known; renv is environment/project context.

Source belongs to an installed copy. A grouped row uses the loaded copy's recorded
source when identified, otherwise the first observed copy in library order, and
indicates additional sources when copies differ. Details identify the library,
repository, remote ref/commit or repository snapshot when recorded, and the basis
for each statement. A full commit remains available behind its shortened display.

`Repository` and `Remote*` installed metadata provide recorded clues; they do not
establish every historical download fact. Current `repos`, a project homepage or
GitHub URL, a package name, or a library directory cannot by themselves prove where
that copy was obtained. A project lockfile is a separate record, not automatic proof
of the current installed copy; attribution needs an explicit matching basis.
Unrecorded provenance displays **Not recorded**. Project links stay separate from
installation provenance. Repository URLs must omit embedded credentials. Inspection
does not load packages, invoke a package manager, change repositories or install.

Documentation basis: [renv package sources](https://rstudio.github.io/renv/articles/package-sources.html),
[remotes source types](https://remotes.r-lib.org/),
[R-universe repositories](https://docs.r-universe.dev/install/dependencies.html),
[Posit repositories and sources](https://docs.posit.co/rspm/admin/repositories/),
and [Conda channels](https://docs.conda.io/projects/conda/en/stable/user-guide/concepts/channels.html).


The implementation uses a 360 px inspector when a panel is at least 1000 px wide;
otherwise selection expands in place. Wide rows are 44 px and compact rows 54 px,
with fixed version/source/status/copy columns in the wide view and a one-line
purpose below each package name. Tiny panels move the mode selector into the
search toolbar; at low heights the row keeps name/version while purpose is hidden.
All, Loaded, Attached and Multiple copies filters operate on the same observed
index. Counts include the whole bounded observation, not just loaded UI rows.
The client labels partially cached results and remains searchable while R is busy.

The owner returns a paginated grouped index or the copies of an exact package.
Continuation requests bind both observation identity and native session. The bridge
retains its last two observations; expired reads require an explicit Refresh.
Each native observation is limited to 10,000 scanned library entries and 8 MiB of
scanned metadata, plus at most 512 loaded namespace observations. Source reads use
installed DESCRIPTION fields, not current repository options or package-manager
execution. Explicit repository URLs can identify a known provider/snapshot; absent
delivery records stay unrecorded. No new conda database or renv lockfile attribution
is inferred. Scope remains read-only.

## 12. Agent connection experience

The user rejected the initial modal design on 2026-09-09 and supplied a desktop
Agent-settings screenshot as the visual reference. The current
[Paper review](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/5-0)
contains two revised settings-page boards: Agent apps and Connections. The user
approved these designs on 2026-09-09 and authorized implementation.

The revised direction uses a persistent 200 px settings rail, a broad white
content surface and a centered list. The selected Codex row expands in place;
other connection presets remain compact. At 1440 × 900, the surface starts at
(232, 64), is 1192 × 820, and uses 184 px horizontal insets. App chrome is 56 px;
controls are 38–42 px, row icons 42 px, and card corners 12 px. Inter remains the
UI font with 24 px page titles, 13–14 px controls/body and 12 px secondary labels.
Neutral canvas/row/border/text values are #F3F3F4 / #F8F8F9 / #E5E5E7 / #242426;
secondary text is #68686D. A charcoal primary action and restrained semantic
connection badges replace the earlier blue instructional dialog. These settings
values apply to the approved settings surface; scientific panels retain their
existing visual tokens.

After trying the manual flow, the user explicitly requested direct local CLI use
and native model selection on 2026-09-09. The approved visual hierarchy remains;
the primary cards now discover installed Codex, Kimi and DeepSeek Harness, show their native model
and reasoning choices, and connect to the current project/window without clipboard
steps. **Test** connects if needed and sends a minimal response check. A connected
card accepts the user's task and displays streamed native replies and activity.
Native permission requests offer the choices supplied by that CLI. A waiting
permission, uncertain result and completed reply must have distinct states.

Visiting settings only reads local CLI metadata; it does not submit a model task,
start R or install anything. Authentication and available models remain with the
native CLI. The model list reflects its advertised configuration, while **Test**
establishes whether the chosen service responds. User configuration is not edited.
**Advanced: manual MCP setup** retains configuration copying for other clients.
Copying setup alone never establishes a successful connection.

DeepSeek Harness uses the same card and conversation controls. If its compatible
ACP runtime is missing, **Install connection component** explicitly adds an isolated
official runtime for Rho. Show the installation state and errors, with a bounded
timeout and explicit retry. Visiting the page or pressing Rescan must not install
software. Native grouped model choices retain opaque identities internally while
the selector displays human-readable names. Permission prompts use the corresponding
native tool-call title even when the permission frame only supplies a tool-call ID.

The Connections tab uses the existing Host-scoped observations: keep configuration
copied, MCP initialized and successful overview/window responses distinct. Client
name/version are self-reported labels. A server response does not acknowledge
model consumption or scientific correctness. Show the exact window incarnation
in details; another window's response cannot verify this one. Display bounded
active/recent sessions separately, with truncation when applicable. Paper names,
versions, dates and states are illustrative, not new live connection evidence.

Full paths, endpoints, credentials and request records belong in disclosure
rather than dominating the main card. Mask configuration credentials on screen;
copy only on an explicit action. Closing settings preserves accepted work and
connections. Protocol closure does not imply R work stopped, and network loss
can leave a protocol session open. Unreachable hosting shows stale/unavailable
status with Retry. A new Host starts fresh observations; restarted Workbenches
need fresh address/credential configuration. Project-only Hosts can connect for
available file/application capabilities with R unavailability explicit.

## 13. Workspace Agent tasks — approved interaction

The 2026-09-09 [Paper task-panel review](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/6-2)
was approved by the user for implementation on 2026-09-09. Its fourteen editable
boards define the first task-panel interaction. Example messages, runtime menus
and scientific references remain illustrative; actual capability and acceptance
evidence is recorded in Status. Section 12 retains configuration and manual MCP
setup; daily conversations now belong to this panel.

Following the user's F11 feedback, the revision removes the setup form, explanatory
recovery cards and rules gallery. The main surface contains task navigation,
conversation, concise state and the relevant action. Detailed evidence opens only
on demand. All fourteen boards belong to the independent **Agent · 工作区任务设计评审**
page; the general high-fidelity workspace page contains only its original five
boards. Page membership was verified from both page roots.

| Board | Review focus |
| --- | --- |
| A01 | 1440 × 900 workspace; 440 px Agent panel docked on the right |
| A02 | 1060 × 800 window; 332 px Agent tab in the right inspection group |
| A03 | 960 × 820 panel; 240 px task list and a compact New task runtime menu |
| A04 | Another window's read-only view, saved draft and idle Take over |
| A05 | Pending permission fixed immediately above the composer; editable next draft |
| A06 | Resume in the task header; concise unconfirmed-turn and history-gap disclosures |
| A07 | Closed panel, persistent top-bar badge and task reminder popover |
| A08 | Empty task ready for input, with model/reasoning controls inside the composer |
| A09 | Read-only conversation after the control window is lost; Stop Agent and take over |
| A10 | Native permission-mode menu beside the input controls; illustrative three-mode catalog |
| A11 | @ picker for specific files, objects, plots, table selections, code and plugin information |
| A12 | Add-channel menu, selected component references, image/file attachments |
| A13 | Variable native permission options, feedback field and explicit response confirmation |
| A14 | Attached-context preview with source, bounded sample and inclusion scope |

The approved single-instance **Agent** panel uses the Studio panel chrome, Inter,
white content surfaces, restrained borders and the existing semantic colors.
Top-bar **Agents**, Panels and the command palette open that same panel; its gear
opens Agent Settings. First placement is on the right for windows at least 1100 px
wide, otherwise as an inspection-group tab. Reopening prefers saved placement.
The task rail appears at **panel width 640 px**; smaller panels use a top selector.
The breakpoint concerns the panel, independently of the window placement rule.
Closing, collapsing, docking, maximizing and undoing layout only change the view.

The task rail is project-wide; selection, filtering and reading position belong
to the window. One task binds one Rho-created native session and one runtime.
Same-runtime tasks can run independently. Only the controlling window edits the
task draft, sends, changes the next-turn model or replies to native permissions.
The running composer accepts a saved next draft but exposes **Stop Agent**, with
an explicit running/waiting status; there is no second-turn send queue. Read-only
views show the saved draft without editable controls. Local conflicts retain a
separate copy. An old acknowledgement cannot erase later edits.

Following the real-use review on 2026-09-09, the conversation keeps a small animated
activity row from Send through native completion, including gaps between tools.
Connecting, restoring, native thinking, responding, tools and waiting for permission
are distinct observed states. Quiet intervals show elapsed time without inventing
progress or treating silence as failure. Reduced-motion preferences remove the
animation. Reasoning text is not copied into the transcript. A saved image is not
presented as a Plots result until the media owner confirms it; the Agent receives
the live Studio context and existing component commands to make its work visible.

**New task** opens a small runtime menu. Selecting a runtime creates the task/draft
with its remembered model defaults and opens the empty conversation. The user can
adjust model/reasoning in the composer before sending; there is no separate setup
form or second Create confirmation. First send creates the native connection.
The first user message supplies the default title without a naming request.
Rename, Archive, Unarchive and Session details are local task-management actions.
Archiving preserves the task, draft and history; unarchiving does not reconnect.
Settings retains CLI discovery, explicit component setup, model catalogs, isolated
diagnostic **Test** and manual MCP configuration. Daily chat moves to the panel.
Opening the panel reads task state without scanning CLIs or sending model requests.

Native permission labels and order are preserved. Following F12, actionable
requests sit in a fixed area immediately above the message input, outside the
conversation's scroll region. The request identifies the actual tool/target but
does not require finding an earlier chat message to respond. After resolution,
the history retains a non-interactive activity/result record. Pending permissions
remain visible in other task rows and the top-bar reminder. Idle takeover requires
no pending permission or submission. If the original window is unreachable while
running, **Stop Agent and take over** waits for confirmed native quiet or safe
recovery. An unconfirmed stop keeps the task read-only and never starts a second
writer. Stopping an Agent does not establish cancellation or rollback of R work.

Resume sits in the disconnected task's header; the conversation remains visible.
It reconnects the recorded native session explicitly and sends no prompt.
Unconfirmed creation/submission displays a status check for the original request,
not a resend action. Missing native sessions or capabilities get a specific reason;
a separate New task is explicit. Agent context and R memory remain distinct.
Codex history is native and paginated, Kimi history is native context replay with
possible omissions, and DeepSeek displays the bounded Rho observation cache.
History gaps and unresolved old turns stay visible. Native history, display cache
and verified scientific results must retain their separate identities.
Use short cues such as **Last turn unconfirmed**, **Earlier messages unavailable**
and **R session changed**, with a disclosure for the native identity, history source,
receipt and scientific-context details. Read-only ownership and Take over belong
in the task header; preserve the saved draft as read-only content below. Do not
replace conversations with recovery instructions or put backend guarantees into
routine task controls. These presentation changes do not relax the underlying
identity, persistence, recovery or single-writer requirements.

### Composer permissions and context channels

The browser/input method owns uncommitted text composition. Draft synchronization
only receives confirmed text; incoming snapshots and autosizing must not rewrite
an active preedit range. Candidate-confirmation keys do not submit a turn, including
native key code 229 and the immediate post-composition Enter. Ordinary Enter still
sends and Shift+Enter inserts a newline. Changing tasks binds a new input identity;
an ownership change during composition preserves the completed local text as a
conflict copy instead of overwriting the other window's saved draft.

The composer is the predictable place for permissions, attachments, context
selection and sending/stopping. Its toolbar contains **+**, an attachment button,
**@**, the selected native permission mode, model/reasoning and Send/Stop. Narrow
panels use two toolbar rows without shrinking labels or hiding the primary action.

Task/session permission mode and a response to an individual request are separate
controls. Mode names, count, meaning, scope and changeability come from the chosen
runtime's actual capabilities. The Ask / Auto approval / Full access menu follows
the user's reference as an illustration, not a promise that Codex, Kimi and DeepSeek
all expose these three modes. Missing capabilities must not produce fabricated
options; show the known native value read-only or an unavailable mode control.
Rho does not implement a second approval engine, silently edit global CLI settings,
or let a native mode override Host containment. Native acknowledgement establishes
an applied mode. Changing it does not implicitly answer an existing request.

The response area adapts to native option count, labels, order and any supported
feedback input. A05 shows two options; A13 uses the four-option CLI example from
the user's screenshot without attributing it to a verified provider implementation.
Confirmation forwards that native choice, not a separate Rho approval. A new
request must not steal typing focus or turn Enter in the draft into approval.
Long requests have bounded detail/option scrolling while the input remains usable.
Requests, permission modes and replies retain task/window/attachment identity;
resolved, expired and old-generation requests cannot remain actionable.

**+** selects information channels; the attachment shortcut supports native-capable
image/file selection, paste and drop. **@** opens the same context-provider system
at a specific component/item. Built-in sources include Files, Editor selections,
Objects, Plots and table selections. Plugins can register named information sources
with searchable items, preview and supported inclusion scopes. The Enrichment
Explorer entries are illustrative plugin contributions, not an installed plugin
or a commitment to implement that analysis plugin. Opening a picker is a bounded
read; it does not run analysis, start R, install a plugin or collect an entire
workspace implicitly.

Chosen items appear as removable references with their source, alongside image
previews and file names. Clicking a reference previews its owned content and the
chosen inclusion scope, such as summary or selected rows. Previewed sample rows
are labeled separately from the amount included. Reference identity includes the
provider, item, scope and owner-specific version/capture; a visible name alone is
not provenance. File, image and plugin delivery must respect the selected runtime's
actual input capabilities and limits. Unsupported, expired or changed content
stays visible for correction/removal rather than being silently dropped or replaced.
Plugin sources preserve project containment and principal visibility.

Draft persistence and CAS include staged attachments and reference selections;
send receipts identify the resolved payload so a lost acknowledgement cannot
duplicate delivery or clear later edits. Native attachment data and verified Rho
references are explicit new-turn input, never a replay of the observation cache
as model memory. Binary content is not duplicated into the text history cache.
Read-only windows can inspect the saved material but cannot change it or permissions.
These additions are a design proposal; native mode catalogs, multimodal delivery
and plugin context-provider contracts have not been implemented or verified here.

Screenshot review covered the affected boards for spacing, type, contrast,
alignment and clipping. This is static design inspection, not browser behavior, keyboard,
scrolling, performance, native-resume or acceptance-test verification. Implementation
must read Paper JSX/computed styles and validate the user's runtime scenarios.

Implementation follows actual native capabilities: Kimi Code 0.41.0 supplies
Default, Plan, Auto and YOLO modes, and its usual ACP permission request supplies
Approve once, Approve for this session and Reject. The four-option feedback board
does not add a fabricated feedback field to that protocol. Short inspection groups
retain a 360 px Agent minimum; context pickers stay inside the panel and long
input/permission content scrolls without losing access to Send/Stop.

## 14. Objects — approved viewing experience

The user authorized implementation of the six [Objects Paper boards](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0)
on 2026-09-09, together with the full-column collapse correction. Native owner
observations supply every displayed value; Paper fixtures are not runtime data.

The directory uses a small sample to show numbers, literal strings and their
character counts, R color swatches, vector lengths and table/array dimensions.
Wide lists align name, type, size and content. Narrow lists retain the value or
shape beneath the name; shape takes precedence over sample elements for arrays.
A color remains a character value. Named colors use R's interpretation rather
than CSS names. Missing values, literal `"NA"`, empty text, NULL and empty vectors
remain distinct. Factor labels retain separately inspectable integer codes.

Disclosure is local and supports several open objects. Standard containers expose
indexed children; dedicated container views use a contents rail and selected
child viewer. Duplicate names remain addressable by index. Explicit **Open in New
Tab** opens a retained viewer in the main editor group, leaving Objects available.
Tables use React Data Grid for virtualized cells, resizing, pinning, keyboard
navigation and column management. Selection and view preferences belong to the
Objects model, not panel lifetime. Current selected cells can be copied as TSV;
long strings are continued before copying, within a 1 MiB copy budget.

Dedicated table reads retain the native object reference, relative path and
original row indices. Row and column paging, direct row navigation, array slice
coordinates, sorting and substring filtering use that same owner. Sorting and
filtering apply to the whole table, with a 1,000,000-row processing ceiling;
calendar/time text filters and opaque/complex column ordering are unavailable.
A returned page still has the existing row/cell/byte bounds. No loaded fragment is
silently treated as the full dataset. Short active values occupy a compact bar;
full text is an explicit detail view with Unicode counts and continuation.

Known native readers include ordinary R containers, base semantic vector classes,
function/language source, `lm`/`glm`/`phylo` list storage, `dgCMatrix`, DFrame and
SimpleList, and the supported native storage of SummarizedExperiment and
SingleCellExperiment. SCE assays, rowData, colData, reductions and metadata reuse
the same viewers. Sparse reads materialize only requested values. This is not
blanket S4, Seurat, delayed-array or custom-method support. Unknown storage stays
metadata only. Source previews are capped at 500 lines with a visible notice.
Plot rendering is an explicit Console-owned execution, separate from observation.

Busy/disconnected views retain their last observation and timestamp. New sessions
clear scientific page caches; changed/expired references cannot merge with old
pagination or complete a stale copy. Refresh opens fresh evidence. User Hosts
must not be restarted merely to deliver new view code without preserving the
existing restart boundary. Current verification and remaining limits are in Status.


### Approved follow-up: information priority and whole-vector viewing

The 2026-09-09 F16 review adds O07–O10 to the same
[Objects Paper page](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0).
The user approved these four boards for implementation on 2026-09-09, including
further refinement when real scenarios expose problems.

- O07 defaults to Name, Content and a secondary Type field. Content answers the
  immediate question: scalar value, table dimensions, array shape, function
  signature, palette sequence or known container composition. Size is initially
  integrated into the summary. Showing Size separately moves that information
  into its column without repeating it in Content.
- O08 makes Content, Size and Type reorderable, resizable and independently
  hideable. Name remains visible and first. Header dragging has a keyboard-usable
  alternative through ordered field controls. Order, visibility and widths are
  retained per view, with reset. Compact panels use summary rows while respecting
  visibility preferences; returning to a wide view restores the chosen columns.
- O09 shows all five known palette values together, in original order, in both
  inline and dedicated views. A strip or tile arrangement compares colors; original
  strings and an original R vector remain available. Selecting a color adds a
  compact original/rendered-color detail, not a full text page. Copy vector is
  distinct from Copy color. Hex conversion is an explicitly chosen copy format;
  original strings such as `green` are preserved by the default copy action.
  Constrained docks use a compact heading and a view selector, preserving a visible
  color strip when both width and height are limited.
- O10 treats long vectors as ranges. It distinguishes selected/shown/full-vector
  copy scope; whole-vector copying obtains complete values before publishing the
  clipboard result and retains the existing budget/error boundaries. Short string
  vectors appear together without automatic item selection or expanded text
  details. Text inspection stays available through an explicit item action.

A palette must be supported by observed values, not inferred from its variable
name or four sample entries. Complete small vectors may show all values when
available within the owner budget. Partial or mixed vectors are not silently
classified as complete palettes. Explicit color view keeps NA, transparency,
non-color values and their original positions visible. Copies retain order,
names and NA semantics. A requested hex copy cannot silently drop non-color items.
Changing a view's field order or color arrangement does not mutate the R object.

The directory and vector viewers implement these interactions. Whole-vector
copying uses bounded reads on one observation, with a 1 MiB / 100,000-value ceiling;
exact values and full names/levels are obtained before changing the clipboard.
Original R vector copy retains supported classes, units and timezone attributes.
Incomplete or unsupported exact representations fail explicitly. See Status for
executed interaction, keyboard, copy and native-data verification.

## 15. Shell navigation and status — approved first version

The [Paper Shell page, S01–S04](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/8-0)
was approved for first-version implementation on 2026-09-09. The user additionally
requires individually selectable, persistent CPU, memory and disk usage in the
footer: removing all metrics would reduce convenience. Sidebar means workspace
module navigation. The implementation uses the existing domain and layout owners.

- S01 places Files, Editor, Console, Objects, Plots and Packages in a 48 px rail,
  with a separate Agent entry and expansion/settings controls at the bottom.
  A 36 px target contains an 18–19 px icon; hover and keyboard focus expose names.
  Only the focused module receives the blue selection surface. A 30 px footer
  groups runtime/execution at left and resources/draft synchronization at right.
  Empty queue counts and resource values are hidden by default. The runtime menu
  and footer customization button offer separate **R CPU**, **R memory** and
  **Project disk** checkboxes that keep the menu open while selecting. Preferences
  persist independently of docking and merge against the latest shared settings.
- S02 offers a persistent 168 px labeled navigation preference. Clicking focuses
  an existing view or restores a closed/collapsed view using its retained placement;
  repeated clicks do not close it. Multiple Console/Plots instances use a chooser.
  An Agent attention mark opens the relevant native task; permission controls stay
  in that task. Layout actions remain discoverable in the top Layout menu.
  Settings retains the existing settings capabilities.
- The runtime footer entry opens a bounded observation of R version, process
  memory/CPU, disk capacity/available space, freshness and queue state, with Console
  and R settings links. CPU and memory refer to the Ark process embedding R;
  children are excluded. Disk usage is total minus free space on the filesystem
  containing the canonical project root, not project directory size or disk I/O.
  Project storage uses a direct native filesystem statistics call, not disk
  enumeration or a directory scan. Busy,
  cached, unknown and disconnected observations must be labeled. Reading this
  disclosure does not start R, probe package loadability or recover executions.
  The top project disclosure owns the full path, Copy path and Open Project.
  Project switching retains its existing session-ending semantics and disclosure.
- Draft synchronization is not file saving. Its disclosure distinguishes synced
  working drafts from files with unsaved changes and links to their Editor views.
  The footer checks document-version acknowledgements in ApplicationBridge as well
  as ApplicationPersistence. An old acknowledgement cannot mark a newer edit synced.
  Sync pending/error states stay at the right; retry uses those existing owners.
- S03 specifies Idle, Running, input waiting, queue pause, lost connection and
  sync failure. Current execution and paused followers can coexist visibly. Input
  waiting provides a route to the owning Console even when its originating view
  is closed. Connection loss leaves R state unknown; it is not proof of stopping.
  Not started and Not configured are explicit alternatives to Idle.
- S03's 800 px footer removes execution source before shortening the runtime
  label; successful sync can become a labeled/tooltip icon, while required input
  and errors retain text. User-pinned metrics remain visible. Below 700 px they use
  a second footer row instead of disappearing. S04 shows all docked panels in a
  1024 × 800 workspace.
  Viewport shrinkage must not close panels or overwrite saved docking weights;
  insufficient space retains workspace scrolling. Navigation expansion is a
  separate preference. Existing owners retain documents, observations and work.

Paper data and plots remain design fixtures. The implementation reads the reviewed
JSX/computed styles and reuses the built-in registry and current owners. Explicit
navigation also reveals views outside another maximized group. Current browser,
keyboard, resource, persistence and native verification evidence belongs in Status;
implementation does not close further first-version usability feedback.

## 16. Runtime management — investigation and interaction proposal

The 2026-09-09 investigation responds to F18. [Paper R01–R03](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/9-0)
explores session inspection, runs/queue and restart/recovery. These are proposals
for review, not approved interactions or implementation authorization. The boards
extend section 15's R entry without deciding the Shell navigation preference.
All displayed versions, metrics, runs and failures are illustrative fixtures.

### What the implementation supports

The important distinction is between management foundations and a multiple-runtime
product. Host currently composes one live R Workspace per selected project.
Several Console views share it. Several native Agent tasks have independent Agent
sessions, but this does not create independent R sessions.

| Area | Existing implementation | Interaction consequence |
| --- | --- | --- |
| Hosting and R selection | `crates/host/src/config.rs`, `crates/workbench/src/settings.rs`: installed R/Ark probing, project lease, selected Host replacement and startup failure reporting | Separate configuration from inspecting a running session; do not present an instance list as an existing capability |
| R execution | `crates/workspace/src/console.rs`, `ui/src/console.ts`, `ui/src/operations.ts`: shared serial queue, pause/resume, pending cancellation, active interruption, stdin and retained request identities | Present current work and waiting work independently, with actions that name their scope |
| Native observation | `crates/adapters/r-runtime/src/lib.rs`, `ui/src/session.ts`: starting/idle/busy/unavailable, session identity, observation time, Ark/R process memory and CPU | Separate Host connectivity, R state and observation freshness; these metrics are not total project or child-process usage |
| Dependency environments | `crates/environment`, `crates/host/src/environment.rs`: pak/renv planning, isolated realization, verification, reconciliation and reference-aware quarantine/restore/purge; verified realization can bind a new R launch | Environment management needs its own future workflow; it is not the live Packages inventory and does not imply switching the current library in place |
| Processes and remote jobs | `crates/execution`, Host registration: local process supervision/reconciliation and conditionally configured SSH/Slurm execution, job observations and cancellation | Remote jobs have their own lifetimes. Successful submission is not job completion; an SSH transport is not a remote interactive R Workspace |
| Durable results and recovery | `crates/operation`, `ui/src/operations.ts`: original operation identities, immutable outcomes, reconciliation and retained unconfirmed requests | Show readable results and original evidence; an unconfirmed outcome must not become an automatic new submission |

The committed Shell at investigation start (`b391d93`) routed both Local R and
Environment to the same settings dialog, showed routine metrics in the footer and
prioritized queue pause over an active run. Concurrent, uncommitted Shell work was
already adding a status disclosure and separate execution/queue presentation during
this investigation. Integrate with that owner; those findings are baseline evidence,
not claims that the concurrent implementation still has every old defect.
The existing Console Run Details renders raw records with `JSON.stringify`.
Settings exposes R/Ark paths, Check Configuration and Apply and Start R, leaving
ordinary session inspection and restart buried in configuration.

### One daily entry, three depths

**R01 — quick observation and session management.** The footer identifies Local R,
version and current state. Waiting input and exceptional states retain text.
Clicking opens a small disclosure with current source, elapsed time when known,
queue state, Open Console and a scoped Interrupt run action. Optional persistent
metrics can follow the Shell preference; the default disclosure labels observation
time and Ark/R-only coverage. Running and Queue paused can coexist. A missing or
old observation does not become zero usage or an idle session.

Manage R Session opens a secondary workspace surface with Overview, Runs and
Details. Preserve editor/Console drafts and selection behind it; closing returns
to that context. Overview shows the selected installation, project and current
library information, with links to Packages and Runs. Library data comes from the
live Workspace package owner, or is explicitly unavailable/cached; another Rscript
process's Environment inventory cannot substitute for it. Details contains paths,
native session identity, adapter and diagnostics. Opening either surface only reads.

**R02 — runs and queue.** A runs list identifies the source and outcome; selected
detail presents result/error, actual captured code, elapsed time when available,
and recorded outputs. Original IDs, receipts and JSON remain in a disclosure.
An available file link opens the current file; it is not the captured historical
code. Missing provenance stays unknown. Start with R runs in this surface, without
silently presenting every process/environment operation as an R execution.

Queue actions remain Pause/Resume and Cancel Pending. Cancellation retains the
native start-race check. Cancelled pending work is not an interrupted execution.
There is no editable or draggable scheduler in this proposal. Copy to Console
creates an editable draft; submitting it is a new action. On failure, the original
error and paused followers stay visible. Do not imply that prior assignments or
file effects were rolled back. Success should show useful outputs rather than an
error-shaped diagnostic card. Live output and stdin continue to use Console.

At constrained widths, Runs uses list → detail → Back while retaining selection
and scroll, rather than compressing two columns. Input actions route to the owning
Console, including when its original view is closed. Opening run detail does not
change a deliberately selected plot or rerun code.

**R03 — restart and recovery.** Restart R and Change R installation are distinct.
Before restart, show loss of live R memory and retention of files, synchronized
drafts, layout and recorded outputs. Flush drafts through their owner before acting;
unsynchronized/conflicted drafts must not be described as retained remotely.
Do not promise restoration of R memory or automatic script replay.

Restart eligibility needs a bounded, read-only Host observation with concrete
blockers: active work, attached MCP/native Agent connections and unresolved holds.
Link to the owning run or connection where identifiable, otherwise report the
unknown hold. Inspecting blockers must not stop tasks or disconnect clients.
Execution rechecks native conditions; a prior eligibility read is not a reservation.
This exposes existing mechanical preconditions, not another Agent approval policy.

Current `apply_r` validates a candidate, rejects active requests/Host references or
live Agent connections, drains and replaces the selected Host, and explicitly sets
`environment: None`. It must not merely be relabeled Restart R: the proposed restart
needs to retain the current installation **and bound environment**, and report
startup failure honestly. Host-only metadata lacks a complete named-blocker list
and a durable lifecycle receipt. A typed hosting lifecycle observation/control with
session preconditions and lost-acknowledgement handling is therefore backend work,
not a frontend-only button. Keep scientific operations on their existing ports.

Host disconnection shows last-seen work and Check connection. It does not establish
that R stopped. An unconfirmed run offers Check original request first. The existing
explicit same-ID retry remains a distinct advanced action after reconciliation,
subject to its original scope and preconditions; it is not a new run or an automatic
retry. Owner recovery that may signal processes or change material must state those
effects, rather than being labeled as a harmless status check. Agent stop, R interrupt
and remote job cancellation retain separate targets and outcomes.

### Delivery boundaries and subsequent design

The first useful slice is the current single-R experience: integrate the Shell
disclosure, add readable run detail, then provide session management with the
required hosting lifecycle support. Reuse Session, Console and Operations; a
presentation model may combine their snapshots but must not add polling, a second
queue, result store or scientific authority. Suggested admission/freshness fields
are proposed contracts, not existing API promises.

A later Environment plugin can express plan → prepare → verify → use in a new
session, with original plan/realization/verification records and retention reasons.
Core Packages stays read-only. Process/job inspection should be a separate scoped
surface when configured, rather than a permanent cluster dashboard for local users.
These are design directions, not authorization to install packages, add a plugin,
connect a server or implement all backend capabilities as controls.

Future multiple-R work follows Architecture's instance boundaries: first independent
sessions of the same R version, then multiple installations/environments. Named
sessions such as Main and Scratch would be analysis targets; runtime definitions
and dependency environments remain configuration. Editor execution must capture its
target with its code; Console/Objects/Packages follow or pin to an explicit instance.
Already accepted work must not move when a selector changes. This proposal does
not introduce that selector before those identities and isolated queues exist.

Review should exercise running with a paused queue, input with a closed Console,
failure after partial effects, lost acknowledgements, stale metrics, Host loss,
restart blockers, preserved environment binding and failed startup. Normal and
constrained layouts need keyboard/focus/scroll checks. Paper screenshots establish
composition only; the four existing frontend suites run during this investigation
establish a model baseline, not acceptance of these new interactions.

## 17. Sessions and recovery — approved interaction

The user authorized implementation of [Paper R04–R10](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/9-0)
on 2026-09-10, on the page `Runtime · 会话与运行管理探索`. Section 16's R01–R03
remain proposals. All versions, metrics, object counts, copies and failures on these
boards are illustrative fixtures; every displayed value comes from an observation.
Paper screenshots establish composition only. Normal, wide and constrained widths
still need keyboard, focus, scroll and real-content checks in a browser against real
R before this is called accepted.

| Board | Paper node | Covers |
| --- | --- | --- |
| R04 单会话安静 / 多会话目标明确 | `BUS-0` | Daily entry, execution target, pinned views, first-run notice |
| R05 会话管理 / 运行与隔离 | `BY9-0` | Session Overview, Runs and paused queue |
| R06 恢复副本 / 覆盖范围与保留 | `C1M-0` | Copy history, object coverage, reasons, pinning, storage |
| R07 自动继续 / 部分恢复与环境不匹配 | `C4N-0` | Restoring, partial restore, environment mismatch, disconnect |
| R08 重启、停止与退出 / 一次集中确认 | `C8D-0` | Restart, Stop and Quit consequence panels |
| R09 高级设置 / 清楚的默认值与继承 | `CB4-0` | App → Project → Session per-field inheritance |
| R10 窄窗口 / 新建会话与状态边界 | `CEQ-0` | 600 px hierarchy, 320 px popover, new-session dialog |

### Language and terminology

Product-authored UI is English. Ordinary users meet three ideas only: the current
session, the work in progress and the latest recovery copy. The product surface says
`Recovery copies`; checkpoint, format version and native-session identity stay in
technical details. File save, draft synchronization and object recovery copies are
reported separately — never one vague global `Saved`.

### Shared measurements

Boards are 1440 px wide with 32 px padding and 24 px column gaps, and reuse the
existing `--color-*` and spacing tokens. Body text is Inter 14/20, secondary notes
13/21 in `--color-muted`, status badges 13/18 colored and non-wrapping, page titles
24/32 at weight 600, card section headings 16–18 px at weight 600. Buttons are
`7px 12px` padding with a 4 px radius and a 1 px border, rendering 36 px tall;
primary uses `--color-accent` with `--color-surface` text, secondary uses
`--color-surface` with `--color-border`. Cards are `--color-surface` with a 1 px
`--color-border` and an 8 px radius; inset info boxes are `--color-subtle` with a
4 px radius and 16 px padding; soft notices are `--color-accent-soft` with a 6 px
radius; a selected row is `--color-accent-soft` with a 4 px radius. Code is Menlo
13 px at 26 px leading in the editor and 24 px leading for a captured snippet.
Recurring widths: session target menu 340 px, its status column a fixed 64 px
right-aligned, session list 256 px, recovery-copy list 310 px, settings navigation
214 px, main content padding 24 px. Below 720 px the layout becomes a single-column
hierarchy.

### R04 — one session stays quiet, several sessions make the target explicit

With a single session the target selector is hidden. The editor card shows the
project name, the file tab, `▷ Run`, the code and a status row carrying a colored
dot, `R 4.5.2 ⌃`, `Ready` and the encoding. The first time a recovery copy is
created, one soft notice appears: `Rho keeps recovery copies on this Mac.` with
`Continue where you left off.`, a `Settings` link and a dismiss `×`. It is shown
once; routine automatic saving never raises a message, and copy time and unprotected
objects are read on demand inside the R popover.

With several sessions the header adds `2 live sessions`, and a secondary `● Main ▾`
button sits immediately before `▷ Run`. Its 340 px popover is headed
`RUN IN SESSION` and lists each session as a check cell, a name with
`R 4.5.2 · study-lock` beneath it, and a 64 px right-aligned status badge
(`Ready` and `Running` in `--color-success`, `Stopped` in `--color-muted`). The
selected row uses `--color-accent-soft`. A footer row offers `＋ New session…` and a
`→` to the management page. The status row then names the target, `Main ⌃`, and
reports other sessions on the right, `Scratch · Running`.

Choosing a `Stopped` session first continues that session and only then accepts the
run. An independently pinned Console always uses its own target; R version and
dependency environment never change implicitly because the user moved between panels.
Every run record keeps the session it was submitted to, and switching or closing a
panel does not change background computation. A pinned-views card states
`Views follow Main` with `Console · Objects · Packages`, beside
`Console · Scratch` with `Pinned to Scratch · Unpin`.

### R05 — session management gives version, environment and runs an owner

`R Sessions` is a management page that returns to the workspace, preserving editor
and Console drafts and selection behind it. Its header carries `＋ New session…` and
`Back to workspace`. A 256 px `THIS PROJECT` list shows each session as a colored
dot, name, R version and status badge. The detail column shows the session name at
24/32 with its status badge, then the tabs `Overview`, `Runs`, `Recovery copies`,
`Details`.

Overview leads with purpose and actionable state, as 210 px label columns:
`R installation` → `R 4.5.2 · arm64`, `Dependency environment` →
`study-lock · Verified`, `Objects` → `90 objects · Open Objects →`. A recovery row
reads `Recovery copy · Today, 10:42` with `87 of 90 objects · 3 need attention` and
a `Review coverage →` link. Actions are `Open Console`, `Save recovery copy`,
`Restart R…` and `More ▾`, where `More ▾` holds exactly `Rename`, `Stop session…`
and `Session settings`. The page states plainly:
`Changing R or the dependency environment creates a new session.` Paths and native
identifiers belong in Details, not Overview.

Runs separates the run from the queue, because they are two facts. The header shows
`Scratch · Runs` with `● Running`, `2 waiting · Queue paused` and `Resume queue`. A
360 px `--color-accent-soft` queue column lists the current file with
`Running · 2m 14s` and each waiting file with `Waiting · Queue paused`. The current
run column names its provenance, `fit-model.R · Run File · Scratch`, shows the
captured code in an inset block, and offers `Open Console`, `Interrupt this run` and
a `Captured code & details ▾` disclosure. Creating a session only uses already
installed and available R and environments; it never installs dependencies from
Packages.

### R06 — a copy answers what can be restored and what is still unprotected

`Main · Recovery copies` offers `Save recovery copy` and `Settings`. A 310 px
`RECENT COPIES` list shows each copy as a time at weight 600, a check cell when
selected, `87 of 90 objects · 468 MiB` and a badge such as `Automatic · Latest`,
`Automatic` or `Manual · Pinned`. The detail column gives the time at 24/32 with a
`Latest` badge, two summary figures — `87 objects saved` with
`468 MiB · Automatic`, and `3 not protected` in `--color-warning` with
`See object coverage below` — then provenance as `SAVED WITH` → `R 4.5.2 · arm64`
and `DEPENDENCY ENVIRONMENT` → `study-lock · Match available`.

`Object coverage` lists each unprotected object in three columns: a 150 px Menlo
name, the reason, and a 198 px next step. `db` / `Live database connection` /
`Reconnect from code` and `atlas` / `External file not captured` /
`Keep source file available` keep a muted next step; `raw_counts` /
`6.4 GiB · Exceeds automatic limit` / `Save selected objects…` stays an accent
action. Actions are `Restore in new session…`, `Pin copy` and a
`Technical details ▾` disclosure, with the note
`Restoring creates a separate session. Main stays available.` A storage footer
reports `Project recovery storage` as `1.8 GiB of 10 GiB · 3 copies · 1 pinned` with
`Manage storage…`.

Viewing the list must not evaluate objects. Coverage is not reproducibility: a copy
records the object scope, R and dependency environment as they were at save time, and
connections, external data and oversized objects are listed explicitly. Automatic
saving waits for idle and coalesces requests; insufficient space is summarized once;
pinned copies and the only valid recovery source are never purged automatically.

### R07 — continuing is the default, only a real choice interrupts

Four states, each a card with a 20/28 title and a status badge.

`Opening Main` with `Restoring…` lists progress rows, each a 24 px icon cell beside a
label and note: `Checked for an existing session` / `No live R process found`,
`Matched R and dependency environment` / `R 4.5.2 · study-lock`, and `Restoring objects`
/ `Recovery copy · Today, 10:42`. Its footer says `Files and drafts are ready to use.`
beside `Cancel restore`. While restoring, only that session's run entry point is
locked; editing and other sessions stay usable. No unmeasured percentage is shown and
no script is re-executed.

A successful partial restore shows `Main` with `● Ready` and exactly one dismissible
non-modal notice: `87 objects restored from 10:42.` with
`3 objects weren't restored.` and a `Review` link. Objects then list name and value,
such as `samples` / `2,700 rows × 8 columns` and `model` /
`Linear model · 4 coefficients`. The missing objects and their source copy stay
queryable under Recovery copies. Restoring returns to the copy's timestamp and does
not imply later unsaved computation was recovered.

`Validation needs attention` with `Stopped` explains
`The recovery copy needs an environment that isn't available.` and lists
`Saved with` → `R 4.4.3 · arm64`, `Environment` → `release-2025 · Not found`,
`Latest copy` → `Yesterday, 18:20 · 84 objects`. Actions are
`Choose matching environment…` and `Start empty`, with
`Your recovery copy stays available. Nothing has been installed.` `Start empty`
explicitly begins with empty memory and cannot overwrite or delete the original copy.
Compatibility differences and manual cross-environment import are handled in details;
there is no global switch that bypasses the checks long term.

`Connection lost` with `Main` reports `Last seen: Running · 10:48:12`,
`fit-model.R · 2m 14s at last observation` and
`R may still be running. New submissions are paused.`, then offers `Check connection`
and `View last known run`, noting that an unconfirmed outcome means checking the
original request before submitting again. A disconnect is not a stop.

### R08 — three verbs, three consequences, one panel

Each dialog states its consequence once, in a single panel that keeps reporting
results; chained confirmations are avoided. Without a stop confirmation, never claim
the session ended.

`Restart Main?` — `Start a fresh R process with empty memory.` An inset box reports
`R AND ENVIRONMENT`, `R 4.5.2 · study-lock`, `✓ Recovery copy saved · 10:52` and
`87 of 90 objects · 468 MiB`. A warning names `3 objects won't be protected`, lists
`db, atlas, raw_counts` and links `Review object coverage →`. The note reads
`Files, synchronized drafts and recorded outputs remain. Objects will not be restored automatically after this restart.`
Actions are `Restart with empty memory` and `Cancel`.

`Stop Scratch?` — `Stop this R process and free its memory.` An inset box shows
`● Ready`, `12 objects · Latest copy at 10:45` and `R 4.5.2 · study-lock`, with a
checkbox `Save a fresh recovery copy first` and the note
`The session, files and recovery copies remain. When you open Scratch again, Rho continues from its latest usable copy.`
Actions are `Save and stop Scratch` and `Keep running`.

`Quit Workbench?` — `2 local R sessions are open in study.` One inset box per
session: `Main` with `Ready` and `87 of 90 objects protected · 10:52`; `Scratch` with
`Running`, `fit-model.R · 2m 14s · 2 waiting` and `View run →`. The note reads
`Stopping sessions interrupts active work and cancels waiting runs. Rho saves supported objects before each process stops.`
Actions are `Keep running in background`, then `Stop sessions and quit`, with `Cancel`
as a quiet centered text row. Closing a window only disconnects that view and never
stops the process; reopening reconnects first. Quit addresses managed local sessions
and must not mistake a remote job for finished work.

### R09 — advanced settings explain every effective value

`Settings` shows a 214 px navigation — `General`, `Appearance`,
`Runtime & recovery`, `R installations`, `Agents` — and a main column titled
`Runtime & recovery`. A scope breadcrumb, `App defaults › Project · study › Session · Main`,
makes the edited scope explicit, with
`Editing Main. Each setting inherits from study unless you override it.`

Inheritance is per field, never a whole-configuration replacement. Each section
header carries a source badge such as `Inherited · App default`. `Recovery behavior`
offers four modes as radio rows: `Save and continue automatically` with
`Reconnect to a live session, or restore a copy in its matching environment.`;
`Save recovery copies; start empty` with
`Keep recovery copies available for manual restoration.`; `Manual copies only` with
`Create copies when you choose Save recovery copy. New processes start empty.`; and
`Off` with `Do not create or automatically restore copies for this session.`
`Object selection` offers `Include` with `Only supported object graphs are eligible.`
and an `All supported objects ▾` control, plus `Exclude object names` with
`Excluded names take priority over the include list.`

`Performance & storage` is headed `Foreground work first` and lists each setting as
label, value and source: `Idle before automatic save` / `30 seconds ▾` /
`App default`; `Minimum interval · App default: 5 minutes` / `10 minutes ▾` /
`Session override · Reset`; `Maximum automatic payload` / `2 GiB ▾` / `App default`;
`Project recovery storage` / `10 GiB ▾` / `Project setting · Edit`. A source that is
overridden shows an accent `Reset` that restores the inherited value. Then
`Pinned copies and the last usable recovery copy are kept. When space is full, automatic saving pauses.`

An `Advanced limits` disclosure carries the badge `App defaults` and reports
`Capture target: 2s · Global storage: 50 GiB · Keep 2 GiB free` and
`History: 5 recent copies + 7 days · Maximum 4 R processes · Idle release: Off`.
Finally `Recovery data on this Mac` states
`Copies may contain sensitive values. Turning recovery off keeps existing copies.`
with `Manage stored copies…`. The footer notes
`Changes apply to future saves and openings.` beside `Cancel` and `Save settings`.
The project storage cap belongs to the whole project and cannot be enlarged by a
single session. These are initial product defaults that must pass performance
acceptance before release; the automatic capture budget is never described as
interrupting any object instantly.

### R10 — narrow widths keep a clear path, a new session asks only what is needed

At 600 px the management page becomes list → detail → Back. Its header is
`‹ R Sessions`, the session name and `×`; the tab row keeps all four tabs with the
active one in accent. A copy detail shows `‹ All copies` with a `Latest` badge, the
time at 22/30, `87 saved · 3 not protected` at 16/24 with
`R 4.5.2 · study-lock · 468 MiB`, then `Not protected` and each object with its
reason. A sticky action row keeps `Restore in new session…` and `More ▾` reachable
while the body scrolls independently. `Back` preserves the copy selection and scroll
position. Narrower still, buttons stack vertically and names may wrap.

The `New R session` dialog asks only for `Session name`, `R installation`
(`Same as Main · R 4.5.2 ▾`) and `Dependency environment` (`study-lock · Verified ▾`),
then offers `Starts with empty memory` with
`Or restore a recovery copy into a new session.` and a `Choose copy…` link, a
checkbox `Use as execution target when ready`, and a footer noting
`Recovery: inherited from study` beside `Cancel` and `Create session`. The R and
environment pickers list only installed, verifiable combinations; when nothing
matches they show the reason and a configuration entry point. The execution target
switches only after the launch handshake succeeds, and a failure keeps the previous
target.

A 320 px status popover still carries its full actions: `Scratch` with
`Input needed`, `Open Console to answer.` and an `Open Console` button. Waiting for
input is never overwritten by queue status, and closing the popover does not affect
R. Acceptance covers Esc closing a popover and returning focus to its trigger,
keyboard selection of sessions and buttons, blur never submitting, closing the
management page preserving editor and Console drafts, and restore or launch status
affecting only the target session.

## 18. Built-in component assistant — approved interaction

The six editable [Paper B01–B06 boards](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/A-0)
are on the independent **Built-in Assistant · 组件助手交互评审** page. The user approved all six boards on 2026-09-13. This approval establishes the
interaction scope; implementation and scientific evidence remain separate. The original
Agent task page still contains its fourteen boards and 2,911 nodes; its content was
not replaced. Example data, messages, plots and statuses are design fixtures.

| Board | Interaction |
| --- | --- |
| B01 | Objects Ask about… entry, selected source, short explanation and source link in a 1440 px workspace |
| B02 | 1024 px workspace showing an error, applied document change, saved/run evidence and explicit Run scope at the composer |
| B03 | Two plots, comparison answer, original-image and producing-run links |
| B04 | 960 px Agent area with grouped Rho Assistant conversations and external tasks; retained draft after reopening |
| B05 | Model settings, remote data destination, credential lifetime and explicit tests; separate unconfigured and unavailable-image input examples |
| B06 | 600 px workspace with a 320 px assistant; expired sources, stop acknowledgement loss and another window's read-only conversation |

Reuse the existing studio chrome and semantic tokens: 38 px panel header, 48 px
conversation selector, Inter 14/22 px message text, 12/18 px metadata, 12 px composer
padding and 8 px internal gaps. Controls use the existing blue accent; evidence and
errors use existing semantic colors. Keep conversation content on the plain surface.
The wide task rail starts at the existing 640 px panel breakpoint; narrow panels use
the selector. The component view must remain usable at 320 px without dropping
controls or changing scientific state. External tasks retain their native controls.

Each Ask action opens the same Agent area with fixed, previewable/removable sources.
Changing panels does not retarget an accepted run. Objects, Packages and Environment
explanations remain read-only. Edit binds document versions; Run visibly includes
the permitted save and the named R session. The example request to fix/save/run is
one authorization, with no extra per-tool approval. Evidence links use original
owner references, not a success sentence generated by the model.

Sources, capability mode, model and pending actions remain near the composer.
Unavailable model/image input and expired targets preserve the draft. Users can
explicitly change model, include only metadata, or refresh sources; no silent
fallback changes the request. Stop-unconfirmed and connection-loss states offer
Check status for the original run; confirmed interruption can then offer explicit
Continue after context verification. Another window's draft is read-only until
controlled takeover; a conflicting local draft remains available for comparison.
Closing/reopening and task navigation never send model requests.

Model settings apply to this project and are shared by its component conversations.
The normal conversation does not contain a setup form. Keys are sent through the
transient credential endpoint and the input is cleared, with only a set/unavailable
indicator retained. Settings can use a session key or an explicit environment
reference. Connection and image tests use clearly labeled synthetic input.

All boards were reviewed with Paper screenshots for spacing, typography, contrast,
alignment and clipping; B06 includes full 320 px controls. Read their JSX and computed
styles for implementation values. The user approval above is separate from browser
evidence, keyboard/IME checks and real-source behavior; executed acceptance and its
limits are recorded in Status.
