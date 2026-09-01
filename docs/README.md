# Rho documentation

Rho documentation explains the code that exists now. Git stores history;
command output reports what actually works. A document that disagrees with the
source or a reproducible run is wrong and should be corrected or deleted.

## Start here

- [Architecture](ARCHITECTURE.md) — the shortest map of processes, authority,
  persistence, and interfaces.
- [Development](DEVELOPMENT.md) — the fast edit–run–inspect–commit loop.
- [Desktop](components/DESKTOP.md), [R runtimes](components/R-RUNTIME.md),
  [Environment realization](components/ENVIRONMENT.md), and [extensions](components/EXTENSIONS.md)
  — deeper implementation maps.
- [Documentation index](INDEX.md) — generated list of current pages.
- [Source index](SOURCE-INDEX.md) — generated paths and checks by
  domain.
- [Build and release](RELEASE.md) — operator commands, loaded only when needed.

## Page shapes

The documentation tree has only three useful shapes:

- an overview maps a system and its boundaries;
- a component page explains behavior that source layout cannot make obvious;
- an operator page gives reproducible commands.

Plans and status live with the working issue or branch. Command output and
artifacts live with the run that produced them. Git retains the evolution.

## Updating the map

```bash
node scripts/governance.mjs impact --changed-auto
node scripts/governance.mjs generate
node scripts/governance.mjs check
```

`governance/registry.json` lists the small set of current pages.
`governance/source-map.json` maps code areas to paths and executable checks.
`docs/INDEX.md` and `docs/SOURCE-INDEX.md` are generated from those files.
