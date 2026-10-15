# Rho status

Updated: 2026-10-15.

## Application

Rho's product, architecture, technology direction and development policies are
specified. The application container, functional UI assembly and first release
build are not implemented. No integrated usability, performance or distribution
acceptance has been completed.

First release uses npm distribution with local WebUI: browser → local service →
Rho-core CLI → R/components. Desktop client deferred to later milestone. The
selected stack is React/TypeScript, Vite and Dockview. Initial editing, data and
graphics views use CodeMirror 6, AG Grid Community and ECharts. Agent-composed
interfaces use a typed json-render catalog; independent HTML views can use
isolated MCP Apps. Dependency versions and composition identities will be
recorded when implementation selects the actual artifacts.

## Available foundation and components

[Rho-core](https://github.com/YuLab-SMU/Rho-core/blob/main/docs/PROGRESS.md)
provides managed execution, original request identity, retained facts, a resident
Host and public CLI. Rho uses those declared capabilities at the selected version.

[Rho-plugins](https://github.com/YuLab-SMU/Rho-plugins/blob/main/docs/STATUS.md)
provides an Agent evaluation component and a real R analysis recipe. Their
component acceptance records contain actual executions, checks, failures and
limits. Application integration is pending; component results do not establish
a running Rho composition.

## Next delivery

Implement the [prioritized first-release tasks](WEBUI-FIRST.md), with interaction
deliverables in [Design priorities](DESIGN-PRIORITIES.md) and the complete flow in
[Roadmap](ROADMAP.md#first-integrated-flow). Application implementation and
integrated acceptance remain pending; the design sequence is recorded separately.

P0 release gates include an installable npm/local-service foundation, project and
dependency setup, one actual Agent adapter, human-Agent shared context and editing,
real linked code/table/plot views, run/error/unknown-outcome continuity,
single-window multi-view layout with one typed Agent composition, export/reopen,
and clean-environment installation acceptance. None of these gates is optional
polish. P1 covers additional adapters, richer views and other nonblocking
enhancements after the reference flow works.

The first-release interaction direction is an external Agent: its actual client
owns conversation; Rho shows project binding, explicit context, actions and results.
The R1–R14 designs use a Claude Code terminal session as the reference entry.
The actual adapter, interfaces/versions, credentials, capability evidence, target
OS/architecture and browser, Node requirement, npm name/channel and component
versions remain open under WEB-01. Native desktop clients, cross-window movement
and system integration are deferred. npm publication and official signed
distribution remain separate delivery decisions.

Action, Resource, Selection and View are design concepts. Public schemas, component
host adapters and application state services remain to be implemented for this
flow. The application side of the Core boundary is specified in the
[execution bridge](EXECUTION.md). Component host adapters and the UI components
belong to their source owners. Native resource conditions and results retain their
functional owner.

## Verification

The Paper ["Release 1 · npm WebUI" page](https://app.paper.design/file/01M4X13H2YQGGR8NQXE8W0QDQY/p-5-0)
contains the revised R1–R14 sequence for `rho-airway-03`, pending user review.
It connects startup and external Agent binding, a first analysis, shared editing,
export/reopen, repair, original-request observation and registered comparison views.
The [design index](DESIGN-PRIORITIES.md#r1r14-连续交互索引) records entries,
next steps and a resource/state ledger. The S-series pages remain historical
references. All 14 screens and their flow notes were screenshot-reviewed at the
1440 px reference width; parameter/footer clipping and overlapping flow-note
placement were corrected. Other widths and live behavior remain unverified.
A static sequence is not application acceptance.

The same run 001 baseline remains 16,139 genes, including KLF15's stable gene ID,
through completion and export/reopen. Later shrinkage repair, run 004's partial
8,204/16,139 result and unknown outcome are design scenarios, not new execution
evidence. The comparison declares both inputs and preserves missing values;
closing or refreshing an observer does not establish that an unknown task is
still running. Agent, editor, analysis action, table and plot components belong to
Rho-plugins; Rho assembles the shell, layout, routing and separately sourced facts.

Repository-local link/anchor checks across 17 Markdown files, `git diff --check`
and rendered inspection of the four changed documents passed for this revision.
Application behavior, actual Agent connection, native input, browser refresh, component
composition, service lifecycle, installation and signing still require evidence
from their actual implementations. Core and component checks retain the scope
recorded by those owners; they are not rerun solely to revise application designs.
This revision does not run a Host or publish an npm package.
