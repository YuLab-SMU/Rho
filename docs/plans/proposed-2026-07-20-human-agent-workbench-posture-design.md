# Human-First And Agent-First Workbench Posture Design

Date: 2026-07-20
Status: Proposed design baseline
Scope: post-`0.2.x` workbench information architecture and incremental frontend evolution

## Summary

Rho should support two first-class workbench postures over the same project,
Workspace R session, Agent history, runs, approvals, artifacts, and audit
records:

- **Human-first**: source production and direct scientific interaction dominate.
  The editor is the primary surface, execution remains close at hand, and the
  Agent supplies contextual assistance.
- **Agent-first**: task direction, monitoring, artifact inspection, review, and
  correction dominate. Code remains fully available, but it is normally
  reached through the task, artifact, problem, or decision being reviewed.

The posture switch is a presentation and navigation command. It must not start
or stop execution, change Agent permissions, create a second workspace, or
discard the user's current context.

Agent-first is not one enlarged chat panel. It is an adaptive workbench with
three task-stage surfaces:

- **Direct** for defining and steering work;
- **Monitor** for supervising active and parallel execution;
- **Review** for inspecting artifacts, evidence, changes, and findings.

The recommended product direction combines two useful patterns observed in
the supplied product references:

- Wisp Science's task-oriented shell, compact execution steps, persistent stop
  control, context attachments, and tabbed project surfaces;
- Claude Science's artifact-first inspection, spatial comments, versioned
  results, shared live computation, reviewer findings, and per-artifact
  provenance tabs.

Rho should adopt these interaction patterns without copying either product's
information hierarchy wholesale. Rho's durable broker records, explicit
Ask/Plan/Act policy, authoritative Workspace R, revision checks, and
scientific provenance remain the governing contracts.

## Decision

Introduce a top-level `WorkbenchPosture` that is independent of Agent
permission mode:

```text
WorkbenchPosture = human | agent
AgentMode        = ask | plan | act
```

The two controls answer different questions:

- posture: who currently leads the interaction and which information receives
  visual priority;
- Agent mode: which observations and mutations the broker allows.

Switching to Agent-first must never imply Act mode. Switching back to
Human-first must not cancel an active Agent turn. Ask, Plan, Act, approvals,
stale-revision checks, and protected tool policy continue unchanged in both
postures.

Within Agent-first, introduce an `AgentSurface`:

```text
AgentSurface = direct | monitor | review
```

The surface may be selected manually. Rho may recommend or automatically open
the most relevant surface after an explicit user action, but it must not move
the user away from an object they are actively editing or reviewing.

## Goals

The design must let a scientist:

- move between direct coding and task delegation without losing context;
- see what the Agent is doing without reading a raw tool transcript;
- stop or interrupt active work from every Agent-first surface;
- inspect a result before accepting the Agent's summary of it;
- trace an artifact to its inputs, code, environment, run, messages, and
  review findings;
- comment on the exact plot region, table selection, text range, code range, or
  document page that needs correction;
- approve or reject protected actions with exact code, arguments, revisions,
  and impact visible;
- take over in the editor, Console, viewer, or Problems surface at any point;
- return to Agent-first without losing the task, artifact, or pending decision;
- use future non-R tools while preserving Workspace R as the authority for live
  R scientific state.

## Non-Goals

This design does not:

- replace the current Human-first workbench;
- turn Rho into a generic chat client or general-purpose AI IDE;
- equate a natural-language answer with a verified scientific result;
- expose hidden model reasoning;
- grant unrestricted shell, Python, MCP, network, package, or filesystem
  access;
- make an Agent-side Python or notebook kernel a second authoritative copy of
  Workspace R;
- require all proposed persistence tables in the first implementation slice;
- require the current static frontend to be rewritten in React before posture
  switching can begin.

## Reference Observations

The observations below are limited to the supplied screenshots. They describe
visible interaction patterns, not undocumented product internals.

