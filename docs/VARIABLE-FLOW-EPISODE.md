# How variables relate in a script and in the Notebook

Updated 2026-11-04. The user had asked on 2026-10-31 for code and values to stop being separate,
with a graph that guides the reader. Now they asked why Rho still could not show how the
variables of a script relate to each other: was that change never finished? It had been
finished, as the Data flow view (Notebook 0.1.1): each cell is a box, with a line from a value to
each cell that read it. This pass looked at what that view shows for the usual ways of running
a script. The user then chose to have both of the next steps: the relations inside a script, and
the relations between cells shown in the Notebook and Variables themselves.

## What the earlier change showed

The shipped PA14 project, in a real browser, with R 4.5.2 in the shared session. Cells were sent
as the person through the Notebook's own operation, in throwaway state:

- **Five small cells.** Data flow drew the chain correctly: `sw` read from the CSV, changed in
  the next cell, read by the model that made `fit` and `co`, and `co` read for `ratio`.
- **The whole swarming script as one cell.** One box held 29 values side by side, with no line
  between any of them. Everything the script read, it had made itself, so the cell read nothing
  from the session. How `welch_vs_wt`, `area_t`, `tab` and `summary_out` lead to the summary
  table could not be seen.
- **`source()` of the same script afterwards.** The cell recorded no values. The kernel records
  what changed in the session's listing, and these values came out the same as before.
- **`Rscript analysis/…R`**, the way Agents usually run a script, does not go through the
  session, so Data flow had nothing of it.

Data flow was reachable only by adding it to a Studio page. The Notebook showed, per cell, only
the names it made or changed, and Variables only each value's type and size. The script editor
showed nothing. The whole-script cell also did not record the figure the script writes with
`ggsave` at its end. The runner looks at no more than 32 of a cell's strings as paths, and the
labels, colors and level names that came first used them all up.

Read with R's own parser, statement by statement, the script's relations were all there in its
text: `sw` → `area_t`, `circ_t` and `round_t` (through `welch_vs_wt`) → `tab` → `summary_out` →
the summary CSV; `sw` → `sc` → the contrast CSV; `sw` → `base_panel` → three panels → `fig` → the
PNG. `tab` is changed 25 times in a row, so a step per statement would bury the shape.

## What changed

**Notebook 0.5.4** (Rho-plugins):

- `scriptFlow` reads a script's values from its text alone, in R or Python, and returns Data
  flow's own shape. A step is a top-level statement, or several. Each step makes the values it
  assigns outside its functions and reads the script's values it mentions. A function's
  arguments and locals, fields after `$` or `.`, arguments' names, the columns in `aes()`,
  `vars()` and formulas, and imports are not reads. A file counts as read or written by the call
  its path string is given to: `read.csv`, `write.csv`, `ggsave`, `to_csv`, `open(…, "w")`. It
  counts the same way when it is given a value that holds the path. A statement joins the step
  before when it only changes what that step made, or when both make something from nothing. A
  statement that makes and writes nothing (a print, a check, a library call) is counted, not
  drawn. On the example script: 27 steps, 40 lines, 24 statements not drawn.
- The Notebook names, under each cell, what it read and from which cell ("Read co from R 3"). It
  also names which later cells read what the cell made ("ratio read in R 6"): at most three, the
  rest counted. A cell named there goes to that cell and marks it for a moment. Variables names
  the cell that made each value as it is now, and the cells that read it.
- A cell that makes its values over three or more steps offers "How its values were made, step
  by step". This is the same drawing as a script's, in the Notebook and in Data flow's opened
  box. It is what the whole-script cell lacked.
- `ScriptFlowView` draws a script's flow for a page. The runners now look at path-like strings
  first among the 32. The whole-script cell now records the PNG as written.

**Documents 0.4.11** lets a page keep the editor's `flow` switch with the view.

**Rho:** a script's editor has a Data flow switch in its header, kept with the page. The flow
shows beside the code, or below it when the view is narrower than 640 px. The code marks the step
at the cursor, the steps it comes from and the steps it leads to, in the colors of the key above
the flow. Choosing a step puts the cursor at its first line. The flow follows typing within a
quarter of a second. Switches in a view's header now lay out in a row. Inside a flex header a
label had been blockified, and the global label rule stacked its mark above its words.

## What the browser showed

A scripted run in throwaway state: six small cells and the whole script, sent as cells, then the
pages a person would open, at 1440, 1920 and 390 px. Screenshots were read after each change.

- The Notebook's lines read "Read sw from R 2 · Made or changed co read in R 4". Going to R 3
  scrolled there and marked the cell. The example's recorded earlier session repeats cell
  numbers, and the links stay within each session.
- Choosing `summary_out` in the editor's flow put the cursor on line 120. Lines 120–144 were
  marked, the `fmt` functions above were marked as what it comes from, and the box path stood
  out in the flow. Clicking line 178 (`write.csv(sc, …)`) marked `sc` and `system_contrast`.
- A line typed into the script appeared as a step of its own. It read `fig`, which the script
  makes only later, so no line ran to it, which is correct when the script is read in order.
- After a reload the switch was still on. At 390 px the code takes the top half and the flow the
  bottom half, with no sideways scrolling.
- The first run found three defects, fixed above. `aes(genotype, area)` linked to a value named
  `area`. The editor's flow stayed empty, because the editor's text arrives before the
  extensions are added (a plugin now reads it when it starts). The header switch stacked. Saving
  the switch first failed with "Component properties do not match the registered catalog",
  until Documents declared `flow`.

## Checks

- Notebook: tests of the script flow in R and Python (scopes, fields, columns, files, path
  values, grouping and limits), of each cell's reads and readers, and of a path split into what
  it comes from and what comes of it. Plugins suite with every plugin built: 175 of 176 pass,
  1 skipped (Windows only).
- A Python cell with 40 labels and a file written last records the file.
- Rho's full suite on the composed build: 287 of 289 pass, 2 skipped (Windows only). The
  contract check is current.

## Not established

- The script flow is read, not run. It misses names built at run time (`assign`, `get`, `exec`),
  columns used in dplyr verbs that share a value's name, paths pasted from parts, f-strings and
  what a file run with `source()` makes. A run with `Rscript` shows its script's flow, not what the run
  made.
- At the editor flow's 280 px minimum, long first lines and "written" are cut short.
- The browser logged 404s from `agent.activity.capture` (no Agent in these runs) and from
  `document.undoOwn` on ⌘Z in the editor. These were not investigated here.
- No person has used these views yet. Whether they guide a reader is unobserved.
