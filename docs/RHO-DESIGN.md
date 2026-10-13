# Rho UI principles

These principles govern a selected future application UI. No rebuilt UI or
researcher-facing flow is implemented in the current tree.

Give research code, data, plots and results the main reading area. Put internal
identities, full paths and diagnostics in inspection details. Distinguish running,
execution complete, scientifically checked, partial and unknown states with their
scope and freshness. Preserve original task identity after observation disconnects.
Background output must not steal focus or overwrite the user's current work.

Use progressive disclosure, inline errors, accessible controls and stable focus.
Product-authored text and accessible names use English; user content and native
output preserve Unicode and their original language. View closure, task cancellation,
confirmed process stop and native resource release are separate outcomes.
Do not show a model answer as a verified scientific result or add another Rho
approval to an already-authorized Agent action.

## Design review

Substantial layout or component redesign uses Paper and user review. Reuse existing
approval only within its recorded scope. Read exact JSX/styles for the selected
design; screenshots and fixtures do not establish live behavior or scientific data.
The historical designs are on Paper **Rho · 工作台交互草稿**; the
[Packages viewing review](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0)
records purpose/version in lists, paths/provenance in details and read-only package
viewing. Installation has a separate owner and selection.

The [archived design references](https://github.com/YuLab-SMU/Rho/blob/codex/legacy-app-before-main-reset/docs/RHO-DESIGN.md)
and [user feedback](https://github.com/YuLab-SMU/Rho/blob/codex/legacy-app-before-main-reset/docs/STUDIO-FEEDBACK.md)
retain exact earlier decisions and unresolved proposals. They do not mandate old
panels, fixed geometry, replacement chat or automatic migration of layouts/drafts.

For an implemented slice, inspect real content at normal, wide and constrained
sizes. Check focus, keyboard and the applicable clipboard, persistence or native
input-method behavior. Reuse valid unchanged evidence. New observations are
required to close a usability issue; a synthetic event is not a native IME check.

## Joint component experience

The selected experience combines natural-language interaction, code/data/graphics
and freely arranged views/multiple windows. Validate them together through
[joint acceptance](TECHSTACK.md#joint-acceptance-flow). Menus, editing, files,
tables, graphics and Agent interaction can be actual plugin functionality; Rho
coordinates their common presentation and interaction.

An Agent may arrange registered components and bind real resource/action/selection
references. Keep scientific values and execution facts with their actual owner.
Validate scope and freshness mechanically; component-schema validity is not an
authorization or scientific check. Background updates must not steal focus or
rebuild the user's active editing view.

Use stable domain IDs for table/plot selection and make the current resource and
window context unambiguous. Opening another view of a document does not create
another authoritative buffer. Preserve unsaved content and undo while moving views;
detect external writes before saving. Layout restoration must not execute actions
or pretend that a missing buffer/plugin has been restored.

Verify native IME, keyboard-only access, focus, clipboard, drag/drop and applicable
assistive text/table alternatives with actual data at representative widths.
Closing a popout or hidden panel releases its observation/drawing resources only;
task ownership and Host shutdown remain explicit. Missing components or failed
popout provide recoverable presentation without losing drafts or replaying work.
