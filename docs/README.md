# Rho documentation

Rho documentation explains the code that exists now. Git stores history;
command output reports what actually works. A document that disagrees with the
source or a reproducible run is wrong and should be corrected or deleted.

## Start here

- [Architecture](ARCHITECTURE.md) — the shortest map of processes, authority,
  persistence, and interfaces.
- [Development](DEVELOPMENT.md) — the fast edit–run–inspect–commit loop.
- [Rho Next system charter and replacement ledger](NEXT-SYSTEM.md) — the
  normative design, capability ownership, decisions, progress, and verified
  work log for the greenfield replacement.
- [Operator guide](OPERATIONS.md) — running the default `rho` binary,
  local workbench/MCP, R runtimes, Environment and native acceptance.
- [Documentation index](INDEX.md) — generated list of current pages.
- [Source index](SOURCE-INDEX.md) — generated paths and checks by
  domain.
- [Build and release](RELEASE.md) — operator commands, loaded only when needed.

## Design research

- [Scenario plugins, runtime context and work bindings](SCENARIO-PLUGINS.md) —
  a user-authorized research note. It separates user choices, Agent assistance
  and deterministic execution, and explores possible plugin forms. Implementation
  is outside the current Rho Next goal; this page is not a second progress ledger.

## Product feedback

- [Studio usability feedback and scenario reference](STUDIO-FEEDBACK.md) —
  user feedback against the frozen M1–M4 baseline and a workflow reference for
  refinement. This is not an implementation plan or a second progress ledger.

## Page shapes

The documentation tree has only three useful shapes:

- an overview maps a system and its boundaries;
- a component page explains behavior that source layout cannot make obvious;
- an operator page gives reproducible commands.

Plans and status normally live with the working issue or branch. The explicitly
authorized exception is `NEXT-SYSTEM.md`, the single living charter and
replacement ledger for Rho Next. It must distinguish target, implemented, and
verified claims. Command output and artifacts live with the run that produced
them. Git retains the evolution.

`SCENARIO-PLUGINS.md` is the separately authorized research exception: candidate
interfaces and concepts must remain explicitly distinct from implemented code.

`STUDIO-FEEDBACK.md` is a user-authorized feedback exception. Requirements and
open investigation questions stay distinct from implemented or verified behavior.

## Updating the map

```bash
node scripts/governance.mjs impact --changed-auto
node scripts/governance.mjs generate
node scripts/governance.mjs check
```

`governance/registry.json` lists the small set of current pages.
`governance/source-map.json` maps code areas to paths and executable checks.
`docs/INDEX.md` and `docs/SOURCE-INDEX.md` are generated from those files.
