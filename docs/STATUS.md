# Rho status

Updated: 2026-10-25.

## Frontend reset

The user stopped the prior frontend work and requested removal of all previous
frontend documents, rules and designs, followed by a reconstruction from the work
people need to do. The old plans and visual specifications are removed, including
the UI/UX Notebook plan, visual replay prototype and E/M/R appearance rulers.
AGENTS.md and the documentation index no longer direct work through those plans.
Uncommitted pre-reset work is preserved locally in `work/frontend-reset/before/`.

The browser now has one project sidebar, dedicated Overview/Files/Activity/settings
sections, searchable projects and files, direct workspace controls and an optional
Agent inspector. The visual layer is rewritten across the app, workspace and plugin
catalog. There is no permanent Agent column or compressed run timeline. Existing
execution records remain reachable from Activity and exact artifact provenance.

The Agent request field uses an explicit clipboard handoff to the external Agent.
Its draft survives panel closure within this tab, scoped by principal/project.
Copying never claims delivery. Documents, selections, run identity and conditional
writes keep their actual owners. The frontend does not invent Notebook capabilities.

## Verification of this reconstruction

- `npm run build`: passed.
- Rho 171/171 unit checks passed: [verification ledger](VERIFICATION.json).
- Real Chrome 155.0.8059.84: project entry/creation, files, table, figure, layout,
  activity, settings, plugin catalog/detail and responsive dialogs passed at
  1440, 1024, 768 and 390 CSS pixels. The newer frontend, entry, pages, plugin,
  shell, actions, objects, continuity, document and person-files suites passed.
- Native browser input: real clipboard, Unicode, Chrome CDP IME composition,
  keyboard commands, modal focus containment and focus return passed. A portalled
  Agent panel focus escape found during this work was fixed and rechecked.
- Real R execution: edited action input, one dispatch after a lost reply, stop
  confirmation, failure/repair, unknown outcomes, exact artifact provenance,
  explicit linked answers and partial exports passed through the rebuilt UI.
- Recovery: unsaved text and own undo survive tab/layout changes; shared selections
  survive re-layout; confirmed documents, layouts and contexts survive normal and
  sudden service exits. Reconnection reads without resubmitting work.
- An unsigned local development tarball passed installation and Chrome launch outside
  the source repositories, with no development runtime overrides and no Host left
  behind. Its composition records the selected Core and local source overrides;
  this is separate from a signed release or registry publication.
- Screenshots and detailed reports are retained locally under
  `work/frontend-reset/`; document rendering and link checks are recorded there.
  Previous frontend appearance acceptance is not inherited.

Checks use disposable projects and owned Hosts. The plugin repository's pre-existing
uncommitted `plugins/tables/src/ui.tsx` change was preserved; browser builds record
that local override. No component source was edited or published in this task.
The unit result for Plugins in the ledger remains historical, with its original date.

## Existing application capabilities

- Node local service with authenticated project/method scope, generated public
  contracts, bounded JSON/SSE observation and a project-scoped MCP adapter.
- Conditional shared Documents buffers, author history, own undo, disk conflict
  checks, exact resource references and durable acknowledged recovery.
- Registered table, media, chart, document, annotation and Agent views; composition
  tabs/splits use the same conditional owner layout and preserve view buffers.
- Real R execution through the public Core CLI, original request identity, retained
  output, cancellation facts, partial/unknown outcomes, explicit repair and export.
- Separate execution completion, artifact integrity, domain checks and Agent claims.
- External Claude Code integration and scoped capability discovery; no built-in model
  conversation. Explicit linked replies remain distinct from a context fetch.

[Headless backend](HEADLESS.md), [Collaboration](COLLABORATION.md) and the historical
backend acceptance records retain their technical scope and immutable candidates.
The three source repositories remain independently owned. No Core behavior or
functional component API was changed by the frontend reconstruction.

## Delivery scope and limits

The current source targets the local browser application on macOS arm64. Source
checks, accepted package composition, installation and official distribution are
separate evidence. npm registry publication, native desktop windows, official
signed distribution, additional platforms and physical IME usability are not
established by this frontend change. Human usability has not yet been evidenced.

[Frontend](FRONTEND.md) describes the current implementation. [Release](RELEASE.md)
describes source publication and the separate future distribution milestone.
