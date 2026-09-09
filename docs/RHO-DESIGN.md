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

Collapse leaves exactly the group tab bar. Restore uses the retained weight within
available space. Maximize/Restore returns to the corresponding group state.
**Undo Layout Change** retains twenty committed changes and never shares the
editor's undo history. A resize gesture contributes one history entry. Reopening
uses a surviving original group or neighbor before choosing a current destination.
A late file read cannot reopen a view closed while the read was in flight.

Native FlexLayout tab dragging remains available. The additional targets name
parent regions, for example **Editor + Console**, and the entire workspace.
**Move To…** supplies a keyboard path through region and direction, including
Join as Tab for a group. Previews use a separate model and show both the complete
region and the resulting occupied area. Release commits one public move action;
Escape, invalid destinations and cancellation discard the preview. Small target
hysteresis reduces border flicker and the preview retains the native grab offset.

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
Classed, opaque, active and lazy bindings retain the safe metadata-only boundary.
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

## 12. Agent connection experience — proposed

The user rejected the initial modal design on 2026-09-09 and supplied a desktop
Agent-settings screenshot as the visual reference. The current
[Paper review](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/5-0)
contains two revised settings-page boards: Agent apps and Connections. This
proposal is awaiting visual/interaction review; no Agent settings UI is implemented.

The revised direction uses a persistent 200 px settings rail, a broad white
content surface and a centered list. The selected Codex row expands in place;
other connection presets remain compact. At 1440 × 900, the surface starts at
(232, 64), is 1192 × 820, and uses 184 px horizontal insets. App chrome is 56 px;
controls are 38–42 px, row icons 42 px, and card corners 12 px. Inter remains the
UI font with 24 px page titles, 13–14 px controls/body and 12 px secondary labels.
Neutral canvas/row/border/text values are #F3F3F4 / #F8F8F9 / #E5E5E7 / #242426;
secondary text is #68686D. A charcoal primary action and restrained semantic
connection badges replace the earlier blue instructional dialog. These settings
values are a proposal, not an approved global restyling of the scientific panels.

The front page identifies the current project and window, keeps **Connect Codex**
as the setup entry and moves configuration snippets into **Manual setup**.
The entry must lead to concrete setup/handoff; clicking it alone never establishes
connection success. Automatic CLI discovery, user-configuration writes, app
launching and model/provider management are not established by this mockup.
Model/account decisions remain with the external Agent platform. Do not open R,
start an Agent or install Skills merely to visit settings. The supplied screenshot
informs visual hierarchy; its provider list and model controls are not a request
to copy those capabilities into Rho.

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
