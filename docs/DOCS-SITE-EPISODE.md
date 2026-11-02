# Documentation site

Updated: 2026-11-02.

Before this pass Rho had no online documentation: the only published surface was the
downloads page at <https://yulab-smu.top/Rho/>, and the 49 documents in `docs/` were
readable only through GitHub's file view. This record covers the site that publishes
them, what was checked, and what remains unverified.

## What existed

| Surface | What it was |
| --- | --- |
| `https://yulab-smu.top/Rho/` | The `gh-pages` branch: a hand-written downloads page, `.nojekyll` and `updates/{stable,development}.json` plus `updates/tauri/*`, the update feeds a 0.4.0 desktop install reads |
| npm `@rho-workspace/rho` | Published, version 0.5.2, but the registry record's `readme` field is the literal string `ERROR: No README data found!`, so the package page shows no description |
| `docs/` in the repository | 49 Markdown files, 12,078 lines, with 74 anchored links between them and 37 links that leave the directory for `CONTRIBUTING.md`, `SECURITY.md`, `protocol/`, `scripts/` and `output/` |

Two statements were stale and are corrected in this pass: `README.md` said npm
publication had not been performed, and nothing said where documentation could be read.

## What was built

`docs/` stays the single source. `scripts/docs-site.mjs` copies every Markdown file into
`site/content/<section>/`, rewrites its links so they resolve in the site, writes a
`navigation.json` the theme reads, and records in `links.json` the source file and every
rewritten link. A document that matches no section fails the run instead of disappearing
from the site.

The three sections are a reading order, not a storage scheme:

- **Concepts** — `ARCHITECTURE`, `COLLABORATION`, `EXECUTION`, `TECHSTACK`, `DEVELOPMENT`,
  `ROADMAP`, `AGENT-ACTIVITY`.
- **Reference** — `HEADLESS`, `FRONTEND`, `STATUS`, `RELEASE`, `PLUGIN-AUTHORING`.
- **Records** — 36 episodes, acceptance records and earlier plans, ordered by the
  `Updated:` date each one carries and grouped by month in the sidebar. Every record page
  opens with a banner saying it is a historical record and not a requirement.

The site is VitePress 1.6.4 with local full-text search. The landing page is an authored
Vue component, not a theme preset: it uses the application's own palette and type from
`web/theme.css` (accent `#1e6b52`, ink `#202927`, hairline `#e1e6e3`, system UI and mono
faces, a Georgia display face matching the application's own ρ mark) and shows five real
screenshots of Rho 0.5.2, four of them captured on the bundled PA14 quorum-sensing
project.

The landing page states the version split (npm 0.5.2 against the 0.4.0 installers), names
what is checked, what is limited and what is not established, and links to
[Status](STATUS.md) as the single summary rather than restating it.

## What was observed

Built with `npm run docs:build`: 55 pages, 5.7 MB, 3–7 s, no dead links reported by
VitePress with `ignoreDeadLinks: false`, and 280 links rewritten across the 49 documents.
`npm run docs:check` compares the generated navigation against `docs/` and passes.

Screenshots were taken with Playwright at 1440×900 and 390×834 and read back:

- The landing page renders its hero, screenshots, evidence bands and repository cards at
  both widths; the phone layout wraps the install command instead of clipping it.
- The documentation pages keep the 690 px measure, the sidebar and the outline; tables in
  `HEADLESS` and `CI-EPISODE` render at full width.
- Search returns `HEADLESS` § Budgets for "budget", with the matched table row in the
  detailed view.
- A record page shows its historical banner above the title and the month grouping in the
  sidebar.

Defects found and fixed in this pass, all by looking at the screenshots: VitePress resolves
its public directory as `<srcDir>/public`, so the first build shipped no images or logo
(assets moved to `site/content/public/`); the hero headline wrapped to a one-word line
(fixed with two block lines and `text-wrap: balance`); the feature screenshots at full
window width were unreadable at their column size (cropped to the content area, shared 4:3
ratio); record summaries cut mid-clause (now cut at a sentence boundary, date prefix
removed).

## Limits

- No one outside this machine has read the site yet. Nothing here is a usability claim.
- The site is served from `gh-pages` under `/Rho/docs/`; the download page, `.nojekyll`
  and the four `updates/*.json` paths are unchanged, so an installed 0.4.0 desktop client
  keeps its update feed. That preservation is the reason the site was added as a
  subdirectory instead of replacing the branch root.
- The npm readme cannot be repaired for an already published version; the next
  publication carries `README.md`, which the packed candidate already includes.
- `docs/HEADLESS.md` still titles itself "Rho local backend 0.5.1" while the package is
  0.5.2. The title is published as written; changing it is a content decision for the
  owner, not a site one.
- Two documents are withheld from the site: `docs/README.md` (the site's own navigation
  replaces it) and the withdrawn 2026-10-26 design commission under `docs/design/`, which
  the repository already treats as history rather than requirements.

## Front page and demo

The root page at <https://yulab-smu.top/Rho/> was still the hand-written 0.4.0 downloads page
of 2026-08-18, while the current delivery is the npm package (0.5.3, published the same day as
this pass, with provenance). This pass replaces it with a front page that carries the real
interface, an install prompt for an Agent and example prompts, and keeps every download, checksum,
signing and uninstall statement the old page made.

### What was built

- **Demo** (`/Rho/demo/`). The application's own WebUI build (`site/demo/vite.config.ts` reuses
  `vite.config.ts` with a relative base) with `site/demo/replay.js` run before it. Every browser
  request is `POST /api/v2/<method>` plus one event stream, so the script answers each method and
  input from `site/demo/recording.json` and keeps the stream open and quiet. A request the
  recording does not hold is refused as `unavailable` with a notice; nothing is computed, saved or
  sent. Three fallbacks were needed: table pages are cut again from recorded rows, a
  `document.read` of a document the walk opened answers with the opened buffer, and reads that
  differ only in `limit` return the recorded list.
