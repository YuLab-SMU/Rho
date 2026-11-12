# Notebook follow-up and 0.5.10

2026-11-12. The user asked to finish the gaps left by
[in-place editing](SIMULATED-PROJECT-EPISODE.md#editing-in-place-and-names) and
[whole-project removal](SIMULATED-PROJECT-EPISODE.md#removing-a-project), then publish a version.
This batch selects Rho 0.5.10 and Notebook 0.5.23; Core remains `8bed8ef`.

## Changes and observations

- **Python names.** Completion now offers keyword arguments of a named function or method,
  leaving out positional-only and supplied parameters, and module names after `import` and
  `from … import …`. It reads function code without evaluating annotations or custom signature
  hooks. It lists import paths without importing packages; an already loaded module also offers
  its attributes. A regression package raises if imported, and functions, properties and a module's
  dynamic attribute hook raise if called: completion offers the expected names without any of
  those effects, output or additional cells. Existing line, count and time limits still apply.
- **Session endings.** In-place runs fold only within the same session. After stopping Python,
  editing an old cell and running `print(99)` leaves the old result before its end mark and puts
  the new cell after the new session's start. The earlier session and its error output remain
  inspectable. The Console remains a chronological transcript of every run.
- **Overview links.** A cell opens the notebook it ran in, including the Project notebook and a
  named notebook, rather than whichever notebook the workspace opens first. The Pages acceptance
  reproduced the missing cell, then passed with both kinds of notebook.
- **Shell acceptance.** Its removed evidence-toggle selector and the old Agent panel contents
  were stale. It now checks the actual Agent button, conversation input, Escape and focus return
  at desktop and phone widths, and keeps the layout, unsaved-buffer and declared-item checks.
  It passed; the product did not acquire a replacement evidence drawer.

## Real runs

`scripts/notebook-acceptance.mjs` ran in Chrome on a disposable Rho project. Local sessions used
R 4.5.2 and Python 3.13.1. A disposable Debian bookworm container, reached through real OpenSSH
with its own key/configuration, used R 4.2.2/jsonlite and Python 3.11.2. Each location passed R
column completion, Python argument and import completion in the actual editor, Escape without a
run, in-place execution, earlier outputs, division-by-zero and repair, and rerunning after the
old session ended. The screenshots were read: names appear at the caret, the error remains in
earlier runs, and the old end and new start separate their cells.

The same script used a controlled ACP peer to call the real Notebook operation under its own
conversation grant. The conversation's Studio showed that cell, a person changed it from 50 to
51 in the same session, and its editor offered `studio_value`. This is actual Studio routing,
R/Python execution and editor behavior, with a protocol peer rather than a model. Its past
timeline offers no edit/run controls.

`scripts/project-remove-agent-episode.mjs claude` and `… codex` used real Claude Code 2.1.322 and
Codex 0.164.0, each with Westlake's `glm-5.3-flash` through the existing isolated configuration.
Each model invoked a native Python command and waited for it. With a terminal, another command
and a live Python session also running, the browser's removal dialog counted all four kinds and
stopped nothing. **Stop and remove** ended the Agent and its native tool, command and session;
seven process identities were checked for Claude, six for Codex. The terminal closed. Restoring
the project retained the original turn identity and project files. Codex 0.164.0 was selected
explicitly; this does not establish behavior for every installed Codex version or provider.

## Verification and evidence

| Check on macOS arm64 / Node 22.22.3 | Result |
| --- | --- |
| Rho complete suite | 371 passed, 3 Windows-only skipped, 0 failed |
| Plugins complete suite | 227 passed, 8 skipped, 0 failed |
| Focused live-completion regressions | 3 passed |
| Pages and shell browser acceptances | Passed, including four widths |
| Frontend and plugin development acceptances | Passed |
| Notebook local, real SSH and conversation Studio | Passed |
| Real Claude Code and Codex removal | Passed |

Plugins skips were five Windows-only checks and three requiring unavailable Python plotting
packages. CI's separate figure-describer jobs retain their own installed dependencies. The
preceding composition, Rho `3381a9f4` / Plugins `ad9edcf`, passed all 18 jobs in
[CI 43288867177](https://github.com/YuLab-SMU/Rho/actions/runs/43288867177), including Windows
(368/374, six skipped); Status's previous “not run on Windows” was stale.

Evidence stays in ignored `work/`: the `remaining-*.log` suite logs, `notebook-*` screenshots and
reports, and `remove-claude-*` / `remove-codex-*` reports. Initial harness failures are retained:
an unset Core in the old launcher scripts, stale selectors, synthetic editor input before its
state updated, Enter inside CodeMirror's 75 ms acceptance guard, and a cell injected after a
controlled conversation without a corresponding tool event. The passing Notebook peer actually
calls the operation and reports its tool event. An overlapping Plugins/Rho build also failed
while Plugins removed its old declarations; the sequential build and full Rho suite passed.

## Delivery scope

Version 0.5.10 is selected for the existing [unsigned npm workflow](RELEASE.md#ci-and-npm-publication):
publish the Plugins source first, select that immutable commit, publish Rho once, wait for its
CI tests and offline installations, and promote that retained candidate with `v0.5.10` without
rebuilding. Publication, registry availability and a fresh installation require their own
receipts; source checks alone do not claim those outcomes.

These runs are the builder's checks, not an independent usability study. Remote checks covered
one disposable Linux server, not the lab cluster or a scheduler. Python completion does not
import an unloaded package to discover dynamically created exports. No user Host, R session or
running Rho service was restarted.
