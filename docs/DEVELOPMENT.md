# Developing Rho

Start with [Status](STATUS.md), [Architecture](ARCHITECTURE.md),
[Roadmap](ROADMAP.md) and [Technology stack](TECHSTACK.md). The local backend is
implemented; its [build, check and assembly commands](HEADLESS.md#budgets-verification-and-assembly)
exercise the actual headless composition. Browser implementation is pending.

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
[prioritized task list](WEBUI-FIRST.md) and
[completion criteria](ROADMAP.md#first-integrated-flow) guide bounded changes in
each owner while the final acceptance exercises the actual application combination.

1. Define the action, inputs, visible result, failure behavior and responsible owner.
2. Select supported public capabilities at explicit versions. Reuse applicable
   native tools, files and existing checks.
3. Implement the selected owner boundary and run checks that exercise its behavior.
4. Review the diff, retain failures and incomplete evidence, then commit coherent
   authorized changes and inspect all touched repository states.

Generic Core contract regressions stay in Core. Component/domain checks and
reusable Agent evaluations stay in Rho-plugins. Application interaction and
composition checks belong here. Never run Cargo builds/tests concurrently.

## Documentation and UI verification

Document changes require local link/anchor checks and rendering after a coherent
batch. Inspect every changed page for missing content/glyphs, clipping, overlap
and broken tables. Recheck affected pagination after fixes; reuse valid unchanged
observations. Only executed checks count as passes.

Substantial UI work follows [Product design](DESIGN.md) and user review. Test real
behavior with actual resources at normal, wide and constrained sizes. Verify
applicable native IME, focus, keyboard access, clipboard, undo and external writes;
synthetic key events alone do not prove native input behavior.

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
