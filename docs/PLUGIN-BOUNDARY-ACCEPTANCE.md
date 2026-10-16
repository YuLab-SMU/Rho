# Plugin boundary review 0.4

The follow-up review found three cross-owner dependencies and removed them:
central format schemas in Contracts, execution availability applied to all R
entries, and an R script budget borrowed from Documents. The eight capability
packages remain independent. Backend and headless scope only; renderers are
unimplemented.

## Responsibilities and required ports

| Owner | Responsibility | Required provider |
| --- | --- | --- |
| Documents | Shared buffer, Unicode edits, undo, disk conditions and snapshots | None |
| Files | Immutable bytes, scope/digests, inventory and restoration | None; typed validators injected |
| R | Frozen script/argument plan and exported JSON objects | Files; Requirements only for execution, Documents only for buffer input |
| Requirements | Explicit R package probe and preparation plan | Selected native Rscript; application dispatches preparation |
| Tables | Declared types/nulls, keys, pages and two-input joins | Files root/read/resolve/register ports |
| Media | Original image/PDF metadata and coordinate bounds | Files resolve only |
| Charts | Numeric fields, entity identities, sampling and binding checks | TableReader only |
| Agent | Scoped MCP, original caller intent, explicit context and receipts | Only sources used by that context |

No capability imports a sibling implementation. Tables alone installs csv-parse;
Agent alone installs the MCP SDK. Reading retained resources starts no R or Host.

## Contracts stays generic

Contracts exports only its root entry: generic references/envelopes, service
interfaces, faults, hashing, contained paths and ordinary-file primitives. Its
runtime exports are fixed by an architecture test and it has no runtime npm
dependency. It owns no parser, format registry, package requirement schema,
language environment, native plan or document budget.

Files, Tables, Media, Requirements and R export pure `./contract` entries. Each
owns its format/requirement/script schema. R's execution-input factory accepts
foreign schemas from the consumer. Normalized reader ports describe observed
values without owning CSV encoding or native state. Document digest checks moved
back into Documents. Reader signatures now accept the methods they actually use.

Rho retains the selected v2 wire vocabulary locally, with parity tests against
provider contracts. That compatibility snapshot describes the API when optional
packages are physically absent; it contains no provider implementation or state.
`protocol/v1.json`, `protocol/v2.json` and both fixture sets are unchanged.
Historical v1 action names remain inert compatibility data for retained requests;
they do not register or execute a recipe.

## Further decoupling

The R package requires Files. Its `r.execute` action additionally requires
Requirements, while buffer execution needs a document snapshot source. With only
Files/R installed, `r-objects` and exported-object reads remain available;
`unavailableActions` names Requirements as missing. No new operation is retained
or dispatched for that unavailable action.

`r.maxScriptBytes` independently protects saved/buffer script snapshots (1 MiB by
default). Exceeding it rejects planning before dispatch. Document configuration
and selection cannot change a saved script's execution budget. Service code/queue
budgets remain separate application limits.

Package APIs move to 0.4.0 because the central schema exports were removed. The
wire API remains 2.0 and action/view contracts remain 0.2.0. Builds clean each
owner's dist before compiling; removed central modules cannot remain in packages.

## Recipe and artifact boundary

The ordinary base-R project and original paired analysis remain explicit source
consumers under Plugins examples. Neither their scripts, datasets, scientific
checks, fixed contrasts nor pipeline sequencing are plugin registrations or base
dependencies. Agent evaluation remains a separate development consumer.

The packer checks the owner-only file inventory and scans compiled first-party
plugin code for the excluded analysis/evaluator consumers. It rejects native R
scripts, first-party example trees and the former aggregate package. The full
application packages the same reviewed owner tarballs; reduced compositions
physically omit unselected packages. Third-party SDK examples and historical
wire/fixture data do not provide scientific execution.

## Verification

Source checks passed: 12 Plugins owner tests, two separate example tests and 15
Rho tests. These include import/dependency boundaries, fixed Contracts exports,
owner schema parity, independent script budgets, object reads without Requirements,
real stdio MCP, provider removal/reselection, retained v1 observations, three
SIGKILL boundaries, partial/unknown state and export/restore behavior.

All eight owner tarballs passed independent npm installation/import, including
pure contract subpaths, with only Contracts and each owner's declared external
dependencies. Three application tarballs then passed fresh installation outside
the checkouts:

| Composition | Observed result |
| --- | --- |
| Full eight plugins | Both explicit R projects, typed table/plot/object reads, keyed comparison, export/restore and partial/unknown recovery passed |
| Documents + Files | Unicode edits/undo and export passed without R or a Host; other providers were physically absent |
| Files + R | Exported-object reads/export passed without Documents, Requirements, R or a Host; unavailable execution retained/dispatched no request |

The ordinary project produced four typed rows, a real linear model, PNG/PDF and
an exported object. The original analysis completed five DESeq2 fits, 16,139 genes,
33 baseline artifacts, 121/121 native observations, 12/12 independent checks and
explicit apeglm preparation/shrinkage. These are consumers of the same action and
readers, with their project recipes outside the packages.

The [immutable 0.4 record](backend-acceptance/v0.4.0.json) freezes the selected
source trees, lockfiles, Core binary, all nine owner package hashes, three
application artifacts, consumer inputs and observed request/resource identities.
The selected runtime inputs are Rho `c4e56934081dc3c323bdaa5d06f02d9938a59308`,
Plugins `183876b111e49035458fe4ef48393adba82f109d` and unchanged Core
`d0159da6feb01d1be9e3b4b34b67953241fedfcb`. Following documentation/test-guard
commits do not replace those artifact identities. Earlier
[0.3 acceptance](PLUGIN-SPLIT-ACCEPTANCE.md) retains its separate evidence.

The initial build attempted concurrently with a Plugins clean build encountered
missing declarations; the owners were then built sequentially. An initial source
test invocation without an explicitly selected Core binary was unavailable;
selecting the existing checked binary passed. Neither unavailable invocation is
counted as a successful execution.

No UI, registry publication, signing or other-platform acceptance is included.
