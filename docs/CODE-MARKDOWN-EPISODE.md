# Code, Markdown and runs in a project

Updated 2026-10-29.

## Question

The user asked to put Python scripts and a Markdown report into the test project and
see how Rho shows code, runs it and renders Markdown, then chose to work in three
steps: code highlighting, Markdown rendering, and legible Agent runs. A Run button
for the person is left out for now.

## Setup

`test/ozone-report/` in the dev service: `analysis.py` (pandas, matplotlib),
`model.R` (ggplot2), `data/airquality.csv`, outputs in `figures/` and `results/`
from real runs, and `report.md` with two tables, three figures, inline and display
math, Python and R code blocks, links to the scripts, a quote and a task list.
Observation scripts and screenshots are in `work/code-md-episode/` (ignored). Later
checks use a copy of the project in a disposable service.

## Observed before

Rho 65dcc8d3 with Documents 0.4.5 (`before/`, `run-2026-10-29T06-50-54-612Z/`):

1. `.py` and `.R` showed as plain monospace text, in place and in Studio. The editor
   had line numbers, wrapping and Agent marks, no language.
2. `report.md` showed as raw Markdown: tables as pipes, broken across lines in a narrow
   Studio column, images as `![…](…)`, math as `$…$`. Rho's Markdown renderer exists
   only for Agent replies and has no images, math, task lists or relative links.
3. The person had no way to run a script. Asked to run both and check the report, the
   Agent (workbuddy-ai/deepseek-v4.1-flash, the saved Westlake settings untouched)
   ran `python3 analysis.py` and `Rscript model.R` in its own shell and compared each
   number. The Graph showed question → runs → the figures and table that changed during
   each run, but a run node said only "Returned": no exit code, duration or output.
   Run titles carried `rtk`, a wrapper from the person's own Claude Code hook.

## Step 1: highlighting

### Changed

- Documents 0.4.6: the editor takes `extensionsFor(path)`, CodeMirror extensions the
  application adds for a document's path. It is asked once the buffer's path is known
  and applied in place, so the text shows at once and the buffer is untouched; a
  failure leaves the text plain. Exact-version views take the same. Annotations 0.4.7
  widens its peer.
- Rho chooses the language by file name (`.py`, `.R`, `.Rprofile`, `.md`, `.Rmd`,
  `.qmd`) and loads it the first time a file of that kind opens: lang-python,
  CodeMirror's legacy R mode, lang-markdown with fenced Python and R, including R
  Markdown's `{r label, …}` chunks. One highlight style uses Rho's colour tokens
  (`--code-*`). Each language is its own chunk; the main bundle grew by about 3.6 KB.

The first version derived the path from the project snapshot. The sources acceptance
caught that a quiet project's snapshot does not list a document opened since, so the
text stayed plain; the editor now asks with the buffer's own path.

### Observed

`highlight/` and `after-hl/`: Python keywords, strings, numbers and called functions
are coloured; R comments, strings and numbers (the legacy mode does not mark calls);
Markdown headings bold, markers dimmed, links tinted, and fenced code coloured by its
language. Typing and undo work as before.

### Checks

Rho-plugins 97/97. Rho 218/218 serially; `acceptance:sources` now checks that an R
script's comment and string take their colours; `frontend` and `person` (9/9 at 1440,
768 and 390) passed.

## Step 2: Markdown read as formatted text

### Changed

- A new package in Rho-plugins, `@rho-workspace/plugin-markdown` 0.1.0, is a UI
  extension over the Documents capability (component `markdown.reader`), so Documents
  stays format-agnostic. It reads the buffer every view of the document shares and
  renders it with markdown-it 14.3.2 (tables, task lists, autolinks) and KaTeX
  0.16.47 for math; the document's own HTML stays text. Read and Source sit in the
  view's header; Source is the Documents editor on the same buffer. The renderer and
  math fonts are their own chunk (about 375 KB), loaded when a Markdown view first
  shows. Above 512 KiB a document opens in Source with a note.
- Documents 0.4.6 exports `useDocumentBuffer`, the hook its cards already used, so
  another view reads the same buffer.
- Rho selects first-party extensions in `ui-extensions.json`, which builds the reader
  into every application; `RHO_UI_EXTENSIONS` adds to it. A `.md` or `.markdown` file
  opens in the reader in place and in Studio.
- Views receive `shell`, the shell's services: a link to a project file opens it in
  place, or beside in Studio; an image is read as its current bytes (at most 64 per
  page, 8 MiB each); Rho's languages serve the editor and code blocks with one set of
  token classes coloured in `theme.css`. Images on the web are not loaded (the page
  policy allows only its own, `data:` and `blob:` images); they show their description.

### Observed

