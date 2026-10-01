# Rho documentation

Read this directory to understand the current project or the next version. These
are separate: a design decision does not establish implementation or acceptance.

## Start here

| Need | Read | Scope |
| --- | --- | --- |
| Resume current work | [Status](STATUS.md) | Implemented behavior, retained evidence, gaps and current focus |
| Understand the next version | [下一版本整体设计](NEXT-VERSION.md) | Headless capabilities, external Agents, plugins, UI separation and staged development |
| Understand current ownership | [Architecture](ARCHITECTURE.md) | Existing mechanisms and constraints that changes must preserve |
| Change and verify code | [Development](DEVELOPMENT.md) | Focused checks, artifact reuse and acceptance boundaries |
| Run the current application | [Operations](OPERATIONS.md) | Startup, connection, scientific work and recovery |
| Work on an interface | [UI design](RHO-DESIGN.md) and [Feedback](STUDIO-FEEDBACK.md) | Approved interactions, Paper sources and remaining user problems |
| Build or distribute an artifact | [Release](RELEASE.md) | Packaging, provenance and separate installation/publication steps |

Current code includes an ordinary Agent plugin and a Rig execution engine. The
next-version direction removes the need for an internal Agent product and makes
capability development independent of a frontend. Those changes are not yet
implemented merely because they are documented here.

## Find implementation details

Use the [generated source and check index](SOURCE-INDEX.md) to locate an affected
owner or check. The [page index](INDEX.md) is generated too. Public wire contracts
live in [the plugin protocol](../sdk/plugin-protocol/README.md); component details
belong with the relevant plugin, SDK, source or test. Live capability discovery
establishes what a running Host actually offers.

## Maintain these documents

- Status is the only current progress summary. Preserve evidence limits and keep
  it below 300 lines. Evidence applies to its recorded artifacts and environment.
- Architecture records durable current boundaries; Next Version records target
  design and explicitly unresolved engineering questions.
- Design records interaction decisions; Feedback records user problems. Neither
  a Paper approval nor a functional test proves current usability.
- Development and Operations contain current procedures, not repeated histories
  of every implementation and test. Release owns delivery instructions.
- Git retains superseded plans, including the former built-in Agent plan and
  scenario-plugin research. Do not add an archive directory or another ledger.

Register pages in `governance/registry.json`; register sources and checks in
`governance/source-map.json`. After changing either map:

```sh
node scripts/governance.mjs generate
node scripts/governance.mjs check
node scripts/test-governance.mjs
```
