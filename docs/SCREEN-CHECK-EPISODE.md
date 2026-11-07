# Layout checks in a real browser

Updated 2026-11-04.

## Question

Eight untracked probe scripts sat in the checkout root. Each opened fixed local pages in Chrome and printed what it found: overflow, overlapping boxes, page errors, screenshots. Each was a one-off, with hard-coded paths and one Chrome location. The question was whether those checks could be a capability anyone can run on any page: a developer, or an Agent that has the Rho Skill installed.

## Setup

- `rho-screen-check <url or page.html>` (`scripts/screen-check.mjs`) opens the page at 1440×900, 1024×768, 768×1024 and 390×844, waits 800 ms, writes one screenshot per width and `report.json`, and prints the same report as JSON. The measurements are `pageFindings` in `scripts/browser-checks.mjs`.
- The browser is Google Chrome through `playwright-core` 1.64.1, then Microsoft Edge, then Playwright's Chromium, unless `--browser` names one.
- The Skill `rho.screen-check` serves the practice text (`src/screen-check-skill.ts`). `skills/rho/references/screen-check.md` carries the same text for an Agent that has no connection.
- The project was a copy of the shipped `example/pa14-qs`, opened with `project.open` in a scratch service with its own state folder. The Open folder button was not used: on this machine it opens a native dialog.
- The checks ran from a verification copy built from the checkout's tracked and new files, not from the checkout's own `dist/`.

## The eight probes

- `findover.mjs` and `overlap.mjs` found overlapping boxes at one width. That is `--overlap SELECTOR`.
- `shot2.mjs`, `shot3.mjs` and `shot-artifact.mjs` took 1440 px screenshots of named files, and `shot3` also collected page errors. That is one screenshot per width, and `pageErrors` in the report.
- `narrow.mjs` took 390 px screenshots at 2× scale. The tool captures at 1×.
- `shot3all.mjs` and `final4.mjs` checked fixed design pages. Their pages are passed to the tool one at a time. `final4` is a subset of `shot3all`.

Several probes blocked outside requests before loading the page. The tool records those requests and blocks nothing, so the page loads as it does for a person.

## Observed

The home page (`/`) at four widths: no horizontal overflow, no elements past the edge, no unnamed buttons, no page or console errors, and no outside requests. The 390 and 1440 screenshots show the project list and its actions whole.

The workspace (`/#project=<id>`) was run twice: first with the copy named `pa14-qs`, then with the install name `PA14 quorum sensing`. Both runs gave the same numbers.

| Width | Horizontal overflow | Past the edge | Not kept in by a box | Failing responses |
| --- | --- | --- | --- | --- |
| 1440 × 900 | no | 89 | 0 | 1 |
| 1024 × 768 | no | 291 | 0 | 1 |
| 768 × 1024 | no | 325 | 0 | 1 |
| 390 × 844 | no | 317 | 0 | 1 |

- The past-edge elements are `span.tl-band`, `span.tl-fold` and `i.graph-tick.tl-block`. Each sits inside the scrolling main pane, so none is unkept. The totals count boxes, not defects.
- The failing response is `POST /api/v2/agent.activity.capture`. It answers `404 not_found` with "This file is not in the project any more." The request path is `PA14 quorum sensing/analysis/summary_figure.R`. The file is at `analysis/summary_figure.R` inside the project.
- The sidebar study title "Co-culture rescue: does mixing Δrhll and Δlasl restore swarming, and at which ra" is cut mid-word at 1440, 1024 and 768 px. No box reports it. Only the screenshot shows it.

### The 404

The agent plugin is not the cause. Its two functions behave as their contracts say, checked directly on the built plugin:

- The observer turns an absolute path, the form a live run stores, into `analysis/summary_figure.R` with state `observed`. The prefixed form from the example comes out as `PA14 quorum sensing/analysis/summary_figure.R` with state `missing`.
- Capture refuses the prefixed path with `not_found`, "This file is not in the project any more." It refuses the existing `.R` file with `unavailable`, because only CSV, PNG, JPEG and SVG can be captured.

The prefix is in the example's recorded data. All 12 distinct observed location paths in `example/pa14-qs/.rho/rho/conversations` carry it, while the turn's evidence records hold `analysis/summary_figure.R`. The manifest says its curation "removed … the folder and host the build ran in", which fits. A search for the manifest's `modelCatalogues` field finds only `example.json`, so the curation script is not in the repository. The folder name is not the cause: the run under the install name gave the same 404.

The request is the preview's. It has no `expectedDigest`, and an R script is not capturable, so it can only come from `web/previews.ts:32`. That line asks the server to capture a node's file whenever capture is available and the node has no resource, with no extension check; `web/canvas.ts:54` checks `capturable` first. On a live run the R script would still be requested and refused as `unavailable`. That follows from the code and the direct check; I have not seen it in a live browser.

