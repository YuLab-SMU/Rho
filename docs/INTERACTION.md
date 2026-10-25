# Adaptive research workspace

Selected direction: 2026-10-25. Rho lets a person and an Agent work around the same
real objects while the workspace adapts to the task. The person controls the
research question, attention and adoption of results. Agents work within existing
authorization and can propose useful changes. Plugins supply domain capabilities;
Rho connects their references, views and interactions.

Keep the environment stable. Let the workspace adapt. Keep the human in control.

This guide turns the current product discussion into development constraints and
experiments. It does not establish implementation or acceptance. [Status](STATUS.md)
records those facts; [Frontend](FRONTEND.md) describes the current browser.
The withdrawn design boards, W7 plans and appearance rulers remain withdrawn.
Examples involving genes, volcano plots or reports describe possible work; they
do not select pages, permanent columns, fixed modes or base-catalog workflows.

## Stable objects, adaptable views

Project scope, resource identity/version, selection meaning, authorization,
unsaved-buffer ownership, execution facts and explicit human protection stay
stable as views change. A view may expand, move or show related material only
within those constraints. Someone reading, typing or comparing must be able to
understand the change and continue from their place.

Use the existing Action, Resource, Selection and View boundaries in
[Architecture](ARCHITECTURE.md#interaction-model). A useful work focus can be a
projection of those objects and the current selection. Add a durable entity only
when a concrete consumer needs an independent lifecycle or recovery contract.
Do not introduce a global scientific revision, a second document buffer or a
parallel execution journal to make the interface easier to draw.

The workspace is composed from supported plugin views. File navigation, tables,
code, figures, Agent interaction, history and future reports are ways into the
same work. A task does not need a new page or a full workflow graph merely to be
observable. Ordinary direct manipulation remains available alongside Agent help.

## Shared interaction grammar

These verbs describe internal contracts, not eight required buttons or a fixed
sequence. Each episode selects the verbs it needs.

| Verb | Object and observable result | Required continuity |
| --- | --- | --- |
| Point | Select an entity, text range or supported image region. | Keep project, owner, resource version and stable keys/range units. A visible row number is not an identity. |
| Inspect | Open data, code, method or evidence behind that reference. | Keep a route back to the original object and place; opening evidence does not execute work. |
| Ask | Attach a question or annotation to the exact object. | Preserve submitted text and its frozen source. Saved, prepared, fetched and explicitly replied remain distinct. |
| Propose | Describe a possible operation or view with a reason and exact targets. | A suggestion is neither execution nor a layout commit. Retain the current work if it cannot be applied. |
| Act | Invoke an available owner action with its actual conditions. | Check existing scope, freshness and native conditions; preserve original managed identity and partial/unknown results. |
| Compare | Inspect two explicit versions, methods or results. | Retain both references and provenance. Cross-version/entity mappings need owner validation. |
| Decide | Record a person's adoption, deferral, rejection or next step. | Name the affected result and basis; a layout pin, successful run and scientific acceptance are different decisions/facts. |
| Return | Revisit an object, version or recoverable arrangement. | State what was restored or is unavailable. Restoring a view does not roll back execution. |

A filtered-out entity remains the same selected entity, with its absence explained
and a way to reveal or clear it. A new resource version cannot silently receive an
old selection. Preserve the old reference when no validated mapping exists.
An Agent's private selection cannot overwrite the person's private selection.

## Rules for workspace changes

Choose the smallest change that helps the ongoing work. The following levels
describe effects, not a new permission service or a universal approval queue.

| Effect | Allowed behavior | Condition |
| --- | --- | --- |
| Local feedback | Update status beside the relevant object. | Keep keyboard focus, selection, reading position and layout; report only observed facts. |
| Suggestion | Offer a related view or next operation with its purpose. | Keep the existing workspace usable; a suggestion alone cannot open, replace or execute anything. |
| Local extension | Open a related view after the person chooses it, or under an explicit existing layout policy. | Validate the current composition, references, available renderer and space; preserve protected content and a return path. |
| Reorganization | Replace/rebind a main view or change an arrangement the person has established. | Require an explicit user action or a previously authorized policy covering that effect. Ordinary writes still cannot bypass view protection. |

Execution authorization and layout authorization have separate scopes. Permission
to run an analysis does not imply permission to replace the person's comparison.
A chosen view suggestion does not grant a new scientific action. When existing
authorization covers an action, apply its mechanical checks and proceed without
another Rho approval. Changing protection uses the existing separately granted
owner operation; neither an Agent recommendation nor a layout policy bypasses it.

Preserve active text input, IME composition, unsaved edits and undo through layout
changes. Inactivity is not evidence that a person has stopped reading. Do not
steal focus for background results or infer permission from a timeout. On a narrow
screen, retain access to related views without squeezing away the active object.
Grouping repeated suggestions must retain their exact targets and explain which
ones are stale; it must not silently apply them.

Opening an older version keeps that version until the person chooses another, or
an explicitly selected following policy applies. A newer result gets an inspect
or compare entry. Following policies must expose their scope and an accessible
way to stop following. Durable protection and temporary reading/focus preferences
must have distinguishable effects and recovery promises.

## Agent intent and plugin ownership

An Agent describes intent using registered capabilities and exact references.
For a proposed view, the design needs a target, capability/component identity,
reason, intended placement and expected workspace basis. These are design
requirements, not a new `suggest_view` API or an implemented wire schema.

Before applying it, use the selected public contract to check project/caller
scope, target version, owner availability, props/bindings, layout conditions and
protection. A missing plugin, stale target, denied action or full workspace leaves
the original objects intact and explains the unavailable effect. Retrying an
uncertain layout write observes its original change identity first.

Only selected, trusted plugin views render domain content. Generated descriptions
do not load arbitrary JavaScript, rewrite the DOM or install packages. A table
owner defines keys and filtering; a plot owner defines marks and mappings; a
document owner defines ranges and write conditions. Rho routes these contracts
without interpreting scientific claims or duplicating domain behavior in the Shell.
New UI entries use [Plugin authoring](PLUGIN-AUTHORING.md); new domain operations
belong in their actual owner and need their own public contract.

Reuse the conditional composition tree and
[collaboration operations](COLLABORATION.md#composition-and-selection).
[Expression rules](../src/expression.ts) and the [workspace](../web/shell/workspace.tsx)
are current implementation starting points to inspect, not authority for withdrawn
designs. A new rule must be justified by an episode and checked through the real
browser/owner path. Do not build another layout engine, Agent framework or generic
workflow system for these experiments.

## Keep three kinds of fact separate

| Fact category | Evidence and owner | What it cannot establish |
| --- | --- | --- |
| Operation | Execution records, conditional edits/saves, resource bytes and checks from Core or the functional owner. | That a result was visible, understood or adopted. Completion, byte integrity, domain checks and model judgment remain separate. |
| Workspace | Rho composition, bindings, protection, scoped selections and actual observation receipts. | That computation succeeded. A committed layout is not proof that the browser rendered it or a person saw it. |
| Review | Authored feedback, explicit linked replies and a person's recorded decision with its referenced basis. | That a fetch means understanding, a reply resolves a question, or adoption proves scientific correctness. |

These categories guide presentation; they do not require three databases or
event sourcing. Reuse existing receipts and owners. If a needed review decision
has no supported storage contract, show that limitation and select its owner
before claiming the decision is saved. A document/annotation may suffice when
that consumer does not need structured decision state.

Show the last observation and its limits when a connection is lost. Preserve
obtained output and unknown outcomes. Reconnection reads the original request;
closing a view, asking to cancel, confirming native stop and shutting down a Host
remain different events. A simple status label must not collapse these facts.

## One continuous episode

Start with a disposable base-R project that produces a keyed table and a figure.
The person opens both, selects an entity and asks a question against that exact
version. The Agent fetches the anchored context, makes a conditional script edit,
deliberately runs new work and explicitly links its response to the question and
new result. The person keeps the old result open, compares the versions, decides
what to use and returns to the original place.

Add a related-view suggestion during reading and an external document write
during editing. Disconnect after one acknowledged change or an uncertain submit.
Check that protected views and input survive, conflicts remain actionable, and
recovery observes the original identities. Missing model access or renderer
availability is an incomplete episode with retained evidence, not a simulated pass.

The eventual gene/batch-effect example repeats these interactions with a real
DESeq2 project and domain checks. Its scientific method stays in the project and
plugins. It does not become application routing or a mandatory product workflow.

## Experiments and acceptance evidence

These are acceptance targets for the selected direction. This document marks
none as newly passed. Reuse existing evidence only for the exact behavior,
composition and conditions it proves; record gaps in [Status](STATUS.md).

| Experiment | Exercise | Evidence needed |
| --- | --- | --- |
| I1: protected reading | A person reads/edits a protected view while an Agent offers related content. Accept and dismiss suggestions; test constrained space. | Original binding, geometry/protection and input/focus survive; any new layout has its own conditional receipt. |
| I2: stable selection | Sort/filter a keyed table, ask about the selected entity, then expose a new version. | The frozen question keeps the original key and version. Hidden/stale selections are explained; mappings are explicit. |
| I3: truthful feedback | Save a question, prepare context, fetch it, delay a reply, then make a linked modification. | Owner receipts and visible language distinguish each fact. A fetch, copy or generic reply cannot mark the question resolved. |
| I4: version comparison | Produce a new result while the person inspects the old one; compare and choose. | Both identities and provenance remain accessible; no silent version switch or implied adoption. |
| I5: return and recovery | Close/reopen, interrupt observation, lose a write acknowledgement and trigger a save conflict. | Recoverable layout/content and execution facts reconcile separately. Preserve drafts and unknown outcomes; no replacement execution identity. |
| I6: plugin extension | Select a separately built view, open it in the existing workspace, then remove its renderer. | No domain branch or new global navigation in the Shell. Existing references/content remain inspectable with an unavailable view explained. |

For each run record the source/composition, actual Agent or fixture, input actions,
owner receipts and before/after browser observations. Include failures and the
unverified scope. A screenshot proves appearance at one moment; an automated
flow proves only its assertions. Neither proves that a researcher can complete
the task independently. Observe target users, recording mistaken state beliefs,
lost focus, unintended actions, assistance needed and the cost of recovery.

## Design references and Rho's application

The following are source-informed adaptations for Rho. They are not endorsements,
copied product specifications or a requirement to imitate another company's look.

**Jakob Nielsen.** His heuristics connect understandable status, familiar concepts,
control, consistency, error prevention, reduced memory burden, efficient use,
focused presentation, recovery and help. Rho applies them by keeping exact object
context visible, offering direct and keyboard paths, and showing the next viable
action beside a conflict. Ask a participant to explain what happened and recover;
a reviewer's heuristic checklist is only a diagnostic aid.
[10 Usability Heuristics for User Interface Design](https://www.nngroup.com/articles/ten-usability-heuristics/).

**Karri Saarinen.** His workbench argument places AI in a structured, useful
environment, and his account of craft keeps makers engaged across the whole
experience. For Rho, design with real capabilities and resources, and own the
episode through input, result, failure and return. Evaluate the transitions and
small interruptions together with the visual result. Chat and generated screens
alone cannot establish that quality.
[Design for the AI age](https://linear.app/now/design-for-the-ai-age),
[Why is quality so rare?](https://linear.app/now/why-is-quality-so-rare).

**Apple.** Its guidance emphasizes agency, familiar behavior, preserved context,
accessibility and clear hierarchy. Feedback should match the consequence and
usually stay near its object. For Rho, protect reading and native input, make
commands discoverable by keyboard, communicate status beyond color, and reserve
interruptions for consequential actionable conditions. Adapt these principles to
the browser's conventions; visual effects are implementation choices.
[Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles),
[Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback).

**SpaceX.** Its published flight-test reports describe explicit objectives,
observed failures, investigation and changes exercised in subsequent tests.
Rho adopts that learning loop: test one integrated episode in a disposable project,
retain the failure evidence, fix its actual owner and repeat the affected checks.
An experiment can teach us something while still failing acceptance. Shorten the
feedback cycle by reducing scope and unnecessary mechanisms; keep user work and
execution identity protected. This is an engineering analogy, not a software
usability standard or a reason to experiment on a user's live session.
[SpaceX flight-test updates](https://www.spacex.com/updates/#flight-7-report).
