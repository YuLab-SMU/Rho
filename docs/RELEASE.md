# Exact local composition

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
