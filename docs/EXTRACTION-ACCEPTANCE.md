# Reusable backend extraction acceptance

Updated: 2026-10-16.

Version 0.2 removes the fixed paired analysis from the base catalog, resource
semantics, application routing and npm inventory. The actual headless consumers
are an ordinary base-R project and the original scientific example. Both use
the same `r.execute` and explicit declarations; no UI is implemented in this work.

The [extraction plan](PLUGIN-EXTRACTION.md) defines PX-01–PX-05;
[HEADLESS](HEADLESS.md) describes the implemented operations and budgets.
The original [v1 acceptance](BACKEND-ACCEPTANCE.md),
[v1 candidate record](backend-acceptance/v0.1.0.json), protocol and fixtures remain
unchanged. They do not identify this new candidate.

## Composition and scope

The selected environment is macOS arm64, Node 22.22.3/npm 10.9.8, R 4.5.2,
Python 3, Claude Code 2.1.301 and MCP SDK 1.29.0. The new local packages are
`@rho-workspace/local` 0.2.0 and `@rho-workspace/headless` 0.2.0.
Core source remains `d0159da6feb01d1be9e3b4b34b67953241fedfcb`, tree
`d76820b39b24df9e7b222efc3626f39915022181`; its explicitly selected binary is
7,399,128 bytes with SHA-256
`eee223026f7e0b4dd1ee14a409c023919626c4175be5728048a02af739af4ce1`.
No Core changes or new execution engine were required.

Plugins owns document buffers, explicit R plans/requirements, resource
declarations/readers and checks. Rho preserves caller/project authority,
original request mapping, CLI dispatch and composition. Scientific script,
formula, dependencies, serialization and domain checkers stay in the example.
Generic completion verifies declared bytes; its domain result remains unchecked.
Project check scripts produce separate reports with their own provenance.

## Executed source checks

| Subject | Executed result |
| --- | --- |
| Plugins capability suite | 9/9 pass: shared documents/budgets, immutable MCP caller intents, explicit types/nulls/keys, joins, stale inputs, frozen script/arguments, base-R requirement probes and artifact containment/integrity |
| Scientific example regressions | 2/2 pass: native singleton histogram and exact script digest under a spaced Chinese path |
| Rho suite | 12/12 pass: v1/v2 protocols and inert fixtures, retained legacy observation, actual stdio MCP, scope/auth, writer leases, budgets, export/restore and three real SIGKILL dispatch boundaries |
| Ordinary R project | Two actual R requests; 7 analysis artifacts and a separate native-model check; four rows, real linear model, PNG/PDF and exported object snapshot |
| Original paired project | Four actual R requests: analysis, independent/native checks, apeglm shrinkage and shrinkage check; 33 baseline artifacts, five saved DESeq2 fits and 16,139-row typed results |
| Recovery | Actual partial base-R result, owned Host SIGKILL, retained original unknown request, explicit cancellation with native process-group release and restored bytes/drafts without execution |
| External Agent | Actual Claude Code MCP v2 context fetch and conditional shared-buffer edit; Chinese/emoji remain unsaved at version 3; no native Host starts |

Commands use disposable projects and owned Hosts:

```sh
# Plugins checkout
npm test
npm run test:examples

# Rho checkout; choose an existing public Core binary
RHO_CORE_BINARY=/absolute/rho-core npm test
node scripts/acceptance.mjs /absolute/new/ordinary /absolute/Rho-plugins/examples/ordinary-r-project
node scripts/acceptance.mjs /absolute/new/paired /absolute/Rho-plugins/examples/real-r-analysis
node scripts/recovery-acceptance.mjs /absolute/new/recovery
node scripts/agent-experiment.mjs /absolute/new/agent
```

Actual local source records are `work/extraction-ordinary-2/report.json`,
`work/extraction-paired-4/report.json`, `work/extraction-recovery-2/report.json`
and `work/extraction-agent-v2/report.json`. These ignored paths retain full local
observations; they are not a published artifact archive.

The ordinary consumer preserves string keys `001` and literal `NA`, declares
null encodings and two different entity namespaces, and joins two explicit
input versions through a declared mapping. Sorting, selection/context and chart
data retain the declared key. Media returns original PNG/PDF bytes and bounded
coordinate context. Model viewing reads an exported JSON snapshot without R.

The original analysis uses one conditional simulation for bounded integration.
Five real-data fits and 121/121 saved-model observations pass; Python checks
pass 12/12. Explicit project preparation obtains missing apeglm, rechecks its
environment and runs shrinkage. The original 200-simulation scientific evidence
and its scope remain in the Plugins example, rather than being relabeled here.

## Installation candidate

Source checks above have passed. The recipe-free npm candidate will be built from
checked commits and installed outside all source checkouts. Installation must
exercise startup without Rscript, bundled Core and actual Plugins resolution,
then the same two explicitly supplied projects and recovery. Its artifact and
composition identities are recorded separately after the run; source passes
alone do not establish installation acceptance.

## Compatibility and retained failures

The frozen `/api/v1` descriptor/schema remains available for retained observations;
new scientific v1 submissions return unavailable. A seeded, explicitly labeled
transport fixture verifies the original frozen request/Core identity and retained
resource bytes without starting a Host. It is not a rerun of historical science.
Schema-1 workspace restore is supported. New resources requiring v2 return typed
unavailable through v1 instead of silently changing the old response contract.

The new `/api/v2` client, schemas and ten inert fixtures agree with actual
response captures or named projections. No fixture contains an executable native
journal. Restore keeps unavailable entry references and does not replay work.

Original failed extraction records remain at `work/extraction-paired`,
`work/extraction-paired-2`, `work/extraction-paired-3` and
`work/extraction-recovery`. They exposed a checker-wrapper variable collision,
a completion sidecar added inside the immutable scientific inventory, an extra
declared shrinkage column and a remaining old action in the recovery harness.
The fixes isolate wrapper arguments, put generic completion beside producer
artifacts, declare the actual columns and use generic execution for both recovery
requests. New identities were deliberately used for repaired trials.
An artifact-containment regression also caught macOS `/var` symlink handling;
execution planning now resolves the project root before forming contained paths.
These are transport/declaration/checker integration failures, not new evidence
against the original statistical fit.

## Limits and handoff

The package can start and serve documents/files without R or scientific packages.
The ordinary project uses base R only; the paired project declares its external
scientific dependencies. Installation is on the existing R host, not a clean OS
image or a promise that npm installs R.

Batch Rscript provides explicit exported object snapshots, not live variables or
R-memory recovery. Media supplies metadata and bytes, not decoding or rendering.
Five view descriptors validate props/bindings while UI remains unavailable.
Future views consume these contracts without creating new buffer/request owners.
Browser layout/input/IME/accessibility, other platforms and whole-product
acceptance remain pending. There is no registry publication or signed release.
