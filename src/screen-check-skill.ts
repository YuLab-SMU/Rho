import { SkillDeclaration, digest } from '@rho-workspace/plugin-contracts';

// The practice for checking a page's layout in a real browser, served as the Skill rho.screen-check.
// skills/rho/references/screen-check.md carries this text verbatim, and
// test/screen-check-skill.test.mjs fails when the two differ, so the text has one source.
const screenCheckContent = [
  'Check how a page lays out in a real browser before you say it works.',
  '',
  'Run `rho-screen-check <url or page.html>`. It opens the page at each viewport (by default 1440x900, 1024x768, 768x1024 and 390x844), waits for it to settle, writes one screenshot per viewport and prints a JSON report. Options: `--viewport WxH` (repeatable), `--out DIR` (default ./screen-check), `--overlap SELECTOR` (report the visible boxes of that selector that overlap one another), `--full-page`, `--settle MS` (default 800), `--browser auto|chrome|msedge|chromium|PATH` (default auto: Chrome, then Edge, then Playwright\'s Chromium).',
  '',
  'Read the exit status first. 0: the check ran, and its findings are in the report. 1: an argument was wrong. 2: the check did not run; `error.kind`, `error.message` and `error.next` say why and what to do. Do what `next` says, then run it again.',
  '',
  'For each viewport, read: `horizontalOverflow` with `scrollWidth` against `clientWidth` (the page is wider than the window); `elementsPastEdgeUnclipped` (what crosses the right edge and no box keeps in: read this count first), then `elementsPastEdge` (the first 50, unclipped first; `clippedBy` names the box that scrolls or hides what is beyond its own width); `unnamedButtons`; `overlaps` for your selector; `pageErrors` and `consoleErrors`; `httpErrors` (each response that failed, with its status and address); `requestsOutsideTarget` (what the page loads from elsewhere).',
  '',
  'Then open each `screenshot` with the Read tool and say what you see. The report says what the page does, not whether a person can follow it; the screenshot and the flow answer that. Check the states a person reaches as well as the first screen: an empty state, an error, a long name or number, a narrow window, the screen after a step. Run the check again after each change.',
  '',
  'Pitfalls seen in real runs:',
  '- A selector can match hidden elements. The report counts visible boxes only; your own probes must filter by visibility too.',
  '- The same attribute can appear in two views at once, such as a script editor\'s flow and a session\'s Data flow. Open a workspace that shows only the view you check.',
  '- At 390 px the sidebar collapses and project labels are hidden. Reach the label through the page\'s own controls before you look for it.',
  '- Text cut short inside a box of fixed height, such as a label that ends mid-word, is not in the report. Only the screenshot shows it.',
  '- Restarting Rho ends the live R sessions, and the page then shows "Rho closed. Values defined before this are gone." Say so when a check follows a restart.',
  '- Check a copy of the project, not the person\'s own project. A check must not change what the person has.',
].join('\n');

export const screenCheckSkill: SkillDeclaration = {
  id: 'rho.screen-check',
  version: '1.0',
  content: screenCheckContent,
  digest: digest(screenCheckContent),
  intent: 'Check how a Rho screen or a local page lays out at phone and desktop widths, in a real browser, and read the result rather than assume it.',
  failureRecipes: [
    { kind: 'browser_missing', message: 'No browser could be started.', next: 'Install Google Chrome or Microsoft Edge, or pass --browser with the path of an installed Chromium-based browser; then run the check again.' },
    { kind: 'unreachable', message: 'The page did not load.', next: 'Check the address, that the service is running or the file exists, and that the page opens in a browser; then run the check again.' },
    { kind: 'usage', message: 'An argument was not understood.', next: 'Run rho-screen-check --help and use one of the listed forms.' },
  ],
  verify: {
    command: 'npm run test:screen-check',
    description: 'Runs the screen-check tests: the findings on fixture pages in a real browser, the JSON report and the exit codes, and this Skill text against the shipped reference.',
  },
};