### Wisp Science

The supplied Wisp Science screen uses three stable regions:

1. a left task and conversation rail with branches, folders, files, favorites,
   skills, MCP capabilities, memory, and settings;
2. a central Agent stream with compact, collapsible execution steps, a visible
   stop control, branch identity, context usage, and a composer that can attach
   files, artifacts, conversations, and skills;
3. a right work surface with tabs for artifacts, notebooks, environment, files,
   and future extensions.

Useful implications for Rho:

- a task branch is more useful than an undifferentiated chat thread;
- low-level steps should be available but collapsed by default;
- stop/cancel is a primary control, not a menu item;
- files and artifacts are referenceable task context, not merely uploaded
  attachments;
- project surfaces can share a single tabbed work area;
- visible counts can direct attention to artifacts, runs, findings, and
  pending decisions.

The central stream remains chat-shaped. Rho should avoid forcing users to find
the current parameter, failure, unverified claim, or pending decision by
scrolling through natural-language messages.

### Claude Science

The supplied Claude Science screens show a task area beside a large artifact
or live notebook. Selected artifacts expose tabs such as Code, Execution Log,
Messages, Environment, and Review. Other visible patterns include artifact
versioning, input links, spatial plot comments, parallel remote work, a live
kernel shared with the Agent, reviewer findings, and a final PDF beside the
task record.

Useful implications for Rho:

- the current artifact should receive more space than the conversation during
  review;
- review comments should target an exact artifact location or selection;
- provenance belongs to the artifact being inspected;
- live shared state should be explicit and inspectable;
- parallel activity should collapse into status summaries and exceptions;
- Reviewer findings should be durable objects that the Agent can acknowledge,
  address, or dispute;
- the final deliverable and the evidence about its creation should be visible
  together.

Rho must not treat a Reviewer badge as proof. A finding is useful only when it
links to inspectable evidence and has an explicit resolution state.

## Product Model

### Human-First

Human-first retains the current Rho mental model:

```text
project -> file or object -> code or direct interaction -> execution -> output
```

The editor or selected viewer is the visual priority. Files, Environment,
Console, Plots, Problems, and Agent remain close to the work.

Recommended desktop structure:

```text
+----------------+-----------------------------+------------------+
| Files / Runs   | Editor / Viewer             | Agent / Env      |
|                |                             |                  |
+----------------+-----------------------------+------------------+
| Console / Plots / Problems / Jobs                               |
+-----------------------------------------------------------------+
```

Existing Code, Analyze, and Focus layout presets remain useful Human-first
surface commands. They become presets inside `posture = human`, rather than
being overloaded to describe Agent authority.

### Agent-First

Agent-first uses a different top-level hierarchy:

```text
project -> scientific task -> stage -> artifact or decision
                                      |- inputs
                                      |- code
                                      |- environment
                                      |- execution
                                      |- messages
                                      |- findings
                                      `- review decisions
