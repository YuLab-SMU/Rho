# dsh analysis, Rho results and a selected-row question

2026-10-31 local / 2026-11-01 UTC. This episode implements the requested
`dsh-rho` prototype: analyse in dsh, show the outputs with existing Rho components,
select a result and continue the original conversation. It follows the native
plugin example in [dsh-context](https://github.com/bowenliang123/dsh-context) and
the installed dsh 0.2.1-rc.5 public APIs. The result is a local package, not a
published npm or signed distribution.

## What was built

The application adapter lives in [adapters/dsh-rho](../adapters/dsh-rho/README.md).
Its Cordis host registers `rho_present` and an authenticated result-reading route;
its browser entry contributes **Rho** to dsh's `conversation.view` slot. Native
session identity supplies both the tool's caller and the view's result scope.
dsh owns analysis, permissions, tools, model and history. It is not started as a
second Agent inside Rho.

The selected owners are Files 0.5.0, Tables 0.5.0, Media 0.4.0 and Contracts 0.4.0
from Rho-plugins commit `1173789010e4679180804aa309e661b218198f70`. Their public APIs,
TableView and MediaView are consumed unchanged. The adapter supplies composition,
session archives and a transient selection port; it reuses Rho's existing POSIX
writer lease. No Core or Rho-plugins source changed, and neither the Core Host nor
the Rho backend is started.

`rho_present` captures completed project files. CSV columns and types are explicit;
row selection needs a unique string key. Questions resolve those keys against the
captured version, then use dsh's native revision-checked draft insertion and normal
Send action. A question can be read or revised before sending. Closing the view,
reading a result and reconnecting do not execute analysis.

## Real episode and observations

The owned fixture used a disposable project and isolated `DSH_HOME`, dsh
0.2.1-rc.5, Node 22.22.3, Python 3 and headless Google Chrome on macOS. It used the
existing configured gateway with `westlakehpc/deepseek-v4.1-flash`; credentials were
read in memory and not put in source, patches or evidence. The person's running
Desktop Harness and projects were not restarted.

The six input values were alpha: 1, 2, 8 and beta: -3, 4, 7. A single native prompt
asked dsh to write and run a standard-library Python analysis once, append one run
marker, emit a CSV and SVG, and present both with `rho_present`. The model wrote
`analysis.py`, ran it and presented both outputs. The run took 3 minutes 32 seconds.

| Group | Observations | Mean in retained CSV |
| --- | --- | --- |
| alpha | 3 | 3.6666666666666665 |
| beta | 3 | 2.6666666666666665 |

The browser showed both rows and the labelled two-bar figure. Selecting alpha
changed the question label to **Ask about 1 selected row**. A Chinese question
asked for its group, count and mean and whether this was the overall mean. The
pre-existing draft `请用中文回答。` survived insertion. The added context contained
only alpha, its exact numeric values, original path, snapshot digest, capture time
and the same session ID. Sent once through the native composer, the model answered
in 13 seconds: alpha, n = 3, mean approximately 3.67; this was alpha's mean and did
not establish the combined mean. It ran no analysis for the question.

Retained identities:

- Session: `session-38a2a4c4-1e62-46f3-8ff6-234d7d098ca7`.
- CSV tool call: `chatcmpl-tool-a6473a9aeace26b0`; SHA-256
  `e2bba75703875eb8484e302157f29d28a42705fa3b21332897bf86f87ba31017`.
- SVG tool call: `chatcmpl-tool-a9ee726ca0c532ff`; SHA-256
  `1cb9430aed9b827880f63b866e539215b2daeab70926119ff4dfb22f9a027cb0`.

## Failures that changed the implementation

1. Loading an absolute package directory as a host module failed with an ESM
   directory import error. The source fixture now resolves the package by name;
   delivery uses an ordinary tarball installed by `dsh plugin`.
2. The first model session used dsh's retained default workspace instead of the
   disposable folder. It found no input and did no analysis. The fixture now
   explicitly creates/selects its workspace with dsh's public controller. The
   installation instructions require choosing the matching folder in dsh.
3. Comparing the browser Origin with the handler's internal request URL rejected
   valid result reads. dsh uses a carrier-neutral internal URL. The adapter now
   relies on the connection service's authenticated `/api` boundary and retains
   the cross-site refusal; it still validates original session and project scope.
4. Files' captured resources name archive paths. Routing those paths back into
   the analysis project made four initial store checks fail. The adapter's path
   provider now resolves captured internal paths in its archive and ordinary
   paths through Files' project containment. All five store checks then passed.
5. An exclusive lock file survived the first owned-host shutdown. Reusing Rho's
   kernel-held writer lease removed stale-unlink/PID-reuse recovery. A second
   writer is refused, and the installed plugin reopened the same archive after
   both normal shutdown and an abrupt kill of its owned dsh process.

A browser assertion initially read an empty draft before asynchronous insertion
completed. Waiting for the native Chat view switch resolved the observation; the
same captured values were then verified. No analysis prompt was resent. Package
assembly also caught nested AG Grid package metadata without adjacent licenses;
notices now come from each actual bundled dependency root, including `ag-stack`.
An installation-guide dry run also showed that `npm --prefix ... pack` selected
the root application. The verified command now names `npm pack ./adapters/dsh-rho`.

## Verification and installation

`npm run build`, five store tests and a TypeScript check over the adapter's three
source files passed. The tests cover snapshot overwrite/reopen, original-call
retries, scope/path/key rejection, budgets and competing writers. They do not
claim full Rho application acceptance; its unrelated suite was not run.

In the real browser:

- Table and SVG views, row selection, the existing Chinese draft and same-session
  model continuation all worked. Screens were inspected at 1440, 768 and 390 px;
  narrow results use scrolling. No browser page errors were recorded.
- Offline result reads showed an error and **Try again** while keeping displayed
  results. Restoring the connection recovered those same results.
- Editing the chat draft while a delayed question request was pending refused
  insertion and kept `Newer draft ✓` intact.
- Refresh and a normal owned-host restart restored the original conversation and
  both results. The test then installed the tarball through
  `dsh plugin --profile web add <tarball> --ignore-scripts --offline`, which added
  and enabled its bundle. Its archive and draft insertion worked after launch.
- Overwriting the original CSV with alpha mean 999 did not alter the displayed
  snapshot or the selected-row question, which still carried 3.6666666666666665.
  The test restored the original CSV afterward.
- After an abrupt owned-host process kill, the installed package reopened the
  archive and original session without removing the lock file. At the end,
  `run-count.txt` still had exactly one line and the archive still had two results.

Local evidence is under `work/dsh-rho/prototype-03/`: `evidence.json`, `chat.txt`,
the native question drafts, original CSV, screenshots of empty/results/selection/
answer/failure/recovery/narrow states, and `dsh-rho-0.0.1.tgz`. The private launch
address stays outside the repository. The fixture and native session history are
retained in the disposable `/tmp/rho-dsh-prototype-03` directory. The package's
composition manifest records exact bundle inputs and selected local overrides;
it is not an official release attestation.

The delivered package is `work/dsh-rho/package/dsh-rho-0.0.1.tgz`, SHA-256
`4ffe8b2798d2d0ead6e558f9d26599bd63b1d5d0b7eecd54efa85684e5396266`.
Final review keyed result choices and questions by original tool call as well as
snapshot, so two presentations of identical bytes retain their own titles. The
five tests and strict type check passed; the final tarball was installed again,
and its table, figure, native draft insertion and original call ID were checked in
the same session without resending analysis. The run count remained one.

## What this establishes and what remains

This observed episode establishes the requested local loop with reused components
and one native dsh conversation. The adapter is deliberately one-project and one
selected dsh release candidate. It has no general Studio, notebook, live variable
inspection or automatic output discovery. Row selections are transient, image
questions carry references rather than pixels, and a question's structured context
is visible in the native draft. React comes from Harness; broader compatibility
with the components' declared React peer version is not established by this run.

The [package README](../adapters/dsh-rho/README.md#ownership-and-limits) names the
budgets, configuration and refusal behavior. Invalid table content can leave a
bounded captured file unlisted. There is no silent deletion of earlier results or
automatic replay of unknown work. Independent researcher use, Desktop/TUI entry
points, Windows locking and public package distribution remain untested.
