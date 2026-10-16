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

The full and reduced application candidates are verified separately from source
checks. Their identities and installed-consumer results are recorded below after
the actual installation checks complete. Registry publication, signing, other
platforms, live R variables and all browser behavior remain outside this scope.
