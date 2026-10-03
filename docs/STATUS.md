# Rho: current state and focus

Updated: 2026-10-03. This is the single current summary. Git retains the former
monorepo, old acceptance matrix and earlier product evidence; they are not gates
for the new repository boundaries.

## Implemented repository separation

| Local repository | Ownership |
| --- | --- |
| Rho-core | Generic Host, journal, public protocol/SDK, CLI/HTTP/MCP and their core tests |
| Rho-plugins | All sixteen official plugin sources, domain contracts, views, native adapters, Jet/patches and scientific skills |
| Rho (this checkout) | Application shell, examples, development entry, selected artifact composition and integration checks |

Core and plugins have independent Cargo workspaces and locks. The application has
no Cargo workspace. The old root-directory/inventory checks, whole-product CI,
monolithic browser scenarios and native-preview assemblers were retired. Useful
core tests, plugin Owner/native tests and application window tests remain with
their owners. This is not a claim that every retained test was rerun.

Core no longer embeds application HTML/JS/CSS or R examples. Its HTTP adapter
serves explicitly selected bounded assets and an existing application-configured
default project; the application prepares the example. CLI now selects --assets
and --default-project. The old --demo-project / --dev-assets startup contract is
not preserved. Historical binaries and user installations were not replaced.

Public SDK source is maintained only in core. Consumers contain exported dependency
snapshots with exact source revision, license, file inventory and digests. Application
build/check uses these files without Cargo. Plugin build tools use their own Node
installation and source workspace, without reading core/application source.

The single local entry is dev.mjs: status, build core/app/plugin, explicit SDK sync,
lock, verify, run and assemble. rho.lock.json records selected checkout revisions
and each plugin artifact independently. An unrelated plugin-repository commit does
not force rebuilding unchanged packages. Local overrides are visible in receipts;
exact assembly requires clean, explicitly selected core/plugin artifacts.

