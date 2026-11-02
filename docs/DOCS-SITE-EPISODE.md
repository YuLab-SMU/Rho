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
