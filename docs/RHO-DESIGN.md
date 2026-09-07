# Rho product design philosophy

Version: 0.2 — proposed foundation and interaction mechanics, 2026-09-07.

This document expresses the proposed product design philosophy and interaction
conventions for Rho. It provides reasons for design decisions, not an implementation
plan or a claim that the interface already follows them. User feedback remains in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md); implementation decisions, milestones and
verification remain in [STATUS.md](STATUS.md).

The Studio regression baseline is `studio-round1-baseline-2026-09-07`. Establishing
this philosophy does not authorize implementing the tutorial's additional features
or replacing the current libraries. Existing scientific and Agent ownership
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

This philosophy intentionally does not prescribe new pixel values, colors,
animation durations or library choices before representative interaction work.
Those choices should follow from the principles and measured use. Blur and
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
