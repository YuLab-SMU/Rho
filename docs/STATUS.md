# Rho status

Updated: 2026-10-31.

## Current focus

The selected work is result review, retained historical evidence, macOS arm64
0.5.1 preview delivery and a separately accepted offline reader. The
[episode](REVIEW-EVIDENCE-EPISODE.md) records baseline, observations, fixes and limits.
Native tools remain normal; Core is optional. No Core execution behavior changed.

The [research method proposal](PAPER.md) centers on purpose-driven composition of
shared scientific workspaces: obtaining and selecting materials, arranging related
views and available operations, and carrying their meaning into Agent continuation.
Plugins supply adaptable information, compute and environment capabilities. The
single-cell walkthrough distinguishes scientific purposes and how available inputs
and execution conditions change the workspace. Galaxy and JupyterLab constrain
plugin-related novelty alongside the interface and shared-context comparisons.
Remote single-cell connections remain illustrative; the proposal's novelty and human
benefits are not established by existing Rho checks.

| Part | Current behavior | Evidence or remaining work |
| --- | --- | --- |
| Immutable capture | Files snapshots survive original overwrite/deletion; disk and dirty buffer versions differ; server-side new-turn collection has budgets/gaps | Owner and conversation fault tests; no retrospective reconstruction |
| Result review | Row/range/resource questions, explicit replies, multi-field keyed differences, code changes and human decisions | Real airquality and browser trials; new versions need a new decision |
| Agent feedback | Frozen contexts join message identities; direct sends are separate from deciding; external handoff copies | Real Claude and Codex trials; context fetch differs from explicit reply |
| Graph | Exact captured refs and capture times, current-file action separate, honest reported/named/observed links, bounded focus | Same-path versions and 160-node-cap regressions; old records show gaps |
| Offline evidence | Preview one review and explicit refs; static reader/original files/manifest; read-only verifier | Service closed/project moved; four browser widths; tamper detection |
| macOS 0.5.1 | Unsigned npm tarball/local WebUI selected; Core bundled explicitly | [Fixed tarball installed and exercised](PREVIEW-0.5.1.md) |
| Independent researcher use | Unobserved | Trial guide in the episode; no usability claim |

M0 retains the completed Python/R highlighting, Markdown reading and native command
exit/time/bounded-output work ([record](CODE-MARKDOWN-EPISODE.md)). The real
Python/R report trial also retains scripts/results/report after originals change.
The first Codex feedback attempt was incorrectly cancelled by the acceptance
permission selector; the failure remains recorded. The corrected trial completed.
Annotations 0.5.1 retains a newly created Review conversation for subsequent feedback;
candidate 2 repeats that browser path and both real client loops. Installed Codex
needed an explicitly selected 64-choice native permission budget after hitting the
default 32; its grant scope did not change.

A [simulated-project episode](SIMULATED-PROJECT-EPISODE.md) ran two rho-bio-eval
capsule projects through Rho with Claude Code and changed what their screens showed:
Studio's eight-view budget now renders the views on screen first, Overview opens with
the latest answer, the Graph folds a message's versions of one file and its unrelated
commands, Review (Annotations 0.5.2) offers questions and kept results as choices,
a folder chosen in the system dialog stays in the local person's list across
restarts, and a tab on this machine names its principal again, so the person's own
edits read "You". Row questions on an ordinary CSV still need an identity choice (a declared
key column or a row position within one exact version); pages have no addresses yet.

