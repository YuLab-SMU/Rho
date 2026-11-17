import { readFileSync } from 'node:fs';
import { parseSkillFile } from '@rho-workspace/plugin-contracts';
import { SkillDeclaration, digest } from '@rho-workspace/plugin-contracts';
const readSkillFile = (url: URL) => parseSkillFile(url.href, readFileSync(url, 'utf8'));

// The practice for checking a page's layout in a real browser, served as the Skill rho.screen-check.
// skills/rho/references/screen-check.md carries this text verbatim, and
// test/screen-check-skill.test.mjs fails when the two differ, so the text has one source.
const screenCheckContent = readSkillFile(new URL('../skills/rho/operations/rho-screen-check/SKILL.md', import.meta.url)).body;

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
