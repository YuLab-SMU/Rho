# Rho product design philosophy

Version: 0.1 — proposed foundation for review, 2026-09-07.

This document expresses the proposed product design philosophy and interaction
conventions for Rho. It provides reasons for design decisions, not an implementation
plan or a claim that the interface already follows them. User feedback remains in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md); implementation decisions, milestones and
verification remain in [NEXT-SYSTEM.md](NEXT-SYSTEM.md).

The frozen Studio baseline remains `studio-round1-baseline-2026-09-07`. Establishing
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
smoke test.

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
- Use motion only to explain a change of state or spatial relationship. Honor
  reduced-motion preferences; avoid perpetual decorative movement.
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
Those choices should follow from the principles and measured use.

## 5. Resolve design tradeoffs consistently

Truthful results, preservation of user work, and the established execution
boundaries are constraints. Within them, prefer the design that preserves context,
reduces repeated effort, remains discoverable and is comfortable to read.

Examples:

- Quiet status is desirable; hiding an unconfirmed save to achieve visual calm is
  unacceptable.
- A compact toolbar is desirable; removing access to Stop in a short Console is
  unacceptable.
- A clean objects list is desirable; forcing every quick inspection into a new tab
  adds avoidable navigation.
- Flexible docking is desirable; invisible parent-group targets defeat that flexibility.
- Rich detail is useful; showing it at the user's chosen depth preserves attention.

A proposal should explain the user's task, action scope, feedback and recovery
path. Visual polish cannot compensate for an unclear answer to those questions.
This is a design review convention, not a permission gate or a second approval system.

## 6. Apply the philosophy to the reported issues

| Feedback | Relevant principles | Design question to answer |
| --- | --- | --- |
| F01: cannot remove components | P2, P4, P5 | Can a person deliberately close the intended view or group and recover it without losing work? |
| F02: docking around several panels | P2, P4 | Does the interaction clearly target an individual panel, a parent group or the workspace edge? |
| F03: English interface | P5; language and accessibility foundations | Is terminology consistent across visible UI and accessibility labels, with user content preserved? |
| F04: weak highlighting | P1, P5 | Can someone read actual R syntax accurately, beyond a short demonstration snippet? |
| F05: Console feels unlike a command line | P1, P5, P6 | Can someone explore rapidly through a continuous prompt/transcript without metadata overwhelming it? |
| F06: object clicks create tabs | P2, P3 | Can someone inspect in place, with dedicated views opened only deliberately? |
| F07: rough plot experience | P1, P2, P3, P7 | Can someone identify, inspect, compare and export a plot while retaining context and original identity? |

## 7. Validate through a sustained scientific workflow

Use the supplied gapminder tutorial as a scenario source, as described in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md). Follow the same project through scripts,
Console exploration, object inspection, repeated plotting and restart/replay.
Keep realistic accumulated files, objects, history and layout changes between steps.
Tutorial features outside the current scope remain separate decisions.

Observe task completion, mistaken actions, forced navigation, focus loss, hidden
controls, recovery effort and uncertainty about scientific state. Include both
first-use discovery and repeated keyboard-heavy work, with normal, narrow, short
and maximized views. Include errors and interrupted work.

Functional tests, accessibility inspection, scenario observation and visual review
provide different evidence. None is a substitute for the others. Do not claim
universal correctness, an arbitrary usability score, or measured performance
without observations. Refine these proposed principles when real work exposes a
conflict, and record the rationale in the existing system ledger.

## 8. Reference and adaptation

Apple's guidance is useful for its attention to sustained desktop work and the
relationship between controls and consequences. The following are specific
references reviewed for this document, not a claim of Apple compliance:

- [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)
  describes long working sessions, comfortable information density, adaptable
  workspaces, keyboard efficiency and personalization.
- [Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)
  explains revealing relevant detail near the content it belongs to.
- [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)
  relates the prominence of feedback to the importance of the information and
  recommends explanations when a command cannot be performed.
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
  supports perceivable state, readable content, keyboard use and alternatives to
  gestures.

Rho's scientific identity model, save/execute distinction, bounded object
inspection, output provenance and reproducibility principles are this proposal's
application-specific synthesis. They are not prescriptions quoted from Apple.
Translucency, large radii or other fashionable surface treatments are not implied
by adopting these interaction lessons.
