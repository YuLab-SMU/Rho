# Working on Rho application assembly

This checkout now owns the application shell, examples, development entry and
component composition. `../Rho-core` and `../Rho-plugins` are separate local Git
repositories with their own AGENTS.md. Default locations can be overridden with
`.rho-dev.json`, RHO_CORE_REPO and RHO_PLUGINS_REPO. There is no root Cargo workspace.

## Orientation and ownership

Read docs/README.md and docs/STATUS.md when joining or resuming. Architecture
records current ownership; NEXT-VERSION records target capabilities; RHO-DESIGN
and STUDIO-FEEDBACK govern interaction work. Keep proposed, implemented and
verified claims distinct. Status is the single current summary, under 300 lines.
Do not add historical ledgers; Git retains the old monorepo and retired tests.

- Core owns generic Host identity, authorization, Operation, journal, lifecycle,
  routing, public SDK and CLI/HTTP/MCP adapters. It embeds no application UI or R
  example. Application assembly selects components; it never reimplements the
  scientific operation path.
- Plugins own scientific semantics, native resources, preconditions and recovery.
  Queries are bounded observations and never start or recover runtimes to read.
  Preserve original requests, caller/project visibility, native identity, partial
  outcomes, commit uncertainty and no-replay recovery. No global scientific revision.
- Agent-authorized requests get mechanical identity/schema/scope/containment and
  native-precondition checks, not another Rho approval. Models cannot expand scope.
- sdk/ is a pinned exported dependency, verified by core-sdk.json. Edit its owner
  in Rho-core, commit, then explicitly sync the dependency. Never maintain a fork
  here or silently follow another repository's main branch.
- Existing built-in Agent and Studio interactions remain until separately changed.
  Repository separation does not authorize abandoned-data migration or a new Agent
  product. Package viewing remains read-only; installation has a separate owner.

## Development and verification

Use this checkout on main as the everyday entry: node dev.mjs status. Each new
repository owns its independent source and commits. Do not duplicate source or
introduce a fourth coordination repository. Routine work needs no worktree.

Inspect git status before editing and preserve unrelated work. Select a bounded
flow and its concrete completion conditions. The old whole-product suite is not
required: retain useful owner/contract tests, adapt necessary cases and retire
checks of old directory layout, package counts or private implementation shape.
Do not implement compatibility solely to satisfy retired tests. A relevant failed,
missing or timed-out check is not a pass. See docs/DEVELOPMENT.md.

Use node dev.mjs build app, node dev.mjs build core, or node dev.mjs build plugin
NAME. Build only changed owners. Application checks do not run Cargo; plugin-only
changes reuse the retained core binary. Never run Cargo builds/tests concurrently.
Generated public contracts belong to core; generation and SDK refresh are explicit.

For app changes run npm run build --prefix ui and npm run check --prefix ui, then
selected UI behavior/browser checks. For core/plugin Rust edits use focused
`cargo test -p <crate> <filter> --locked` in its repository. Source closure, real
Owner results and cross-component composition are distinct evidence. A component
build or historical archive does not prove the current complete application.

Do not add acceptance scope during closure without a concrete missing requirement.
An unavailable historical full-product test does not block selected boundary
acceptance. Inspect the diff and commit coherent authorized changes in each
repository; update the source lock only after component commits. Verify clean
status in all three repositories before ending. Never push, install, sign or
publish merely because a local build passed.

## UI and runtime continuity

Product UI uses English and preserves Unicode user content. Substantial layout or
component redesign needs Paper development and user review; reuse existing approval.
Packages designs are in Paper “Rho · 工作台交互草稿”, page “Packages · 查看体验设计评审”;
read JSX/styles via the design references in docs/RHO-DESIGN.md. Show useful package
purpose/version in lists, paths/provenance in details. Verify representative widths.

The shell starts in ui/src/app.ts. App assets are emitted to target/app-assets and
served by core --assets. HTML/JS/CSS refresh does not replace an immutable plugin,
add Host capabilities or preserve R memory through backend replacement.

Use disposable projects/catalogs for verification. Inspect existing work before
starting another Host for the same project. Do not restart a user Host or R session
without existing authorization. Preserve acknowledged drafts/layout/history and
never treat missing acknowledgements as saved data. Navigate private URLs directly;
never put tokens in Git, documents or shell search queries.

Skills live with their real source owner. Validate package/resource containment;
links do not expand project read scope. Do not scan other products' private catalogs.
Jet source, patches and scientific runtime tooling live in Rho-plugins.
