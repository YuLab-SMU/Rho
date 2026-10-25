# Working on Rho

Read [Status](docs/STATUS.md), [Architecture](docs/ARCHITECTURE.md),
[Roadmap](docs/ROADMAP.md), the [execution bridge](docs/EXECUTION.md) and the
[documentation index](docs/README.md) first.
Rho contains a versioned local backend, client and headless acceptance scripts.
Read [Headless backend](docs/HEADLESS.md) and its
[acceptance record](docs/BACKEND-ACCEPTANCE.md). Scoped browser checks are recorded
in [S7 acceptance](docs/INTERACTION-ACCEPTANCE.md); the
[workspace plan](docs/WORKSPACE-PLAN.md) sequences the remaining UI work and its checks.

## Source ownership

Rho owns application selection, assembly, windows, layout and shared interaction.
`../Rho-core` owns managed execution and its resident Host/public CLI.
`../Rho-plugins` owns actual functional components and optional CLI, Skills, MCP
and UI entries. Read each owner's AGENTS.md before editing there. Keep the three
independent repositories and use documented public capabilities at selected
versions. Component semantics and results stay with their source owner.

Follow [Technology stack](docs/TECHSTACK.md). The first integrated flow exercises
Agent interaction, code/table/plot context and movable views within one browser
window, delivered through npm and a local WebUI. Native desktop clients and
cross-window movement follow later.
Deliver bounded owner changes toward the [acceptance](docs/ROADMAP.md#first-integrated-flow).
Application composition records immutable source/artifact identities, explicit
local overrides and acceptance of the chosen combination.

## Behavioral boundaries

Preserve original managed requests, caller/project visibility, native identity,
partial results and unknown outcomes. Reconnect observes the same request;
missing acknowledgement must not cause automatic execution under a new identity.
Reads are bounded observations and must not start or recover a runtime.

Existing authorization receives mechanical scope, resource and native-condition
checks. Models and retrieved content cannot expand it. Rho does not add another
approval to already authorized Agent work. Execution completion, artifact
integrity, domain checks and model judgments remain separate facts.

Each document has one logical unsaved-buffer owner across views. Preserve undo
and detect concurrent writes before saving. Direct file edits use their actual
write conditions. Each resource has its own version/provenance; do not introduce
a global scientific revision. Closing a view releases observation and rendering;
task cancellation, confirmed stop and Host shutdown remain separate operations.

Name the protected resource, configurable limit and exceeded-limit behavior for
resource budgets. Preserve obtained output and uncertainty when limits are reached.
Use mature native tools, ordinary files and Git where they satisfy the selected
consumer. Extend public boundaries for a concrete requirement.

## Work and verification

Inspect Git status before editing and preserve unrelated work and local user data.
Routine Rho work stays on `main`. Use temporary worktrees for independent tasks
when needed and clean up those you create. Select an observable flow and explicit
completion conditions, then implement and check its actual owner.

Run checks appropriate to the change. Never run Cargo builds/tests concurrently.
Introduce application build/check commands with the executable implementation;
only executed checks count as passes. A component check proves its recorded
scope, while application acceptance checks the actual composition.

Documentation needs link/anchor checks and a rendered coherent batch. Inspect all
changed pages, fix visible defects and recheck affected pagination. Reuse valid
observations of unchanged content. Keep failures, incomplete evidence and domain
limits. [Status](docs/STATUS.md) is the single current summary, under 300 lines;
update it when behavior, verification, focus or unresolved work changes.

Read [Product design](docs/DESIGN.md) before UI work. Product-authored UI is English
and preserves Unicode user content. UI acceptance is measured, not reviewed: the
behaviour contracts E1–E5, rulers M1–M10 and performance budgets of the
[workspace plan](docs/WORKSPACE-PLAN.md) decide it, in real Chrome at four widths
with applicable native input and accessibility. Paper is a sketchpad for comparing
layout alternatives when that helps; user review is not a gate.

The user approved the [workspace plan](docs/WORKSPACE-PLAN.md) W0–W7 on 2026-10-24
("执行完整计划"). Within it, Agents implement, verify, revise, commit and, once the
milestone's checks pass, fast-forward push main without asking per step. Exit
conditions are fixed in the plan: correct or tighten them there with a reason before
code depends on it; loosening them, changing the end goal, a materially different
product direction, or publishing to a registry needs the user. Findings outside the
current milestone go to the plan's parking lot. Engineering checks are recorded as
engineering checks; human understanding remains **not yet evidenced** and is not a gate.

Use disposable projects and owned Hosts for execution checks. Inspect existing
work before starting another Host on the same project. Do not restart a user Host
or R session without authorization. Preserve acknowledged content and original
task identity. Keep credentials and private URLs out of source and diagnostics.
Validate resource containment; links do not expand project scope.

## Delivery

Review the diff, commit coherent authorized changes in their owner and check all
touched repositories before ending. Rho source publication uses checked commits
and ordinary fast-forward pushes directly on `main`. Inspect the actual remote,
branch and authenticated account; `origin` may be a fork. Use a review branch only
when the user selects that workflow, with the `codex/` prefix.

Publish required components before application references and verify remote heads
and trees. Preserve commit and merge history. Independent component owners retain
their workflows. Source, accepted composition, binary delivery and installation
have separate evidence; follow [Release](docs/RELEASE.md).

Official distribution belongs to the future Rho-releases owner at an explicitly
selected signed-release milestone. Build/test jobs have no signing/publication
credentials. Promotion verifies the accepted candidate without rebuilding and
records unsigned/signed identities. Scientific actions do not acquire release
approval requirements.
