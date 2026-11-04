# Documentation site

Updated: 2026-11-04.

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

## The install prompt on a real machine

On 2026-11-03 the user shared one run of the Codex prompt, in Codex on another Mac with Node
26.10.0, and asked for the problems it exposed in Rho to be fixed before the prompt itself is
changed. That run's own record is not on this machine; what it showed comes from its
screenshot, and each cause below was found in the source and then run here.

### What was observed

| In the run | Cause | Change |
| --- | --- | --- |
| Step 1 stopped on Node 26.10.0. Told to skip it, `npm install -g` finished in 4 s with one `EBADENGINE` warning, and Rho started | `engines` was `>=22.22.0 <23`, while 24 and 26 are the current LTS lines. Only Rho's own range is checked; the bundled plugins' ranges print nothing | `>=22.22.0 <27`; CI also installs the candidate on Linux x64 with Node 24 and 26 |
| The `nohup rho … &` start left no running process; Codex then started Rho in the foreground | Not established. A check of which background processes outlive a Codex command was not run here: the session's permission check refused it | None |

Reading the prompt's later steps against the source found four more, each reproduced on the
published 0.5.3 in a throwaway folder:

- **A restart moved Rho to a new port, and the Agent's tools stopped working.** Every start took a
  new port (53149, then 53161), while the connection file `--grant` writes keeps the address it
  was given, so Codex's `rho_index` answered `Delivery outcome unknown`. With `--port` fixed, the
  same grant worked across a restart. Now a start without `--port` takes this state's last port;
  only when another program holds it does it take a new one, and each Agent connection file that
  named the old address is rewritten to the new one with its token. `--port 0` still always takes
  a new port.
- **Codex connected with `--grant` showed under Claude Code.** `--session` defaults to
  `claude-code`, which the project page reads as Claude Code's grant, and the CLI records no
  `mcp add`, so even `--session codex` shows "Access only". `rho --grant … --agent codex` (or
  `claude-code`) now does what the page's "Add to …" button does: the grant, that Agent's own
  `mcp remove` and `mcp add`, and the record the page shows.
- **Refusals printed stack traces.** A second start on a running state, a `--port` already in use,
  and `--grant` while Rho is stopped now print one line each: where Rho already runs, which port
  is taken, or that Rho is not running at its address.
- **The Agent was told the outcome was unknown when Rho was not running.** Agent 0.4.28's bridge
  reports a refused connection as `unavailable`, naming the address, with `delivered: false`: no
  byte reached the service, so nothing ran. Other transport failures keep their unknown outcome.

### Checks

- On a build of these changes, in a throwaway folder: a restart without `--port` kept 58224; with
  58224 held by another program the next start took 58283, the grant named 58283 and `rho_index`
  answered; `--grant --agent codex` ran a stand-in `codex` with `mcp remove` and `mcp add`; each
  refusal printed its one line.
- `test/agent-connect.test.mjs` gains the operator's `session.connect` and the restart and
  taken-port cases; `test/cli-refusals.test.mjs` runs the CLI's refusals; the writer-lock test in
  `test/service.test.mjs` now expects the taken port as a `conflict` naming it, and still checks
  that the failed start released its lock.
- The full suite passed on Node 22.22.3, 24.22.2 and 26.13.0 (284 of 286, 2 skipped). One
  earlier run on 22 failed two timing-bound tests (a changed-file record and the bridge's waited
  Notebook call); both passed alone twice and in the next full run.
- A candidate packed from this tree (darwin-arm64 only, a debug Core, the dirty-tree override)
  passed `ci-install-check.mjs` on Node 24.22.2 and 26.13.0: offline install, its own Core,
  orderly stop, recovery 7 and the ordinary project 7. Installed on Node 26 it printed no
  `EBADENGINE`.
- The bridge, pointed at a closed port, answered `unavailable` with the address where 0.4.27
  answered `Delivery outcome unknown`.

### Not done

- The prompts are unchanged.
- Why the background start ended is not known, so no detached start was added.
- R and the example's packages are checked neither by the prompt nor by a start with folders:
  Rho's R session needs `jsonlite`, and the example's scripts use `ggplot2`, `dplyr`, `tidyr`,
  `patchwork`, `scales` and Bioconductor's `DESeq2`.
- The writer lock on macOS and Linux needs Python 3. On a Mac without the Command Line Tools,
  `python3` is only a prompt to install them; that start was not observed.
- `codex mcp add` adds the project's tools to every Codex session on the machine. Whether
  Codex sessions that Rho itself starts also load them was not checked.
- Agent 0.4.28 is a Rho-plugins change; Rho composes it from Plugins `3b81626` on.
- Windows was not run, and CI has not run these changes.

## Desktop installers taken off the front page

