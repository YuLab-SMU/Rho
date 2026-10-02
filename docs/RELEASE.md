# Source publication and local composition

## Source repositories

The public source repositories are YuLab-SMU/Rho-core, YuLab-SMU/Rho-plugins and
the existing YuLab-SMU/Rho. Core and plugins are published on main; the application
split is submitted on codex/split-repositories for review into main.

Publish the committed core and plugins before updating the application, so its
SDK provenance and rho.lock.json revisions can be resolved remotely. The component
repositories' independent histories begin at the split; the original monorepo
history stays in Rho. Push the selected branches without mirror or force pushes.

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
source lock does not fetch unavailable artifacts or authenticate a publisher;
source publication does not publish the locally assembled binaries and archives.

Native validation remains Apple Silicon macOS. Other platform sources are not a
new distribution commitment. Historical native Preview launchers and old bundle
assemblers are retired from this source tree; Git retains them. New signing,
notarization, installer, licensing audit, installation and publication work requires
its own requested scope. Do not describe local component builds as those outcomes.

## Future official release boundary

This is an agreed design for the first official signed distribution, not an
implemented pipeline or a request to create another repository now. The current
three source repositories remain the daily development structure. Introduce
Rho-releases with that distribution milestone, once its target platform, installation
format and required acceptance flow are selected.

| Owner | Release responsibility |
| --- | --- |
| Rho-core | Core implementation, public protocol/SDK and declared compatibility |
| Rho-plugins | Scientific implementations, independently versioned plugin packages and owner checks |
| Rho | Application source, product component selection, assembly and integration evidence |
| Future Rho-releases | Release manifests and workflows, signing/notarization, official assets, checksums and installation/update channels |

The release repository consumes selected source and artifacts. It does not mirror
production source or replace the application development entry. It provides a stable
distribution endpoint for official binaries and, when implemented, automatic updates
and a Homebrew tap. A product release number names one accepted composition; core
and plugins do not need matching version numbers or synchronized tags.

### Fixed release composition

Before promotion, freeze a release manifest containing:

- The product version, application and core commit SHAs, and public SDK identities.
- Each selected plugin's identity, source revision, artifact digest and size.
- Target OS/architecture, packaging configuration and the build toolchain/workflow
  identity needed to trace how the candidate was produced.
- The candidate artifact inventory and the acceptance results for that exact
  composition, including any unsupported or unverified scope.

Resolve source references once before building; do not independently follow main
or a mutable tag during later jobs. rho.lock.json, composition.json and build
receipts provide starting evidence, but do not yet constitute a signed-release
manifest. Source commits, built candidates and published releases remain distinct.

### Promotion and credentials

1. Build and test a candidate without signing keys or publication credentials.
   Retain its immutable artifacts, digests and applicable acceptance evidence.
2. An explicitly authorized release stage verifies that candidate and its evidence,
   then signs, notarizes and packages it using trusted release tooling. This stage
   must not execute source build scripts with signing credentials or rebuild the
   application. Record the input candidate and resulting signed/package digests;
   signing changes bytes, so their identities must remain distinguishable.
3. Verify the resulting signed distribution on the selected target platform, then
   publish its assets, checksums and provenance. Advance installation/update
   channels only after the required release assets are available and verified.

Control who can change release workflows, select a candidate and access signing
or publication credentials. A separate repository is one part of that boundary;
placing build and signing in the same privileged job would defeat the intended
separation. Release jobs need only the capabilities required for their stage.

A source or build change produces a new candidate and needs relevant acceptance
before promotion. A failed publication retains its receipts and selected artifacts;
retrying delivery must not silently rebuild or replace that candidate. Software
release authorization is separate from Rho's scientific caller authorization and
does not introduce another approval decision for Agent-authorized Operations.

The first implementation milestone is one traceable signed delivery on the chosen
platform: source selection, accepted candidate, signing/notarization evidence,
final artifact verification and successful publication. Multi-platform delivery,
automatic updates and Homebrew are subsequent scopes unless explicitly included
in that milestone. This document establishes their ownership without claiming
those capabilities are available now.
