# Outputs And Viewer Specification

Status: active; OUTPUTS-VIEWER-1 and prior repairs implemented; OUTPUTS-IMAGE-ARTIFACT-R1 implementation and exact local zero-Plot PNG acceptance complete 2026-08-19; broader release-candidate acceptance remains open

Date: 2026-08-05
Change class: D2 bounded workflow feature
Risk: R3 untrusted HTML and project-file WebView boundary
Owner: OUTPUTS-VIEWER-1
Next checkpoint: stop after one contract-complete implementation, affected
automation, security review, browser review, documentation reconciliation, and
an independent commit

## Authorization

The user authorized this package on 2026-08-05 after the independent Format
Document repair and menu-organization packages. This active specification is
the focused implementation contract. It authorizes only the package below; it
does not activate the remaining proposed RStudio-inspired workstreams.

## Problem And Evidence

- `Tools > Render Active Document` correctly renders `.Rmd` and `.qmd`, but a
  Markdown file reports `Not renderable` instead of offering a non-executing
  preview.
- Rendered HTML and project `.html` files open as editor source. The existing
  Artifact detail proves availability and provenance but cannot inspect the
  result itself.
- CSV and TSV files use the source editor even when a bounded table is the more
  useful default inspection surface.
- Interactive plots are HTML documents. Treating Viewer as a right-side
  Environment peer would make the inspected result secondary and would mix
  unrelated authorities.
- The existing bottom `Plots` surface already discovers Plot history and Saved
  outputs. Agent-first already provides a dominant Review work surface. These
  are the compatible navigation and inspection foundations.

## Goals

1. Evolve bottom `Plots` into `Outputs`, retaining Plot and Artifact history as
   their existing independent authorities.
2. Open a selected output in a dominant Viewer in the central work area.
3. Support static Plot images, self-contained interactive HTML/htmlwidgets,
   rendered HTML Artifacts, non-executing Markdown preview, and bounded CSV/TSV
   tables.
4. Preserve source access and efficient Source/Preview movement without adding
   a new top-level mode or right-side panel.
5. Make project containment, payload bounds, unsupported resources, loading,
   missing, malformed, stale, and failure states explicit.

## Non-Goals

- PDF, remote URLs, browser navigation, downloads, printing, DevTools, or a
  general-purpose browser.
- Executing Markdown, `.Rmd`, or `.qmd` during preview. Render remains the only
  executable document path for `.Rmd` and `.qmd`.
- Supporting non-self-contained HTML resource directories in V1.
- Creating Viewer, Plot, Artifact, Run, or project persistence or schema.
- Changing Render completion, provenance, retention, Agent approval, execution,
  environment, or project-switch authority.
- Replacing the existing bounded Workspace object Data Viewer.

## Ownership And Authority

- Project identity and containment remain broker/project-store authority.
- Render job terminal truth remains the Render job contract.
- Artifact identity, availability, provenance, and retention remain WP3 and
  P2-3B authority. Viewer reads the exact selected Artifact path; it does not
  rediscover or infer a producing run.
- Plot identity, payload, history scope, and retention remain Plot authority.
- Open documents and unsaved buffers remain editor authority.
- Outputs is a read-only projection over Plot and Artifact records. Viewer is a
  transient inspection state and creates no durable record.

## Information Architecture

### Outputs discovery

- Rename the bottom Dock tab and panel language from `Plots` to `Outputs`.
- The panel keeps the selected Plot preview and history navigator, while Saved
  outputs remains progressive disclosure in the same panel.
- Selecting a Plot preview, a Saved output, or the exact Last Render Artifact
  offers `Open in Viewer` and opens the central inspection surface.
- Agent-first Outputs continues to list existing Plot and Artifact records.
  Selection reuses the existing dominant Review work surface and embeds the
  same Viewer content there.

### Central Viewer

- Viewer occupies the editor work area, never the right context panel and never
  a new Code/Analyze/Agent mode.
- On wide viewports, an open source document and its preview use a Source/Preview
  split. The user may collapse either side through a Source/Preview/Both
  segmented control.
- On narrow viewports, Source/Preview is a segmented switch with one pane shown
  at a time. No horizontal page overflow is permitted.
- `Open Source` selects the existing project document. `Close Preview` returns
  focus to the prior source/output trigger. HTML and tables label the source
  action `Open Source` and `Open as Text`, respectively.

## Type Dispatch

