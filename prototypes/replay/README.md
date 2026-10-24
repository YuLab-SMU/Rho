# Replay prototype

A behavior prototype for [the interaction model](../../docs/INTERACTION-MODEL.md).
It replays two recorded Agent runs through Rho's expression rules
(`src/expression.ts`) and lets a person follow, work or leave at any point, so the
rules can be judged against real work instead of static boards. The link at the
right of the dock switches between them (`?trace=check` opens the second).

```bash
npm run prototype:replay      # http://localhost:5173
npm run check:replay          # types, then the rule tests (test/expression.test.mjs)
```

## What is real

- **The Agent's work.** All 61 calls of `work/agent-exp-2215`, in order, with their
  outcomes and rejection reasons. The run, on `datasets::airquality`, asks how much of
  the temperature effect on ozone is wind and sunlight.
- **Times.** Each time comes from the project's own records: the event stream,
  document receipts and operation records. A call with no recorded time shows only the
  recorded times on either side of it, and pacing places it at the earlier one.
- **Content.** All nine versions of `analysis.R` (each checked against its recorded
  digest), the two `findings.md` versions, the R stderr and stdout, the three CSVs,
  and run 5's figure. Runs 1 and 2 also produced figures; only run 5's image is kept.
- **After the run.** Facts #61–68, 3.5 hours later, from Rho's own records through
  `src/trace.ts`: an Agent session (`acceptance-declare`) redeclaring the task map with
  exact artifact versions on two items (#61–63), then two questions a browser asked
  about run 5's results (the figure, and rows A and D of effects.csv), each written into
  `questions.md` first, and the one fetch of the first question (#64–68). All three
  principals were scripts (`acceptance-v3.mjs` driving a real browser, and the Agent
  sessions it granted), not a person or a model.
- **Who.** Every fact carries the principal that made it. The run's Agent is the one
  granted exactly the methods its connection lists.

`build-trace.mjs` regenerates `trace/` from that directory, which is ignored by
Git and present only on the machine that recorded it; run `npm run build` first, since
it folds the records with `dist/trace.js`. It writes two files: the
transcript trace (`airquality.json`, which drives the screen) and Rho's own records
cut down to what `src/trace.ts` folds (`records.json`: activity, document histories,
operations, resources, contexts, composition and task map; no image data or local
paths).

## The second run

`?trace=check` replays a run of another kind, known only from Rho's records: real
Claude Code (`claude --print`, MCP limited to rho, the same 23 methods as the first
run) told that the check in `check.R` fails and to fix `stats.R` without changing
`check.R`. The prompt states only the task; Rho's own guidance is its only hint about
declaring its work. `record-agent.mjs` records such a run from the seed files in
`tasks/check/` (three bugs; the check writes `results.csv` and its manifest), then
`build-trace.mjs <dir>` writes `trace/check.records.json` and nothing else, since
there is no transcript. All 20 facts, #0–19, are the Agent's calls plus Rho's own
observation of the run's exit (#13). The two `document.open` calls do not say which
document they returned, so `check.R` first appears when the run names it.

## The ledger

The count at the bottom of the object list opens what Rho itself recorded about the
Agent, up to the current step: Given, Did, Read, Produced and Refused, folded from
`records.json`, not from the transcript. A call whose object Rho did not record reads
"Not recorded". A step the transcript has and Rho does not (four refusals the agent
adapter made locally) says "not in Rho's records" in the dock.

## What is simulated

- **The person.** The scenarios and every click are actions recorded at the step
  where they happen. Nothing here comes from a real person watching this run. A
  question asked in the replay records no context, so nothing can fetch it.
- **The shell.** It is drawn with Rho's tokens but is not the WebUI: no service,
  no dockview, no plugin entries. The rules in `src/expression.ts` are meant for the
  real shell; this page only gives them something to drive.
- **The Agent's attention.** Reads (`data.page`, `action.lookup`, `action.output`)
  count as attention. Today they reach the service but are not events the browser
  receives.

## Reading the object list

A source's earlier runs fold into a row of their marks under it, numbered and coloured
by outcome; the row unfolds them. The run on screen, the run the Agent is on and a run
that failed while the person waited stay listed. The away digest folds runs the same
way.

## Reading the dock

One tick per call: tall for writes and runs, short for reads, faint for catalog
reads. Red is either a rejection (short) or a failed run (tall); green is a run that
exited 0; amber is a fact a browser made. A grey rule marks ten minutes or
more with nothing recorded. The line under the ticks marks when the main area moved, blue for the
Agent and amber for the person. Amber dots are the person's actions.
Keys: ← → step, space plays.
