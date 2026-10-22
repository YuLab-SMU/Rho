# Rho product design

Rho makes functional components feel like one workspace. Most operations are
expected to come from an Agent working within its harness: it edits code, submits
runs, opens and arranges views and points at results. Rho is where that work
becomes visible. People read what the Agent did, inspect the actual data and step
in where they choose. Direct editing, running and arranging use the same actions
and resources, but the interface does not assume a person performs every step.
The [first release](WEBUI-FIRST.md) is an npm-distributed local WebUI, with tabs
and split views in one browser window. A later desktop client extends that
workspace across native windows. Scientific workbench, workspace composition and
Agent interaction are evaluated together through the
[first integrated flow](ROADMAP.md#first-integrated-flow).

## Role of the interface

Execution belongs to protocols (component CLI, Skills, MCP) and to the Agent that
calls them. Delegation stays in the Agent client; Rho does not duplicate its chat.
An Agent works faster than a person reads, so the interface cannot mirror its
output; it selects. What is on screen is there because it changes what the person
concludes or does next. A person should be able to tell what was done, why, how
sure the result is and how to redirect it without reading everything the Agent
produced. The interface exists for what the Agent cannot do on the person's
behalf, and each screen region serves one of four intents:

- Understand: does the result answer my question? Lead with the answer, then the
  evidence (actual table, figure or code), then detail on request.
- Supervise: escalate only at risk or uncertainty, placing the reason and the next
  action together at the affected result.
- Monitor: a digest of what changed and what needs the person, not an event stream.
- Create: direct editing of code, data and figures, with the shared buffer, undo
  and write conditions.

A region that serves none of these is not drawn. Invariants are guaranteed by
behavior rather than labels: identity, outcome and check distinctions appear only
where they change what the person can conclude or do. Screens are organized around
the analysis question, not around components or runs, and component outputs are
woven into one account. Coverage limits are stated with a path to completion.
Provenance, identifiers, versions, rejected requests and Agent self-corrections
sit behind disclosure.

## The inquiry surface

The working surface is the inquiry, not a pane: the question being asked, the
branches it has taken, what each branch found and what is still open. Runs, edits
and views are steps inside an inquiry and evidence for its findings, never the
structure around them. Several inquiries proceed at once; the surface shows which
are settled, which need the person and which are still moving, so volume is
managed by choosing where to look rather than by reading everything.

Every finding carries a trace. From a result the person can retrace the steps,
inputs, code and checks that produced it, and return to an earlier point to steer
differently. Superseded and abandoned branches stay in the trace rather than
being deleted: a conclusion is read through the roads not taken as well as the
one followed.

Rho assembles this structure from explicit inquiry records and owner facts.
Agent bridge activity is evidence of observed calls and results, not an inferred
branch outcome or the external Agent's reasoning. A branch state names its source;
missing or stale observations leave uncertainty visible.

## Agent expression and human feedback

The Agent explains by composing, not only by writing: summaries, diagrams,
annotated figures and generated views built from registered components, presented
as explanation and kept distinct from execution, artifact and domain-check facts.
The interface does not branch by assumed expertise; one self-explaining
presentation serves the newcomer and the expert, with source, identities and
detail behind disclosure.

The person answers on the same surface. Any presentation accepts anchored
feedback: a mark, circle, sketch or comment on a point, row, region or line,
made available as context tied to that exact object and its version.
Annotation steers the next step and joins the trace; it does not gate the work.

Feedback closure distinguishes a draft, context available but not yet fetched,
an actual `tool-fetched` receipt, observed Agent work and a linked response or new
finding. Making context available does not claim delivery into an external chat;
a fetch receipt proves the fetch, not that the Agent understood or acted on it.
Link subsequent work only through an explicit feedback/context reference, and
return the person to the resulting finding, resource or trace step. If fetching
or work fails, retain the note and anchors with a continuation at that stage.

Presentation/animation (C9) and annotations (C10) remain proposed boundaries in
the [capability catalog](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-CATALOG.md).
An explainer binds its spec and source versions; editing it creates a distinct
version. A note on explainer v1 at 00:12–00:14 stays on that version and time range
after v2 exists. Opening the original remains possible when retained; unavailable
source content is reported. Moving an anchor to another version is an explicit,
validated action, never an automatic rebase.

## Workspace behavior

Code, tables, plots and files are the evidence layer: opened from a finding, an
inquiry step or an Agent presentation, and read in full when the person chooses.
Code first has a summary labelled as Agent explanation — what it does, what
changed, which result depends on it and which checks cover it — with the actual
source one step away. The document entry owns the source buffer; an explanation
does not establish the checks it describes. Use progressive disclosure for
provenance, internal identities, full paths and diagnostics.
Make the active project, resource, selection and view context clear. Selection
propagates through stable component/domain identifiers, including after sorting
or filtering.

Docking, tab changes and split-view changes preserve the current work. Each
document has one logical buffer across its views, with unsaved content, undo and
external-write checks. Background updates do not steal focus, reset the cursor or reconstruct
an active editing view. Layout persistence describes arrangement; document and
task owners retain their content and facts.

A live composition retains exact resource references and versions until an
explicit update or a declared update policy validates replacement bindings.
Refresh is bounded observation, never execution. Show the last observation and
mark affected portions stale or unavailable when their sources change or cannot
be read. Checks and explanations retain their own source versions and scope;
they do not become current because a chart or table was updated. Preserve pinned
views, active editing, focus and selections; an incompatible selection offers
reselection instead of silently attaching to a different object. Earlier
versions and their trace remain inspectable when retained.

Product-authored labels and accessible names use English. User content, native
outputs and input methods preserve Unicode and their original language. Commands
are reachable without dragging; graphics have suitable text/table alternatives.

## Agent interaction

The first release selects an external Agent entry: conversation stays in that
client, while Rho shows project binding, explicit context, actions and results and
provides a return to the bound conversation. The design reference is a Claude Code
terminal session; the actual adapter and capability evidence remain under WEB-01.
Configuration, connection testing, available capabilities and project binding have visible states
and a continuation after failure. A provider list or a chat mockup does not
establish a working Agent. Agent components retain their model loop and context;
Rho assembles their entries and routes shared interaction.

An Agent can open typed parameter forms, bind selected resources and arrange
registered views. The user can continue direct editing and inspecting those same
resources. Composition uses a small catalog with typed properties and scoped
actions; validation checks both the description and the action boundary.
Explanations the Agent composes follow the same path, so a presentation is as
inspectable and traceable as the results it explains.

Show proposed inputs and their resource context clearly. Existing authorization is
checked mechanically at invocation. Models and retrieved content cannot enlarge
scope; an already authorized action does not acquire another Rho approval.
Generated explanations remain distinguishable from component results and checks.

The user can see which project, resource, selection and unsaved buffer content an
Agent is using, and return from an action or result reference to that resource.
Agent edits to an open document use the same logical buffer, undo and write
conditions as direct user edits. Direct file actions retain their actual write
conditions. Context handoff does not lock the workspace; the user can continue
working, inspect the change and take over at the point of interest.

## Agent-led presentation

Design each screen first for a person following Agent work, then for direct
operation. An Agent session shows the request it serves, a digest of what it
changed through Rho (edits, submissions, opened views, highlighted entities), each
linked to its resource, and what it is doing now; the full ordered action log sits
behind disclosure. Current activity names the last observation time; a lost
connection leaves its current state unknown. Rho presents the
actions that pass through its own boundary; it does not reconstruct an external
Agent's conversation or reasoning.

Runs, edits, view changes and selections show who performed them. Agent notes stay
labelled as explanation, separate from execution, artifact and domain-check facts.
An Agent can open and arrange views; a person can follow those changes or stop
following, and views the person moved or pinned stay in place. Cancelling a run,
taking over an edit, starting a new run from changed inputs and sending context to
the Agent each remain one step away.

## Reviewable interaction journeys

Design the following as independently reviewable sequences, then connect them
through the same real analysis case. Each sequence names its entry, participants,
resource context, action, visible feedback, next step and failure continuation.
Static screen states alone do not establish that the sequence works.

- First use proceeds from installation and local startup to project selection,
  selected-component dependency checks, Agent connection and the first inspectable
  analysis result. The start screen contains welcome, open/create and recent-project
  entries, without a service or environment panel. Actual startup failures expose
  startup diagnostics. Dependency checks and preparation appear inside the project
  at the selected capability/action, bound to its actual environment; there is no
  separate global environment page. Checks follow component/action declarations,
  never execute project scripts or infer all dependencies from a script scan, and
  report their scope and freshness. Missing required dependencies have a clear next step.
- Agent connection proceeds from configuration to an actual connection test,
  project-bound session and first resource-aware request. Unconfigured, connecting,
  available, failed and disconnected states remain distinguishable.
- Inquiry navigation proceeds from an open question to its branches and findings,
  from a finding into the trace of steps, inputs, code and checks behind it, and
  back to an earlier point to steer a different branch; superseded branches stay
  inspectable.
- Human-to-Agent handoff proceeds from a code range, table entity or plot selection
  to an explicit context reference, a shared component action, its observed result
  and direct human continuation. Stale context and concurrent writes have a
  recoverable path; already authorized edits do not gain another approval gate.
- Run continuation proceeds from submission to execution and result inspection,
  with separate paths for failure, partial output and a missing acknowledgement.
  An error can enter Agent repair with its actual resource and error context;
  a deliberately new execution after repair remains distinct from finding the
  original request.
- Workspace composition proceeds from a real resource to linked code/table/plot
  views, tab or split changes and an Agent-added registered view. Returning to a
  view preserves its logical resource and work; unavailable components offer an
  inspectable fallback without replaying actions.

The [design delivery checklist](DESIGN-PRIORITIES.md) records required prototype
coverage, the current W1–W5 capability-composition sequence (I1–I4 retained as
reference) and the retained R1–R14 flow/state coverage, resource/state ledger
and review scope.
Prototype review, implementation and observed application acceptance are separate
evidence.

## Visible state and continuity

Distinguish running, execution complete, artifact checked, domain checked, partial
and unknown outcomes, including check scope and freshness. These distinctions are
shown where they affect a conclusion or action, not as standing badges. Missing acknowledgement
preserves the original request identity. Reconnection observes the same task;
browser refresh, view closure or failure releases observation without replaying
execution. Closing a browser page is distinct from stopping the local service or
Host. Restored views report which content is available; layout persistence alone
does not establish that an unsaved buffer survived a refresh.

Cancellation, confirmed stop and Host shutdown have explicit effects. A failed
view transition or unavailable component preserves drafts and result references
and offers a recoverable presentation. A restored layout does not claim
unavailable content saved, restored or scientifically valid.

Each exceptional state keeps the obtained output and offers its own continuation:
unknown execution looks up the original identity, partial output states its
coverage, a stale binding can be inspected or explicitly updated, and an
unavailable view preserves references and drafts with an available fallback.
Reconnection only reads; it does not start or recover a Host. Newly requested
execution remains a separate deliberate action. No continuation silently replaces
an identity, rebases a note or treats missing results as complete.

## Interaction constraints

These follow from observed use of the earlier application and constrain the
selected flow.

- Review follows the action, it does not gate it. An action the user takes writes
  through; the resulting change is reviewable and can be reverted afterwards.
  Approval before the write and a review after it are not both applied to the same
  edit.
- A settled review collapses. Once a change is accepted or reverted, its diff is
  dismissed, and an edit control that can no longer take effect (such as undo after
  a settled accept) is hidden rather than shown inert.
- Work is not single-threaded. A task in progress does not block starting another
  session or another action; sessions, views and execution have independent
  lifetimes.
- Direct manipulation stays at the point of interest. A contextual operation acts
  on the element under the cursor or the current selection, instead of requiring a
  distant control and a modal round trip.
- Feedback is anchored. A mark, sketch or comment attaches to the point, row,
  region or line it concerns and is made available as versioned Agent context;
  steering does not require re-describing the target in prose.
- A failure offers its continuation. A failing script presents a direct entry to
  the Agent repair path carrying the actual error and the resource reference, in
  addition to the problem/diagnostics view. The Agent applies the fix through the
  same buffer and write conditions as a user edit.

## Design and acceptance

Substantial layout or component design uses Paper and user review for the selected
flow. Record its purpose, source and scope; reuse approval within that scope.
Review a presentation by whether a person can state what was done, why, how sure
the result is and how to redirect it without opening the source. Inspect the
actual component/styles during implementation. Mockups communicate intent; live
resources and observed behavior establish acceptance.

Inspect normal, wide and constrained widths with representative data. Test native
Chinese IME, keyboard navigation, focus, clipboard, drag/drop, undo and concurrent
writes as applicable in the supported browser. Cover empty, loading, error,
unavailable and partial-result states, accessible names, non-drag layout commands
and suitable text/table alternatives for graphics. Switch tabs and split views,
close an observer, refresh the browser and find the original task from another
view. Keep draft availability, selection and task continuity visible.

The later desktop milestone adds native window movement, menus and integration.
Move views across actual native windows without losing buffer ownership, undo or
task observation, and verify window close/crash behavior there. These checks are
additional desktop evidence, not first-release WebUI requirements or claims.

Measure interaction latency, retained memory and rendering work on the actual
composition. Use bounded pages and resource references for large data. Limits
name their protected resource and behavior; exhausted view resources retain
obtained results and do not silently stop a user Host or replay a task.