| Input | Default action | Execution | Source action |
| --- | --- | --- | --- |
| Plot record | image Viewer | none | Open producing source when available |
| `.md` | sanitized preview from current editor buffer | none | Source pane/current document |
| `.html` / HTML Artifact | isolated interactive Viewer | inline scripts only inside sandbox | Open Source |
| `.csv` / `.tsv` | bounded table Viewer | none | Open as Text |
| `.Rmd` / `.qmd` | existing Render command; exact completed Artifact opens Viewer | existing Render contract | Open source document |

`Render Active Document` remains unavailable for `.md`, `.html`, `.csv`, and
`.tsv`; their command is `Preview Active Document`. Unsupported extensions
receive a truthful disabled command or `Preview is not available for this file`,
not `Not renderable`.

## Typed Read Contract

The desktop command returns:

```text
ViewerFile {
  contract: "rho.viewer_file.v1",
  project_root: normalized active project root,
  path: normalized project-relative path,
  media_type: "text/html" | "text/markdown" |
              "text/csv" | "text/tab-separated-values",
  content: UTF-8 text,
  size_bytes: integer
}
```

Rules:

- Accept only `.html`, `.md`, `.csv`, and `.tsv`.
- Resolve the requested relative path through the canonical project containment
  guard. Reject absolute, parent, drive-prefixed, symlink-escape, missing,
  directory, non-UTF-8, unsupported, and over-limit inputs.
- The default file budget is 4 MiB. Self-contained HTML uses a separate 32 MiB
  budget because embedded report figures routinely exceed 4 MiB; this remains
  bounded and does not broaden filesystem or network authority. The frontend
  applies the same media-specific budget to a current editor buffer before
  parsing or iframe construction.
- The response carries the captured normalized project root. The frontend
  rejects it as stale if the active project changed before presentation.
- Artifact opening first resolves the exact same-project Artifact record, then
  reads only that record's `output_path` through this command.
- There is no write, execution, network, approval, schema, or persistence path.

## Rendering And Security

### Markdown

- Use pinned Marked and DOMPurify browser assets, checked into the static
  frontend vendor tree with their licenses.
- Parse CommonMark/GFM-compatible Markdown without executing source code.
- Sanitize parsed HTML before insertion. Remove scripts, event handlers,
  frames, forms, embedded objects, and unsafe URL schemes. External images are
  not fetched in V1; links may be displayed but open no in-app navigation.

### HTML and htmlwidgets

- Use a sandboxed iframe with `allow-scripts` only. Do not grant
  `allow-same-origin`, top navigation, popups, forms, downloads, modals, pointer
  lock, or storage authority.
- Parse and serialize the document only to place a restrictive CSP before all
  author content and remove refresh/base behavior. Permit inline/data/blob
  script, style, image, font, and media required by self-contained htmlwidgets;
  block `connect-src`, remote/default sources, frames, objects, forms, and base
  navigation.
- The opaque-origin frame cannot access parent DOM or Tauri IPC. Parent code
  accepts no messages or commands from Viewer content.
- Show `Self-contained HTML only` in Viewer metadata. If relative or remote
  resources are detected, show `External resources were blocked`; do not imply
  a complete rendering.

### CSV and TSV

- Use pinned Papa Parse rather than delimiter splitting.
- Parse as text with header detection and explicit delimiter. Render at most
  500 data rows and 100 columns, with truncation metadata for additional data.
- Preserve empty fields as empty cells, escape all cell text through DOM text
  nodes, and expose malformed parse errors without partial-success wording.

## States And Recovery

- Empty: no output selected; Outputs explains where project results appear.
- Loading: central Viewer identifies the requested path/type and disables
  conflicting open actions.
- Success: content, type, boundedness/provenance metadata, and source action are
  visible.
- Warning: blocked HTML resources, truncated table, or incomplete Artifact
  provenance is explicit while available content remains inspectable.
- Failure: missing, unsupported, malformed, non-UTF-8, over-limit, or read error
  leaves the source/editor intact and offers retry or source access where valid.
- Stale/project switch: discard the response, close transient Viewer state, and
  never display project A content in project B.
- Restart: Viewer state is transient; Outputs history reloads from existing Plot
  and Artifact authorities and no incomplete Viewer state is restored.

## Work Package OUTPUTS-VIEWER-1

Authorized implementation:

1. Add the bounded typed desktop read command and project/security tests.
2. Vendor the pinned Markdown parser, sanitizer, and CSV parser with a
   deterministic sync script and license records.
3. Rename Plots presentation to Outputs while preserving internal Plot and
   Artifact keys/contracts.
4. Add central Human-first Viewer and shared content renderers for Plot,
   Markdown, HTML, CSV, and TSV.
5. Reuse the shared content renderer in Agent-first dominant Review.
6. Route exact Render Artifact, Saved output, project file, menu, and editor
   preview actions without changing Render execution.
