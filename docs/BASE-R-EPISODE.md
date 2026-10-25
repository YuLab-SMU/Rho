# Base-R collaboration episode

This episode applies the [interaction guidance](INTERACTION.md) to an ordinary R
project: select a result row, ask about its method, let a real external Agent edit
and execute the analysis, compare both outputs, and return after connection loss.
It uses the public owner contracts and installed Chrome. The person is automated;
this is not a human usability study or scientific acceptance of the method.

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
outcomes remain separate work in the [validation roadmap](ROADMAP.md#interaction-system-validation).