```

Code is not hidden or demoted in importance. It is reached from the thing the
user is evaluating: a task, artifact, error, change, finding, or run.

The Agent-first shell has three conceptual regions:

- **Task rail**: tasks, branches, attention queues, and project navigation;
- **Agent flow**: objective, stage, concise activity, decisions, and composer;
- **Scientific work surface**: artifacts, source, data, plots, reports, files,
  Environment, Runs, Problems, and provenance inspection.

The widths and visibility of these regions depend on `AgentSurface`.

## Agent-First Surfaces

### Direct Surface

Direct is used while the user defines, redirects, or narrows a task.

```text
+-------------+---------------------------+----------------------------+
| Task rail   | Agent flow                | Scientific work surface    |
|             |                           |                            |
| Current     | Objective                 | Artifact | Source | Data   |
| Pending     | Stage and concise plan    | Plots | Files | Env        |
| Background  | Decisions and exceptions | Runs | Problems             |
| Completed   | Composer and attachments  |                            |
+-------------+---------------------------+----------------------------+
```

Default desktop guidance:

- task rail: 220-260 px;
- Agent flow: 36-42% of remaining width;
- scientific work surface: at least 45% where possible;
- execution dock: collapsed by default, available on demand.

The Agent flow is not an unstructured transcript. It renders typed sections:

- objective;
- current stage;
- plan summary;
- active work;
- important completed steps;
- exceptions;
- pending decisions;
- reviewer findings;
- final response.

Raw messages and tool events remain available in a detail view.

### Monitor Surface

Monitor is used while one or more runs, renders, searches, model fits, package
operations, or remote jobs are active.

The primary information is operational:

- active and queued jobs;
- elapsed time and bounded progress;
- resource or remote target where available;
- latest meaningful output;
- warnings, failures, and decisions requiring attention;
- stop, cancel, retry, and open-run actions.

Parallel jobs should appear as one group with expandable members. The default
view must not render every stream line from every job. Selecting a job opens
its structured run detail and relevant output.

Suggested layout:

```text
+-------------+--------------------------------+-------------------------+
| Task rail   | Active work and exceptions     | Selected run / output   |
|             |                                |                         |
| Attention   | 5 running, 2 queued            | Plot, log, Problem,     |
| Running     | grouped progress               | environment, source     |
| Completed   | pending approvals              |                         |
+-------------+--------------------------------+-------------------------+
```

### Review Surface

Review is used when an artifact, file change, parameter decision, finding, or
final deliverable needs human judgment.

```text
+-------------+--------------------------------------+------------------+
| Task rail   | Artifact review canvas               | Inspector        |
|             |                                      |                  |
| Current     | Plot / table / report / PDF / diff   | Overview         |
| Findings    | version compare and annotations      | Inputs           |
| Decisions   |                                      | Code             |
|             |                                      | Execution        |
|             |                                      | Environment      |
|             |                                      | Messages         |
|             |                                      | Review           |
+-------------+--------------------------------------+------------------+
```

Default desktop guidance:

- task rail: 200-240 px;
- review canvas: the largest flexible region, normally 55-65% of usable width;
- inspector: 320-440 px, resizable and collapsible;
- Agent flow: reduced to a drawer, compact task header, or a lower composer.

Review actions should include:

- accept artifact version;
- request changes;
- annotate a precise target;
- compare with previous version;
- open producing code;
- open producing run;
- inspect inputs and environment;
- resolve, dismiss, or dispute a finding;
- rerun from the relevant stage;
- take over manually.

## One-Click Posture Switching

### Invariants

A posture switch must:

- complete locally without waiting for Agent R or Workspace R;
- perform no scientific execution or mutation;
- keep the same workspace identity and revisions;
- preserve active Agent turns and pending approvals;
- preserve unsaved editor buffers;
- preserve the selected task, artifact, run, problem, or source location;
- be reversible without navigation loss;
- restore posture-specific panel dimensions rather than applying one global
  set of widths.

### Human-First To Agent-First

The frontend derives a context attachment from the active Human-first object:

| Human-first selection | Agent-first destination |
|---|---|
| saved or unsaved source file | Source tab plus file/version attachment |
| code selection | source range attachment with document version |
| Console entry | producing run detail |
| plot | artifact review canvas |
| Environment object | bounded object reference and inspector |
| Problem | related task/run with the Problem selected |
| rendered document | artifact review canvas at current page/section |

If no task exists, Rho opens a draft task with the derived attachment but does
not submit a prompt automatically.

### Agent-First To Human-First

The frontend resolves the best takeover target:

| Agent-first selection | Human-first destination |
|---|---|
| artifact with producing source | open source at producing range |
| file diff | open diff or target file without applying it |
| run | Runs/Console selection plus source link |
| Problem | Problems selection plus source location |
| Environment reference | Environment selection or object viewer |
| report/table/plot without source | open the artifact viewer |
| pending approval | keep approval visible in Agent context panel |

When several takeover targets exist, use a small chooser. Never silently pick
and execute code.

### Layout Persistence

The current frontend persists panel dimensions and session state. Extend that
model with versioned, project-scoped posture preferences:

```json
{
  "schemaVersion": 2,
  "posture": "agent",
  "humanPreset": "code",
  "agentSurface": "review",
  "humanPanels": { "left": 214, "right": 362, "dock": 260 },
  "agentPanels": { "rail": 232, "flow": 420, "inspector": 368 },
  "selectedTaskId": "task_...",
  "selectedArtifactId": "artifact_...",
  "inspectorTab": "review"
}
```

Panel preferences are presentation state and may remain frontend-local.
Selected durable entities are restored by ID and validated against broker
queries. Missing entities fall back to the nearest valid project surface.

## Domain Model

The existing durable runs, Agent turns, approvals, Problems, revisions, and
plot artifacts provide much of the required foundation. Agent-first needs a
small domain layer above them.

### Scientific Task

A task represents an intended scientific outcome, not one model turn.

Minimum fields:

```text
task_id
project_id
parent_task_id or branch_from_task_id
title
objective
status
current_stage
created_at
updated_at
created_by
active_turn_id
workspace_id
state_revision_at_creation
project_revision_at_creation
```

Recommended task states:

```text
draft | ready | running | waiting | needs_review | completed |
failed | cancelled | archived
```

Agent turns, runs, approvals, findings, and artifacts link to a task. A task
may contain many Agent turns and runs. Conversation history alone must not be
used as the task database.

### Task Branch

A branch records a deliberate alternative path, such as a different analysis
method, parameter set, literature strategy, or correction approach.

It should capture:

- source task and source revision;
- branch objective;
- copied references, not copied live scientific objects;
- resulting artifacts and runs;
- comparison and merge/disposition outcome.

Branching does not clone Workspace R. Each branch action still runs against an
explicit workspace identity and revision contract.

### Artifact

An artifact is a versioned, inspectable result or work product.

Initial kinds should include:

```text
plot | table | file | report | rendered_document | diff | model |
dataset_reference | environment_snapshot | run_report
```

Future external-tool outputs may use the same artifact contract.

Minimum artifact metadata:

```text
artifact_id
task_id
kind
title
status
media_type
storage_reference
created_at
created_by
producer_run_id
producer_turn_id
workspace_id
state_revision
project_revision
version
supersedes_artifact_id
```

Suggested artifact states:

```text
producing | ready | needs_review | accepted | changes_requested |
superseded | failed
```

Large payloads must not be copied into task-list responses. List APIs return
bounded manifests. Payloads, pages, rows, plot images, and logs load lazily.

### Artifact Link

Artifacts need typed relationships:

```text
input_to | produced_by | derived_from | visualizes | documents |
validates | contradicts | supersedes | attached_to
```

This is the basis of the inspector and later provenance graph. It should link
durable IDs rather than relying on filenames embedded in messages.

### Context Attachment

A context attachment is a bounded reference supplied to a task or Agent turn:

```text
file + document version
source range + content hash
artifact + version
run
problem
plot
Environment object reference + workspace revision
task or conversation reference
skill or tool capability
```

Attachments are explicit, visible, removable, and revision-tagged. Unsaved
source content requires a bounded snapshot or editor-buffer reference; it must
not be represented as if it were already saved to disk.

### Annotation

Annotations allow precise human feedback on an artifact. Target forms include:

- image or plot normalized rectangle/point;
- table row/column/cell selection using stable row identity where possible;
- text or code range with content hash;
- PDF page plus normalized rectangle;
- diff hunk and side;
- whole artifact.

Minimum fields:

```text
annotation_id
artifact_id
artifact_version
target_json
body
author
status
created_at
resolved_at
resolution_turn_id
```

Targets must survive viewport resize. If a target cannot be reattached after an
artifact changes, Rho marks it stale instead of placing it approximately.

### Review Finding

A finding is a structured quality concern produced by a reviewer, validator,
test, policy rule, Agent, or human.

```text
finding_id
task_id
artifact_id
severity
category
summary
evidence_links
status
raised_by
raised_at
resolution
resolved_by_turn_id
```

Suggested states:

```text
open | acknowledged | addressed | disputed | dismissed | stale
```

Findings must cite inspectable evidence. Reviewer completion does not imply
artifact acceptance.

## Frontend State Model

The frontend should distinguish durable server state from local presentation
state.

### Durable Query State

Examples:

```text
tasks
taskDetailById
taskBranches
artifacts
artifactVersions
artifactLinks
annotations
reviewFindings
runs
problems
agentTurns
pendingApprovals
```

This state is fetched from narrow broker APIs and refreshed from workbench
events. The frontend must not reconstruct task truth by parsing message text.

### Local Presentation State

Examples:

```text
workbenchPosture
humanPreset
agentSurface
selectedTaskId
selectedArtifactId
selectedRunId
selectedFindingId
workSurfaceTab
inspectorTab
expandedActivityIds
panelSizesByPosture
agentFlowCollapsed
```

The current static frontend can implement these additions in its existing
state object and CSS grid. A future React migration should preserve the same
domain and protocol contracts rather than redefine posture semantics.

### CSS And Layout Strategy

Use explicit root classes or data attributes:

```text
data-posture="human|agent"
data-human-preset="code|analyze|focus"
data-agent-surface="direct|monitor|review"
```

Do not encode all combinations as scattered element-level toggles. Centralize
layout application in one function that:

1. captures the outgoing posture's panel snapshot;
2. updates posture and surface state;
3. restores incoming posture dimensions;
4. translates the active selection;
5. lays out Monaco and other size-sensitive viewers;
6. persists the versioned snapshot.

The current `applyWorkbenchLayout()` behavior can be evolved into this model.
Code, Analyze, and Focus remain Human-first presets. The existing Agent preset
becomes the entry point to `posture = agent, surface = direct` during migration.

## Component Breakdown

### `PostureSwitcher`

A compact two-state segmented control in the persistent workbench toolbar.
It shows Human and Agent posture, has an accessible label, and exposes the
command palette action `Switch Workbench Posture`.

It must not contain Ask/Plan/Act controls.

### `TaskRail`

Provides:

- current and recent tasks;
- branches;
- attention queues such as pending approval, needs review, failed, and stale;
- active background work;
- archived/completed tasks;
- project files as a secondary surface, not a replacement task model.

Badges represent actionable counts, not decorative totals.

### `AgentFlow`

Projects structured task and turn data into concise sections. It supports:

- objective and stage;
- plan summary;
- grouped steps;
- exceptions and decisions;
- approval surfaces;
- context attachments;
- final response;
- composer and mode selector;
- stop/cancel control.

Tool details and raw messages are expandable. The stop control remains visible
while an Agent turn is active.

### `ScientificWorkSurface`

A tabbed host for artifact viewers and existing Rho surfaces:

- Artifact;
- Source;
- Data;
- Plots;
- Report;
- Files;
- Environment;
- Runs;
- Problems;
- future Jobs or remote execution.

Tabs are opened by stable entity IDs. Selecting an entity in AgentFlow should
open the relevant tab without losing the task position.

### `ArtifactReviewCanvas`

Renders kind-specific viewers with a common review contract:

- version selector;
- accept/request-changes actions;
- annotation support;
- compare/open-source/open-run actions;
- bounded loading and error states.

Viewer implementations may differ, but annotations and provenance use common
durable IDs.

### `ArtifactInspector`

Recommended tabs:

- Overview;
- Inputs;
- Code;
- Execution;
- Environment;
- Messages;
- Review.

Tabs appear only when data exists. The inspector displays workspace and project
revision tags and warns when the artifact describes stale state.

### `ActivityGroup`

Groups parallel or repetitive activity by task stage, tool, or job group. It
shows summary state and exceptions while keeping exact events accessible.

### `AttentionQueue`

Provides a cross-task list of:

- pending approvals;
- open review findings;
- failed or crashed runs;
- stale context;
- unresolved Problems;
- artifacts with requested changes.

This is a query projection, not another source of truth.

## Broker And Persistence Design

### Authority Boundaries

The existing boundaries remain:

- Workspace R owns live R scientific objects and analysis execution;
- Agent R owns model orchestration and `aisdk` integration;
- Rust broker owns transport, IDs, policy, revisions, approvals, persistence,
  lifecycle, and normalized workbench events;
- `rho-store` remains the only event and projection database;
- frontend state is a projection and never writes SQLite directly.

### Incremental Store Extensions

A complete model may eventually require projection tables equivalent to:

```text
scientific_tasks
task_branches
artifacts
artifact_links
annotations
review_findings
task_entity_links
```

These tables are query projections beside the append-only event stream, not a
second event system. The first implementation should add only what its UI slice
uses. Existing `agent_turns`, `approval_requests`, `runs`, `problems`, and
`plot_artifacts` should be linked or migrated incrementally rather than
duplicated.

### Workbench Events

Candidate normalized events include:

```text
task.created
task.updated
task.branched
task.stage_changed
task.completed
artifact.created
artifact.version_created
artifact.review_requested
artifact.accepted
annotation.created
annotation.resolved
review.finding_created
review.finding_resolved
context.attached
context.detached
```

Events carry entity IDs, timestamp, actor/origin, and applicable workspace and
project revisions. They must not embed large artifact payloads.

### Query And Command APIs

Candidate narrow Tauri/broker APIs:

```text
list_tasks
get_task_detail
create_task
branch_task
update_task_stage
list_task_artifacts
get_artifact_manifest
get_artifact_payload_page
list_artifact_versions
list_artifact_links
create_annotation
resolve_annotation
list_review_findings
resolve_review_finding
attach_task_context
detach_task_context
```

Protected commands continue through broker policy and approvals. Read APIs are
bounded and paged. The frontend never receives unrestricted filesystem paths
or arbitrary database queries through these interfaces.

## External Tools And Languages

Agent-first creates a natural place for Rho to use tools beyond R, but this
must not weaken the workspace contract.

### Execution Contract

External execution should be represented as a broker-managed job with:

- tool/runtime identity and version;
- exact command or structured arguments;
- working directory and allowed project scope;
- declared inputs;
- declared outputs;
- environment reference;
- start, progress, cancellation, and terminal state;
- stdout/stderr or structured event limits;
- task, turn, run, and artifact links;
- approval and policy outcome.

Possible runtimes include Python, shell, Quarto, Git, literature connectors,
databases, MCP tools, remote compute, or domain services. Each runtime needs a
specific policy class. There is no global `allow external tools` switch.

### Workspace R Boundary

An external tool may:

- read approved project files;
- produce files or artifacts;
- report structured metadata;
- be referenced by a task and review record.

It must not silently become the authoritative source for live R objects. When
an external result enters R analysis, Workspace R imports or reads it through
an explicit broker-recorded action. The resulting R state revision and the
external producer artifact remain linked.

### Approval Classes

Policy should distinguish at least:

```text
read-only project inspection
bounded scientific execution
project file mutation
package/environment mutation
network retrieval
external write action
shell-like arbitrary execution
remote compute submission
```

Agent-first may make approvals easier to review, but it must not reduce the
number of protected classes or hide exact operations.

## Review And Evidence UX

### Evidence Before Explanation

When a user selects a claim, artifact, or finding, Rho should prioritize:

1. the relevant result or changed region;
2. its input and producing run;
3. validation or comparison evidence;
4. the Agent's explanation.

Natural-language explanation is useful context, not the root of provenance.

### Reviewer Separation

A reviewer or validator should operate as an explicit role or stage. Its output
is stored as findings. The producing Agent can acknowledge and respond, but it
must not overwrite the original finding.

Resolution should show:

- original finding;
- evidence cited;
- Agent response;
- resulting change or rerun;
- current status;
- human decision where required.

### Acceptance Semantics

Accepting an artifact version means the user reviewed that version for the
current task purpose. It does not certify universal scientific correctness.
Acceptance records the artifact version, relevant revisions, reviewer state,
open findings, and user identity/time.

## Navigation And Commands

Core commands should include:

```text
Switch Workbench Posture
Open Direct Surface
Open Monitor Surface
Open Review Surface
Focus Agent Composer
Open Current Artifact
Open Producing Source
Open Producing Run
Attach Current Selection To Task
Take Over In Editor
Stop Active Agent Turn
Open Attention Queue
```

Menus and the command palette expose shortcuts. Permanent instructional text
should not occupy the workbench.

## Responsive And Accessibility Behavior

### Widths

At medium widths:

- collapse the task rail to an icon-and-badge rail;
- keep one primary surface plus one secondary panel;
- allow AgentFlow and ScientificWorkSurface to switch rather than compressing
  both below usable widths.

At narrow widths:

- present Task, Agent, Work, and Inspector as switchable primary surfaces;
- keep stop/cancel and pending approval access persistent;
- preserve the selected entity while switching surfaces.

### Accessibility

- posture and surface controls use semantic buttons or tabs with explicit
  selected state;
- resize handles retain keyboard operation and ARIA values;
- status never relies on color alone;
- annotations are available through a list as well as spatial markers;
- artifact versions and findings have descriptive labels;
- focus moves predictably when switching posture or opening an approval;
- live progress announcements are bounded and do not announce every stream
  event;
- reduced-motion preferences disable nonessential layout animation.

## Failure And Recovery Behavior

Posture and surface restoration must tolerate:

- Agent R restart while Workspace R remains live;
- Workspace R restart while Agent history remains durable;
- missing or superseded artifacts;
- stale annotations;
- deleted or renamed source files;
- interrupted external jobs;
- stale approvals;
- project reopening on a different display size;
- frontend restart during review.

The UI must show the durable terminal or stale state. It must not silently
recreate missing work, rerun code, or attach a finding to a different artifact
version.

## Implementation Strategy

### Phase A: Posture Shell

Purpose: validate switching and information priority using existing entities.

Deliverables:

- add `WorkbenchPosture` and `AgentSurface` frontend state;
- add the persistent posture switch, separate from Ask/Plan/Act;
- persist independent Human-first and Agent-first panel snapshots;
- implement Direct using existing Agent turns, runs, approvals, files,
  Environment, Plots, and Problems;
- translate active selections across posture changes;
- retain the current Human-first behavior unchanged by default.

No new task or artifact schema is required for the first visual prototype.
Existing Agent turns can temporarily project as task rows, clearly marked as a
compatibility projection.

### Phase B: Durable Tasks And Unified Work Surface

Deliverables:

- add durable scientific tasks and task/entity links;
- introduce TaskRail and AttentionQueue;
- introduce ScientificWorkSurface tabs backed by current APIs;
- attach files, selections, runs, Problems, plots, and objects by stable
  references;
- add Monitor grouping for current runs and Agent activity.

### Phase C: Artifact Review

Deliverables:

- generalize plot artifacts into an artifact manifest contract;
- add artifact versions and typed links;
- add ArtifactReviewCanvas and ArtifactInspector;
- add annotations and review findings;
- implement Review surface, version comparison, accept, and request-changes;
- connect findings to reruns and resulting artifact versions.

### Phase D: External Tool Jobs

Deliverables:

- define broker-managed external job contracts and policy classes;
- add one narrow, demonstrated non-R workflow;
- represent inputs and outputs as task-linked artifacts;
- expose cancellation, logs, environment, and provenance through Monitor and
  Review;
- verify that Workspace R remains authoritative after importing results.

Do not begin with unrestricted shell or a generic multi-language terminal.
Choose a concrete scientific workflow and validate the complete review and
provenance path.

## Testing Strategy

### Frontend Unit And State Tests

Cover:

- posture and surface transitions;
- independent panel restoration;
- selection translation in both directions;
- missing-entity fallback;
- no execution or permission changes on posture switch;
- attention badge derivation;
- annotation target serialization;
- bounded activity grouping.

### Broker And Store Tests

Cover:

- task lifecycle and branching;
- artifact manifest/version/link persistence;
- finding and annotation lifecycle;
- revision tagging;
- recovery marking;
- bounded/paged query behavior;
- policy enforcement for external jobs;
- immutable audit records after finding resolution or artifact acceptance.

### Integration Tests

At minimum:

1. open an R project in Human-first;
2. select code and switch to Agent-first without saving or executing it;
3. create a task from the selection;
4. run an approved correction in Workspace R;
5. inspect the resulting plot in Review;
6. annotate a precise plot region and request a change;
7. inspect the new artifact version and producing run;
8. switch to Human-first and open the producing source location;
9. restart Agent R and verify task/review recovery;
10. restart the desktop and verify posture, selection, approvals, and durable
    records restore truthfully.

### Visual Acceptance

Verify desktop and narrow layouts for:

- no overlapping controls or unreadable tabs;
- stable panel dimensions during status changes;
- long task and artifact names;
- multiple pending badges;
- large plots and PDFs;
- large code diffs;
- expanded approvals and findings;
- keyboard-only posture switching and review.

## Acceptance Gates

### Phase A Gate

> A user can switch between Human-first and Agent-first while an Agent turn is
> active, preserve the selected file/run/problem/plot, keep Ask/Plan/Act policy
> unchanged, stop the turn, and switch back without losing unsaved source or
> changing Workspace R.

### Phase B Gate

> A user can direct a durable scientific task, attach current project context,
> monitor grouped execution, identify the exact item needing attention, and
> take over in the relevant Human-first surface without reading a raw event
> transcript.

### Phase C Gate

> A user can review a versioned scientific artifact, inspect its inputs, code,
> environment, run, messages, and findings, annotate a precise issue, request a
> correction, and verify the resulting artifact version and audit trail.

### Phase D Gate

> An approved non-R tool can produce a reviewed artifact with declared inputs,
> environment, logs, and provenance; Workspace R can import that result through
> an explicit recorded action without creating a second authoritative live
> workspace.

## Open Questions

- Should the application reopen in the last posture, or always default to
  Human-first until Agent-first reaches release quality?
- Is `task` the user-facing term, or should Rho use `work`, `analysis`, or
  another term while retaining `task_id` internally?
- Which artifact kinds are required for the first Review slice beyond plots,
  diffs, and rendered documents?
- Should an Agent surface change automatically when a task enters
  `needs_review`, or should Rho only display a recommendation?
- What constitutes artifact acceptance for an automated rerun whose inputs or
  environment changed after review?
- How should task branching interact with Git branches without conflating the
  two concepts?
- Which narrow external-tool workflow best demonstrates the Phase D contract?
- Which review findings require explicit human resolution before task
  completion?

## Recommended Immediate Next Step

Do not start by adding external runtimes or a generalized artifact database.
Build a frontend-only Phase A prototype over current durable entities and use
one representative workflow:

1. start from an R source selection in Human-first;
2. switch to Agent-first Direct;
3. monitor an approved Agent correction;
4. open the resulting plot or diff in Review;
5. take over at the producing source in Human-first.

This prototype will test whether the posture model and selection translation
actually reduce navigation cost before Rho commits to the broader task and
artifact persistence model.
