# Source publication and future distribution

## Source repositories

The source owners are [Rho-core](https://github.com/YuLab-SMU/Rho-core),
[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) and
[Rho](https://github.com/YuLab-SMU/Rho). Each owns its implementation and commits.
Rho owns application selection, assembly and presentation. Its new implementation
is pending; this source replacement supplies design and policies, not a built product.

Before publishing, inspect the actual remote URL, branch, selected commit and
account permissions. In the current local checkout `origin` is a personal fork
and `upstream` is the organization repository. Use the actual selected destination;
never infer it from a remote name. Keep credentials out of URLs and tracked files.

Publish and verify complete required archives before removing old controlled assets.
The [old application baseline](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-rebuild)
and [complete pre-clear tree](https://github.com/YuLab-SMU/Rho/tree/codex/legacy-app-before-main-reset)
are published, including the latter's updated historical documents. Ignored local
runtime, evidence and user data remain outside source publication.

Carry forward the user's existing source-publication authorization. Rho organization
`main` requires a PR, Code Owner review and approval of the latest push. Publish the
selected work on a `codex/` review branch and preserve its commit identities with a
merge commit. Do not force, bypass review, squash or rebase the selected history.
Verify the resulting remote head and tree; a pushed review branch is not a merged main.

Publish required components before an application change references their fixed
identities. Source selection, artifact identity and acceptance are distinct evidence.
The old SDK snapshots, `rho.lock.json`, development scripts and assembly commands
are archived. There is no replacement lock or assembly tooling yet; historical
composition receipts do not establish integration with the new Core.
Source publication does not publish binaries, install components or create a release.

## Future official release boundary

This remains agreed design, not an implemented pipeline or a request to create
another repository. Keep the three-source-repository daily development structure.
Introduce Rho-releases only at the first explicitly selected official signed
release milestone, with target platform, installation format and acceptance chosen.

| Owner | Release responsibility |
| --- | --- |
| Rho-core | Generic execution, supported public capabilities and declared compatibility |
| Rho-plugins | Domain implementations, selected independently versioned artifacts and owner checks |
| Rho | Application source, component selection, assembly and real integration evidence |
| Future Rho-releases | Promotion manifests/workflows, signing/notarization, official assets, checksums and installation/update channels |

The release repository consumes selected source and artifacts. It is not another
source mirror or daily development coordinator. Product versions identify accepted
compositions; component versions and tags need not match. Automatic updates and
Homebrew remain later scopes unless explicitly selected.

### Fixed release composition

Freeze a manifest before promotion, containing:

- Product version, application/Core source commits and any selected public dependency identities.
- Each selected plugin's identity, source revision, artifact digest and size.
- Target OS/architecture, packaging configuration and build toolchain/workflow identity.
- Immutable candidate artifact inventory and acceptance evidence for that exact
  combination, including unsupported, failed and unverified scope.

Resolve source references once before building. Later jobs must not follow floating
main or mutable tags. Source commits, built candidates and published releases have
separate identities. Any future source lock and build receipts provide evidence;
they do not themselves form a signed release or prove scientific acceptance.

### Promotion and credentials

1. Build and test a candidate without signing keys or publication credentials.
   Retain immutable artifacts, digests and applicable acceptance evidence.
2. An explicitly authorized release stage verifies that candidate and evidence,
   then signs, notarizes and packages it with trusted release tooling. It must not
   rebuild the application or execute source build scripts with signing credentials.
   Record the input candidate and resulting signed/package digests separately.
3. Verify the signed distribution on the selected target platform, then publish
   assets, checksums and provenance. Advance installation/update channels only
   after required assets are available and verified.

Control who can change release workflows, select candidates and access credentials.
Separate repositories alone do not establish this boundary; combining builds and
signing in one privileged job would undermine it. Each stage gets only its needed
capabilities. Signing changes bytes, so unsigned and signed identities stay distinct.

A source/build change creates a new candidate and needs relevant acceptance before
promotion. Failed publication retains selected artifacts and receipts; a delivery
retry must not silently rebuild or replace them. Release authorization does not
introduce another approval decision for scientific Agent requests.

The first implementation milestone is one traceable signed delivery on its selected
platform: fixed sources, accepted candidate, signing/notarization evidence, final
artifact verification and successful publication. Multi-platform delivery, automatic
updates and Homebrew are separate later scopes unless included explicitly.
