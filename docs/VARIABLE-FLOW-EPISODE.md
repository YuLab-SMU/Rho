# How variables relate in a script and in the Notebook

Updated 2026-11-04, with [the redesign](#redesign-a-graph-of-values) and then [the meaning in the
code](#meaning-in-the-code) the same day. The user had asked on 2026-10-31 for code and values to
stop being separate, with a graph that guides the reader. Now they asked why Rho still could not
show how the variables of a script relate to each other: was that change never finished? It had been
finished, as the Data flow view (Notebook 0.1.1): each cell is a box, with a line from a value to
each cell that read it. This pass looked at what that view shows for the usual ways of running a
script. The user then chose to have both of the next steps: the relations inside a script, and the
relations between cells shown in the Notebook and Variables themselves.

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

## Redesign: a graph of values

The user looked at the result and judged Data flow's design close to a disaster: it did not
help with anything real. They asked for it to be redesigned in the code.

**What the boxes showed.** Read again on the same screenshots, the drawing followed the code,
not the question. A box per statement in script order repeated the script beside the script. The
lines ran in unlabeled lanes in the margin, so a reader could not tell which value a line
carried. Inputs, results and the helpers between them looked the same. Each box's head repeated
the first line of its code. In the editor, a 280 px column of boxes and lanes was mostly lanes.

**What it draws now** (Notebook 0.5.5):

- **One node per value**, in rows from the files read at the top to the results at the bottom.
  Results are the files written and the plots drawn, else the values nothing reads. A value made
  and then changed is one node, made where it was first made and changed where the rest were.
- **Functions and constants are not drawn.** Each value names the functions and constants it
  uses: a constant holds literals and calls that only put them together, not a `read.csv()` of a
  URL. A helper made from one value and used only to change it (a row mask) is named the same
  way. On the swarming script this leaves 19 values from 1 file to 3 written files, and folds
  away 10 functions, constants and helpers (`welch_vs_wt`, `fmt`, `cols`, `theme_swarm`,
  `wt_row`…). What leads to no result (the printed tests' loop variables `v`, `tr`, `wt`, `ps`,
  `g`, `w`, `p12`) is named below the graph.
- **A bar names the results.** Choosing one draws only what leads to it. When every result at
  once would put more than six values in a row, the first result is chosen to begin with. For
  the summary CSV the graph reads `single_cultures.csv` → `sw` → `area_t`, `circ_t`, `round_t`,
  `desc` → `tab` → `summary_out` → the CSV. Choosing a value that leads to no result draws what
  leads to it (`fit` → `co` → `ratio` in the session).
- **Choosing a value** colors what it comes from and what comes of it, in the colors the editor
  marks lines in. It also names:
  - how it was made (the code its assignment gives it);
  - where it was made (lines, or the cell);
  - what it comes from, what it uses and what it leads to;
  - which results it reaches.

  A session's value can be looked at, a file opened, and the cell that made a value shown in the
  Notebook. A plot shows its image. In a narrow view the chosen value sits above the graph and
  stays in view; in a wide one it sits beside the graph.
- **In a script's editor**, choosing a value goes to where it is made, and the code marks:
  - the lines that make it;
  - the lines that make what it comes from, with the functions and constants they use;
  - the lines that make what comes of it.

  A click on a line that makes a value chooses it.
- **In a session**, a cell that makes its values over several statements is read statement by
  statement, with the session's values it recorded. Each value then comes from what its own
  statements read, through what the cell made and dropped. A plot comes from what the statement
  that drew it read (`plot(fit)`, not `rm(tmp)`), and the newest result comes first. A value whose
  cell read something made again since says so.

`lanes`, `related`, `flowPath` and `scriptStepAt` are gone. `sessionGraph`, `scriptGraph`,
`graphPath`, `graphRows`, `graphMarks` and `graphNodeAt` replace them. Rho's editor keeps the
chosen value, follows the cursor with it and marks lines from `graphMarks`.

**What the browser showed.** The same scripted run as above, plus a plot cell, at 1440, 1920 and
390 px, with screenshots read after each change:

- The first graph wrapped badly. Nodes that showed how each value was made were about 200 px wide.
  The editor's flow column is 350–500 px on a Studio page, so a row of eight values became eight
  lines with a tangle of lines between them. The chosen value's panel, kept at the bottom, took
  the whole lower half. Narrow views now name values without how each is made, the panel moves
  above the graph, and wide graphs start on one result.
- Two names cut to `swarming_single_mutant…` could not be told apart. Long names now keep their
  first word and their end (`swarming…_summary.csv`).
- A value made from nothing that fed one other was folded into it as a helper, because an empty
  list of sources passed the helper test (`fit` disappeared into `co`). Fixed and tested.
- A plot first came from what its cell made last (`co`), not from what `plot(fit)` read. The
  script reader now keeps what a statement that makes nothing reads.
- Faded nodes let lines show through them; they are opaque now.
- At 390 px neither the script with its flow, the Data flow view nor the Notebook scrolls sideways.

**Checks.**

- Notebook: tests of both graphs, a value's path and the lines behind it, constants against
  data, helpers, a cell read statement by statement and a plot's source.
- Plugins suite with every plugin built: 178 of 179 pass, 1 skipped (Windows only).
- Rho's full suite on the composed build: 287 of 289 pass, 2 skipped (Windows only).

**Not established.**

- Whether the graph answers a person's questions faster than the code does: no person has used
  it.
- On the 300-line co-culture script, everything at once is 73 values; what leads to its ratio
  model holds 47 of them. The graph scrolls, and it is unobserved whether people trace one result
  at a time.
- What a plot came from is a reading of the code (the statements that make nothing). A plot drawn
  inside a function or a loop that also makes values is attributed to what the cell made last.

## Meaning in the code
The user read the redesigned graph and said that code and variable names are still not for people.
The readers are the Agent and the people who use one. Someone who does not read R or Python cannot
follow `sw`, `area_t` and `tab`, so the explanation has to come from the Agent that wrote the code,
sit beside that code, and change when the code does.

**What the Agent writes.** The instructions Rho gives every session it starts (`notesInstructions`,
appended to the Agent's system prompt) ask for a comment above each top-level statement that first
makes a value it reports, or writes a file:

```r
# means: Dish measurements, one row per dish
sw <- read.csv("data/swarming/single_cultures.csv", fileEncoding = "UTF-8")
```

Where one statement makes or writes several things, the comment names the one it is for: `# means
NAME: …`, with a value name or a file path. A sentence is under 200 characters, in the language the
person writes in. Comments inside a function, and changes to a value after it is made, need none.

**What Rho reads.** The kernel reads the comments from the text, as it reads the statements; nothing
runs. A comment goes to the statement that first makes or names its value or file. The first
statement to make a value decides its meaning, so a later change does not replace it. A session's
cells are read the same way, and a plot takes the comment above the statement that drew it.

**Where it shows.** A node is titled with its meaning, with its name beneath in monospace; a file's
node is titled the same way. The chosen value's panel has the meaning as its heading, and its
caption says whether the code writes one. A helper's meaning shows beside its name under Uses. The
editor's flow and a Notebook cell's "How its values came about" use the same drawing, and the flow
line counts the values that have a meaning. In a narrow view a node shows up to three lines of its
meaning.

**What the browser showed.** A scratch copy of the shipped PA14 project, with comments written for
this check (not by an Agent) on `analysis/swarming_single_mutants.R`; the shipped example has none.
Two R cells, with their own comments, were sent to a live session through `kernel.run`. Screenshots
were read after each change.

- The editor's flow for that script at 1440, 1920 and 390 px: "1 source → 19 values → 3 results" and
  "13 of 19 values have a meaning written in the code". The six without one are the loop variables
  `v`, `tr`, `wt`, `ps`, `g` and `w`, which no comment names. No sideways scroll at any of the three
  widths.
- Run 2's script, in the editor at 1440 px: "1 source → 10 values → 2 results" and "10 of 10 values
  have a meaning written in the code", in Chinese, as the prompt was. Its 390 px check did not run:
  a sidebar label in my check script was hidden at that width.
- A page with only Data flow, on the live session: four values and one result, each titled with its
  comment. The chosen `mean_area` panel is headed "Mean colony area per strain, in imaging units"
  and says "written in the code"; the two values that lead to no result are named below the graph by
  their meanings. No sideways scroll at 1440 or 390 px.
- A Notebook cell's graph at 390 px: "3 of 3 values have a meaning written in the code"; no sideways
  scroll.

**The trial.** Each run is a fresh `claude -p` session in a copy of the shipped project. The task is
the same each time: write `analysis/swarming_area_by_system.R`, a script that compares the systems,
and update the project notes, without running the script. Every launch allowed the file tools (Read,
Write, Edit, Glob, Grep) and did not list Bash. Some shell calls still ran (the read-only ones
succeeded), and one was refused, as noted below.

- Run 1 used the first prompt, which names the script but not the Write tool, and the earlier
  instructions. The Agent described its plan and stopped; no script was written
  (`trial/trial-log.txt`).
- Run 2 used the second prompt, which names the Write tool, and the earlier instructions. It
  completed in 19 turns, 9.3 minutes, $0.31: one Write, a 199-line script, and six Edits (four to
  its project notes, two to the script). Its instructions lacked "top-level statement" and "need
  none", so it put comments inside functions and on changes to a value, which Rho ignores. The
  kernel reads 10 of 10 drawn values and 2 of 2 written files with a meaning. The input CSV has
  none, because the instruction covers values and written files, not files read.
- Run 3 used the second prompt and the shipped instructions. It did not finish: after eight turns,
  two of them read-only shell listings, the reply broke off with `API Error: the reply broke off:
  The operation timed out`, and no script was written.
- Run 4 used the same prompt and instructions as run 3, apart from the session label, and finished.
  It took 51 turns, 64 minutes and $10.99: one Write and eight Edits to the script, and fourteen
  Edits to its project notes. The notes gained a section whose Key results is empty, because the
  script was not run. The script has eight `# means` comments, each above a top-level statement. The
  kernel reads six of its seven values and both written files as having a meaning. The input CSV has
  none, as in run 2. The seventh value, `unknown`, is the guard that stops the script on an
  unexpected genotype label; the instruction covers values the script reports, so it has no comment.
  The run also loaded the bundled `dataviz` skill, which run 2 did not use, and tried to run that
  skill's palette validator. The shell call was refused with `This command requires approval`, and
  the run went on.

**Checks.** The four kernel test files pass, 20 tests, after the final edits (`kernel-meaning`,
`kernel-script-flow`, `kernel-value-graph`, `kernel-lineage`). The Rho-plugins suite passes 184 of
185 with every plugin built; the one skip is a Windows-only test. Rho's `project-notes` test passes
its 4 tests on a compiled copy of the shipped instructions. The browser bundle type-checks and
builds into a scratch folder; `dist/` was not rebuilt. The docs coverage check passes; the 164
internal links and anchors in the checked pages resolve, and the docs site builds and renders them
at 1440 and 390 px.

**Not established.**

- No person has used the meanings. Whether a reader follows the flow better is unobserved.
- The meanings are the Agent's words. Rho shows what the code says; it does not check the words
  against the numbers or the science.
- Names built at run time, columns named like a value, and pasted paths are still missed, as before.
- Input files get a meaning only when a comment names them (`# means data/…: …`). The instruction
  does not ask for that; the scratch cell wrote one by hand.
- Loop variables have no meaning unless a comment names them.
- The shipped example has no comments and is unchanged.
- Four runs, each one trial, not a rate. Run 1 used the first prompt and the earlier instructions;
  run 2 the second prompt and the earlier instructions; runs 3 and 4 the second prompt and the
  shipped instructions. Run 4 reran run 3's setting after its timeout, so those two runs are one
  setting with one failure and one success.
