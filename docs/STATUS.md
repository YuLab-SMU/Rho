# Rho: current state and focus

Updated: 2026-10-01. This is the single current summary. Git retains the former
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

Source publication is prepared for YuLab-SMU/Rho-core, YuLab-SMU/Rho-plugins and
YuLab-SMU/Rho. The component origin URLs, Cargo repository metadata, online links
and sibling-clone instructions now use these targets. New repositories and first
pushes remain pending; the application is intended for a pull request on
codex/split-repositories. The existing personal fork remains a separate remote.
The configured xiayh17 account has administrator access to YuLab-SMU/Rho.

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
| Files package tests/protocol.py against its built executable | Native protected paths, settlement/cancellation, duplicate/foreign identity and disconnected-work checks passed |
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
accordingly. That assembly retains its original core 10ccb43a receipt. Current
source and the retained core receipt are 55c6ac1e; cargo build --locked completed
with the same native binary bytes. Packages were built at plugin source f03bf973.
Later test-fixture, repository metadata and SDK-verifier changes are selected for
source development; they do not invalidate the unchanged package artifacts.

Remote preparation exposed Finder .DS_Store files in local SDK directories. Core's
exporter and verifier now exclude ordinary Finder metadata files while still
rejecting symlinks, unlisted code and changed dependencies. The focused check
node --test scripts/tests/sdk-snapshot.test.mjs passed. Both consumer snapshots
were refreshed from committed core source; source closure checks and
node dev.mjs verify passed. No runtime or UI code changed during this preparation;
the selected behavior evidence above remains applicable.

## Limits and next work

- This establishes local source/build separation and the selected Files/application
  flow, not a fresh sixteen-plugin acceptance, real-R computation/recovery matrix,
  visual redesign acceptance or signed/public distribution.
- Component source repositories exist locally at sibling paths. Remote creation
  and pushing remain pending. Automatic acquisition of missing artifacts, installer/signing/notarization and
  an updated native Preview launcher remain separately scoped work.
- Existing Agent/Rig, window-bound contracts and Studio-specific Agent entry points
  remain in their plugin owners. The external-Agent/headless goals in Next Version
  are not automatically implemented by moving source.
- Plugin archives remain immutable. Refreshing shell assets does not update plugins
  or add Host capabilities. Replacing an R-owning backend can lose native R memory.
- No user Host, installed preview, catalog, R session or project data was restarted,
  migrated or overwritten. Acceptance used disposable catalogs/projects only.

Continue from node dev.mjs status and the relevant owner's README. Select the next
bounded capability from Next Version independently of this completed source split;
use its real Owner and public contract to define required evidence.
