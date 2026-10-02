# Working on Rho application assembly

This checkout owns the application shell, examples, development entry and component
composition. `../Rho-core` and `../Rho-plugins` are independent source repositories.
Read the owning repository's AGENTS.md before editing there; this file governs Rho.
Default locations can be overridden with `.rho-dev.json`, `RHO_CORE_REPO` and
`RHO_PLUGINS_REPO`. There is no root Cargo workspace.

## Orientation and ownership

Read [docs/README.md](docs/README.md) and [Status](docs/STATUS.md) when joining or
resuming, then only the references needed for the task. Reuse current context.
[Architecture](docs/ARCHITECTURE.md) records ownership and durable constraints;
[Next Version](docs/NEXT-VERSION.md) records target capabilities;
[Design](docs/RHO-DESIGN.md) and [Feedback](docs/STUDIO-FEEDBACK.md) govern interaction
work. [Development](docs/DEVELOPMENT.md) gives commands and scoped verification;
[Release](docs/RELEASE.md) distinguishes source publication, local assembly and
future official distribution. Keep agreed, implemented and verified claims distinct.
Status is the single current summary, under 300 lines. Git retains history;
do not add completed-work ledgers or embed current commit/PR/account details here.

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
- `sdk/` is a pinned exported dependency, verified by `core-sdk.json`. Edit its
  owner in Rho-core, verify and commit, then use `node dev.mjs sdk sync app` or
  `node dev.mjs sdk sync plugins` explicitly. Never maintain a fork here, manually
  alter the inventory to conceal a mismatch, or follow a floating source branch.
- Existing built-in Agent and Studio interactions remain until separately changed.
  Repository separation does not authorize abandoned-data migration or a new Agent
  product. Package viewing remains read-only; installation has a separate owner.

## Development and verification

Use this checkout on `main` as the everyday entry: `node dev.mjs status`. Each
repository owns its source and commits. Application build/check must not require
sibling source checkouts or Cargo. Routine work needs no worktree; use temporary
worktrees for independent tasks, then integrate their changes and remove them.
Keep the three-source-repository development structure; future release ownership
is a separate concern described below.

Inspect git status before editing and preserve unrelated work. Select a bounded
flow and its concrete completion conditions. The old whole-product suite is not
required: retain useful owner/contract tests, adapt necessary cases and retire
checks of old directory layout, package counts or private implementation shape.
Do not implement compatibility solely to satisfy retired tests. See Development
for the selected repository-boundary acceptance flows.

Use `node dev.mjs build app`, `node dev.mjs build core`, or
`node dev.mjs build plugin NAME`. Build only changed owners; plugin-only changes
reuse the retained core binary. Never run Cargo builds/tests concurrently.
Generated public contracts belong to core; generation and SDK refresh are explicit.

`rho.lock.json` selects component commits, SDK snapshots and individual plugin
artifacts. Update it with `node dev.mjs lock` after component commits and the
required SDK refresh/builds. An unrelated plugin-repository commit does not require
rebuilding unchanged packages. Source selection, artifact identity and acceptance
are separate evidence; preserve their receipts. Local overrides must be explicit
and cannot be represented as an exact published composition.

For app changes run `npm run build --prefix ui` and `npm run check --prefix ui`, then
selected UI behavior/browser checks. For core/plugin Rust edits use focused
`cargo test -p <crate> <filter> --locked` in its repository. Source closure, real
Owner results and cross-component composition are distinct evidence. A component
build or historical archive does not prove the current complete application.

Reuse passing checks when they cover the current change. Report only executed
checks; unavailable, skipped and timed-out checks are not passes. Preserve failed
or incomplete evidence rather than treating a narrower pass as its replacement.
Documentation-only changes need link/anchor checks and rendered-content inspection,
not native builds. Render a coherent batch, inspect affected content and downstream
layout, and reuse valid observations of unchanged content.

Do not add acceptance scope during closure without a concrete missing requirement.
An unavailable historical full-product test does not block selected boundary
acceptance. Inspect the diff and commit coherent authorized changes in their owning
repositories. Check repository states before ending; preserve and report unrelated
changes instead of cleaning them to obtain an empty status. Update Status only when
behavior, verification conclusions, focus or unresolved work changes, not merely
to record an edit to instructions or documentation.

## Source publication and future releases

Before pushing, inspect the actual remote URL, branch and authenticated account;
do not assume `origin` is the organization repository. Use `codex/` for new review
branches. Publish required component commits before an application change that
references them, and verify remote heads after pushing. Carry forward existing
user authorization; do not request it again for the same agreed action. Source
pushes, PR merges, binary publication and installation are separate outcomes.

Rho owns application assembly. The agreed future `Rho-releases` repository owns
promotion of accepted compositions, signing/notarization, official artifacts and
installation/update channels. It is not another source mirror or daily development
coordinator. Its implementation belongs to the first explicitly requested official
signed-distribution milestone; the design alone does not authorize creating it.

Official releases must pin immutable source and artifact identities with their
acceptance evidence. Product and component versions can evolve independently.
Build/test jobs do not hold signing or publication credentials. A separate release
stage verifies the chosen candidate without rebuilding it and records unsigned
and signed artifact digests. Follow Release for the full boundary. Do not introduce
release approvals into scientific Operations or publish as a side effect of a build.

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
