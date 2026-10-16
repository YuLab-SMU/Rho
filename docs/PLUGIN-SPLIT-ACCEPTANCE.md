# Independent plugin backend acceptance

Updated: 2026-10-16. This record covers the 0.3 package split. API 2.0,
`r.execute` 0.2.0, view contracts 0.2.0 and inert protocol fixtures retain their
meanings. No UI was implemented. Earlier [extraction](EXTRACTION-ACCEPTANCE.md)
and [v1 acceptance](BACKEND-ACCEPTANCE.md) remain historical evidence.

## Delivered boundary

[Eight independent capability packages](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/PLUGIN-PACKAGES.md)
own Documents, Files, R, Requirements, Tables, Media, Charts and Agent. Each has
its own manifest, version, compiled implementation, descriptor and optional
entries. No plugin imports another implementation; Rho injects typed ports.
Shared contracts contain schemas and ordinary-file primitives, with no capability
state/catalog or R/CSV/MCP dependency. The private source workspace rejects root
packing. Only Tables depends on csv-parse; only Agent depends on MCP SDK.
Examples and the Agent evaluator are outside the capability tarballs.

Rho selects finite reviewed packages and exact versions, publishes actual
availability, checks required services and wires the selected owners. CLI
`--plugins` controls activation; `pack:local --select-plugins` also controls which
packages are physically included. There is no automatic installation or arbitrary
module-path loading. Core's managed execution and public CLI remain unchanged.

## Source and component checks

- **13/13 Rho tests pass**, including actual HTTP/Core and stdio MCP, original
  identity across three SIGKILL delivery boundaries, v1/v2 contract fixtures,
  authentication/scope, drafts/undo, export/restore and resource budgets.
- **10/10 plugin tests pass**, covering existing documents, typed keys/nulls,
  joins, byte integrity, script snapshots, requirements and durable Agent intents,
  plus independent media/object/context owners and typed bytes without providers.
- **2/2 separate native example tests pass**, preserving singleton histogram and
  spaced Unicode script identity behavior.
- **8/8 isolated plugin installations/imports pass**. Each fresh consumer has
  contracts plus exactly one capability package. CSV and MCP dependencies follow
  only their owners; installed packages are ordinary directories, not symlinks.

The removal/reselection test executes an R script once, retains its Core identity,
draft/undo, typed table bytes, stable selection and scatter composition, then
selects only Documents/Files. Typed reads, chart data, Agent context and new R
submissions become unavailable; raw bytes and the identical accepted intent
remain readable. Export/restore preserves bytes and drafts while missing typed
selection remains explicit. Selecting no plugins still preserves metadata/save;
reselecting all permits typed reads and undo without another dispatch or Host.

An initial new test used the wrong client error property and a component fixture
omitted frozen code. Corrected fixtures pass; no execution outcome was changed.
The pre-existing scientific trial failures retain their original records.

## Installed composition

The [immutable 0.3 record](backend-acceptance/v0.3.0.json) freezes both actual npm
candidates, nine individual package hashes, source trees/build inputs, production
locks, selected example inputs and observed request/resource identities. Both use
committed inputs without a local override: Rho
`2bb6a8a028103bcf465bb80569f4d6f8e8be7f5d`, Plugins
`09b5c7f055ab65ed017cbdbd96abe64273739fb0` and unchanged Core
`d0159da6feb01d1be9e3b4b34b67953241fedfcb`.

| Actual candidate | Physical first-party packages | npm bytes / entries |
| --- | --- | --- |
| Full | Contracts plus all eight plugins | 6,249,545 / 3,790 |
| Reduced | Contracts, Documents and Files | 2,658,922 / 601 |

The full tarball SHA256 is
`e9ced10bc544d20f54ef3c8413c1fffcfdbaefcf303ba25c44fcb3a8da5df875`;
the reduced tarball SHA256 is
`81e16aa388bf03ead26e4adbd9a2709816eea693b7325837ce4ab0399b141aae`.
Both contain the same selected Core bytes. Shared plugin artifacts match exactly
across these candidates. They are unsigned local npm tarballs.

The full candidate was installed outside the source checkouts under a spaced
Chinese path. Bin startup without R, private credentials, bundled Core selection,
schema/fixture presence and ordinary installed plugin directories passed. The
same installed runner then passed:

- **Ordinary base-R project:** real linear model, four keyed rows, two-input
  comparison, PNG/PDF, exported object and project-owned coefficient checks.
- **Original paired project:** five DESeq2 fits, 16,139-row typed results and
  33 baseline artifacts; 121/121 saved-model observations and 12/12 arithmetic
  checks; explicit apeglm/dependency preparation, shrinkage with original Wald
  tests unchanged and a two-input comparison. This bounded trial uses one
  simulation and does not replace the earlier 200-simulation evidence.
- **Recovery:** four computed partial rows survive owned Host loss with the
  original request/native identity and unknown outcome. Observation closure does
  not cancel work. Partial export/restore starts no Host or replacement run;
  separate explicit cancellation confirms native process-group release.

The reduced candidate was installed in another fresh process. Only Contracts,
Documents and Files are physically present; csv-parse and the MCP SDK are absent.
The other six selected defaults honestly report missing packages as unavailable.
Unicode draft editing, export and bounded project observations work without R
or Host startup. It also exercises the actual compiled application with absent
optional implementations, beyond activation-only source tests.

An initial application pack check rejected upstream MCP SDK `examples` paths.
The corrected predicate excludes first-party recipes while allowing the unchanged
third-party dependency distribution. That failed candidate remains unaccepted;
the two hashes above identify the successful checks and installations.

Documentation links/anchors and all changed rendered pages were checked. The
final evidence/status batch was rendered again after recording these results.
Registry publication, signing, other platforms, live R variables and all browser
behavior remain outside this scope. Later documentation commits do not rebuild
or replace these accepted candidates.