7. Add real/mock parity, deterministic preview scenarios, UI/security/bounds
   contracts, responsive browser review, NEWS, and implementation evidence.

Mandatory stop: do not add PDF, remote or relative resource serving, Viewer
persistence, new Artifact discovery, browser navigation, or later WS5 review
features in this package.

## Verification Matrix

Backend and security:

- supported type success and exact media type;
- empty, boundary, and just-over 4 MiB payloads;
- absolute/parent/symlink escape, unsupported, missing, directory, and invalid
  UTF-8 rejection;
- two-project isolation with identical relative filenames;
- sandbox omits same-origin/navigation/download authority;
- injected CSP blocks network, frames, forms, objects, base, and IPC access;
- Markdown sanitization removes executable content and unsafe URLs;
- CSV quoted delimiter/newline, empty field, malformed, row/column truncation.

Frontend and workflow:

- `.md` preview uses the unsaved current buffer and does not invoke Render;
- `.Rmd/.qmd` still invoke Render and exact Artifact selection;
- `.html/.csv/.tsv` preview and source actions;
- Plot and Saved output open from Outputs; missing files fail truthfully;
- project switch discards stale content; mock command matches desktop contract;
- loading, empty, success, warning, failure, and unavailable states;
- keyboard focus, Source/Preview/Both, close/retry, wide split, narrow switch,
  long Unicode paths, and no viewport overflow;
- Agent-first output uses its existing dominant Review work surface.

Run focused tests while iterating, then the complete affected Rust crate,
frontend UI contract matrix, JavaScript syntax, Rust formatting, R bridge tests
if the command boundary affects them, and `git diff --check`. Record installed
Tauri and display-scale review separately if not run.

## Cross-Review

- The accepted 0.3.x handoff and WP3 remain authoritative for project identity,
  Plot/Artifact records, provenance, retention, and bounded object viewers.
- P2-3A/P2-3B remain authoritative for Render terminal truth and exact Artifact
  linkage. This package begins only after successful completion and does not
  reinterpret failed/interrupted Render jobs.
- PLOT-UX1 retains Plot history behavior; this package changes the containing
  presentation label and adds an inspection command without changing Plot
  record semantics.
- UX4-AWS1 retains Agent-first surface state. Viewer content is embedded in the
  already authorized dominant Review surface, not a new Agent state.
- M2 retains shell/editor/Dock geometry and menu organization retains command
  grouping. This package adds only Preview/Open in Viewer commands and the
  central transient inspection surface.
- The proposed RStudio-inspired document supplies direction but is not itself
  implemented. This focused active contract resolves its HTML inspection slice
  and explicitly excludes its remaining WS3/WS5 scope.

No schema, persistence, approval, execution, environment, credential, public
protocol, or release-policy conflict was found. The security boundary is new
and is wholly owned by this contract.

## Version, Documentation, And Release

This is user-visible behavior in the existing `0.4.0-dev.0` development line.
Update `NEWS.md` after verification. Do not bump the application or R package
version in this work package; a later named distributable candidate must decide
and synchronize its candidate version before distribution.

Installed-app acceptance is required before a candidate can be accepted:
interactive htmlwidget behavior, iframe isolation, source/preview focus,
Windows 100%/125% display scale, and project switching must be reviewed in the
exact installed build. This source package cannot change release readiness.

## Definition Of Done

OUTPUTS-VIEWER-1 is implementation-complete when all authorized types and entry
points work through one bounded Viewer contract, security and project-isolation
negative tests pass, mock and desktop commands match, affected automated suites
and browser layouts pass, an independent security/contract review has no open
blocking finding, evidence and NEWS are reconciled, only scoped files are
committed, and installed/release gates remain truthfully separate.

## Implementation And Evidence

OUTPUTS-VIEWER-1 implementation and automated/browser verification are complete
on 2026-08-05. The installed-app and display-scale gates remain open.

- Added `rho.viewer_file.v1` with project containment, UTF-8 validation, a
  four-MiB byte budget, supported media types, and project-isolated fixtures.
- Added pinned Marked 18.0.9, DOMPurify 3.4.13, and Papa Parse 5.5.4 browser
  assets with license files and a deterministic sync script.
- Renamed the Dock presentation to Outputs and added a central Viewer with
  Source/Preview/Both controls, narrow-window switching, Plot and Artifact
  actions, Markdown sanitization, sandboxed HTML/CSP, and bounded CSV/TSV.
- Agent-first Artifact Review now embeds the same isolated HTML/table/Markdown
  preview path in its existing dominant Review surface.
