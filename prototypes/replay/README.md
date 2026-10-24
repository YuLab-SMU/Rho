# Replay prototype

A behavior prototype for [the interaction model](../../docs/INTERACTION-MODEL.md).
It replays one recorded Agent run through Rho's expression rules
(`src/expression.ts`) and lets a person follow, work or leave at any point, so the
rules can be judged against real work instead of static boards.

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

`build-trace.mjs` regenerates `trace/` from that directory, which is ignored by
Git and present only on the machine that recorded it.

## What is simulated

- **The person.** The scenarios and every click are actions recorded at the step
  where they happen. Nothing here comes from a real person watching this run.
- **The shell.** It is drawn with Rho's tokens but is not the WebUI: no service,
  no dockview, no plugin entries. The rules in `src/expression.ts` are meant for the
  real shell; this page only gives them something to drive.
- **The Agent's attention.** Reads (`data.page`, `action.lookup`, `action.output`)
  count as attention. Today they reach the service but are not events the browser
  receives.

## Reading the dock

One tick per call: tall for writes and runs, short for reads, faint for catalog
reads. Red is either a rejection (short) or a failed run (tall); green is a run that
exited 0. The line under the ticks marks when the main area moved, blue for the
Agent and amber for the person. Amber dots are the person's actions.
Keys: ← → step, space plays.
