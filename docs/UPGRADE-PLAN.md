# Rho upgrade plan — close the loop between claimed and actual behaviour

Written after a real end-to-end attempt on 2026-10-23: a person opened a folder,
an Agent ran an R script, and the route from "produced a plot" to "a person sees
it" was executed by hand, with nothing scripted to fall back on. That attempt
found defects that every existing check had been structurally unable to see.

## Why this exists

The checks in this repository were strong on what they refused to do. Browser
acceptance asserted **zero Host starts**, which is correct for a read-only shell
and simultaneously proves the execution path was never exercised. Source tests
selected a Core and passed; a checkout without one failed eight tests with a
message that did not name the remedy.

The same attempt also showed the Skills mechanism working against its own
purpose. An Agent following the documentation had to discover, by failing:

- which session methods a task needs, one missing method at a time;
- that `document.edit` and `document.save` require `expectedRevision` beside
  `changeId`;
- that `action.observe` takes only `{projectId, operationId}`;
- that artifact facts are keyed by the principal that submitted the run;
- that `artifact.check` needs a declared completion inventory;
- that the declared output directory did not exist.

None of these are deep. All of them cost round trips, and two of them produced
a wrong conclusion that was reported as fact before being corrected. A Skill
that is prose cannot prevent that; a Skill that is checked can.

## Principles

1. **A Skill is executable.** Every shipped Skill carries a runnable check of
   the path it describes. A Skill whose check fails cannot be published.
2. **Errors carry the remedy.** Every refusal names the next operation, the
   missing field or the command, in machine-readable form.
3. **Reads reconcile.** Observation reports what the owner already knows; it
   never leaves a finished run looking active. Observation still starts nothing.
4. **One front door.** An Agent states an intent and receives the methods and
   prerequisites it needs, instead of assembling a grant by hand.
5. **Acceptance cannot flatter.** A read-only flow may assert zero Host starts;
   an execution flow must assert the start it needs and the artifact it produced.

## Phases

### P0 — Close the observed defects

| Work | Owner | State |
| --- | --- | --- |
| Create the declared output directory (and each artifact subdirectory) before the producer starts | Rho-plugins | done: `plugins/r/src/index.ts`, tests in `test/resources.test.mjs` |
| Reconcile a non-terminal run when a read observes it, bounded, never starting a Host | Rho | done: `src/requests.ts`, `test/reconcile.test.mjs` |
| Execution acceptance: real Host, real R, artifact, completion inventory, `artifact.check`, exactly one Host start | Rho | done: `scripts/execution-acceptance.mjs` |
| Sidebar content counts match what the project shows | Rho | done: the count is labelled "registered", and the Overview lists the folder |
| Lock conflicts name the holder, not just "another service" | Rho | done |
| Generic failures name their cause instead of "could not be confirmed" | Rho | done |

The execution/browser journey now checks the registered reference returned by
`artifact.check`, binds it directly and requires a decoded image in Chrome.
The earlier claim that owner-state artifacts were not presentable was caused by
an incorrect test that attempted to register the same internal path again.

### P1 — Skills become contracts

- Skill format v2: `preconditions`, `inputs`, `example`, `output`, `verify`,
  `failureRecipes`. **Started:** `SkillDeclaration` carries `intent`,
  `requires`, `example`, `failureRecipes` and `verify`.
- Build-time validation: every example payload is checked against the operation
  schema it claims to illustrate, so prose cannot drift from the contract.
  **Started:** `test/skills.test.mjs` checks every declared example, every named
  operation and every `verify` command; it caught a placeholder digest in the
  first draft of the rewritten Skill.
- Every Skill ships a check that runs on a disposable project.
- First Skills: `person-open-file`, `agent-run-r`, `artifact-and-view`,
  `task-map`, `feedback`. **Done:** `r.workspace`, `rho.person-files` and
  `rho.task-map` carry intent, requires, example, failure recipes and a verify
  command that runs (`acceptance:execution`, `acceptance:person`,
  `test:task-map`). Two remain by the plan's own list: `artifact-and-view`,
  and `feedback`. The artifact route is now covered by the execution/browser journey.
