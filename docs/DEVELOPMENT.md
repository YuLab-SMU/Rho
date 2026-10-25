# Developing Rho

Start with [Status](STATUS.md), [Architecture](ARCHITECTURE.md),
[Roadmap](ROADMAP.md), [Interaction guidance](INTERACTION.md) and
[Technology stack](TECHSTACK.md). The local backend is
implemented; its [build, check and assembly commands](HEADLESS.md#budgets-verification-and-assembly)
exercise the actual headless composition. The browser implementation is described in [Frontend](FRONTEND.md).

## Work in the source owner

The adjacent `Rho`, `Rho-core` and `Rho-plugins` checkouts have independent source,
dependencies, commits and checks. Read the applicable AGENTS.md before editing.
Rho owns the application container; components own their actual functionality;
Core owns its declared execution contract.

Inspect Git status and preserve unrelated work. Start with a concrete user action,
try the available public capability and identify the smallest gap in its owner.
Reuse mature tools and valid evidence. Additional state, transport or compatibility
mechanisms need a consumer requirement and explicit acceptance conditions.

Routine Rho changes proceed on `main` through reviewed diffs, checked commits and
ordinary fast-forward pushes. A review branch is used when the user selects it.
Component repositories retain their own workflows.

## Deliver toward the integrated flow

The first product delivery uses npm and a local WebUI, combining natural-language
action, linked script/table/plot resources and movable views within one browser
window. Native cross-window movement belongs to a later desktop client. The
[product flow](ROADMAP.md#first-integrated-flow) guides bounded changes in
each owner while the final acceptance exercises the actual application combination.

1. Define one interaction episode using the brief below, including its responsible
   owners and the uncertainty this change will resolve.
2. Select supported public capabilities at explicit versions. Reuse applicable
   native tools, files and existing checks. Remove unnecessary steps before adding
   abstractions or automating the flow.
3. Implement the smallest complete episode, including failure and return. Exercise
   actual resources and owner contracts; inspect transitions in a real browser.
4. Compare the observations with the completion conditions, fix the responsible
   owner and repeat affected checks. Automate stable assertions once their meaning
   is clear; do not turn an exploratory mock into product acceptance.
5. Review the diff, retain failures and incomplete evidence, then commit coherent
   authorized changes and inspect all touched repository states.

Generic Core contract regressions stay in Core. Component/domain checks and
reusable Agent evaluations stay in Rho-plugins. Application interaction and
composition checks belong here. Never run Cargo builds/tests concurrently.

## Write an interaction episode

Use this brief in the task or change description. Scale its detail to the change;
it is a working specification, not a new document or approval ceremony per patch.

| Field | What to specify |
| --- | --- |
| Real context | Project, resource/version, selection, current view/input and actually available capabilities. |
| Trigger | The person's action or the Agent's observation/proposal, with its existing authority. |
| Allowed change | Owner action, visible outcome and permitted local layout effect. |
| Must remain | Object/request identity, protection, focus, input/undo, provenance and route back. |
| Failure and return | Stale input, conflict, missing provider, unread feedback, disconnect and unknown outcome, as applicable. |
| Completion evidence | Observable checks, selected environment, browser actions and separate domain/model/user evidence. |

Use the [shared grammar](INTERACTION.md#shared-interaction-grammar) to check the
contract. A still image can explore hierarchy, but the deliverable must explain
the transition between states. Candidate fields and mock data stay explicitly
unimplemented until their actual owner and public contract exist.

Keep operation, workspace and review facts separate. A layout commit, rendered
result, context fetch and adopted conclusion need different evidence. Use existing
authorization without another container approval; apply additional layout effects
only within their own authorized scope and protection conditions.

## Documentation and UI verification

Document changes require local link/anchor checks and rendering after a coherent
batch. Inspect every changed page for missing content/glyphs, clipping, overlap
and broken tables. Recheck affected pagination after fixes; reuse valid unchanged
observations. Only executed checks count as passes.

Test real browser behavior with actual resources at normal, wide and constrained sizes. Verify
applicable native IME, focus, keyboard access, clipboard, undo and external writes;
synthetic key events alone do not prove native input behavior.

Use the [interaction experiments](INTERACTION.md#experiments-and-acceptance-evidence)
for applicable cross-plugin changes. Existing suites such as
`acceptance:interaction`, `acceptance:continuity`, `acceptance:shell` and
`acceptance:plugin-dx` can supply bounded evidence; inspect their actual assertions
before claiming coverage. Deterministic consumers and real Agent trials are
different evidence. Record the command, selected source/composition, observed
result, failures and limits. Documentation-only changes do not require runtime
builds or new execution trials.

Observe target users doing the episode without coaching. Start during prototyping
and repeat after material interaction changes. Record task completion, wrong
beliefs about state, focus loss, mistakes, help needed and recovery effort; keep
the participant/task scope visible. Human usability is separate from browser,
accessibility, scientific and installation checks. Numeric style rules and a
pixel-perfect screenshot cannot substitute for those observations.

Use disposable projects and owned Hosts for execution checks. Inspect existing
work before starting another Host on the same project. Preserve user sessions,
original request identity, partial output and unknown outcomes. Resource budgets
name the protected resource, configuration and exceeded-limit behavior.

## Composition and delivery

Record immutable source/artifact identities, dependency versions, public boundaries,
explicit local overrides and acceptance of the chosen application composition.
Component checks alone do not prove application integration. Publish required
components before application references and verify remote heads and trees.

Follow [Release](RELEASE.md) for source publication and distribution. Keep the
[Status](STATUS.md) summary focused on current implementation, evidence and next
work, under 300 lines. Credentials and private diagnostics stay out of source.