- `cargo +stable-x86_64-pc-windows-gnu test --workspace`: passed.
- All `scripts/test-*-ui.mjs` contracts: passed.
- `node --check desktop/dist/app.js`, Rust fmt check, Viewer contract test, and
  `git diff --check`: passed.
- Browser/mock review passed for Markdown preview and interactive HTML click
  behavior at 1440x900. At 390x844 Viewer uses one preview pane and measured
  document `scrollWidth` equals the viewport width.

Independent review closed the link-navigation and posture-residue issues by
disabling Markdown external link activation and clearing transient Human Viewer
state when switching to Agent posture. `npm audit` still reports the existing
Monaco 0.55.1 transitive DOMPurify 3.2.7 advisories; Viewer uses the direct
DOMPurify 3.4.13 asset and does not invoke Monaco's bundled dependency. This is
recorded residual dependency risk for a future Monaco upgrade, not a Viewer
security-boundary acceptance.

### HTML budget defect repair (2026-08-06)

The user authorized repair after a real self-contained scientific report
(`reports/pbmc3k_analysis_report.html`, 4,694,609 bytes) was rejected by both
the central Viewer and Agent Saved Output preview. OUTPUTS-VIEWER-1 remains the
owning contract. The repair raises only the HTML budget to 32 MiB, retains the
4 MiB default for Markdown, tables, source text, and images, uses the same
byte-based check for unsaved HTML buffers, and preserves a truthful oversized
error instead of collapsing it into generic preview failure. Acceptance
requires regression coverage above 4 MiB, rejection above 32 MiB, unchanged
non-HTML bounds, frontend contract checks, JavaScript syntax, Rust formatting,
the focused Rust Viewer tests, and `git diff --check`. Installed acceptance
remains open and separate.

Implementation and automated verification completed 2026-08-06 for
`0.4.0-dev.14`:

- the real 4,694,609-byte report is within the new bounded HTML contract;
- all 107 `rho-desktop` tests passed, including six Viewer file tests;
- Outputs Viewer, Agent Output Review, and Evidence Claim UI contracts passed;
- JavaScript syntax, Rust formatting, version/cache metadata consistency, and
  `git diff --check` passed.

The repository-wide UI contract sweep also exposed an unrelated pre-existing
Git Review assertion pinned to the obsolete `0.4.0-dev.2` asset URL. It is not
part of this repair and remains a bounded validation-maintenance follow-up.
The rebuilt installed application, display-scale behavior, and exact report
interaction have not been manually accepted, so this candidate is not yet
release-ready.

### HTML fragment-navigation defect repair (2026-08-06)

The user reported that clicking a table-of-contents link in the installed
`pbmc3k_分析报告.html` preview replaced the report with a nested Rho startup
screen. Inspection confirmed that the report uses ordinary percent-encoded
`href="#..."` fragment links. In an iframe `srcdoc`, those fragments inherit
the embedding Rho page URL, so default navigation loads the application shell
inside the opaque-origin sandbox; that nested shell cannot access Tauri and
reports a runtime-check failure.

Authorization: the user reported this Viewer defect and requested the broken
preview workflow be repaired. Change class: D1. Risk class: R2 because the
behavior is local frontend navigation but lies inside the HTML sandbox security
boundary. The authorized `HTML-FRAGMENT-NAV-1` slice requires:

- fragment-only links scroll to the matching `id` or named target inside the
  same preview document, including percent-encoded Unicode fragments;
- fragment navigation must not reload the Rho application, escape the iframe,
  or gain parent/Tauri access;
- empty fragments remain inside the preview and return to its top;
- relative, absolute, external, `javascript:`, popup, form, download, and all
  other non-fragment link activations remain blocked;
- the same sandbox transformation applies to central Viewer and Agent inline
  HTML preview without changing Artifact, project, read, or execution authority;
- focused static and browser/mock regression checks cover a working internal
  link, unchanged inline script interaction, and blocked non-fragment links.

The mandatory stop is after implementation, focused frontend/browser evidence,
security-contract review, syntax and diff checks, and version/NEWS assessment.
Exact installed-report acceptance remains separate.

Implementation and focused verification completed on 2026-08-06. The shared
`viewerSandboxHtml()` transformation now injects a capture-phase link guard
after the restrictive CSP. It prevents default link navigation, decodes
fragment identifiers, and scrolls only to a matching `id` or named target in
the same opaque-origin document. Non-fragment link events are stopped before
author handlers can navigate the frame. Central Viewer and Agent inline Review
continue to use the same transformation.

