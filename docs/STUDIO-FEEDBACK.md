# Studio usability feedback and scenario reference

Captured: 2026-09-07.

This is the user-authorized feedback document for the next Studio refinement
round. It records user experience requirements and investigation questions;
it is not an implementation plan, a completion checklist, or another progress
ledger. Implementation decisions and verified progress remain in
[STATUS.md](STATUS.md).

## Baseline and evidence

The implementation baseline is commit
`d5a970b1559c9bd85567073108d05bca21886de4`, identified by the local Git tag
`studio-round1-baseline-2026-09-07`. This preserves the delivered Studio code.

The user considers the overall appearance promising, but has identified substantial
interaction problems. The previous functional and automated acceptance does not
establish that Studio is sufficiently polished for sustained professional use.

This feedback comes from:

- The user's seven-point review and accompanying screenshot on 2026-09-07. The
  screenshot shows Files on the left, an editor above Console in the middle,
  and Workspace objects above a plot on the right. The session contains actual
  R objects and a PlantGrowth boxplot.
- The supplied *RStudio Data Analysis Practical Introduction — Tutorial Design*,
  v0.1, dated 2026-09-07, read from
  `/Users/xiayh/Downloads/rstudio-tutorial-design.md`.

The screenshot is a visual reference, not evidence of why an interaction fails.
The tutorial is a workflow reference; its RStudio commands and shortcuts are not
claims about current Rho functionality. The original observations below preserve the user’s reported problems. The
implementation and verification response is summarized in STATUS.md; the
acceptance map below identifies how to recheck each issue. The list remains
open-ended for further user review.

The proposed cross-product principles for interpreting this feedback are in
[RHO-DESIGN.md](RHO-DESIGN.md). They do not replace or close the reported issues.

## User feedback

### F14 — Agent activity and workspace results must form a coherent experience

**Reported experience (2026-09-09):** A simple ggtree request spent long periods
showing only the user's message or a completed tool. Tool failures and a paused-R
queue notice were hard to interpret; the Agent appeared unaware of the workspace
components. A PNG appeared in Files while Plots remained empty, and the Agent task
ended with an uncertain timeout. The user did not experience a completed analysis.

**Required experience:** User input, connection, native inference, tools, queue
state and completion need continuous, truthful feedback near the conversation.
The Agent should use Editor, Console, Objects and Plots through their real owners
and verify the visible result. Correctable tool errors must reach the Agent with
their actual cause; acceptance, running and a paused queue must remain distinct.
An arbitrary client deadline must not hide a native final response. Tests must
exercise a real analysis and visible result, not only a short greeting.

### F01 — Components cannot be removed

**Reported experience:** The user cannot remove a component.

**Required experience:** Removing an unwanted component from the layout must be
obvious and reliable, including after docking, grouping, and maximizing.

**Questions for investigation:** Does the problem concern a tab, a whole panel
group, a component instance, or all instances of a component? Is the control
missing, difficult to discover, or ineffective? A screenshot containing an X
icon does not establish that removal works for the user's attempted action.

Distinguish closing a view, collapsing a group, and discarding a document.
Removing a view must preserve drafts and must not delete a project file or
implicitly cancel an execution. Reopening the component should be discoverable.

### F02 — Docking relative to several components is unclear

**User question:** How can one component move to the common left, right, or top
of two or more components?

**Required experience:** Users need to distinguish docking beside one panel,
beside a group of panels, and at the workspace boundary. Moving a panel to the
left of Editor and Console together must be possible to understand without
trial-and-error dragging.

**Questions for investigation:** Which layout levels can be targeted today?
Does the drop preview identify the whole region that will move or split? Can a
user deliberately target a parent group instead of the nearest child panel?
Can they recover from an unintended drop without resetting the entire layout?

Visible drop targets and explicit placement commands are candidates to evaluate,
not chosen solutions. The requested positions are left, right, and top; broader
docking behavior should be assessed consistently without inventing new scope.

