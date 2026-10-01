# Source publication and local composition

## Source repositories

The source publication targets are YuLab-SMU/Rho-core, YuLab-SMU/Rho-plugins and
the existing YuLab-SMU/Rho. The new repositories are prepared locally; creation
and first pushes are pending. Use public visibility to match the existing project.

Publish the committed core and plugins before updating the application, so its
SDK provenance and rho.lock.json revisions can be resolved remotely. Create the
two empty repositories without generated README, license or initial commit, then
push only their main branches. Their independent histories begin at the split;
the original monorepo history stays in Rho. Do not use mirror or force pushes.

Submit the application on codex/split-repositories to YuLab-SMU/Rho and open a
pull request into main. Include the unpublished ancestor commits, repository
ownership changes, selected verification and its limits. The old xiayh17/Rho
origin is a personal fork; use upstream explicitly for the organization submission.
Publishing source is separate from merging that pull request or creating a release.

Use an existing GitHub account with the required organization permissions; do not
store credentials in Git URLs or tracked files. Verify each remote branch head
against the local commit after its push. An API read or push dry run establishes
preparation, not repository creation or publication.

## Exact local composition

The repository split currently provides local development assembly, not a signed
installer or a published release. Core, official plugins and application have
independent source commits. Source identity and built artifact identity are separate.

```sh
node dev.mjs lock
node dev.mjs build core
node dev.mjs build app
node dev.mjs build plugin files
node dev.mjs build plugin annotations
node dev.mjs build plugin r
node dev.mjs lock
node dev.mjs verify
node dev.mjs assemble /absolute/new/composition annotations files r
```

Locking requires clean committed component sources and explicitly refreshed SDK
snapshots. Build receipts record exact source identities and artifact digests. Each plugin
artifact is pinned independently; packages built at different plugin-repository
commits may coexist without rebuilding unchanged packages.
Assembly verifies those receipts and the application's asset inputs, refuses
changed/off-lock component artifacts, and writes a new directory. It never rebuilds,
activates or installs a component. Choose plugin names explicitly; there is no
hardcoded historical sixteen-package acceptance gate.

composition.json records core and plugin identity, application source identity,
exact payload hashes, sizes and executable modes. plugin-set.json records source
revision/artifact identities for each immutable archive. The assembled assets
remain separate from the core binary. Preserve these files with their artifacts.

The assembly can contain a subset of official plugins. Completeness and behavior
are established only by the flows actually run against that combination. A plugin
repository commit does not imply every package was rebuilt or accepted. A local
source lock does not fetch unavailable remote repositories or authenticate a
publisher; no new remote repositories have been published by this split.

Native validation remains Apple Silicon macOS. Other platform sources are not a
new distribution commitment. Historical native Preview launchers and old bundle
assemblers are retired from this source tree; Git retains them. New signing,
notarization, installer, licensing audit, installation and publication work requires
its own requested scope. Do not describe local component builds as those outcomes.