On 2026-11-04 the user asked for the front page's desktop installers section to be removed:
the current desktop version has not been released, so a page offering 0.4.0 installers points
visitors at a line that is not the current Rho. The section's table of 0.4.0 installers and
checksums, its Windows code-signing statement and its uninstall notes are gone, with the header's
Downloads link. The one line that applied to the npm package moved to the requirements table under
"Or install it yourself" as an Uninstall row. The documentation home no longer points at a
downloads page, and the README no longer calls the installers the earlier line.

What stays: the v0.4.0 GitHub Release and its assets, the footer's Code signing policy link, and
`updates/*.json` with `.nojekyll` on `gh-pages`, so an installed 0.4.0 desktop app keeps its
update feed. The demo was not rebuilt: it stays the build deployed from `5c28b441`, which matches
its recording.

## Setup page and Agent skill

On 2026-11-04 the user asked for a skill kept outside Rho that guides an Agent to install Rho,
use it, and apply it to different needs. Another pass had first answered the same request with
`rho.analysis-run`, a Skill served inside Rho. The user then asked for a setup page, so that a
first-time person need not paste the long install prompt and only says: "请阅读
https://yulab-smu.top/Rho/doc/setup.md 文档，按照步骤为我安装并配置 Rho。"

### What was built

- **`skills/rho/`** is an Agent Skill for the Agent's own skills folder: `SKILL.md` and six
  references (install, connect, tools, analysis, needs, troubleshooting). It works before Rho
  is installed and marks the behaviour that appeared after the published 0.5.3.
- **[`SETUP.md`](../SETUP.md)** is served as raw Markdown at
  <https://yulab-smu.top/Rho/doc/setup.md>. It has eight steps for the Agent:
  1. Check the machine.
  2. Find an existing Rho.
  3. Install.
  4. Start on `~/Rho/projects` and `~/Rho/state`, the folders a start without flags uses after
     0.5.3.
  5. Install the skill from <https://yulab-smu.top/Rho/skills/rho/>.
  6. Connect itself to the example project.
  7. Check R.
  8. Report.

  Windows has its own short section.
- **`scripts/pages-site.mjs`** copies both into the pages tree. It refuses a `SETUP.md` whose
  download list differs from the files in `skills/rho`; a scratch copy missing one reference
  was refused before anything was built. CI treats both as documentation.

### What was observed

- **The skill against npm 0.5.3.** Its commands and reply shapes come from 0.5.3 installed in
  `/tmp`, with `rho --mcp` driven over JSON-RPC:
  - a 75 KB reply came back as a reference and was read by the paths `rho_read` gave;
  - a released reference answered `not_found`;
  - `waitMs` held a 45 s cell until it finished;
  - the same `changeId` returned the same cell in 32 ms;
  - `ggsave` worked in a simple cell;
  - `--version` does not exist, and a start without flags exits 2;
  - a second start exited 1 with "Another Rho service holds …".

  These runs corrected nine statements in the first draft. Among them were the version from
  which a restart keeps its port, the page size of `rho_read` text, and the stop command:
  `pkill -f "--state-dir …"` can match the shell that runs it, and `[-]-state-dir` cannot.
- **A fresh Claude Code session.** Claude Code 2.1.318 (Haiku 5.5) had only the skill, Rho's
  tools and file tools, with no shell. It answered an airquality question in the Notebook:
  - it loaded the skill unprompted and read only the two references the task needed;
  - 3 `rho_index`, 2 `rho_resolve` (one a page continuation) and 6 cells, with 0 refusals;
  - 30 turns, 7.2 minutes and $0.29;
  - it wrote its notes first, ran the whole script with `source()` and checked the result files
    against memory;
  - it corrected a column it had computed wrongly, and added a sensitivity check that weakened
    its own conclusion.

  The Overview showed the six runs, the figure and both tables. The Notebook gave each cell its
  purpose and "An Agent". This is one small task, not a rate, and it does not compare with the
  five papers.
- **`SETUP.md` by hand.** It was followed command by command on 0.5.3, in a throwaway `HOME` and
  npm prefix, without `--open`:
  - the install took 5 s;
  - the plain `nohup … &` start still answered from a later command, and the example was copied;
  - the skill downloaded from a local copy of the pages tree into Claude Code's and Codex's
    folders, identical to `skills/rho`;
  - `claude mcp add`, run in the project folder, showed "✔ Connected" there and nothing
    elsewhere;
  - the Codex entry, started as configured, answered `rho_index`;
  - `jsonlite` was found. The example-package check reported `car` and `DESeq2` missing only
    because the throwaway `HOME` hid the person's R library; it reports nothing missing with
    the real `HOME`;
  - the stop command stopped that service and no other.

### Limits

- No Agent has followed the setup page from the one-sentence prompt. A nested Agent with a
  shell and no approvals was refused by the session's permission check, so the page was
  followed by hand, not by a model.
- Codex was not run as an Agent; only its configuration commands were. Windows was not run.
- The front page's install prompts are unchanged. They still use `~/rho-projects` and
  `~/.rho-service`, which the page and the skill recognise.
- An Agent whose fetch tool summarises pages may miss commands. The page asks it to fetch the
  whole file with `curl` when it has a summary.
