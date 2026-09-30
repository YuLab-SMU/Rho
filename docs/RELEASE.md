# Build and release

The first user-facing preview targets the user's current environment only:
**Apple Silicon (arm64), macOS 26.5.2 (25F84)**. This is the local validation
baseline, not a claim of compatibility with older macOS versions. Installation,
launch, existing R/Ark discovery, recovery-component preparation and Rho model
configuration should be completed for that one environment before expanding the
release scope. Linux, Windows and Intel Mac distribution are outside this preview.
Existing platform-specific source and development helpers do not create a current
distribution commitment.

The development delivery consists of the `rho` core and sixteen ordinary plugin
archives, assembled as the portable bundle below. The core alone starts an empty
workbench; it neither embeds feature packages nor reinstalls removed ones. To build
the CLI/local-browser core executable:

```sh
cargo build --release --locked
```

The output is `target/release/rho` for macOS arm64, including embedded
HTML, CSS and JavaScript. R and Ark are external runtimes; the binary does not
bundle their installations. Build frontend changes first using
[Development](DEVELOPMENT.md).

`.github/workflows/rho.yml` defines macOS arm64 native source/transport checks for
pushes and pull requests. No active workflow starts Linux or Windows jobs.
`.github/workflows/build-rho.yml` is a manually triggered macOS arm64 binary build
that uploads an artifact. Both macOS 26 jobs verify the native architecture;
this does not establish that the runner has the same patch version as the local
baseline. Neither a workflow definition nor an older successful run proves that
the current commit passed remote CI.

The current path does not produce a signed/notarized installer or automatic updater.
For a requested distribution, report the exact source commit, artifact paths, sizes,
hashes, signatures actually present and checks that ran. Build, signing, installation
and publication are separate outcomes. Do not install or publish automatically.

## Ordinary plugin delivery sets

`scripts/plugin-set.mjs` assembles **already built** source/artifact directories
through the existing CLI's snapshot, export and validation commands. It never
compiles, activates an instance, starts R or changes a scenario. The output holds
ordinary `.rho-plugin` archives, a bounded `plugin-set.json` index with exact
revisions/artifacts/byte sizes/SHA-256 hashes, and the standalone Node utility.
The assembler's CLI hash is recorded; it is not a signature or a claim that the
CLI was rebuilt from the same checkout as each independent plugin revision.

The input JSON has `name`, `profile` and `packages`. Each package supplies a
`directory` (relative to the input file or absolute) and `target` (`ui-web` for a
UI-only package, `aarch64-apple-darwin` for the current native target).
`profile: "rho-default"` requires exactly Agent, Annotations, Console, Editor,
Environment, Files, Help, Manager, Objects, Packages, Plots, Process, R, Remote,
Studio and Viewer. `profile: "custom"` supports selected revisions, including two
versions of one plugin. These are assembly checks, not runtime privileges.

```sh
node scripts/plugin-set.mjs pack --rho /absolute/rho --input /absolute/packages.json --out /absolute/new-set
node /absolute/new-set/plugin-set.mjs verify --rho /absolute/rho --set /absolute/new-set
# Installation is an explicit, separate operator action:
node /absolute/new-set/plugin-set.mjs install --rho /absolute/rho --set /absolute/new-set --database /absolute/catalog/host.sqlite
```

Installation pins and validates all archive bytes before the first destination
import, then uses the normal repository beside the selected database. It does not
grant capabilities or create running instances. An interrupted import reports
acknowledged revisions and the attempted revision with an unknown outcome; it
does not claim transactional rollback or that a lost reply means nothing changed. An
explicit retry is idempotent. No startup hook invokes this installer, and removed
plugins stay removed until another explicit import. Treat the source packages and
utility as trusted local code; checksums do not authenticate their publisher.

`node scripts/test-plugin-set.mjs` exercises real CLI archive validation,
preflight failures, coexisting revisions, import/remove/reimport and an empty
generic Host startup using a disposable repository and retained binary. Set
`RHO_TEST_BINARY` and `RHO_PLUGIN_SET_EVIDENCE` to select the binary and report.
Set `RHO_PLUGIN_SET_PACKAGE` to additionally verify an assembled default set's
sixteen actual archives: import, remove all, start the empty Host, and explicitly
restore identical source/capability/permission declarations and artifacts.
This does not establish signing, complete default scenario integration, final
fixed-composition removal or a user installation; see Status for actual evidence.