- **Recording.** `scripts/demo-capture.mjs` starts this checkout's service on a new state, which
  copies `example/pa14-qs`, walks it with `scripts/demo-tour.mjs` (every answer on the Overview,
  the Agent panel, Studio and its three sessions, Graph, Console, Notebook, Skills, every source
  file, project settings and all twelve plugin pages) and keeps the last answer per method and
  input: 195 answers over 21 methods, 6.3 MB. Machine paths become `/home/researcher/rho`; the
  capture refuses to write if a home path, user name or credential-shaped field survives. The
  build used Rho-plugins `1eb1d3e`, clean and equal to its `origin/main`.
- **Front page** (`site/home/index.html`, assembled by `scripts/pages-site.mjs` into
  `site/.pages` with the demo and the documentation). The hero is the demo, opened on the
  project. The install prompts live in `site/home/install-prompts.json`, for Claude Code and for
  Codex, with the projects folder as a field (quoted, with `$HOME`, when it has spaces). The
  example prompts are the six requests the recording holds, with how long each took and what it
  wrote, and each plugin's own `examplePrompts`, read from its presentation at build time. The
  version shown is the registry's, not the checkout's.

### What was observed

- The install prompts' commands were run on npm 0.5.3 in a throwaway `HOME`: `npm install -g`,
  the `nohup rho … &` start (port chosen per start, JSON first in the log), the example copied
  into the projects folder, a start with `--agent-backend codex-acp`, and `rho --grant`, whose
  reply carries the `claude mcp add` command and the `mcp` entry Codex needs. No Agent has yet
  followed either prompt from start to finish, and Windows was not run.
- `scripts/demo-check.mjs` serves the tree under `/Rho/` as Pages does and walks the demo with
  the same tour at 1440 px, plus a phone pass at 390 px: 0 unanswered requests, 0 page errors,
  0 failed assets. The first run left two `document.read` unanswered, which the opened-buffer
  fallback closed. On the front page it opens the install dialog, switches to Codex, types a
  folder with a space, compares the clipboard with the prompt shown, switches prompt sets and
  requests all 11 internal links.
- Screenshots were read at 1440, 768 and 390 px. Fixed by looking: the demo first opened on the
  nearly empty project list (it now opens on the project's Overview), the closing sentence's
  folder field was clipped, terminal blocks scrolled sideways on a phone, the prompt-set tabs ran
  past the screen edge on a phone, and the demo's badge covered content inside the front page.
- In the shipped example, the Overview's "Files the Agent used" lists every file as missing and
  disabled. The recorded paths carry the project folder's name as a prefix
  (`PA14 quorum sensing/analysis/summary_figure.R`), and the walk's `document.open` and
  `agent.activity.capture` calls used those paths. This is visible in the demo and was not
  changed here.

### Limits

- The demo is a replay. Sending a message, editing, running, saving and paging a table past the
  recorded rows are refused, and times are the recording's. A change to the browser contract
  needs a new capture from the same commit as the demo build.
- `updates/*.json` and `.nojekyll` on `gh-pages` are left as they were, so an installed 0.4.0
  desktop client keeps its update feed; the deployment compares their checksums.
- No one outside this machine has used the page or the demo yet.
