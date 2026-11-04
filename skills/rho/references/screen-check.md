# Checking a page in a real browser

`rho-screen-check` ships with `@rho-workspace/rho`. From a project where the package is installed, run `npx rho-screen-check --help`; from a Rho checkout, run `node scripts/screen-check.mjs --help`. It needs Google Chrome or Microsoft Edge on the machine, or Playwright's Chromium; without one it exits 2 and says how to fix that.

The practice below is the text Rho serves as the Skill `rho.screen-check`. When you are connected to a project, read it there with `skill.read`; this copy is for an Agent that has the Skill installed but no connection.

Check how a page lays out in a real browser before you say it works.

Run `rho-screen-check <url or page.html>`. It opens the page at each viewport (by default 1440x900, 1024x768, 768x1024 and 390x844), waits for it to settle, writes one screenshot per viewport and prints a JSON report. Options: `--viewport WxH` (repeatable), `--out DIR` (default ./screen-check), `--overlap SELECTOR` (report the visible boxes of that selector that overlap one another), `--full-page`, `--settle MS` (default 800), `--browser auto|chrome|msedge|chromium|PATH` (default auto: Chrome, then Edge, then Playwright's Chromium).

Read the exit status first. 0: the check ran, and its findings are in the report. 1: an argument was wrong. 2: the check did not run; `error.kind`, `error.message` and `error.next` say why and what to do. Do what `next` says, then run it again.

For each viewport, read: `horizontalOverflow` with `scrollWidth` against `clientWidth` (the page is wider than the window); `elementsPastEdgeUnclipped` (what crosses the right edge and no box keeps in: read this count first), then `elementsPastEdge` (the first 50, unclipped first; `clippedBy` names the box that scrolls or hides what is beyond its own width); `unnamedButtons`; `overlaps` for your selector; `pageErrors` and `consoleErrors`; `httpErrors` (each response that failed, with its status and address); `requestsOutsideTarget` (what the page loads from elsewhere).

Then open each `screenshot` with the Read tool and say what you see. The report says what the page does, not whether a person can follow it; the screenshot and the flow answer that. Check the states a person reaches as well as the first screen: an empty state, an error, a long name or number, a narrow window, the screen after a step. Run the check again after each change.

Pitfalls seen in real runs:
- A selector can match hidden elements. The report counts visible boxes only; your own probes must filter by visibility too.
- The same attribute can appear in two views at once, such as a script editor's flow and a session's Data flow. Open a workspace that shows only the view you check.
- At 390 px the sidebar collapses and project labels are hidden. Reach the label through the page's own controls before you look for it.
- Text cut short inside a box of fixed height, such as a label that ends mid-word, is not in the report. Only the screenshot shows it.
- Restarting Rho ends the live R sessions, and the page then shows "Rho closed. Values defined before this are gone." Say so when a check follows a restart.
- Check a copy of the project, not the person's own project. A check must not change what the person has.
