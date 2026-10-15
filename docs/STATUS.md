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
[Roadmap](ROADMAP.md#first-integrated-flow). All tasks remain pending.

P0 release gates include an installable npm/local-service foundation, project and
dependency setup, one actual Agent adapter, human-Agent shared context and editing,
real linked code/table/plot views, run/error/unknown-outcome continuity,
single-window multi-view layout with one typed Agent composition, export/reopen,
and clean-environment installation acceptance. None of these gates is optional
polish. P1 covers additional adapters, richer views and other nonblocking
enhancements after the reference flow works.

First select the reference Agent and conversation location, target OS/architecture
and browser, Node requirement, npm name/channel and component versions. These
choices are not yet fixed. Native desktop clients, cross-window movement and
system integration are deferred. npm publication and official signed distribution
remain separate delivery decisions.

Action, Resource, Selection and View are design concepts. Public schemas, component
host adapters and application state services remain to be implemented for this
flow. The application side of the Core boundary is specified in the
[execution bridge](EXECUTION.md). Component host adapters and the UI components
belong to their source owners. Native resource conditions and results retain their
functional owner.

## Verification

For this revision, repository-local link/anchor checks across 17 Markdown files,
`git diff --check` and rendered inspection of the three changed documents passed.
The execution bridge also
distinguishes application-started Hosts from existing Hosts whose lifecycle stays
with their original owner. Application behavior, native input, component composition,
signing and installation require evidence from their actual implementations. Core
and component checks retain the scope recorded by those owners; they are not rerun
solely to rewrite application documents.

Browser refresh, Agent connection, service lifecycle, native input and package
installation still require application evidence. The Paper designs remain design
references. The reported S2/S3 inconsistencies are corrected in Paper (S2 split
into S2a/S2b, S3 rebuilt from the Slice A components) and await user review.
[Product design](DESIGN.md#agent-led-presentation) now treats Rho as the place
where Agent work becomes visible; an Agent-led S3′ is a trial, and the remaining
screens still assume step-by-step human operation. Continuous interaction
prototypes and implementation acceptance are pending. This update does not run a
Host or publish an npm package.