`node --check desktop/dist/app.js`, Outputs Viewer, Agent output-review, and
Agent-first frontend contracts passed, as did `git diff --check`. Browser/mock
interaction with a percent-encoded Unicode fragment moved the iframe from
`scrollY = 0` to `937` and exposed the target heading. The existing inline
script button still updated its content, while an external-link click retained
the report and one iframe without loading a nested Rho shell.

Post-implementation security review found no change to project containment,
Artifact selection, file reads, parent/Tauri access, network, persistence,
execution, approval, schema, or sandbox tokens. No version or `NEWS.md` update
is made because no new distributable candidate was produced and this repair is
not present in `0.4.0-dev.14`. The next rebuilt candidate must advance to
`0.4.0-dev.15`, record the repair in `NEWS.md`, and repeat the exact installed
`pbmc3k_分析报告.html` link acceptance.

### Saved image Artifact preview repair (2026-08-19)

The project owner's local `0.4.1-dev.1` test selected a valid generated PNG
Artifact while the current Workspace session contained zero Plot records. The
file exists inside the project (`2400 x 1800`, `image/png`, 189,734 bytes), its
same-project Artifact record is complete, and historical Plot payloads remain
renderable. `renderPlotsContent()` nevertheless called `showPlotSurfaceState`
and returned immediately on `!plots.length`; `renderArtifactRecords()` rendered
metadata only. Artifact selection therefore could not populate the main Outputs
preview, and Viewer required a separate action.

`OUTPUTS-IMAGE-ARTIFACT-R1` is an explicitly authorized D1/R3 repair:

- current-session/history Plot filtering remains Plot-only and cannot suppress
  a selected Saved image Artifact;
- selecting an Artifact clears active Plot selection and loads only that exact
  Artifact path through existing `viewer_read_file()` containment, media, size,
  generation, and active-project checks;
- supported image media are `image/png`, `image/jpeg`, `image/gif`, and
  `image/webp`; their bounded base64 response is rendered in the existing main
  Outputs image stage without creating another file read or durable record;
- asynchronous preview state is bound to project root, Artifact ID, path, and a
  monotonic request sequence; late project/selection results are discarded;
- loading, missing, unsupported, malformed, oversized, stale-project, and read
  failure states clear any previous image and display truthful output-specific
  copy;
- clicking a Plot restores Plot preview precedence; clicking a Saved image
  Artifact immediately restores Artifact preview and makes Open in Viewer
  target the Artifact rather than a previously selected Plot;
- non-image HTML, Markdown, table, and source Artifacts retain central Viewer
  behavior and are not injected into the image stage;
- project switching clears Artifact preview bytes and invalidates pending
  requests; and
- no schema, persistence, network, execution, write, remote URL, sandbox,
  retention, provenance, or filesystem authority changes.

Regression evidence must cover zero Plot + selected PNG, Plot + selected PNG,
artifact/plot switching, missing/unsupported/error, stale request/project,
project reset, Open in Viewer target selection, and the existing 4 MiB image
limit. Local acceptance uses the owner's existing PNG and performs no Agent or
Workspace execution.

Implementation and bounded local evidence on 2026-08-19:

- Artifact preview state is now bound to the selected Artifact, normalized
  active project, exact Viewer response path, media type, and monotonic request
  sequence. A selected image retains main-stage and Open-in-Viewer precedence
  across background Plot-list refresh; explicit Plot selection clears it.
- The existing WebView script URL gained the `outputs=image-artifact-r1`
  cache-buster so a rebuilt app cannot continue executing a cached pre-repair
  `app.js` under the unchanged development version.
- `node --check desktop/dist/app.js`,
  `node scripts/test-outputs-viewer-ui.mjs`,
  `node scripts/test-agent-output-review-ui.mjs`, and `git diff --check`
  passed.
- An unsigned Apple Silicon app build completed with
  `npx -y "@tauri-apps/cli@2.11.4" build --target
  aarch64-apple-darwin --bundles app`. The exact repository bundle, rather than
  the same-bundle-ID copy in `/Applications`, was targeted for acceptance.
- In the owner's `test_rho` project, selecting the recorded
  `scatter_plot_example.png` while Session showed zero Plots rendered the real
  `2400 x 1800` PNG in the main Outputs stage. No Agent call or Workspace
  execution was performed.

The browser/mock matrix, failure injection, two-project isolation, and full
cross-platform matrix were not run in this local repair round. No application
version or `NEWS.md` change is made because this is an uncommitted local test
build, not a newly named or distributed candidate; the next candidate that
includes the repair must advance version metadata, add release notes, and run
the remaining acceptance matrix.
