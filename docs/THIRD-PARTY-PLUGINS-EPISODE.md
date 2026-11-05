# Third-party packages and the sclet consumer

Observed on 2026-11-05, macOS arm64, Node 22.22.3, Chrome, R 4.5.2. The task was
to make sclet independently installable and provide the development, installation
and management channel another author could use. This is source work after npm
0.5.4. No npm release, signed distribution or independent usability claim follows.

## First gap and owner change

The existing `rho-ui` path compiled React entries into an application build;
Plugins described the selected first-party components. Running
`node dist/cli.js plugin --help` failed with an unexpected positional argument.
There was no runtime package installer or management UI. The installed DeepSeek
Harness 0.2.1-rc.5 plugin manager supplied a useful comparison: independent
packages, visible source/version, enable/update/remove, and an optional directory.

Rho now owns package admission, immutable runtime trees, enabled selection,
generic `extension.*` operations and an opaque-origin view bridge. A package
declares its own operation schemas, Skill and prebuilt HTML; Rho does not compile
its domain code. CLI scaffolding and `dev` install valid snapshots. The optional
directory records checked public sources without making registration mandatory.

The sclet adapter is an independently packed consumer in
`Rho-plugins/examples/sclet-plugin`, outside the base catalog and dependencies.
It uses public Notebook operations and sclet's public R functions. Rho-core and
sclet's source were not modified. The old sclet proposal is not a replacement
architecture for this implementation.

## Real scientific episode

The selected sclet source was 1.1.0 at
`3e03720fea17ee30bb598cce3bc94dc0c728fc44`. The user's ordinary library did not
contain sclet. A separate temporary library received sclet and its missing
dependencies; no user's running R session was restarted.

1. The installed plugin's sessions read returned no sessions and started none.
   An explicit package check started the disposable project's R session and
   printed `sclet MISSING`, alongside SingleCellExperiment 1.32.0/jsonlite 2.0.0.
2. The same R session selected the temporary library and created a seeded
   200-gene, 60-cell SCE. Reading its ledger and action registry used sclet's
   public APIs; no assay matrix entered Rho metadata.
3. A four-action plan used that ledger fingerprint. Validation succeeded.
   Normalization, 50-variable-feature selection, scaling and five-component PCA
   completed, returning the updated `sce`. Notebook retained the original cell.
4. The first report attempt failed: `ExecuteAIPlan` records execution, while
   `RenderAIReport` needs a recorded AI result. The adapter gained a `record`
   operation using `RecordAIResult` with claim auditing enabled. A synthetic-input
   interpretation with no biological findings/citations was recorded. Its report
   showed the four execution steps and passed the native citation/claim self-check.
5. A report read without an id could still find no active result. The UI now has
   an explicit Report ID and carries a newly recorded result's id into it.
6. Validation using the pre-analysis fingerprint returned `valid: false`.
   The adapter did not replace the fingerprint or rerun the analysis automatically.

The report's pass says its cited/recorded assertions are internally consistent;
with no biological findings it proves no biological hypothesis. Execution status,
success assessment, evidence checks and scientific interpretation stay separate.
The shared object showed `counts`, `logcounts`, `scaled`, 50 HVGs and PCA.

The opt-in reproducible check is:

```sh
RHO_SCLET_LIBRARY=/absolute/existing/R-library npm run acceptance:third-party
```

It uses an owned disposable service/project, never installs R packages, checks
the analysis and stale-plan failure, and verifies that disable/remove preserve
the original acknowledged cell and live R session. `RHO_SCLET_PLUGIN` selects
another package source; `RHO_RSCRIPT` selects Rscript. The result is written under
`output/third-party-plugins/acceptance.json` by default.

## Package and browser results

Focused regressions exercised disabled lifecycle hooks, invalid/stale updates,
tampered runtime bytes, concurrent same-identity calls, crash and restart with
unknown outcomes, caller-scoped receipts and cross-project delegation refusal.
The default Agent grant stayed within its existing limit and could discover/call
installed plugins without receiving installation or management methods.

In Chrome at 1440 and 390 pixels, the sclet view read the real session, ledger and
recorded report. A missing R variable produced the original error, then selecting
`sce` recovered. Disable blocked Open; enable reopened the same native session.
Screenshots were inspected: controls wrapped, source paths stayed inside cards,
and the report remained scrollable without horizontal overflow. Call status was
moved above the controls so narrow layouts expose progress without scrolling to
the bottom. Native session inspection was reduced to session summaries rather
than repeatedly returning recent analysis output.

A second consumer was generated with `rho plugin create`. `dev` installed it and
then changed its runtime digest after a source edit from Hello to Welcome, without
rebuilding Rho. Its form initially received no submit event because the shared
HTML frame disallowed forms. A plugin-specific frame now permits form events,
while CSP still prohibits form navigation/network submission; the ordinary HTML
viewer is unchanged. The generated view returned `Welcome, 小夏!` through its
host, preserving Unicode. A missing installation source failed visibly while
both installed packages remained. Remove and reinstall succeeded through the UI.

The developer loop, native failure/recovery and lifecycle paths were observed;
these are not observations of an independent developer or researcher using them.
Runtime views currently open on Plugins, not in Studio's resource binding model.

## Checked source and package

The sclet adapter was published on Rho-plugins `main` at
`82df99f8cbab868c30949692172c6cf11db2f5c0`. The directory selects that exact Git
commit. A fresh public Git install produced runtime-tree digest
`a9055d5b14b0718158dc63656906ecbf88d1d5d486a2c760f7dfd4b0321f867e`, identical to
the independently packed 0.1.0 tarball that passed the real scientific check.
The tarball is 20,273 bytes and includes its AGPL license. Rho's existing base
component pins do not change; the optional package has its own selection.

`npm run build`, `npm run check:contracts`, eleven focused contract, access,
Notebook and extension regressions, and `npm run docs:build` passed. The opt-in
scientific acceptance passed from source and from the packed artifact. Changed
Markdown links/anchors and rendered pages were checked. Native/browser evidence
and the machine-readable acceptance outputs are separate from source publication.

## Retained boundaries

Native code remains trusted code with the user's OS authority. The child process
handles crashes/timeouts; it is not an OS sandbox. Only declared Rho methods can
cross the bridge, using the original principal/project and current native
conditions. The iframe receives no service token, origin/storage access or network
loading. Listing/content reads do not start plugin code or a scientific runtime.

Non-read invocations preserve original request identities and delegated native
requests/replies. A crash, output limit or lost acknowledgement can leave an
unknown outcome; observing it never re-executes. Disable/remove do not cancel
native work. Retained package revisions and receipts have explicit refusal limits,
documented in the [author guide](THIRD-PARTY-PLUGINS.md#resource-limits-and-current-scope).

Windows/Linux runtime installation, registry publication of the sclet adapter,
automatic R environment provisioning, plugin signatures, Studio docking and a
remote marketplace are outside the observed result. Public-source installation
selects source identity; it is separate from npm/binary delivery.
