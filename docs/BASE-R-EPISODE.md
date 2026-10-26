# Base-R collaboration episode

This episode exercises an ordinary R project: select a result row, ask about its
method, let a real external Agent edit and execute the analysis, compare both
outputs, and return after connection loss. It uses the public owner contracts and
installed Chrome. The person is automated; this is not a human usability study or
scientific acceptance of the method. Each run ends with a [review](#review-of-the-2026-10-25-run)
that decides what the next run should show.

## Question and objects

The [project fixture](../fixtures/base-r-airquality/README.md) uses
`datasets::airquality`. The initial script selects complete observations across
all variables and calculates monthly sample counts and mean ozone. It produces
`monthly-ozone.csv`, with stable keys `month-05` through `month-09`, and a base-R
PNG. The only runtime is R and its included packages; the tested R is 4.5.2.

In the browser, the person adds a Unicode code comment, saves it, leaves a separate
note unsaved, sorts the table, filters May and selects its row. The Chinese question
asks why May has only 24 observations and asks the Agent to drop only missing ozone
values, preserve the comment, recalculate every month and link both new outputs.

The question freezes the table identity, version, `month-05` key and confirmed
draft. Copying its request is an explicit handoff to an external Agent. The runner
passes that actual clipboard text to Claude Code with a project-scoped MCP session;
it does not generate an answer or edits in place of the model. The model has no
shell/filesystem tools or layout-write grant. It reads the frozen context and
shared document, saves against observed conditions, submits one new managed R
operation, checks artifacts, reads rows and records an explicit linked reply.

## Comparison and ownership

The expected descriptive results are independently calculated by a separate base-R
expression, not by the Agent's modified script or explanation:

| Month | Complete-case n | Complete-case mean, ppb | Ozone-only n | Ozone-only mean, ppb |
| --- | ---: | ---: | ---: | ---: |
| May | 24 | 24.125000 | 26 | 23.615385 |
| June | 9 | 29.444444 | 9 | 29.444444 |
| July | 26 | 59.115385 | 26 | 59.115385 |
| August | 23 | 60.000000 | 26 | 59.961538 |
| September | 29 | 31.448276 | 29 | 31.448276 |

The original table remains bound to its original version. Its May selection does
not migrate to the new table. The person opens the exact table linked in the reply
and chooses **Arrange views → Split right** to inspect both versions, each with its
own producing-run line. Both original and linked PNGs remain accessible. Reload
restores the saved comparison; below 768 CSS pixels the two views remain reachable
as separate tabs. At narrower widths a real horizontal wheel exposes the mean
column, and the full numeric value is checked against the oracle. Acknowledged
unsaved notes remain in the document owner.

This exposed an application gap: an opened linked result was a local view outside
the saved composition tree, so its Arrange views menu was absent. Rho now includes
only that exact view in the person's conditional arrangement write. It neither
rebinds an existing same-id node to different bytes nor persists unrelated previews.
Existing composition freshness, reference, availability and protection checks still
apply. Core and plugin semantics did not change.

The source line distinguishes completed execution, verified bytes and the absence
of a domain check. The external Agent's reply is its interpretation. The separate
oracle verifies these five aggregates; it does not establish missingness assumptions,
uncertainty, significance or causal conclusions. The person's note leaves adoption
pending. View placement and execution success do not record scientific approval.

## Failure and return

Two failures belong to this episode:

1. The question is accepted, but its browser response is deliberately dropped.
   Reload and **Retry original question** send the original body and change identity.
   There is one immutable question, with the original text, row key and version.
2. The browser goes offline while the Agent's R operation is active. The script has
   an explicit six-second test window; normal fixture execution does not wait.
   The Agent continues under its existing grant. The person restores the connection
   and clicks **Reconnect**. Rho observes the
   same request digest, Core caller/request identity and native operation identity.
   There are exactly two native submissions: the baseline and the requested change.

The browser also reloads after saving the comparison. The old selection and dirty
notes survive. Sort/filter controls return to their existing defaults on reload;
the selected stable entity and frozen question remain exact. This record does not
claim Host crash recovery, restoration of every local presentation setting or
automatic resumption of an external model session. Those require separate episodes.

## Review of the 2026-10-25 run

The run asked whether a real external Agent can answer an anchored question through
Rho's public owners, and whether the person keeps their place and work across the
change and a disconnection. It takes this episode to the *runs* stage
([stages](DEVELOPMENT.md#stages)). The observations come from the retained
screenshots at 1440 × 900 (`01-point-ask`, `02-question-ack-lost`,
`03-offline-during-run`, `05-compare-tables`, `07-linked-figure`) and at 390 px
(`comparison-390`).

**What works.** The Agent read the frozen context, changed only the inclusion rule
and its comment, kept the person's Unicode note in the script, ran R once and linked
both outputs. The selection, both versions and the unsaved notes survived; Reconnect
observed the same request, and there were exactly two native submissions. The
offline notice says what the person is looking at and offers Reconnect without
covering the table. The one application gap the run exposed, a linked result that
could not be arranged, is fixed.

**What does not work yet.**

1. *The answer is not on any screen.* May goes from n 24 to 26 and mean 24.125 to
   23.615, August from 23 to 26 and 60.000 to 59.962, and the other months do not
   change. To learn this, the person compares two tables cell by cell. The Agent's
   explanation sits behind a button labelled "Explicit Agent response"; in place it
   is one truncated line of raw Markdown (`Agent: "**为什么五月原来只有 24 条：** 原 a...`).
2. *The comparison is two unrelated tables.* Their headers and first rows are 48 px
   apart. The left is named by its rule ("Original · complete cases"), the right by
   its file (`monthly-ozone.csv`). Nothing marks the changed cells, and one column
   shows `60` beside `59.12`.
3. *Implementation facts lead.* "Open linked result · b517bba0" and "Open linked
   result · fcde896f" leave the person to guess which is the table and which the
   figure. Each result view is subtitled "completed · bytes verified · no domain
   check". After the lost acknowledgement, nine lines describe one question, the
   word "retained" appears five times, and the first line is the raw browser error
   "Failed to fetch".
4. *Everything has the same weight.* Three stacked bars, tabs, four bordered buttons
   and a status line come before the data. The first data row starts nearly 400 px
   down a 900 px window, while about 300 px stay empty below five rows. "Step away"
   does not say what it changes.
5. *At 390 px the versions cannot be seen together.* They become separate tabs, so
   comparing means remembering values across a switch: recall instead of
   recognition.

**Analysis.** Problems 1–4 share one cause at the concept level. The workspace is
assembled from the views that exist, one tab per file and one button per link,
rather than from the episode: a question, what the Agent changed, what changed in
the results and the evidence behind it. Restyling would not fix that. Problem 2 also
has a capability part: the Tables plugin offers a keyed
[`data.compare`](../protocol/operations/data.compare.json), but no view presents its
differences. The mixed precision in problem 2 belongs to the table view. The labels
in problem 3 are each true, but they describe the implementation rather than the work.
The question's labels and linked-result buttons come from the Annotations plugin's
table-question view in Rho-plugins; the run subtitles come from Rho's shell. Problem
5 is composition: below 768 px the shell shows one view at a time.

**Next run.** Present the episode around the question: what was asked, the Agent's
answer, the change between the two results by month key with the changed values
marked, and the code change, with tables, figure and provenance one step away. Keep
the project, prompt and failure injections so that the runs can be compared. The
run succeeds if the change in May and August and its reason can be read from one
screen at 1440 px and reached at 390 px; then a person who did not build Rho tries
to say what changed and why. If the person still has to compare tables to find the
change, the presentation is wrong, not merely unpolished.

## Reproduce

From a configured source checkout, after building the selected plugin packages:

```sh
npm run build
RHO_CORE_BINARY=/absolute/path/to/rho-core npm run acceptance:base-r
```

The command needs the installed Chrome executable, Rscript and an already configured
Claude Code client. It uses the existing local model configuration without printing
credentials. `RHO_UI_CHROME` selects Chrome; `RHO_RSCRIPT` selects Rscript.
`RHO_EPISODE_EVIDENCE` selects the evidence directory, and `RHO_EPISODE_HEADED=1`
shows the browser. The runner creates its own temporary project and owned service,
closes its browser/service on completion and retains the project and evidence.
It does not restart a user's Host or R session.

The model is bounded to 48 turns and a ten-minute process deadline. On exhaustion,
failure or incomplete evidence, the command fails and retains obtained output;
there is no deterministic fallback and no automatic new execution identity.
Tables have five rows, each read is bounded, and the ordinary artifact/output and
view budgets still apply. No add-on R packages are installed by this episode.

For debugging later browser steps, `RHO_EPISODE_RESUME` can point to this runner's
saved evidence directory. That mode reuses recorded outputs and performs no model
run or native submission. Its report explicitly names the prior evidence; it must
not be counted as a fresh end-to-end pass.

## Evidence

The selected run and its remaining limits are recorded in [Status](STATUS.md).
Local evidence is under `work/base-r-episode-20261025/`: the report, model activity
receipts, native identity before/after connection loss, exact result references,
all compared rows, independent oracle output and browser screenshots. Private
model transcripts and connection files are not source artifacts.

This is a source-checkout composition. It uses the accepted Core binary from
`ebe351043e74529ccf49960c0b07c805d1e50c07`, with SHA-256 recorded in the report,
and Plugins `3588175e25371ae1fa953d92bc24e5897489d7f5` with the pre-existing local
table-style override. This work leaves that override untouched. The report records
every selected UI entry and the browser asset digest; implementation file hashes
identify the application/runner/fixture bytes. No component API, package selection,
binary distribution or signed-release claim is introduced.

The first runner attempt corrected document-field/DOM readiness assumptions. A
later attempt preserved a successful real Agent run after a runner response-shape
error. `before-fix/` reproduced the absent arrangement control on its actual new
table. `after-fix-2/` verifies the repaired browser path against those retained
outputs. `full-run/` retained a second real Agent's successful output when the
runner incorrectly expected network restoration to replace the explicit Reconnect
action. `scroll-check-2/` checks column access against those outputs after correcting
a grid DOM selector. These are diagnostic evidence, separate from the final fresh
run under `accepted/`.

The layout regression checks cover two explicit bindings, id collision refusal,
unchanged sibling weights, movement and removal. The existing frontend acceptance
also exercises saved views, keyboard navigation, Unicode/undo, handoff and reload.
Human observation, a DESeq2 episode, external-write conflicts and broader unknown
outcomes remain separate work in the [roadmap](ROADMAP.md#how-the-roadmap-advances).
