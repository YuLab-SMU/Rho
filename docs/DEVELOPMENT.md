# Developing Rho

Change each component at its real source owner. Read Status before resuming and
inspect Git state in the repository being changed. Use this repository and
`node dev.mjs status` when application composition is in scope; a component task
does not require inspecting all three repositories. The defaults are this checkout,
../Rho-core and ../Rho-plugins; a gitignored .rho-dev.json can override core and plugins paths.

## Start with a user action

Write the action and its observable success condition before choosing an API or
state model: for example, an external caller changes one line in a project file.
Try the existing public capability and check the actual disk result, reusing valid
evidence where available. Fix only the demonstrated gap in its owner. An absent
integration environment is not evidence that a new abstraction is needed.

Reuse mature editors, file tools and Git by default. Custom implementation needs
a necessary requirement that the existing capability or maintained tools cannot
meet. Explain why files, Git and the operation journal cannot carry the required
state before adding another model. UI buffers are a separate need from directly
editing a disk file. Keep file semantics in Files; verify tool behavior rather
than assuming its memory use, atomicity or text fidelity from its name. State the
purpose, configurability and failure behavior of resource limits.

During this breaking upgrade, select one repository and a bounded responsibility.
Build and test its new public contract with a minimal caller. Other repositories
may remain incompatible; do not add compatibility, consumer migration, SDK refresh,
lock updates or application assembly as closure requirements. Core contract tests
prove core behavior, not real Files/R results. Test the latter when that owner or
an explicit integration flow is selected. Generality and future possibilities do
not independently justify more work.

## Optional composition setup

For application integration, clone the three repositories as siblings. This layout
keeps one development entry without Git submodules. While the application split is awaiting merge, use
`git clone --branch codex/split-repositories https://github.com/YuLab-SMU/Rho.git`
for the first command below; after merge, the default main branch contains the split.

```sh
git clone https://github.com/YuLab-SMU/Rho.git
git clone https://github.com/YuLab-SMU/Rho-core.git
git clone https://github.com/YuLab-SMU/Rho-plugins.git
cd Rho
node --input-type=module <<'JS'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const lock = JSON.parse(fs.readFileSync('rho.lock.json', 'utf8'));
for (const name of ['core', 'plugins']) {
  execFileSync('git', ['-C', `../Rho-${name}`, 'checkout', '--detach', lock[name].revision],
    {stdio: 'inherit'});
}
JS
node dev.mjs status
```

The explicit checkouts reproduce this application's selected component sources.
For new component work, commit and verify in its repository. Update the application
lock only when selecting that component for integration. Git clones contain source
and dependency snapshots; build receipts and native plugin packages are local outputs.

## Commands and source ownership

| Work | Command from this repository |
| --- | --- |
| Inspect checkouts and retained artifacts | `node dev.mjs status` |
| Build application assets | `node dev.mjs build app` |
| Build and retain core executable | `node dev.mjs build core` |
| Build one plugin package | `node dev.mjs build plugin files` |
| Verify retained component bytes | `node dev.mjs verify` |
| Start an explicit development application | `node dev.mjs run /absolute/project` |
| Assemble selected artifacts without rebuilding | `node dev.mjs assemble /new/composition annotations files r` |

Install application build dependencies with npm ci --ignore-scripts --prefix ui.
Install plugin build dependencies separately with npm ci --ignore-scripts in
Rho-plugins. Core needs its pinned Rust toolchain; no application Node modules or
scientific source is required. Build tools do not install R/Ark or activate plugins.

Core and plugins have separate Cargo workspaces and locks. Build only the affected
owner and run Cargo commands serially. Type generation belongs to core:
node scripts/generate.mjs in Rho-core. Ordinary application edits use the committed
public SDK and never invoke Cargo. Imported plugin artifacts remain immutable.

## Explicit versions and local development

rho.lock.json records development checkout commits, dependency snapshot hashes and
each selected plugin artifact separately. Plugin artifacts may come from different
commits of the official-plugin repository; an unrelated plugin/test change does not
force their rebuild. When integrating a changed plugin, build it and explicitly run
lock to select it.
core-sdk.json records the public SDK source revision, inventory, hashes and license.
Consumer copies in sdk/ (and plugins' public crates/) are generated dependencies,
not source to edit. A core-only change finishes with its own checks and commit.
When a later task explicitly integrates that core change:

1. Select the verified, committed core revision.
2. Run `node dev.mjs sdk sync app` and/or `node dev.mjs sdk sync plugins` explicitly.
3. Verify and commit affected plugin changes, then build affected component artifacts.
4. Run `node dev.mjs lock` to select those artifacts, then run the selected integration
   flow before committing the application combination.

Core exports must be clean. Component builds may capture local changes, marked in
retained receipts; run/verify require --local to select those overrides. Exact
assembly refuses dirty or off-lock core/plugin receipts. It records the actual
application source identity, including whether that checkout is dirty. It does not
claim atomic commits across repositories or rollback of scientific effects.

## Repository separation acceptance

This section describes the completed split's selected boundary checks and the
available composition flow. It does not require every new component task to repeat
the split or restore application compatibility.

Choose checks from concrete new responsibilities. Old whole-product counts, one
root workspace, private file layout and an exact historical package inventory are
not requirements. Retain useful tests, rewrite necessary behavior checks, and
retire implementation-shape assertions without compatibility scaffolding.

| Boundary | Meaningful evidence |
| --- | --- |
| Core | Builds without app/plugin source; empty startup and public transports work |
| Plugin | Builds with declared public dependencies; executes through a retained core |
| Application | Builds without Cargo; selects exact artifacts and serves its own assets |
| Composition | A real file changes once; duplicate/stale requests and restart preserve original identity/results |

The selected initial flow is Files (with its declared Annotations provider) through the core's public session protocol,
plus external application assets through HTTP. Run node scripts/test-composition.mjs
with already built artifacts. It uses disposable files/catalogs, never builds, and
checks empty core, path containment, a real patch, retry, stale-write refusal,
restart readback, external HTML/JS, asset refresh, asset containment and auth.
This does not establish real-R analysis, all-plugin compatibility or product-wide
acceptance. Those need separately selected relevant flows.

## Focused checks

For app changes: npm run build --prefix ui, npm run check --prefix ui, then relevant
npm run test --prefix ui tests. Browser wiring uses npm run test:browser --prefix ui
with the retained current core. No type-generation/Cargo prerequisite applies.
For Rust changes use cargo test -p CRATE FILTER --locked in the owner repository.
Core's node scripts/check-boundaries.mjs and plugins' node scripts/check.mjs inspect
actual source closure and the public dependency; these are not full-product suites.

Tests of real effects, caller/project isolation, native preconditions, idempotency
and recovery remain useful where affected. A fixture is not a real-R result, and
functional correctness is not visual approval. Removed tests are retired, not
passed. A selected requirement that fails or times out remains incomplete; preserve
its evidence. Do not add optional coverage while closing a settled milestone.

## Completion

Inspect the diff; commit coherent work in its owning repositories. Update Status
when behavior, evidence, focus or remaining work changes. Use Git for history.
Documentation edits need link and rendered-content review, not native builds.
Do not restart user Hosts, clear caches, install or publish as a side effect of
verification. Temporary acceptance data belongs in target/ or disposable folders;
acceptance runner source belongs in scripts/.