Its [second pass](SIMULATED-PROJECT-EPISODE.md#second-pass) moved review onto the
answer. The Overview leads with an answer board derived from the Graph: results by
role, then method, run, inputs and report. Ask on a result or a selected passage
continues the same conversation, and later questions stay with the answer they ask
about. Use this answer or Needs changes (`conversation.decide`) is bound to the
versions the message kept. Review is listed only while review records exist. The
Console (Console 0.1.0) lists the Agent's and the person's commands, and runs, stops
and reruns the person's own (local browser only). A message's commands read in the
order they ran, each led by the Agent's own words on what it was for (Agent 0.4.23). Agent 0.4.19 keeps a command's
whole text. Repeated reads no longer exhaust a message's capture budget before its
results. Agent-declared choices are shown by the meaning layer pass below, without Agree/No.

The [process Studio](SIMULATED-PROJECT-EPISODE.md#process-studio) pass made Studio show
how a conversation's work was done. Each conversation started in Rho has its own
Studio, laid out from its record by role: data, script and a Commands view down one
side, figures above tables and reports on the other, each file's view naming the kept
version it shows. A chip names the part of the work in progress, and a timeline runs
beside the Agent panel. A moment chosen there replays the views, commands, part and
conversation together. Arranging saves the layout as `conversation-<id>`. The person's
own workspace still opens nothing by itself.

The [project notes](SIMULATED-PROJECT-EPISODE.md#project-notes) pass lists the sessions
under Studio in the sidebar, then the person's workspaces, and shares one set of notes
(`project-notes.md`) beside every Studio layout. Rho asks each session it starts, in
its Agent's instructions (Agent 0.4.20), to keep one section: a heading naming its task
with its session marker, then Question, Data & method, Key results with a figure and
To do. That heading titles the session. In a live run Claude Code (DeepSeek V4.1 Flash)
wrote its section unprompted by the message, and the title followed within seconds.
The panel reads the notes formatted, ticks to-dos in place and edits them with a
toolbar (Markdown 0.2.0, Documents 0.4.8); the person's edits save after a pause.

The [meaning layer](SIMULATED-PROJECT-EPISODE.md#meaning-layer) pass reads each section
of the notes as a question, method, findings, figures, choices, file descriptions and
to-dos, each with the files it links. Kept versions of the notes trace a statement to
the message that wrote it and each file to the version kept then. The Graph shows
Meaning + process by default, or either layer alone, with "kept as" and "written in"
edges into the process. The answer board and Studio's file views say what each file
holds. A choice shows what it is about and what was taken, with any other option the
notes name under it, nested or in the same sentence, and what it gives; Use this
instead drafts a message, and nothing waits on the person. The Agent followed the
fixed subsections, linked its files and computed some alternatives, but described files
at the end of its run, not as it wrote them, even when told to.

The [descriptions](SIMULATED-PROJECT-EPISODE.md#descriptions-while-the-work-goes-on) pass
reads each file a running message writes: facts from its bytes within seconds, then one
sentence from the conversation's model through the person's own Claude Code with no tools
(Agent 0.4.22). Studio, the answer board and the Graph show the notes' words first, then
the sentence with its model, then the facts. In two live runs, results had facts within
6 s of being written and sentences within half a minute (10 s median in the first).
[Figures](SIMULATED-PROJECT-EPISODE.md#figures-cost-and-a-switch) go to the model as
images when models.dev lists it as reading them, else as the code that made them. Each
call is priced by Claude Code or from models.dev's price; the session popover shows the
conversation's spend and a person-wide switch. In the ninth copy, 13 calls cost about
$0.0086, and the first image sentence misnamed the plot type.

The [quick checks](SIMULATED-PROJECT-EPISODE.md#quick-checks-choices-and-the-console)
from rho-bio-eval ran in Rho: bix-18 (Python) had 4 of 5 answers in range twice, the
miss being a proportion against a range written as a percentage; bix-51 (R) had 7 of 7.
The Choices and the Console were redrawn from what these runs showed.

The [Notebook](SIMULATED-PROJECT-EPISODE.md#the-notebook) (Notebook 0.1.0) keeps a live R
and a live Python session per project that the person shares with the Agent. Its page lists
cells in the order they ran with who ran them and why, the code, output streamed as it is
printed with messages and warnings in place, plots, and the session's variables; the person
runs, edits, reruns and interrupts cells, and only they stop a session. A conversation's
Studio shows the cells its Agent ran. In fresh quick checks the Agent ran its script in the
session (bix-51 7 of 7 in 5 cells, bix-18 4 of 5 in 4 cells) rather than exploring cell by
cell. The default Agent grant had reached its 64-method limit, so the limit is now 96
(`layeredGrantLimits.maxMethods`); a larger grant is still refused.

The Notebook is also a view of any Studio page
([episode](SIMULATED-PROJECT-EPISODE.md#exploring-a-finished-answer)). The person makes
empty workspaces of their own and adds the Notebook or project files to them. Explore in R
or Python on a table or script, from Studio, the answer board or the file page, opens it on
their workspace beside the Notebook: a table loads as a new value in their own cell, a
script waits in the line to run. A Studio stage under 640 px shows its views one at a time.
Pages cannot yet be renamed or removed.

Values of the live sessions have a view of their own
([episode](SIMULATED-PROJECT-EPISODE.md#looking-at-values)). Notebook's `kernel.inspect`
reads one value as its session describes it, without starting, waiting for or changing a
session; each cell names the values it made, changed and removed. From the Notebook's
variables or a cell's names the value opens beside the Notebook, or as a tab next to it
when a split would leave either under 360 px: a table pages, sorts and gives each column's
type and summary; a model its fit and coefficients; a list its parts, each opening in place
with the code that reaches it, which Use in Notebook puts in the line. While a cell runs or
after the value is gone, the last reading stays, dimmed, with the cell it was read after.

The four panes of interactive exploration, a script, its console, the variables and the plots,
are made from these components ([episode](SIMULATED-PROJECT-EPISODE.md#script-console-variables-and-plots)).
⌘/Ctrl+Enter or Run in an R or Python script runs the selection, or the statement the cursor
is in, as the person's cell and moves on; a page without the Notebook gets one under the
script. Variables and Plots are views of their own, in a column along the page's right side.
R now draws on one device for the whole session, so a later cell draws over an earlier plot
and a sourced script keeps each plot. No Agent ran cells in this layout.

The Notebook has [two forms](SIMULATED-PROJECT-EPISODE.md#two-forms-of-the-notebook) of the same
sessions, switched in its header: the notebook, and a console with one transcript of prompts and
output, Enter that runs finished code and continues unfinished code, history, Esc and Clear. A
Studio view saves its form with the page; one placed by running a script's line starts as a console.

[Toolbars](SIMULATED-PROJECT-EPISODE.md#toolbars) take one form whichever component puts a
control in a view's header: quiet words and icons, Run in the accent, one kind of switch, and a
control only while it can act (Documents 0.4.9: Save with unsaved edits, Review with a selection,
Highlight changes while Agent or disk edits remain). The Activity row joined the Studio bar, so
the code starts 72 px higher at 1440 × 900, and tabs scroll before a selection's controls can move
the view.

[Sources follow the project](SIMULATED-PROJECT-EPISODE.md#sources-that-follow-the-project):
Variables lists the live sessions' values between Code and Results, each opening in Studio, and
Workflows, Reports, References and Environment appear when the project holds such files. The
Notebook's language switch is the small chip each cell carries, in its input as at the console.

[Data flow](SIMULATED-PROJECT-EPISODE.md#data-flow-html-pages-and-object-dependent-cases) joins
code and values: each cell now names what it read and the project files and folders it named
(Notebook 0.1.1), and a Data flow tab beside Variables shows each cell that made something still
there, in run order, with lines from each value to the cells that read it, values changed in place
and reads made stale. An HTML file opens as its page (HTML 0.1.0) in a sandboxed frame with no
network, with its project styles, scripts and images. In bix-46 (R, a DESeqResults object) both
answers matched; the phylogenetics files of bix-58/60 (Python, ClipKIT run in the session) gave
bix-60's 19 only for five of the ten trees and did not reproduce bix-58. The runs found and fixed an
S4 value listed as changed by printing, scope and rerun errors in what a cell read, and unrecorded
folders.

## Existing application

- Projects opens selected folders and manages finite source folders. Sources counts
  and browses Data, Code, Results & figures and Notes in one bounded walk; Files
  exposes the project/source folders. Current-file previews remain current-file facts.
- Studio shares one Documents buffer per logical document, with confirmed versions,
  own undo and concurrent-write detection. An Agent edit beside unsaved text is
  merged or sent through the Documents hook ([record](DOCUMENTS-EPISODE.md)).
  Tabs/splits/moves retain original layout intent and do not cancel tasks.
- Agent supports Claude/Codex ACP, retained session identity, settings/model choices,
  native permission requests, cancellation/unknown outcomes, trash and Markdown
  conversation export. Reads/reconnect do not replay prompts
  ([ACP](ACP-MULTI-AGENT-EPISODE.md), [panel](AGENT-PANEL-EPISODE.md)).
- Managed execution retains Core's original request identity, output, stop/repair
  facts and integrity checks. Native execution remains available without Core
  ([boundary](NATIVE-TOOLS-EPISODE.md)). Completion, integrity, domain checks and model
  judgments are separate facts. Observing native tools grants no managed guarantee.
- Project/method-scoped HTTP/SSE and MCP discovery expose selected owner capabilities.
  Local browser access uses same-origin loopback checks; narrower paired access
  keeps its project/method scope. Models cannot expand grants or create human decisions.
- Independent UI extensions contribute optional views over selected capabilities;
  standalone previews receive no project credentials and start no runtime
  ([authoring](PLUGIN-AUTHORING.md)).

Earlier observations remain in the [home/project](HOME-PROJECT-EPISODE.md),
[sidebar/canvas](AGENT-CANVAS-EPISODE.md), [Graph](GRAPH-EPISODE.md),
[Agent page](AGENT-PAGE-EPISODE.md), [Agent activity](AGENT-ACTIVITY.md) and
[backend acceptance](BACKEND-ACCEPTANCE.md) records. Their checks retain their
original scope; they do not establish usability of later changes.

## Verification

Baseline: Plugins 104/104 and Rho 223/223 with an explicit unchanged Core binary.
The first full changed run passed Plugins 109/109 and Rho 227/228; an undeclared
new CSS variable caused the application failure and was corrected. The second pass
(answer board, decisions, Console, Agent 0.4.19) passed Rho 240/240. The process Studio
pass first failed 244/245 on another undeclared CSS variable, which was corrected;
Rho 245/245 and Plugins 117/117. The Notebook pass first failed Rho 257/260: two
checks still held the 64-method limit and the plugin count, and the Skill's verify
command was not an application script; corrected, Rho 261/261 and Plugins 132/132. The
exploring pass first failed Rho 263/264, the Studio shell importing a module outside its
allowed set, and ui:u2 also matched the New workspace row; corrected, Rho 264/264 and Plugins 132/132.
The Data flow pass records Rho 273/274 and Plugins 141/141 in the [ledger](VERIFICATION.json): the
MCP v2 test was cancelled at its 30 s limit and passed alone in 19.8 s; the contract check and the
same eight acceptances passed, and shell and interaction failed as before. The Sources pass recorded
Rho 268/269, Plugins unchanged at 134/134: the MCP v2 test was cancelled at its 30 s limit and passed alone in 18.1 s. The contract
check and the sources, ui:u2, agent-canvas, graph, agent-page, agent-ui, review and person-files
acceptances passed; ui:u2 first failed counting the Overview's 3-row previews among the grid's
reads, and now counts from the Table tab. The shell acceptance (editor focus at 390 px) and the
interaction acceptance (a `/^workspace/` sidebar row) failed before the toolbar pass and remain
open. Earlier passes: toolbars Rho 268/269 and Plugins 134/134 with the same acceptances; two forms Rho 269/269 with the seven acceptances (graph passed
when run again alone); four panes Rho
268/268 and Plugins 134/134, both suites run again after the R runner's reading fix; value view Rho 265/265 and Plugins 134/134; choices and Console Rho 260/260 and Plugins 125/125; figures and cost Rho 258/258; project notes Rho 249/249 and Plugins 120/120 (ui:u2 first
failed until the notes stopped opening with every project); meaning layer Rho 253/253;
descriptions Rho 257/257 and Plugins 122/122, each with the same seven acceptances.
The [episode](REVIEW-EVIDENCE-EPISODE.md) records contract, browser and installed results.
The fixed 0.5.1 candidate passed 230/230; installed review/Graph/restart and both real
clients passed. See the [preview](PREVIEW-0.5.1.md) for identities and limits.
No failures are converted into passes by omitting the failed run.

Automatic capture defaults: 8 MiB/snapshot, 64 snapshots and 32 MiB/turn, at most
two workers/project (initial collector serializes), Files 512 MiB/1024 resources.
Export defaults: 512 MiB/128 files/4 MiB metadata; previews 200 rows/20 columns and
64 KiB text. Exhaustion preserves earlier evidence, output and uncertainty.
[Headless](HEADLESS.md#retained-review-evidence) names configuration and behavior.

## Scope and follow-up

The product target is local WebUI on macOS arm64. Windows/Linux folder picking,
POSIX locks, executable discovery, packaging and installation need their own
portability acceptance. No cloud/account/team/billing, native shell, automatic
runtime download, public npm publication or signed release is included.
[Release](RELEASE.md) separates source, fixed composition, installation and future
signed distribution. Offline evidence is not a workspace restore or executable
analysis format. Existing archives preserve owner fields within their stated scope
and reject older collaboration formats that would lose state.

The user withdrew the 2026-10-25 frontend guidance; Git retains it, but it is not a
requirement. The [2026-10-26 design commission](design/2026-10-26/index.html) describes
a broader designer task, not a template for these implemented screens. Current work
advances by running real episodes and reviewing their results
([Development](DEVELOPMENT.md), [Frontend](FRONTEND.md)). No independent researcher
trial or physical IME observation has yet established ease of use.
