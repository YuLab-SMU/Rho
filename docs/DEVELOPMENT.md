# Development

Development is an edit–run–inspect loop. Plans are temporary; code, tests, and
observable behavior are the lasting result.

## Fast loop

1. Inspect `git status` and the relevant entry point.
2. Ask the source map what the change reaches:

   ```bash
   node scripts/governance.mjs impact --changed-auto
   ```

3. Make the smallest coherent change and run the focused test beside it.
4. Inspect the real behavior or error, then adjust the code.
5. Run the affected checks once the change settles.
6. Review the diff and commit it. Update a current document only when the code
   is no longer understandable without that explanation.

The source map suggests checks; it does not invent a risk class or claim that
an unrun command passed. Full workspace, visual, installer, and release checks
are used only when the changed behavior reaches them.

## Design compass

Keep these properties in the implementation and its tests, not in paperwork:

- success reflects committed or live authoritative state;
- identity and permission are checked where an operation is admitted;
- project data and secrets remain contained to their intended destination;
- external input, output, time, and memory are bounded where they can grow;
- failure is visible and leaves a truthful recovery path;
- generated interfaces and their real implementations move together.

Violations of these properties are implementation problems to resolve in code
and tests, not exceptions to explain with more process prose.

## Parallel work

Use another worktree only for genuinely independent code. Register its paths:

```bash
node scripts/dev-lanes.mjs start --id example --own 'path/**'
node scripts/dev-lanes.mjs check --id example --changed-auto
node scripts/dev-lanes.mjs finish --id example
```

Prefer one or two short-lived feature worktrees and one integration checkout.
Checkpoint unfinished work in a clearly named branch before switching tasks;
never rely on an unexplained dirty directory as the handoff.

## Replacement programs

Large clean replacements keep temporary scope and status with their working
issue or branch. No replacement ledger is part of the current architecture.
Once a program closes, delete its temporary dashboard and describe only the
implementation and executable checks that remain.

## Test tiers

Use the narrowest tier that can falsify the change:

| Tier | Command | Purpose |
| --- | --- | --- |
| Focused | `npm --prefix desktop run rsr:test -- <file>` or `cargo test -p <crate> <filter> --locked` | one component, contract, or regression while editing |
| UI inner loop | `npm --prefix desktop run rsr:check` | type/lint, static binding inventory, transport contracts, and fast unit tests |
| Desktop contracts | `npm --prefix desktop run rsr:check:contracts` | generated Rust/TypeScript facets and acceptance contracts after an IPC change |
| Pre-handoff | `npm --prefix desktop run rsr:check:full` | all Vitest suites, generated bindings, governance, and production build |
| Acceptance | `npm --prefix desktop run rsr:acceptance` | browser, broad interaction, and visual harnesses |
| Release | `npm --prefix desktop run rsr:release` | pre-handoff plus production/security invariants, acceptance, and release contracts |

`App.test.tsx`, `AgentSurfaceView.test.tsx`, and `src/acceptance/**` are excluded
from the inner-loop Vitest configuration. They remain available directly and
run in the pre-handoff tier. Generated binding checks have one fast static
inventory and one consolidated full gate; the domain-specific scripts remain
available for focused IPC work. `scripts/dev-checkpoint.mjs rsr-final` resumes
the pre-handoff gates, not acceptance or release evidence.

Every test has one active reason to exist: invariant, external contract,
minimal regression, integrated acceptance, or release evidence. A test that
only proves an old implementation is gone must be promoted to a durable
invariant or deleted. Do not preserve obsolete interaction flow by bending a
new architecture around it.

## Feedback and evidence

Tests should report the smallest useful reproduction. Cargo `target/`
directories at any depth, local ledgers, and visual artifacts are ignored and
do not participate in checkpoint fingerprints. A handoff says exactly which
commands ran and their results; prose never upgrades `not run` into success.
Git commits record the evolution, so current documentation does not repeat it.