Both were fixed in Rho, not in the agent plugin. The preview asks for a capture only when `capturable` names the file, the same test `canvas.ts` already applies. The server accepts exactly those kinds, so no request that could succeed is removed. The example's 256 bare project-file values lose the projects-folder prefix (`PA14 quorum sensing/analysis/x.R` becomes `analysis/x.R`). The 38 occurrences inside command text stay as the agent ran them. A leaf-by-leaf comparison with the previous commit shows that only those 256 values changed.

## Changed

- `pageFindings` counts elements past the edge that no box keeps in (`elementsPastEdgeUnclipped`) and lists them first.
- The report lists each failing response with its status and address (`httpErrors`).
- The Skill names both fields and the mid-word blind spot.
- `test:screen-check` builds first, since its Skill test imports `dist/`.
- `playwright-core` is a runtime dependency and is listed in `bundleDependencies`, so an offline install still works. The person accepted its size, about 13 MB unpacked.
- `web/previews.ts`: a file that no capture can open gets the note "Preview could not be read" without a request, and it no longer uses one of the preview slots.
- `example/pa14-qs`: the three recorded conversations name their project files relatively, in the form the turns' evidence records already use.

## Checks

- `npm run test:screen-check` in the verification copy: 20 of 20 pass, none skipped, exit 0. Five are Skill tests: the reference matches the served text and digest, every option the Skill names appears in `--help`, every failure kind it names is emitted, SETUP and SKILL route to the reference, and the service lists the Skill with the same text. Fifteen cover the findings and the command; the ones that open pages use Chrome.
- `node --test test/skills.test.mjs` in the copy: 3 of 3, with `Rho-plugins` linked beside it. Without that link, the verify-script paths do not resolve and one check fails. That comes from the copy's layout, not from the change.
- `npm pack --ignore-scripts` in the copy: 1,439 files, 12.3 MB packed and 36.9 MB unpacked. `playwright-core` adds 115 files, about 13 MB unpacked.
- The tarball installed offline (`npm install -g --offline`) into a scratch prefix. Its bins are `rho`, `rho-screen-check` and `rho-ui`. The installed `rho-screen-check` found the overflow on a fixture at 390 px and exited 0, and reported nothing on the live home page at four widths.
- After the fixes, with a fresh service on the fixed example: the workspace load made 56 API responses, all 200, and no capture call. The four-width check found no HTTP error, page error, console error or outside request, and nothing unkept. Past-edge counts moved to 84, 280, 315 and 307, because the observed paths now resolve; all sit inside scrolling boxes. A direct capture of `results/summary.png` returns a media resource, and `results/summary.md` is still refused as `unavailable`.
- The observer over the fixed records: 98 references, 12 distinct files, all `observed`. `test/example-project.test.mjs` passes 4 of 4. The copy's build, including the web type check, passes.

## Limits

- Only macOS Google Chrome was used. Edge, Playwright's Chromium and a path given to `--browser` are covered only by the missing-browser test.
- Screenshots are at scale 1. The tool has no 2× option.
- An Agent trial that runs the tool through Bash has not been done. Auto mode blocks Bash without authorization.
- The release route has not run: `pack-local` bundles every dependency, so `playwright-core` also enters the release candidate, and the candidate's size and the Windows install time are unmeasured.
- Installations that copied the example before this keep their copy, which is never overwritten. The preview stops asking for those files, but their observer still reports the prefixed paths missing.
- The mid-word sidebar cut is not detected by the tool.
- At the end of this trial, the changes had not been committed or pushed, and the eight probe scripts were still untracked.

## Checkout cleanup on 2026-11-07

The eight probes were removed after confirming that their reusable checks are
already in `scripts/screen-check.mjs` and `scripts/browser-checks.mjs`, with their
differences recorded above. No fixed local-page paths or one-off scripts enter
the package. The five untracked dsh-rho prototype artifacts under
`adapters/dsh-rho/lib/` were also removed: `index.cjs`, `store.mjs`,
`store-next.mjs`, `composition.json` and `THIRD_PARTY_LICENSES.txt`. Their old
TypeScript entries were removed in `be6f3943`; the current adapter uses
`src/host.cjs` and the separately retained observation bundle.

The [sclet acceptance reports](THIRD-PARTY-PLUGINS-EPISODE.md#retained-machine-records)
were retained as evidence. The standalone commit-count chart was moved to the
ignored local folder `work/checkout-cleanup/2026-11-07/`; its generating script
was not among the untracked files, so it is kept as a historical image rather
than added to the product. Only `output/third-party-plugins/` and `output/viz/`
were newly ignored; existing tracked design and PDF artifacts remain tracked.

Checks on the current checkout after removal: `npm run test:screen-check` passed
20 of 20 with no skips; `npm test --prefix adapters/dsh-rho` passed 7 of 7;
the three archived reports passed their SHA-256 checks. The documentation build
and coverage check passed, and 86 local links and anchors in the three changed
documents resolved. These checks do not rerun the historical sclet analysis.
