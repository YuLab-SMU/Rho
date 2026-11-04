# Running an analysis the person can follow

This practice comes from five published papers re-analysed through Rho (bulk RNA-seq,
snRNA-seq, GeoMx DSP, bulk plus a metabolome, a multi-omics cohort) and from a later run of
one of them. Each rule below is there because a run lost work, turns or the person's trust
without it.

## Before the first cell

1. **Read what the project already says.** Read `README.md`, `project-notes.md` and the
   project's skills (`skills.list`, then `skills.read` for those that apply). Follow the
   skills. They record how this person works.
2. **Write the notes section first.** If Rho started you, its instructions give the section's
   exact shape. Otherwise, add a level-2 section to `project-notes.md` that names the task, with
   level-3 subsections in this order: Question, Data & method, Key results, Choices, Files,
   To do. Link every file by its path from the project root (`[de.csv](results/de.csv)`).
   This section is what the person reads while you work.
3. **Check packages once, in one cell.** For example,
   `setdiff(c("DESeq2","clusterProfiler"), rownames(installed.packages()))`. Name what is
   missing. Install into the person's library only when they agree. Never install into a
   temporary library: it vanishes, and the next run differs from this one.
4. **Resolve the Notebook operations once** (`kernel.run`, `kernel.read`, `kernel.inspect`,
   `kernel.interrupt`) and keep their `contractRef`s. One reproduction spent 36 index calls
   re-discovering them and ended with only its quality-control table.

## Running cells

```json
rho_call {"operation":"kernel.run","contractRef":"…","input":{
  "language":"r",
  "code":"counts <- read.csv('data/counts.csv', row.names = 1); dim(counts)",
  "purpose":"Load the count matrix once for the later cells",
  "changeId":"load-counts",
  "waitMs":120000}}
```

- **Use the shared session for exploration**, not `Rscript -e` or `python3 -c`. The person sees
  each cell, its purpose, its output, its plots and the variables, and can run cells too.
- **Load once, then build on it.** What a cell defines stays for the next cells. Use
  `kernel.inspect` to look at a value (a page of a table, a model's coefficients) without
  adding a cell.
- **Print summaries, not data.** A cell that prints thousands of lines makes a large reply,
  and you then have to page through it.
- **Keep each cell short enough to finish.** Prefer a few substantial cells to many tiny ones.
- **`waitMs` holds the call until the cell ends, up to 600000 (10 minutes).** Set it for the
  slowest step you expect. If the cell outlives the wait, the reply shows it still running.
  Read it later with `kernel.read {"cellId":…}`, or send the same request with the same
  `changeId`, which returns that cell and does not run it again. If the call itself comes back
  as an unknown outcome or a transport error, the cell may still be running: recover it the
  same way, never under a new `changeId`.
- **A stuck cell:** `kernel.interrupt {"cellId":…}`. The session and its values stay. Only the
  person stops a whole session.
- **Never end your turn "waiting for" a cell, a background job or a monitor.** Nothing will
  wake you. In one reproduction an Agent armed a monitor for a normalisation step and ended its
  reply. The conversation then read "Done in 8 min" while the analysis was unfinished. Either
  wait in your own calls, or stop and say plainly what is still running and how to continue.

## Files are the record that survives

- **Keep the code that results rest on in a script** (`scripts/analysis.R`). Write it whole,
  then run it in the session with `source("scripts/analysis.R")` so the person sees it run. One
  complete write costs less than many partial edits, and only a file on disk outlives a stop.
- **Live values do not survive a Rho restart.** Cells and outputs stay. The objects in memory
  are gone, and the session reads `rho-closed`. The script is how anyone rebuilds them.
- **Write each result as soon as it exists** (`results/*.csv`, `figures/*.png`), and add it to
  the notes' Files list right away. Do not leave this to the end. A stopped turn keeps only what
  was written.
- **Figures:** printing a plot in a cell keeps it in the Notebook (up to 8 per cell). For a file,
  draw to an explicit device: `png("figures/x.png", width = …, height = …); print(p); dev.off()`.
  `ggsave` worked in a simple check on 0.5.3, but it stalled once in a larger reproduction. If a
  save stalls, interrupt the cell and use the explicit device.

## Python

The Python session uses the machine's `python3`, or the `--python` Rho was started with. When
the work needs packages, make an environment in the project (`python3 -m venv .venv` or
`uv venv`, then install into it). If the resolved `kernel.run` contract has an `interpreter`
input (versions after 0.5.3), pass `"interpreter":".venv/bin/python"` and later sessions keep
it. Without that input, ask the person whether to restart Rho with `--python` set to that
interpreter.

## Reproducing a published analysis

- **State up front what the deposit lacks** (labels not public, a cohort smaller than the
  paper's, an undefined threshold). Re-analysing public data is a documented re-analysis, not
  an equality check. None of the five reproductions matched the paper's counts exactly, and
  every one had a nameable reason.
- **When a number does not match, name the undefined choice** (threshold, direction, model).
  Compute the cheap alternatives next to your main one, rather than tuning until it fits.
  Record each choice and its alternative in the notes' Choices section.
- **When you substitute a source** (a gene-set collection, an annotation build), say so next
  to the result, because the substitution changes the numbers.
- **Flag a technical signal as technical.** For example, top hits that are all unnamed or
  non-coding features, or groups of very different sizes. Say what it means for the paper's
  claim.

## Finishing

Report what you actually reached:

- the files on disk that answer the question, and the numbers you checked against them;
- anything still running, and its `cellId`;
- what did not reproduce, and why;
- what is unverified, including your own interpretation.

Update the notes' Key results and To do. The person continues from that record, not from a
claim that the work is done.

## When a conversation in Rho's panel stops

If a turn ends on the Agent's own limit, the panel names it as a limit stop. Since 0.5.3 the
person can choose "Continue unfinished work", which continues with the original task. In
earlier versions the row reads Failed, and the person presses Continue and restates what is
left. Either way, the new turn starts from what is on disk and in the notes. That is why files
and notes come first.