`markdown-1/` and `markdown-2/` in a disposable service with copies of the project:
`report.md` opens as a page: headings, the two tables with numbers right-aligned, the
three figures from `figures/`, inline and display math, highlighted Python, the quote
and four task boxes. `analysis.py` in the text opens the script in place. Source shows
the editor with Save and the change highlight; Read returns. In Studio the tab carries
Read and Source; at 390 px the page reflows without horizontal scrolling.

A closing parenthesis after inline math wrapped onto its own line; punctuation against
a formula now stays with it (`markdown-3/`). A Studio tab placed for `report.md` before
this change stays the editor, because a tab keeps the component it was placed with;
opening the file in a workspace without that tab places the reader.

### Checks

Rho-plugins 103/103 (new: paths, links, images and their budget, escaped HTML,
tables, task lists, math, fenced code, the manifest). Rho 218/218 serially;
`acceptance:sources` 8/8 now reads a Markdown note with its image, math, table and
coloured code, follows an edit by another writer, switches to Source and opens a
linked script; `frontend`, `person` (9/9) and `plugin-dx` passed.

## Step 3: what an Agent's run did

### Changed

- Agent 0.4.17 asks Claude's ACP adapter for its `terminal_output` extension, so a
  command's printed output and exit code arrive as data instead of a console text block
  the record dropped. A command step keeps its exit code (never invented when the Agent
  sends none) and the last lines it printed, at most 20 lines and 2 KiB with terminal
  codes removed and carriage-return rewrites resolved. Other tool output is still not
  kept.
- Rho records when each tool step started: its last description before any result,
  because the adapter reports a call while the model is still writing its input. A
  message at its size limit gives up a command's output before its outcome.
- The panel row names the command without a leading `rtk` (the person's own output
  wrapper; the details keep what ran), with the time it took and, when it failed, its
  exit code. Its details show the exit code, the time and what it printed, opened at the
  last line. The Graph's run card reads "Exit 0 · 4.3 s · 04:06" and its details show the
  output. A command that ran and failed is "failed" and stays on the Graph; before, the
  adapter's "failed" status made it "refused" and the Graph left it out.

### Observed

Four real runs of the same request in a disposable service (`run-2026-10-29T08-…`,
`runs-after-*`, `panel-rows-*`), workbuddy-ai/deepseek-v4.1-flash, mode auto:

1. Every command carried exit 0 and 6–30 printed lines; R's ANOVA table reads in the
   panel and the Graph with its columns intact (output is no longer wrapped).
2. Times of 2–8 s for `ls` and `find`: between the call's last description and its
   result Claude Code also decides permission (auto mode) and runs its hooks, which ACP
   does not report. The time is shown as how long the call "took", not as run time.
3. Asked to run a failing script, the Agent first appended `; echo "EXIT: $?"`, so the
   shell exited 0 and the output's last line reads `EXIT: 1`; asked for the bare command,
   the adapter reported exit 1 and the record kept the traceback's end,
   `FileNotFoundError: … 'data/june.csv'`. The panel said "refused" until the "failed"
   outcome was added.
4. One command's output carried rtk's own lines (`[+1 hidden: rtk recall …]`): the
   person's hook rewrites commands after the Agent names them, so the record shows the
   Agent's command and the rewritten command's output.

### Checks

Rho-plugins 104/104 (new: exit codes, the bounded tail without terminal codes, an
unreported exit). Rho 223/223 in a direct serial run (new: start time, the output given
up first, command names, durations and failed versus refused, a failed run on the Graph).
In three runs of `npm run verify` the real stdio MCP v2 test, which this step does not
touch, hit its 30 s limit; alone it passes in 21 s. The machine's load was about 6.5 from
other applications, and the ledger keeps the failed run.
`sources` 8/8, `agent-ui` 7/7, `agent-page` 7/7, `agent-canvas` 10/10, `frontend`,
`person` 9/9 and `plugin-dx` passed. `acceptance:graph` fails at "both outputs changed
while their command ran": after Fit the Graph sits at 60 % zoom, below the 62 % at which
edge labels are drawn. It fails the same way with the Graph view at HEAD; its last
recorded pass was at 0d98b571, before the timeline lanes and Overview commits.

## Limits and next

- The reader opens `.md` and `.markdown`; R Markdown and Quarto files stay in the editor
  (their front matter and chunk options are not rendered). Front matter in a `.md`
  shows as text.
- A Studio tab placed before the reader keeps the editor.
- The Documents card's outline still splits Markdown headings inside Documents.
- Command times include Claude Code's permission decision and hooks. Codex and the
  person's own Claude Code outside Rho are not covered by the terminal extension yet.
- No Run button for a person, as chosen.
