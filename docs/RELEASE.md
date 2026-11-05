# Source publication and distribution

## Source publication

[Rho-core](https://github.com/YuLab-SMU/Rho-core),
[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins) and
[Rho](https://github.com/YuLab-SMU/Rho) independently own their source and commits.
Rho selects and assembles the application. A versioned backend and local npm
assembly are implemented; [backend acceptance](BACKEND-ACCEPTANCE.md) records the
selected headless composition separately from the pending browser product.

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

## First npm delivery

The first product delivery uses an npm package and local WebUI. The backend
assembly uses `@rho-workspace/local` 0.1.0 and bundles the exact selected Core
binary, Plugins package and production dependencies. From 0.5.2 the Agent clients
are not among them: conversations drive the person's installed Claude Code or Codex,
and the adapters' optional platform binaries are left out. The packer emits immutable
source/tree, input, lock and artifact digests; installed acceptance runs outside
the source checkouts. See [assembly instructions](HEADLESS.md#budgets-verification-and-assembly)
and [accepted scope](BACKEND-ACCEPTANCE.md).

This delivery is an unsigned local tarball, on macOS arm64 until 0.5.2 and since then also on
Linux x64 and arm64, with external Node and Python prerequisites; R is needed only for R execution. Browser assets, npm registry namespace/channel rights,
other platforms and full product installation are not accepted by a headless run.
No registry publication or signing is performed. npm publication would not itself
establish a signed desktop distribution or require creating Rho-releases.

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

The first official signed-distribution milestone proves one traceable signed
distribution on the selected platform: fixed sources, accepted candidate,
signing/notarization evidence,
final artifact verification, successful publication and installation acceptance.
Additional platforms, automatic updates and package-manager channels require their
own selected scope and checks.


## Version 0.5.1 preview

The selected scope is an unsigned npm tarball with local WebUI on macOS arm64,
including an explicitly selected, digest-checked Core. Native Agent work also
starts without Core. A wrong platform or changed bundled binary is refused rather
than replaced or downloaded. Windows/Linux folder picking, POSIX locking,
executable discovery and installation remain portability work; component support
is not application support.

Install into a new directory with Node 22.22.x and Python 3 available. Claude Code
or Codex and its configured provider are prerequisites for conversations; base R
is needed for the R episodes. Rho does not install Agent credentials or silently
replace runtimes. The [accepted preview](PREVIEW-0.5.1.md) records the fixed artifact, checksums,
component inventory and outside-checkout checks.
The [review episode](REVIEW-EVIDENCE-EPISODE.md) describes capability evidence and
separate offline-reader acceptance. No public npm, signing or Rho-releases action
is included. Independent researcher observation remains a separate follow-up.

## Version 0.5.2 candidate

The form is still an unsigned npm tarball with a local WebUI, explicitly selected
digest-checked Cores, and an installation that downloads nothing. One tarball now serves
macOS arm64, Linux x64 and Linux arm64: it carries one Core per platform from one Core commit,
Linux's statically linked, and startup selects this machine's
([platforms episode](PLATFORMS-0.5.2-EPISODE.md)). The current candidate is 16,854,000 bytes. The Agent clients
are no longer in it. Conversations and the external relay drive the person's installed
Claude Code or Codex (`--claude`/`--codex`, `RHO_CLAUDE`/`RHO_CODEX`, else `PATH`). A
missing client is named, not replaced. Rho pins the ACP adapters; the client versions are
the person's. The tarball fell from 274,921,791 to 12,753,572 bytes. The packer writes
`SHA256SUMS` beside the tarball and its composition.

```sh
shasum -a 256 -c SHA256SUMS            # Linux: sha256sum -c SHA256SUMS
npm install --prefix "$HOME/rho-0.5.2" --omit=dev --ignore-scripts /absolute/rho-workspace-local-0.5.2.tgz
"$HOME/rho-0.5.2/node_modules/.bin/rho" --root "$HOME/rho-projects" --state-dir "$HOME/.rho-0.5.2" --open
```

The [packing episode](PACKAGE-0.5.2-EPISODE.md) records leaving out the Agent clients, real
Claude and Codex conversations and open items; the [platforms episode](PLATFORMS-0.5.2-EPISODE.md)
records the current candidate's installation on macOS, Debian 12 arm64, Ubuntu 25.04 x64 and
Rocky 8 x64. Linux Agent conversations and real x86_64 hardware are unverified. A Windows x64
candidate from the same Core commit is packed and installed separately
([Windows episode](WINDOWS-0.5.2-EPISODE.md)). On Windows, in PowerShell:

```powershell
Get-FileHash rho-workspace-local-0.5.2.tgz -Algorithm SHA256   # compare with SHA256SUMS
npm install --prefix "$HOME\rho-0.5.2" --omit=dev --ignore-scripts C:\absolute\rho-workspace-local-0.5.2.tgz
& "$HOME\rho-0.5.2\node_modules\.bin\rho.cmd" --root "$HOME\rho-projects" --state-dir "$HOME\.rho-0.5.2" --open
```

These 0.5.2 candidates have not had the full 0.5.1 acceptance. No registry publication, GitHub
release or signing was performed. CI now packs one tarball for all four platforms, below.

## CI and npm publication

[`ci.yml`](../.github/workflows/ci.yml) runs on each push to `main` and pull request that changes
more than documentation; the pages the package ships and the Status and ledger a test reads count.
`components.json` selects the Core and Plugins commits. CI builds the four Cores from that Core
commit (macOS arm64; static musl Linux x64 and arm64; MSVC Windows x64), reusing a Core commit it
has already built, runs Rho's suite on macOS
arm64, Linux x64 and Windows x64, and packs one candidate with all four Cores. Each of the four
platforms installs it offline with an empty npm cache and runs `scripts/ci-install-check.mjs`: the
launcher with its own Core and the shipped project, then the packaged recovery and ordinary-project
acceptances. The composition names the run that packed it. What the first runs found is in the
[CI episode](CI-EPISODE.md).

The package is `@rho-workspace/rho`; the source checkout stays private and the staged package is
public. A `v*` tag naming the version in `package.json` runs
[`release.yml`](../.github/workflows/release.yml). It takes the candidate of the successful CI run on
`main` for the tagged commit and builds nothing; only when no such run kept its candidate (a
documentation-only commit, or past GitHub's artifact retention) does it run CI first.
[`release-check.mjs`](../scripts/release-check.mjs) verifies the digest, that run and commit, the four
installation reports, the name and the tag's version. Then `npm publish --provenance` runs with the
repository secret `NPM_TOKEN`,
which no other job names and GitHub does not give to pull requests from forks. A prerelease version
goes to the `next` dist-tag, any other to `latest`; npm makes a package's first version `latest`
whatever the tag. The job runs in the GitHub environment `npm`, which records each publication as a
deployment; it has no required reviewer, so a tag whose run passes publishes without waiting for a
person. Run by hand on `main`, the release rehearses everything but the publication. The npm
organization `rho-workspace` and a token that can publish there without a one-time password must
exist before the first tag. `@rho-workspace/rho@0.5.2` and `0.5.3` were published this way on
2026-11-02, and `0.5.4` on 2026-11-05, with provenance ([CI episode](CI-EPISODE.md#publication)).
Since July 2026 npm scans a version before serving it, so a release is installable only when the
registry serves it: 0.5.4 appeared 55 minutes after `npm publish` returned.
