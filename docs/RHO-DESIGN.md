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
| App bar / status bar / group tab bar | 48 / 24 / 38 px |
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