Documentation or test-only source updates need no native rebuild. Materialize the
accepted archive's source and artifact files into a new owned directory, preserving
their bytes and executable modes, then replace only the reviewed source files.
Use ordinary `plugins snapshot`, `export` and `validate` to create the new revision;
do not edit archive identities or build receipts. Compare every other source entry,
the manifest, and every runtime file's digest, size and mode against the accepted
archive before assembling the set. Revision/artifact identities change even when
all runtime bytes remain identical. Preserve the independent package's dependency
layout and lockfiles. Runtime, dependency, manifest or build-script changes instead
require their affected build and acceptance checks. Keep the prior archive and
record the changed source paths, old/new identities and reused artifact digests.

## Portable local development bundle

The current visual-runtime/annotation milestone refresh is reproducible with
`scripts/refresh-development-bundle.mjs --previous OLD_BUNDLE --rho CURRENT_CORE
--out NEW_BUNDLE --evidence REPORT_JSON`. It serially assembles the thirteen
affected packages, guards the unchanged native dependency closure, and copies
Environment/Process/Remote archives byte-for-byte. It records build times and
old/new revision, artifact, size and digest identities, validates all archives,
and preserves failed staging directories. Build the current core first; this
runner never installs into a user catalog or silently rebuilds the core.

For imported runtime acceptance, `visual-studio.spec.ts` accepts
`RHO_STUDIO_PLUGIN_ARCHIVE`; it and `visual-science.spec.ts` accept
`RHO_TEST_BINARY`. Set `RHO_FILES_PLUGIN_ARCHIVE` for the Files provider,
`RHO_ANNOTATION_PLUGIN_ARCHIVE` for its declared saved contract, and
`RHO_VISUAL_SDK_ARCHIVE` to the delivered Studio archive so both examples use its
actual compiled SDK bytes. These flows cover the definition editor, built/applied
views and real Files original-operation recovery. Archive validation alone does
not establish these behaviors.

To reuse a retained macOS arm64 core and a settled default plugin set, assemble a
new directory without running Cargo, frontend builds or independent plugin builds:

```sh
node scripts/build-rho-bundle.mjs --rho /absolute/retained/rho --set /absolute/plugin-set --out /absolute/new-bundle
```

The assembler refuses an existing destination and checks the core's architecture
and system-only dynamic libraries, then validates the sixteen ordinary archives.
The directory contains the core, archives, standalone import utilities, getting
started instructions and license summaries. `rho-bundle.json` records every
payload's size/hash and executable flag. Its assembly checkout is distinct from
core provenance: the retained core's source commit is explicitly unknown. This is
an internal development artifact, not a public release provenance/licensing audit;
`LICENSES.md` is not a complete redistribution notice bundle.

Move the whole directory, then use an existing Node.js 22+ for verification/import:

```sh
node /absolute/bundle/rho-bundle.mjs verify
node /absolute/bundle/rho-bundle.mjs install --database /absolute/state/rho.sqlite
/absolute/bundle/rho --database /absolute/state/rho.sqlite workbench
```

Verification pins and hashes all payloads, rejects symlinks and escaping names,
and runs ordinary archive validation using the copied core. Import requires an
explicit absolute database path; launch must use the same database. Daily launch
needs no Node or installer. R and Ark remain separately configured existing
runtimes. Assembly does not sign, notarize, install on the user's system or publish.
Checksums detect changed files, not trusted publishers; these utilities and native
plugins are trusted local code.

`RHO_PLUGIN_SET_PACKAGE=/absolute/set node scripts/test-rho-bundle.mjs` exercises
relocation to a path with spaces/Unicode, preflight failures before destination
writes, explicit import/retry, complete removal, empty default Host startup and
explicit restoration. It uses a disposable catalog and retained core, and never
builds missing inputs. `RHO_TEST_BINARY` selects that core;
`RHO_BUNDLE_EVIDENCE` selects the results file. The original default scenario's
browser/scientific checks remain separate evidence.

See [current validation scope](STATUS.md), [artifact trust](../CODE_SIGNING_POLICY.md),
[license](../LICENSE), [third-party notices](../LICENSES.md) and
[security reporting](../SECURITY.md).