Core and plugins are published as public repositories at
[YuLab-SMU/Rho-core](https://github.com/YuLab-SMU/Rho-core) and
[YuLab-SMU/Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins). Their initial remote
main heads were verified against local commits 55c6ac1e and 7b88e1cd respectively. The
application split is submitted on YuLab-SMU/Rho's codex/split-repositories branch
for review into main. The existing personal fork remains a separate remote.
This publishes source; no binary release or installer was published.

Core has subsequently published windowless context contracts, explicit launcher
grants and query observations that preserve owner time and notices. Unknown owner
time stays null; cached data is readable with partial completeness and a cache
notice. Focused protocol, Operation and CLI/MCP checks passed (42 tests), together
with an independent core build, SDK example compilation and source-boundary check.
An external file change and later reads after an uncertain Operation were checked
with a Core-owned protocol fixture. These prove Core boundaries, not scientific
results, Editor merging or the current application composition. Consumer SDKs,
the application lock and retained composition artifacts have not selected these
new Core contracts.

Files source now separates native disk access from the managed-write settlement
fence. Once a native patch attempt returns, bounded queries can read current files
before Host settlement, including subsequent external changes. Current reads do
not confirm the original outcome or replace its captured result. Managed patches
and instance release remain fenced until settlement; active native patches exclude
observations. No observation store, event capture or public SDK change was added.
The six backend tests and the built executable's public protocol checks passed;
the regression first failed on the former settlement-wide read fence. The Files
package was built through the application development entry without rebuilding
Core. This package has not been selected by the application lock or checked in a
new application composition. The next Files gap is its mandatory presentation
dependencies, which still bind basic capabilities to window and annotation ports.

## Selected verification

| Executed flow | Established result |
| --- | --- |
| Core source closure and cargo build --locked in Rho-core | Independent generic core executable; no application or domain-plugin source dependency |
| cargo test -p rho-workbench --lib --locked in Rho-core | 13 HTTP/Host behavior tests passed, including auth, project selection, queries and asset containment |
| node scripts/check.mjs in Rho-plugins | Contained source graph with only declared public core dependencies; SDK file digests verified |
| node scripts/vendor-jet.mjs check in Rho-plugins | Pinned native source, notices and ordered patch replay verified |
| node dev.mjs build plugin files / r / annotations | Three packages built from the independent plugin checkout; retained core binary unchanged |
| npm run build --prefix ui; npm run check --prefix ui | External application assets and client types built/checked without Cargo |
| npm run test --prefix ui | 135 window/client tests passed; dependency CSS source-map warning was non-fatal |
| cargo test -p rho-files-backend --lib --locked in Rho-plugins | Six tests passed, including reads and external changes before settlement, stale content, cancellation and original write fences |
| Files package tests/protocol.py against its built executable | Current reads before settlement, external changes, protected paths, settlement/cancellation, duplicate/foreign identity and disconnected-work checks passed |
| node scripts/test-composition.mjs | Empty core; real Files patch with declared Annotations provider; path escape refusal; original retry, stale-write refusal, restart readback; external assets, refresh, containment and HTTP auth passed |
| npm run test:browser --prefix ui -- composition.spec.ts | Isolated Chrome loaded external app assets, selected the app-owned Demo and retained the workspace after refresh |
| node dev.mjs verify and exact assembly | Retained binary/package digests checked; three selected archives assembled without rebuilding or installing components |

Files currently declares annotations.read as a required capability. The composition
flow uses a real Annotations provider rather than a fixture pretending the dependency
exists. R was built but no real-R session was started for this split.

Evidence is retained under target/: composition-test.json and its original report,
composition-browser.png, core.json, packages.json, app-assets.json, and
composition-split-locked/composition.json. The latter records exact sizes/hashes and
source identities; its application source was dirty during assembly and is labeled
accordingly. That assembly retains its original core 10ccb43a receipt. The split's
core source and retained core receipt are 55c6ac1e; cargo build --locked completed
with the same native binary bytes. Packages were built at plugin source f03bf973.
Later test-fixture, repository metadata and SDK-verifier changes are selected for
source development; they do not invalidate the unchanged package artifacts.
The latest Files build has a separate current receipt in packages.json. The
historical composition receipts and application lock still retain their original
package selection.

Remote preparation exposed Finder .DS_Store files in local SDK directories. Core's
exporter and verifier now exclude ordinary Finder metadata files while still
rejecting symlinks, unlisted code and changed dependencies. The focused check
node --test scripts/tests/sdk-snapshot.test.mjs passed. Both consumer snapshots
were refreshed from committed core source; source closure checks and
node dev.mjs verify passed. No runtime or UI code changed during this preparation;
the selected behavior evidence above remains applicable.

## Limits and next work

- The [Core mission and implementation plan](../../Rho-core/docs/MISSION-AND-PLAN.md#权限体系建设后置)
  defers permission-system design until a concrete sharing, remote-access or
  isolation requirement is selected. Near-term work prioritizes local reading,
  editing, execution and checking without adding roles, grant configuration or
  approval steps. Existing launcher grants remain current implementation; this
  planning change does not remove them or select a new application composition.
- The latest Core source has removed production test-project orchestration,
  source/build workflows, product presentation state and the Core draft model;
  its [current boundaries](../../Rho-core/docs/ARCHITECTURE.md#responsibility-boundary-after-the-breaking-upgrade)
  distinguish those removals from consumer integration. The
  [Core simplification plan](CORE-SIMPLIFICATION.md) remains the design reference.
  Receiving plugin/application flows and the selected composition still await
  migration. The Files observation change above uses its existing pinned public
  dependency and does not refresh consumers or select the newer Core.
- The current breaking upgrade accepts independent repository delivery. A core
  task proves its new contract with a minimal caller; plugin/application migration,
  consumer SDK refresh, lock updates and composition are separate integration work.
  Other repositories may remain incompatible. No compatibility or legacy-data
  migration is required merely to close a component task.
- This establishes local source/build separation and the selected Files/application
  flow, not a fresh sixteen-plugin acceptance, real-R computation/recovery matrix,
  visual redesign acceptance or signed/public distribution.
- The component source repositories are published; the application split awaits
  merge into main. Automatic acquisition of missing artifacts,
  installer/signing/notarization and an updated native Preview launcher remain
  separately scoped work.
- The future release boundary is agreed in [Release](RELEASE.md#future-official-release-boundary):
  Rho keeps application assembly; Rho-releases will promote fixed accepted
  compositions with separate build and signing/publication credentials. That
  repository and pipeline remain unimplemented until the first signed-distribution
  milestone; documenting the design does not publish another release.
- Existing Agent/Rig, window-bound contracts and Studio-specific Agent entry points
  remain in their plugin owners. The external-Agent/headless goals in Next Version
  are not automatically implemented by moving source.
- Plugin archives remain immutable. Refreshing shell assets does not update plugins
  or add Host capabilities. Replacing an R-owning backend can lose native R memory.
- No user Host, installed preview, catalog, R session or project data was restarted,
  migrated or overwritten. Acceptance used disposable catalogs/projects only.

Continue from the selected owner's README and Git state. Use node dev.mjs status
when composition is selected. Follow Next Version's user-action-first plan; prove
only the selected owner's result and report any unverified integration separately.