**Follow-up (2026-09-09):** The user tried to place Agent to the shared right of
Objects and Plots, but normal dragging placed it beside Plots alone. The floating
parent-region matrix exposed internal hierarchy, even including the dragged Agent
in the target name. Its controls were also below FlexLayout's transparent drag
overlay. Parent placement needs an actual reachable target at the shared boundary,
with the complete region highlighted and the dragged view excluded from its label.
An explicit placement command remains useful as a keyboard alternative.

### F03 — The product interface should use English

**User direction:** Use English for professionalism and international use; do not
use Chinese for product-authored interface text.

This covers navigation, panel names, actions, menus, dialogs, settings, tooltips,
status messages, empty states, error explanations, and accessibility labels.
Use consistent scientific-workbench terminology across surfaces. A few translated
buttons would not satisfy this requirement.

Preserve user-authored filenames, paths, code, comments, data, object names, and
runtime output in their original language. English UI must not remove Unicode
support or rewrite diagnostic evidence produced by R or another native tool.
Additional language packs are not requested by this feedback.

### F04 — R syntax highlighting is weak

**Reported experience:** Editor highlighting is inadequate.

**Required experience:** Real analysis scripts should remain readable as they
combine comments, literals, function calls, package-qualified calls, operators,
formulas, indexing, and multiline expressions.

**Questions for investigation:** Separate missing or incorrect language tokens
from an ineffective color theme. Use representative code containing `pkg::fn`,
`<-`, `|>`, `%>%`, `$`, `[[ ]]`, model formulas, named arguments, and ggplot layers.
Inspect readability at the normal font size and in narrow panels.

Changing colors alone should not be assumed to fix parsing problems. Conversely,
this feedback does not automatically require a new language server, semantic
analysis engine, or debugger.

### F05 — Console does not feel like a command line

**Reported experience:** R Console lacks a command-line interaction feel.

**Required experience:** Console should support quick exploratory work, with a
clear prompt, an immediate input position, readable command/output continuity,
and predictable keyboard behavior. The analysis itself should remain in scripts.

**Questions for investigation:** Assess how execution cards, operation metadata,
whitespace, and embedded plot previews interrupt the command transcript. Examine
command history navigation, multiline entry and continuation prompts, error and
warning display, interruption, clear-screen behavior, scrolling, and the return
to the prompt after a run. These are investigation areas, not separately reported
or reproduced bugs.

Execution identity and truthful status remain necessary, but should be presented
without dominating ordinary Console use. A terminal appearance alone is not an
adequate fix if typing and keyboard interaction remain awkward.

### F06 — Object inspection should expand in place by default

**Reported experience:** Selecting an object opens and switches to another tab,
although the user often only wants a quick look.

**Explicit interaction direction:** Default inspection should expand bounded
details inside the existing objects panel. Opening a dedicated viewer tab should
require an explicit action such as **Open in New Tab**.

**Questions for investigation:** Determine the disclosure hit area, how expanded
rows collapse, how selection and scroll position behave, and whether multiple
objects may be expanded at once. Assess vectors, lists, ordinary data frames,
and opaque classed objects. A dedicated viewer must not silently replace the
quick-inspection interaction.

Keep read-only, bounded inspection and the existing protections against evaluating
active bindings, promises, or user-defined print/format/subset methods. When R is
busy, label the previous observation rather than presenting it as fresh data.

### F07 — Plot viewing needs substantial refinement

**Reported experience:** The plot panel is rough and the viewing experience is
poor, with more problems than the user has enumerated.

This is a broad experience issue, not a confirmed list of individual defects.
Do not reduce it to cosmetic spacing changes or claim a specific cause from the
screenshot alone.

**Scenario-based investigation should cover:**

- Plot history: identifying the current plot, navigating several outputs, relating
  a plot to its source execution, and retaining a deliberately selected old plot.
