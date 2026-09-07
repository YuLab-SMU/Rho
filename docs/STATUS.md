# Rho: current state and focus

Updated: 2026-09-07. This is the single current status page. Code and reproducible
results establish what exists; Git retains completed work and its history.

## Current focus

**Refine Studio into a coherent professional scientific workbench.**

The local editing and R execution loop is implemented. User review finds the
overall appearance promising, with substantial interaction problems still open.
Functional acceptance does not establish that the experience is polished.

The next design work should apply the proposed
[product philosophy](RHO-DESIGN.md) to the
[reported usability issues](STUDIO-FEEDBACK.md), using the same analysis project
across editing, Console exploration, object inspection and repeated plotting.
The philosophy is v0.1 for review; it is not a claim that the UI implements it.
The gapminder tutorial supplies scenarios, not an automatic feature roadmap.

This documentation rewrite does not start UI refinement or change running sessions.

## Implemented baseline

| Area | Current behavior |
| --- | --- |
| Studio | Local browser application launched by `rho workbench`; React, FlexLayout, CodeMirror and embedded assets |
| Local R | Discovery, configuration and explicit restart; one project and one live R session per Host; file editing remains available without usable R |
| Documents | Filesystem browsing, UTF-8 editing, BOM/line-ending preservation, digest-checked saves, captured save-then-run content, formatting comparison and synchronized drafts |
| Output | Bounded incremental text, paginated operation summaries, original PNG/JPEG/SVG references, plot history and observed Ark/R resource metrics |
| Objects | Read-only metadata and bounded previews; busy queries retain the previous observation |
| Layout and recovery | Docking, grouping, collapse/maximize, document state outside panel lifetime, SQLite state across ports, explicit multiwindow conflict handling |
| Shared execution | CLI, session protocol, browser and official MCP use one Host and the same scientific operations |
| Other domain capabilities | Project/Git operations, isolated package environments, local processes and configured SSH/Slurm execution; these are not all exposed as Studio panels |

The reproducible Studio baseline is commit `d5a970b1559c9bd85567073108d05bca21886de4`,
tagged `studio-round1-baseline-2026-09-07`. Current documentation changes are
separate from that application baseline.

## Open experience issues

The user's feedback remains open. Detailed observations and questions are in
[STUDIO-FEEDBACK.md](STUDIO-FEEDBACK.md); this table summarizes the current focus.

| Topic | Required direction or unresolved question |
| --- | --- |
| Component removal | Make removal and reopening discoverable; determine why the user's intended action fails |
| Group docking | Make placement around several panels understandable, including parent-group and workspace targets |
| Interface language | Use consistent English for product-authored UI; preserve Unicode user content and native output |
| Editor | Improve actual R syntax recognition and readability |
| Console | Establish prompt/transcript continuity and fluent keyboard interaction |
| Object inspection | Expand details in place by default; open a separate tab only through an explicit action |
| Plots | Review navigation, zoom, layout, export and recovery together in a real workflow |

The English interface and revised object-inspection interaction are requirements,
not descriptions of the current UI. Console and plot feedback needs concrete
scenario observation before choosing a redesign.

## Evidence and its limits

The application baseline was checked on macOS with Chrome and R 4.5.2:

- Rust workspace tests, Clippy, formatting and generated client/asset checks;
- 14 Vitest/React Testing Library tests and 15 isolated Chrome scenarios, including
  the real save/run/object/plot loop, UTF-8 pages, BOM/CRLF, conflicts, layout,
  focus, restart, reconnect and R configuration;
- real Ark/R, HTTP/MCP, Environment and process-recovery scripts, plus local
  SSH/Slurm protocol fixtures. Environment tests use temporary fixture libraries
  and verify that the user's R library is unchanged.

These are recorded baseline results, not a fresh runtime test claim for every
subsequent documentation edit. Current test entry points and prerequisites are in
[DEVELOPMENT.md](DEVELOPMENT.md). Logs and screenshots belong with their runs.

A separate 2026-09-06 acceptance exercised CPU jobs on YuLabServer with Slurm
19.05.2. That evidence does not cover arbitrary clusters, GPU allocations or
connection providers. Windows/Linux, other browsers and distribution require
separate verification. SVG attack fixtures test the rendering boundary; actual
Ark PNG tests establish the scientific plotting path.

## Scope

Current product work concerns the local scientific workspace and its interaction
quality. There is no active implementation commitment for a native desktop shell,
installer/updater, Vibe, plugin loader, collaboration, multiple-runtime orchestration,
LSP/DAP, full package/data browsers or Quarto integration.

[Scenario plugins](SCENARIO-PLUGINS.md) remain research. Data from abandoned
implementations is not a supported input; there is no migration or compatibility
workstream. Current application data and its recovery remain supported responsibilities.

## Keeping this page useful

Update current behavior, open focus or evidence when it changes. Keep proposals,
implemented behavior and verified outcomes distinct. Replace stale summaries;
do not append daily logs, completed phase tables or a second capability registry.
The runtime registry owns exact capability schemas. Use Git to recover past decisions.
