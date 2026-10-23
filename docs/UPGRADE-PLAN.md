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

Done in this row so far: the output directory, run reconciliation and the
execution acceptance. The three remaining items above are the rest of P0.

The execution acceptance records one gap rather than hiding it: an artifact
produced by `r.execute` lives under owner state, `resource.register` refuses
owner state by design, and presentation accepts only native `artifact.ready`
events, so an Agent-run plot has no route to a view. Recorded as
`artifact-not-presentable` in the report.

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
  which needs the presentation gap decided, and `feedback`.
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

### P3 — Protocol ergonomics

- `protocol.describe` gains `example` and `dependencies` per operation.
- `protocol.validate { method, body }`: a dry run that answers with the exact
  missing field instead of a schema path. **Done:** it returns one `fix` per
  problem ("Adding \"changeId\" also requires \"expectedRevision\"."), and every
  schema refusal now carries the same explanation plus a remedy.
- `session.grant` accepts `profile` (`agent-r`, `agent-business`,
  `agent-presentation`) rather than a hand-written method list.

### P4 — The person's journey, made explicit

- State what a person can do without an Agent: open a folder, list it, open and
  edit a text file in the buffer. Saving, registering and executing stay Agent
  or operator work; that boundary is stated in the Skill, not discovered.
  **Done:** `rho.person-files` states it, and the editor shows it before the
  person types: a first version rendered below the editor, invisible, which the
  person acceptance now rejects by asserting visibility rather than presence.
- Decide and, if accepted, grant `document.save` to a tab with the same
  conditional identity it already uses for edits.
- Show runs in the browser: what was submitted, what it is doing, where its
  artifacts are. "Nothing happened" must stop being a possible observation.
  **Done:** `project.runs` gives a person a bounded summary of every run in their
  project — action, execution state, author kind, declared artifacts — with no
  request body, no code and no output text, reconciled on read. The Overview
  lists it. Checking it exposed that a project opened at the service root could
  not be granted a session, because its relative path is empty.

### P5 — Verification that cannot overstate

- Matrix: journey × (source build / packed install) × width. **Done:**
  `npm run acceptance:matrix -- --install DIR` runs the person, execution,
  Skills and U1 shell journeys against both columns; 8 of 8 pass, the installed
  column using the Core vendored in the artifact. The packed candidate is built from a clean
  worktree of HEAD, because packing the working tree would have baked a local
  CSS override into the artifact.
- Zero Host starts is a constraint for read-only flows only; execution flows
  assert the starts and artifacts they need.
- Every claim in [Status](STATUS.md) links to a machine-readable report.
- A standing "unverified and dead paths" list, so a gap is never mistaken for
  a decision.

## Definition of done

1. An Agent who has read only the Skills completes open → edit → execute →
   present with no refused call. **Measured:** `npm run acceptance:walkthrough`
   reads the Skills from the service, follows them, and proves its refusal
   recorder works by feeding it one deliberately wrong call first.
2. An environment problem is located within one round trip after `doctor`.
   **Measured:** one call reports three simultaneous faults (a stale Host socket, a
   read-only project folder, a missing Rscript) with a remedy for each, and a
   dead-Host socket is reported as stale rather than as an idle project.
3. Every execution check asserts the Host start it depends on. **Measured:**
   `acceptance:execution` asserts exactly one Host start and the artifact, and
   fails if either is missing; `acceptance:walkthrough` drives the same
   submission through the Skills.
4. No claim in Status lacks a report, and every gap is either scheduled here or
   stated as accepted work. **Measured:** `npm run verify` writes
   `docs/VERIFICATION.json` with each command, exit code, count and commit, Status
   cites it, and a guard test rejects a cited count the ledger never recorded
   (checked by feeding it a wrong number).
