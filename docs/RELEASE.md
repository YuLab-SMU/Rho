# Source publication and distribution

## Source publication

[Rho-core](https://github.com/YuLab-SMU/Rho-core),
[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) and
[Rho](https://github.com/YuLab-SMU/Rho) independently own their source and commits.
Rho selects and assembles the application. Its implementation and accepted
composition are pending.

Before publishing, inspect the actual remote URL, branch, selected commit,
authenticated account and write permission. Remote names do not identify the
intended owner. Keep credentials out of URLs and tracked files.

Routine Rho changes are checked, committed and published directly on organization
`main`. Use a `codex/` review branch only when a review workflow is explicitly
selected. Preserve existing commit and merge history, use an ordinary fast-forward
push and verify the remote head and tree. Do not force-push or delete `main`.
Component repositories retain their own development and publication rules.

Publish required components before an application reference to their immutable
identities. Record the source and artifact identities actually selected, explicit
local overrides and acceptance of that combination. A component check does not
prove application integration. Source publication, binary delivery, installation
and official release are separate outcomes.

## Official distribution

This is selected design, not an implemented pipeline. Create Rho-releases only
for an explicitly selected official signed-distribution milestone, with its target
platform, installation format and acceptance flow defined. Daily source development
continues in the three source repositories.

| Owner | Responsibility |
| --- | --- |
| Rho-core | Managed execution, public capabilities and component checks |
| Rho-plugins | Functional components, native semantics, artifacts and domain checks |
| Rho | Application composition, assembly and integration acceptance |
| Rho-releases | Candidate promotion, signing/notarization, official assets and installation/update channels |

Rho-releases consumes selected sources and artifacts. Product versions identify
accepted compositions; component versions need not match.

### Freeze the candidate

Before promotion, record the product version, selected source commits and public
dependency identities; each component's source revision, artifact digest and size;
target OS/architecture; packaging configuration; build toolchain and workflow
identity; and immutable candidate inventory. Include acceptance evidence and all
material unsupported, failed and unverified scope.

Resolve source references before building. Later stages must use those fixed
identities rather than follow mutable branches or tags. Source commits, unsigned
candidates and signed distributions retain separate identities.

### Promote without rebuilding

1. Build and test without signing keys or publication credentials. Retain the
   immutable candidate, digests and acceptance evidence.
2. The authorized release stage verifies that candidate and evidence, then signs,
   notarizes and packages it with trusted release tooling. It must not rebuild the
   application or run source build scripts with signing credentials. Record the
   input candidate and final signed/package digests separately.
3. Verify the final distribution on the selected platform, then publish assets,
   checksums and provenance. Advance installation/update channels only after the
   required assets are available and verified.

Control who can change release workflows, select candidates and access credentials.
Each stage receives only its required capabilities; repository separation alone
does not establish the credential boundary. Signing can change bytes, so candidate
and distribution digests are checked separately.

A source or build change creates a new candidate and requires relevant acceptance.
A publication retry uses the retained candidate and receipts; it does not silently
rebuild or replace them. Release authorization does not add an approval to a
scientific Agent request.

### Accept delivery

The first delivery milestone proves one traceable signed distribution on the
selected platform: fixed sources, accepted candidate, signing/notarization evidence,
final artifact verification, successful publication and installation acceptance.
Additional platforms, automatic updates and package-manager channels require their
own selected scope and checks.