- Viewing: fit-to-panel versus original size, zoom and panning, aspect ratio,
  resizing, maximization, large plots, and narrow or short containers.
- Interaction: discoverable controls, focus behavior, selection feedback, and
  the relationship between a Console preview and the main plot viewer.
- Export: what bytes, dimensions, and format the interactive action exports, and
  how that differs from reproducible, script-controlled `ggsave()` output.
- Failure states: loading, unavailable originals, decoding failures, unsupported
  formats, and the absence of any plot.

Continue to identify outputs by their actual operation/output reference. Viewing
must not rerun R; a missing original must not be replaced with a same-named image.
SVG remains an image, and HTML/widgets must not acquire page execution privileges.

### F08 — Package inspection without installation decisions

**User direction (2026-09-08):** Inspecting variables and dealing with missing R
packages are recurring pain points. Studio has an object inspector but needs a
package view. Package installation depends on runtime management (local R, conda,
renv and others), OS, configured libraries and R-version choices. Installation is
excluded here and is intended for a separate future plugin.

**Required experience:** Inspect what the connected R session can see, distinguish
installed, loaded and attached packages, locate versions and library paths, and
understand duplicate copies without making installation decisions. Preserve the
current runtime, library configuration and loaded/attached state while viewing.
The interaction contract is in [Design section 11](RHO-DESIGN.md#11-read-only-package-inspection).

**Follow-up review (2026-09-08):** The user finds the implemented panel unattractive
and uninformative, with little practical value, and requests frontend design in
Paper first. Their screenshot shows full library paths repeated under every row,
large horizontal separation between package names and versions, and no purpose
text in the list. Rework information hierarchy and density before treating the
package component as accepted. Functional regression results do not close this
usability feedback.

**Source follow-up:** The user likes the Paper direction and asks for a place to
show package source, including GitHub, CRAN, Bioconductor and Posit Package Manager.
Source must accommodate other repositories and local/remote archives, and distinguish
an installed copy's recorded origin from its distribution channel and environment.

**Implementation authorization:** The user approved the revised Paper design,
including Source, and asked to begin implementation on 2026-09-08. Functional and
visual evidence belongs in STATUS.md; the earlier rejected screenshot remains the
problem reference.


### F09 — Agent setup should feel like a polished settings surface

**User feedback (2026-09-09):** The user rejected the initial Codex-connection
Paper design as unattractive and supplied a screenshot of a desktop application's
Agent settings. The reference has persistent sidebar navigation, a broad white
surface, gray segmented controls, recognizable Agent rows and an expanded selected
row with aligned configuration fields and actions.

**Approved design response (2026-09-09):** Replace the instructional modal with a settings
page, reduce front-page explanatory copy, expand the selected Agent in place and
put detailed connection evidence on a separate tab. Use neutral gray layers,
consistent icon/text/action lanes and a single clear primary action. The reference
does not establish Rho support for its model/provider settings or list of CLIs.
The user approved the revised Paper design. The approved interaction is in Design
section 12; implementation and runtime/visual verification belong in STATUS.md.

### F10 — Agent connection must be immediately usable

**User feedback (2026-09-09):** The approved appearance did not resolve the setup
experience. Connecting Kimi took a long time and required two manual copies.
The user supplied a working local-CLI reference with native model selection and
a direct response test, and requested the same practical ease of use.

The supplied transcript records both a provider quota failure and setup friction:
the Agent searched for configuration instructions, used mismatched server names,
and fell back to shell requests instead of registered native MCP tools. These are
distinct problems. The product should discover an already installed CLI, show its
native model choices, connect it to the current Rho workspace and accept a task
without asking the user to shuttle configuration or verification prompts. Native
permission waits and provider errors must be visible rather than looking like an
indefinite setup spinner. The user subsequently reported that the implementation
task itself appeared stuck; verification must have bounded waits and a clear end.

The user next requested DeepSeek Harness on 2026-09-09, with a reference showing
installation of a product-specific connection component through `dsh`. This extends
the same direct-use interaction to another native Agent runtime. The reference's
installation text does not authorize modifying that other product's configuration.

### F11 — Agent work must not become a configuration manual

**User feedback (2026-09-09):** The user rejected the first workspace Agent task
proposal because actions and long explanations were crowded into popup/card
surfaces. This repeats the instructional-interface problem in F09. They also
found the Agent boards on the general high-fidelity workspace Paper page instead
of an independent Agent page. The new page had been created without switching
the write target; its existence and link did not establish board ownership.

The main surface should support choosing a task, reading messages and acting.
New task should lead directly to composition; model controls belong with the
composer. Permission replies need context about the actual tool activity; F12
further establishes their fixed location near the composer. Recovery
and ownership need a concise state and a relevant action, with detailed evidence
available on demand. Backend rules belong in the specification, not explanatory
cards that users must read before working. Verify actual page membership when
delivering a Paper link. The revised interaction in Design section 13 received explicit user approval
on 2026-09-09. Implementation and real-runtime evidence belong in Status;
screenshot inspection alone does not establish usability.

### F12 — Permission and information controls belong around the composer

**User feedback (2026-09-09):** The user supplied examples of a three-mode permission
selector, a CLI request with four ordered options including session approval and
feedback, and composer controls for attachments/workspace/plugin channels. A fixed
Allow/Decline design does not represent native variation. The user wants a
predictable area near message input for actions, instead of searching the transcript
for permission controls. They also want images/files and @ references to particular
component data, files, plots, tables and plugin-provided information.

The revised proposal separates native mode selection from individual responses,
anchors pending requests immediately above the composer and supports native option
lists/feedback without imposing a common mode count. Context selection includes
source-labeled, previewable and removable items with explicit scope. These are
interaction requirements; the supplied screenshots are design references, not
evidence that every runtime supports identical modes, options or input types.
Native capabilities and scientific-owner identities remain authoritative.

### F13 — Agent input prematurely commits Chinese preedit

**User feedback (2026-09-09):** Agent's message field turns Pinyin into literal text
before the user can select Chinese characters. The user suspects draft autosave.
The confirmed browser reproduction starts a second composition while extending
`ni` to `nihao`, leaving `ninihao`. The textarea's controlled value is restored to
its old external-store snapshot, then rewritten after a batched notification;
this happens before an autosave response.

The input method must retain its marked range until confirmation or cancellation.
Draft saving and polling must not replace preedit text, and the candidate-selection
Enter must not send a turn. Preserve committed local text as a conflict copy if
another window takes over during composition. Report browser composition-protocol
coverage separately from actual OS input-method testing.

**User verification (2026-09-09):** After trying the corrected ime-test page, the
user confirmed Chinese input works. This is recorded alongside the browser-native
composition/ACK regression tests, rather than inferred from those tests alone.

## Workflow reference: a country development analysis

The supplied tutorial follows a complete project using gapminder: import, clean,
transform, visualize, model, and report. Its central distinction is useful for
Studio: reusable logic belongs in scripts; Console supports exploration; objects
and generated files can be reconstructed from those scripts.

Use a fixed local dataset and a prepared dependency environment for repeatable
interaction review. The tutorial's optional live TidyTuesday exercise is not needed
to establish this baseline. Do not automatically install tools or packages as
part of this feedback-capture task.

| Workflow moment | Interaction to examine | Related feedback |
| --- | --- | --- |
| Open a project with `data/raw`, `data/processed`, `R`, `scripts`, and `output/figures` | Locate files; arrange Files beside Editor and Console together; remove unwanted panels and reopen them | F01, F02, F03 |
| Write `scripts/01_import_clean.R`, using project-relative paths | Read actual R syntax; save; run a line, selection, or file; keep the input position predictable | F03, F04, F05 |
| Explore data and create vectors, factors, lists, and a data frame | Make short Console queries; expand an object without changing tabs; explicitly open a viewer when needed | F05, F06 |
| Transform and summarize data; write processed RDS files | Keep track of changing objects and files while several panels are visible; distinguish old observations from current state | F02, F05, F06 |
| Produce a scatter/facet plot and a trend plot; assign a ggplot object and print it | Navigate plot history, compare outputs, resize/zoom, return to editing, and contrast interactive export with `ggsave()` | F02, F05, F06, F07 |
| Move repeated code into `R/utils.R`; create an `lm` object | Work across scripts, use `source()`, read formulas and function calls, and inspect model/function metadata without unwanted tab changes | F04, F05, F06 |
| Explicitly restart R and replay the scripts | Distinguish retained drafts/layout/history from reset R memory; verify that inputs can recreate objects and generated outputs | F01–F07 |

A meaningful review should follow the same project across these transitions, not
start each panel test in a freshly idealized state. Record the user's intention,
exact action, resulting focus/layout/output, and point of friction. Exercise
mistakes as well: wrong paths, unsaved edits, an R error, an interruption, and a
plot selected from an earlier run.

## Tutorial features that need separate scope decisions

The tutorial describes RStudio features beyond the delivered Studio baseline.
Their presence in the tutorial is not authorization to implement them here:

- `.Rproj` creation, file association, and double-click launching;
- Files operations such as directory creation, moving, and renaming;
- code sections, folding, outline navigation, and additional execution modes;
- package installation/management UI, import wizards, and full data browsers;
- Quarto rendering, report previews, and HTML Viewer behavior;
- RStudio-specific shortcuts, project options, and session menus.

The report stage remains a useful end-to-end reference and a place to expose
capability gaps. It must not become an unannounced Quarto/Viewer implementation
requirement. Similarly, ordinary data-frame inspection does not prove that a
tibble, ggplot object, or model has a full structural preview.

The next design review should establish the concrete plot and Console problems,
resolve panel-removal and group-docking behavior, and distinguish experience
refinement from new scientific capabilities. No library replacement, development
sequence, or additional capability scope is decided by this document.

## Acceptance map for the Calm Precision implementation

The accepted interaction details are in [Design section 10](RHO-DESIGN.md#10-studio-interaction-contract).
This map identifies repeatable checks, rather than declaring all future user
experience concerns closed. Fresh results and any unverified details belong only
in [STATUS.md](STATUS.md).

| Feedback | Concrete review |
| --- | --- |
| F01 | Close every view, observe empty-group space recovery, reopen from Panels, restore a closed Console draft, undo layout and confirm no execution |
| F02 | Move Plots to the common left of Editor + Console using Move To; compare preview with final area; check all model directions and cancel a preview |
| F03 | Inspect menus, settings, errors, labels and keyboard hints in English while retaining Chinese paths, object columns and native output |
| F04 | Read representative R syntax and function/parameter colors; preserve selection and undo across settings, polling and layout changes; retain plain text mode |
| F05 | Print multiple expressions, queue a failure followed by retained work, resume explicitly, switch Console drafts, answer readline/menu, refresh and check history/composition boundaries |
| F06 | Expand raw, clean and summary together without adding tabs; explicitly open a viewer; verify bounded tibbles/special values and safe busy observations |
| F07 | Produce scatter/facet/trend plots, select history, zoom/pan, pin a comparison, export/check original bytes and inspect older output with R unavailable |

The fixed CSV fixture and analysis script live in `ui/e2e/fixtures/gapminder/`.
The analysis dependencies are already installed; the scenario does not install
packages. Browser regression scenarios are in `ui/e2e/studio.spec.ts`, model
checks in `ui/tests/`, and native ownership/queue/input checks in the Host tests.
Report synthetic composition coverage separately from OS input-method testing.