- **Done:** all 14 shipped Skills carry `intent`, `requires`, a schema-valid
  `example`, `failureRecipes` and a `verify` command that runs. The check keeps
  printing the count so a new prose-only Skill cannot appear unnoticed.

### P2 — A service that diagnoses itself

- A `doctor` operation: Core present, Rscript, write access to the project root,
  lock holder, plugins needed by an intent. **Started:** `project.doctor` reports
  write access to the project and state folders, Host state, Rscript, unfinished
  runs and plugin selection, each with its next action. The Overview asks it
  before listing content, so "nothing happened" is answered in the product.
- `capability.index` accepts an intent and answers with the required session
  methods and any missing prerequisite. **Done in `project.doctor` instead of
  the layered index**, which is a security-sensitive pager: `intent: 'run-r'`
  answers with the methods the task needs, which of them this session lacks, and
  whether the environment allows it.
- Startup prints the narrow conclusion a person needs, not only a URL.
  **Done:** the ready line carries `startup` with the selected projects and state
  folders, the Core binary and the resolved Rscript, plus how to open the tab. It
  stays inside `ready` so a parser reading line one is unaffected.

### P3 — Protocol ergonomics

- `protocol.describe` gains `example` and `dependencies` per operation.
  **Partially done, deliberately:** field dependencies are in the schema and
  `protocol.validate` explains them. Examples are not duplicated into the static
  protocol — that would make protocol generation depend on loaded plugins — so the
  umbrella Skill points at each Skill's validated example instead.
- `protocol.validate { method, body }`: a dry run that answers with the exact
  missing field instead of a schema path. **Done:** it returns one `fix` per
  problem ("Adding \"changeId\" also requires \"expectedRevision\"."), and every
  schema refusal now carries the same explanation plus a remedy.
- `session.grant` accepts `profile` (`agent-r`, `agent-business`,
  `agent-presentation`) rather than a hand-written method list.

### P4 — The person's journey, made explicit

- People can open, edit and conditionally save a shared document. The browser
  uses the owner revision, disk digest and original change identity; button and
  keyboard saves, refresh and external-write conflicts are exercised in Chrome.
  Registration and native execution remain separately scoped.
- Show runs in the browser: what was submitted, what it is doing, where its
  artifacts are. "Nothing happened" must stop being a possible observation.
  **Done:** `project.runs` gives a person a bounded summary of every run in their
  project — action, execution state, author kind, declared artifacts — with no
  request body, no code and no output text, reconciled on read. The Overview
  lists it. Checking it exposed that a project opened at the service root could
  not be granted a session, because its relative path is empty.

### P5 — Verification that cannot overstate

- Matrix: journey × source/installed composition × width. The current runner
  has three distinct journeys: person, execution/MCP and U1. The old Skills
  walkthrough is an alias of execution/MCP and is not independent evidence.
  [Status](STATUS.md) records which current columns have actually run.
- Zero Host starts is a constraint for read-only flows only; execution flows
  assert the starts and artifacts they need.
- Every claim in [Status](STATUS.md) links to a machine-readable report.
- A standing "unverified and dead paths" list, so a gap is never mistaken for
  a decision.

## Current completion evidence

The implementation enforces owner-first discovery, complete selected contracts,
bounded retained replies, streamed file pages, conditional browser saves and
real artifact rendering. The deterministic stdio execution/browser journey and
the actual Claude Code context/edit trial have different scopes. Neither passing
prose checks nor declaring a layout counts as successful image rendering.

[Status](STATUS.md) records executed checks and [verification scope](UNVERIFIED.md)
keeps platform, autonomous scientific and full-product work explicit. These
replace the earlier claim that a scripted Skill walkthrough proved model use.
