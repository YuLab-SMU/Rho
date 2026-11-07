# Rho status

Updated: 2026-11-07.

## Current focus
[Session continuity](SESSION-CONTINUITY-EPISODE.md): a Claude Code, Codex or Harness session in the project folder continues in Rho's Agent panel under its own session ID, wherever it started; sessions from outside Rho are no longer read-only. Conversations is one list read from each Agent's own records. A session open in another window is refused with where it is open, or continues as a copy. The Agents tab replaces new-conversation settings and holds the [connection prompt](AGENT-CONNECT-EPISODE.md). A real Claude Code passed all 8 steps (Rho and terminal in turn, held refusal, copy); Harness resumed both ways through `dsh acp`; Codex only with a test Agent. Source after 0.5.5 with Agent 0.4.30; not released.

[External conversations](EXTERNAL-CONVERSATIONS-EPISODE.md) join native Harness questions, replies, operations and result versions in Conversations; their input is now continued in Rho as above. The original two-turn palette-change session passes in installed Rho 0.5.5 and dsh-rho 0.1.5. CI passes on macOS/Linux/Windows, including four-platform offline installation. Rho 0.5.5 is available from npm with bytes matching the tested candidate; the public Harness index selects 0.1.5. The installed original session passes in both the browser and Harness window. No native tool was replayed and no Core behavior changed. The episode retains the unchanged MCP SDK/Hono dependency audit findings.

The [third-party plugin channel](THIRD-PARTY-PLUGINS.md) now installs independent packages; sclet and a generated package have real native/browser [evidence](THIRD-PARTY-PLUGINS-EPISODE.md). The application path is included in 0.5.5; external plugin packages retain their own delivery.

[dsh-rho project matching](DSH-RHO-EPISODE.md#conversation-project-matching) binds
tools and the launcher to the same verified folder. The public 0.1.5 Git package
is installed in the person's Desktop; the index is Rho’s own optional source.
Result review and offline evidence retain their [episode](REVIEW-EVIDENCE-EPISODE.md).
Native tools remain normal; Core is optional. No Core execution behavior changed. [P3 continuity](P3-CONTINUITY-EPISODE.md) reproduced a 64-turn stop and continued it after reopening; the restarted Notebook's in-memory state did not survive, and four native choices remained. Claude sessions now prefer Auto, and Rho sets no step or wall cap by default. Rerun so, P3 asked for no permission; the Agent's MCP bridge had cut Notebook calls at 30 s and then 300 s, and without those cuts P3 finished in the shared R session in 12.9 minutes.

The [research method proposal](https://github.com/YuLab-SMU/Rho-paper) centers on purpose-driven composition: selecting materials, arranging related views and operations, and carrying their meaning into Agent continuation. Plugins supply information, compute and environment capabilities. The single-cell walkthrough distinguishes scientific purposes and how inputs and execution conditions change the workspace. Galaxy and JupyterLab constrain plugin-related novelty alongside interface and shared-context comparisons. Remote connections remain illustrative; novelty and human benefits are not established by existing Rho checks.

| Part | Current behavior | Evidence or remaining work |
| --- | --- | --- |
| Immutable capture | Files snapshots survive original overwrite/deletion; disk and dirty buffer versions differ; server-side new-turn collection has budgets/gaps | Owner and conversation fault tests; no retrospective reconstruction |
| Result review | Row/range/resource questions, explicit replies, multi-field keyed differences, code changes and human decisions | Real airquality and browser trials; new versions need a new decision |
| Agent feedback | Frozen contexts join message identities; direct sends are separate from deciding; external handoff copies | Real Claude and Codex trials; context fetch differs from explicit reply |
| Graph | Exact captured refs and capture times, current-file action separate, honest reported/named/observed links, bounded focus | Same-path versions and 160-node-cap regressions; old records show gaps |
| Offline evidence | Preview one review and explicit refs; static reader/original files/manifest; read-only verifier | Service closed/project moved; four browser widths; tamper detection |
| macOS 0.5.1 | Unsigned npm tarball/local WebUI selected; Core bundled explicitly | [Fixed tarball installed and exercised](PREVIEW-0.5.1.md) |
| 0.5.2 candidate | 16 MB tarball for macOS arm64 and Linux x64/arm64, and a 12 MB Windows x64 one: one Core per platform (Core `c3dbeca`), Claude Code/Codex the person's own, all 12 plugins | [Packing, real Claude/Codex](PACKAGE-0.5.2-EPISODE.md); [offline install on four systems, Linux Notebook and Open folder](PLATFORMS-0.5.2-EPISODE.md); [Windows: Host lifetime and stop, installed checks](WINDOWS-0.5.2-EPISODE.md); x64 only under Rosetta; the full 0.5.1 acceptance not done |
| CI and npm | Each push that changes more than documentation builds the four Cores (each Core commit once), runs the suite on macOS, Linux and Windows, packs one candidate for all four platforms (3,030 files, 23 MB; bundled third-party packages keep what Node loads, licenses and reached declarations) and installs it offline on each; a `v*` tag publishes the candidate CI tested for that commit as `@rho-workspace/rho`, building nothing | [CI episode](CI-EPISODE.md): every job passes on the four platforms since run 7; [`@rho-workspace/rho@0.5.4`](CI-EPISODE.md#publication) published on 2026-11-05 from the candidate CI run 41975339969 tested, with provenance and its README, declaring `>=22.22.0 <27`; npm served it 55 minutes after accepting it, byte-identical to that candidate, and Linux x64 also installs it on Node 24 and 26; CI failed from `e92efb12` until `826d73c1` selected the Plugins commit the Data flow imports; pruning cut the Windows offline install by 35–39% |
| Third-party plugins | Runtime package installation, checked snapshots, CLI development, directory and Plugins management; optional sclet adapter uses the shared R session | [Episode](THIRD-PARTY-PLUGINS-EPISODE.md): real 200 × 60 synthetic SCE, PCA, audited report, stale-plan refusal and browser lifecycle. Source after 0.5.4; no npm release or independent usability claim |
| Independent researcher use | Unobserved | Trial guide in the episode; no usability claim |
| Example project | `example/pa14-qs` ships with the application; a new state copies it into the projects folder once, as an ordinary editable project | [Episode](EXAMPLE-PROJECT-EPISODE.md). Without folders (after 0.5.3), `npx @rho-workspace/rho` starts on `~/Rho/projects` and `~/Rho/state`, ships this project, and names a missing Agent client or R at startup; flagged starts are unchanged. The full suite also passes on Node 18.20.8 (end of life), below the engine range's 22.22. |
| dsh-rho 0.1.4 | Prebuilt public Git package and Rho’s own market index; each conversation’s tools and launcher select the same verified folder; [installation and upgrade guide](DEEPSEEK-HARNESS.md) | [Public workspace fix](DSH-RHO-EPISODE.md#public-workspace-fix): two fresh Harness 0.2.1-rc.5 installs, with and without scripts; all nine files match; direct public-index search, recovery after an unmatched query and the selected source detail checked; 6/6 adapter tests and earlier real MCP/Desktop project checks. No npm, default-source, TUI or other OS claim |
| Literature reproduction | Five papers of the 97 fully-open corpus reproduced in Rho 0.5.2 (bulk, snRNA-seq, GeoMx DSP, bulk+metabolome, multi-omics): Agents ran R in the shared Notebook, Rho captured cells, values, figures and notes | [Episode](LITERATURE-REPRO-EPISODE.md): two of five needed one turn and three needed 2–4, because the Agent client capped at 64 turns or waited on an event nothing wakes; 8–24 approval choices per run (counted); resource paths guessed. Conversation return and turn-limit continuation have a later [P3 pass](P3-CONTINUITY-EPISODE.md); the other issues remain. |
| Agent practice Skill | `rho.analysis-run` 1.1 is a shipped Skill for running a whole analysis in the live sessions, and every conversation started here is told to read it before a multi-step analysis | Written from the five reproductions above: spend calls on the analysis not on re-discovery, never wait for an event that does not come, draw to an explicit device, write files complete and to disk, and report the state actually reached. Read back through `skill.list`/`skill.read` on a running service; `test:notebook` is its verify command |
| Agent setup | A person asks their Agent to read <https://yulab-smu.top/Rho/doc/setup.md> ([SETUP.md](../SETUP.md)); the Agent installs the npm package, starts Rho on `~/Rho/projects` and `~/Rho/state`, installs the Agent Skill `skills/rho` in its own skills folder and connects itself to the example project | [Episode](DOCS-SITE-EPISODE.md#setup-page-and-agent-skill): the skill was checked against npm 0.5.3, and one fresh Claude Code session used it in the Notebook with no refusals; the page was followed by hand on 0.5.3 in a throwaway home, including the Claude Code and Codex configuration; [on the site](DOCS-SITE-EPISODE.md#the-latest-page-and-skill-and-the-node-row) the page and the skill's eight files answer 200, byte-identical to `f82bc77a`; no Agent has yet followed it from the one-sentence prompt; Windows was not run |
| Documentation site | <https://yulab-smu.top/Rho/> is a front page with the real WebUI replaying the shipped PA14 project's recorded session (no backend), the one install sentence that sends an Agent to the setup page, and the recorded and per-plugin example prompts, with no desktop installers until a current desktop release; `docs/` is published under `/docs/` with local search and every page naming its source file | [Episode](DOCS-SITE-EPISODE.md): the demo tour gets every request answered at 1440 and 390 px; the install prompts' commands ran on npm 0.5.3, and the front page now gives [the sentence](DOCS-SITE-EPISODE.md#the-front-page-asks-for-the-sentence) instead; [one Codex run](DOCS-SITE-EPISODE.md#the-install-prompt-on-a-real-machine) stopped at the Node check, lost its background start and exposed a port that moved per start, Codex grants shown as Claude Code's and stack-trace refusals, fixed in Rho; the prompts are unchanged; the four `updates/*.json` feeds are unchanged; the documentation, redeployed from `2d97d763`, names the registry's version and the Node range ([0.5.4](DOCS-SITE-EPISODE.md#the-documentation-for-054)); the demo is still the earlier build; no outside reader yet |
| Python environments | An Agent makes an environment in the project and passes `interpreter` (`.venv/bin/python`) to `kernel.run` (Notebook 0.5.3); the project keeps it for that language, a session only the Agent used starts again with it, and each session and cell records its program and version; the Agent panel reads install commands as what they installed | [Episode](PYTHON-ENV-EPISODE.md): five real runs outside Rho and from its Agent panel; installs made inside cells are not read as installs; other models and Codex unobserved |
| Variable relations | Under each Notebook cell, what it read and from which cell, and the later cells that read what it made; Variables names the cell that made each value and those that read it; Data flow is a graph of values from the files read to the results written or plotted, each node titled with the meaning the code's `# means:` comment gives (the Agent writes these; read from the text, never run), with functions and constants named on what uses them, a bar to trace one result, and the chosen value's path and details; beside a script's editor it is read from the text (R and Python) and marks the lines behind and in front of the chosen value (Notebook 0.5.5, Documents 0.4.11) | [Episode](VARIABLE-FLOW-EPISODE.md#redesign-a-graph-of-values) and [meanings](VARIABLE-FLOW-EPISODE.md#meaning-in-the-code): redesigned after the user judged the boxes useless; the shipped example in a real browser at 1440, 1920 and 390 px; with comments written by hand, the editor shows 13 of 19 values with a meaning, and a fresh Agent run's script reads as 6 of 7 values and both written files; read, not run, so names built at run time, dplyr columns named like a value and pasted paths are missed; the meanings are the Agent's words and no person has used them |

M0 retains Python/R highlighting, Markdown reading and native command exit/time/bounded
output ([record](CODE-MARKDOWN-EPISODE.md)); its report trial keeps scripts, results and
report after originals change. A first Codex feedback attempt cancelled by the acceptance's
permission selector stays recorded beside the corrected trial; Annotations 0.5.1 keeps a new
Review conversation for later feedback. Installed Codex needed a selected 64-choice native
permission budget (default 32); its grant scope did not change.

A [simulated-project episode](SIMULATED-PROJECT-EPISODE.md) ran two rho-bio-eval
capsule projects through Rho with Claude Code and changed what their screens showed:
Studio's eight-view budget now renders the views on screen first, Overview opens with
the latest answer, the Graph folds a message's versions of one file and its unrelated
commands, Review (Annotations 0.5.2) offers questions and kept results as choices,
a folder chosen in the system dialog stays in the local person's list across
restarts, and a tab on this machine names its principal again, so the person's own
edits read "You". Row questions on an ordinary CSV still need an identity choice (a declared
key column or a row position within one exact version); projects and conversations now have addresses, while other pages do not.

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
([episode](SIMULATED-PROJECT-EPISODE.md#exploring-a-finished-answer)). The person makes empty
workspaces of their own and adds the Notebook or project files to them. Explore in R or Python on a
table or script, from Studio, the answer board or the file page, opens it on their workspace beside
the Notebook: a table loads as a new value in their own cell, a script waits in the line to run. A
Studio stage under 640 px shows its views one at a time. Pages cannot yet be renamed or removed.

Values of the live sessions have a view of their own
([episode](SIMULATED-PROJECT-EPISODE.md#looking-at-values)). Notebook's `kernel.inspect`
reads one value as its session describes it, without starting, waiting for or changing a
session; each cell names the values it made, changed and removed. From the Notebook's
variables or a cell's names the value opens beside the Notebook, or as a tab next to it
when a split would leave either under 360 px: a table pages, sorts and gives each column's
type and summary; a model its fit and coefficients; a list its parts, each opening in place
with the code that reaches it, which Use in Notebook puts in the line. While a cell runs or
after the value is gone, the last reading stays, dimmed, with the cell it was read after.

The four panes of interactive exploration, a script, its console, the variables and the plots, are made from
these components ([episode](SIMULATED-PROJECT-EPISODE.md#script-console-variables-and-plots)). ⌘/Ctrl+Enter
or Run in an R or Python script runs the selection, or the statement the cursor is in, as the person's cell
and moves on; a page without the Notebook gets one under the script. Variables and Plots are views of their
own, in a column along the page's right side. R now draws on one device for the whole session, so a later
cell draws over an earlier plot and a sourced script keeps each plot. No Agent ran cells in this layout.

The Notebook has [two forms](SIMULATED-PROJECT-EPISODE.md#two-forms-of-the-notebook) of the same
sessions, switched in its header: the notebook, and a console with one transcript of prompts and
output, Enter that runs finished code and continues unfinished code, history, Esc and Clear. A
Studio view saves its form with the page; one placed by running a script's line starts as a console.

[Toolbars](SIMULATED-PROJECT-EPISODE.md#toolbars) take one form whichever component puts a
control in a view's header: quiet words and icons, Run in the accent, one kind of switch, and a
control only while it can act (Documents 0.4.9: Save with unsaved edits, Review with a selection,
Highlight changes while Agent or disk edits remain). The Activity row joined the Studio bar, so
the code starts 72 px higher at 1440 × 900.

[By hand](AGENT-CANVAS-EPISODE.md#the-persons-own-hands-on-the-layout), the person arranges Studio
as the Agent does: × on the shown tab, a middle click, Delete or the tab's menu closes, with Undo;
a group's + adds a view into it; the strip beside its tabs drags the whole group, also to a side of
the page. Tabs narrow to icons, so a view's controls take a second row sooner. In a conversation's
Studio a replay shows the work's views even when closed, and with all closed [Lay out the work
again](AGENT-CANVAS-EPISODE.md#closing-every-view-of-a-conversations-studio) restores them.
The live sessions' views (Notebook, Variables, Plots, Data flow, Servers, a value) now come from the
Kernel plugin's own `./ui` as registered components (Notebook 0.4.0), and the person's command line
and records from the Console plugin's (Console 0.2.0); Rho keeps the layout, the page services it
hands them, the Agent's commands and managed runs ([Frontend](FRONTEND.md)). The views still use
Rho's base classes and theme tokens, which no written contract names yet.

[Sources follow the project](SIMULATED-PROJECT-EPISODE.md#sources-that-follow-the-project):
Variables lists the live sessions' values between Code and Results, each opening in Studio, and
Workflows, Reports, References and Environment appear when the project holds such files. The
Notebook's language switch is the small chip each cell carries, in its input as at the console.

[Data flow](SIMULATED-PROJECT-EPISODE.md#data-flow-html-pages-and-object-dependent-cases) joins
code and values: each cell now names what it read and the project files and folders it named
(Notebook 0.1.1), and a Data flow tab beside Variables draws the values a live session made as a graph
from the files read to the results, each node titled with the meaning its `# means:` comment gives
(Notebook 0.5.5). An HTML file opens as its page (HTML 0.1.0) in a sandboxed frame with no
network, with its project styles, scripts and images. In bix-46 (R, a DESeqResults object) both
answers matched; the phylogenetics files of bix-58/60 (Python, ClipKIT run in the session) gave
bix-60's 19 only for five of the ten trees and did not reproduce bix-58. The runs fixed an S4 value
listed as changed by printing, scope and rerun errors in what a cell read, and unrecorded folders.

[Live sessions on a server](REMOTE-EPISODE.md): R and Python can run in a folder on a server
that ssh reaches as the person's own setup does (Notebook 0.2.0). A place names the ssh
destination, the folder and setup lines; a check reports the system, R and Python there; each
language's next session starts where the project marks it. A Servers view adds, checks and
chooses places and lists a place's files, opening one as a copy under `remote/<place>/` with its
size, time and digest; the Notebook, Variables and Data flow name where a session runs. On a
disposable Linux server holding bix-46's data only, the analysis ran there (mexG −4.96, its
plot shown here), a written file opened from Data flow, and a dropped network left the running
cell unknown and ran nothing again. The episode fixed interrupt under dash, UTF-8 text from a
login without a UTF-8 locale and Explore loading local paths on the server.

[Servers' own skills](REMOTE-EPISODE.md#servers-own-skills) (Notebook 0.3.0): how a server is
used is now the server's own skill, not Rho's code. A server the person manages with serverctl
is reached through `serverctl exec`, which holds its login, and `kernel.servers` lists those
servers with the skills serverctl binds to each; `kernel.server.skill` reads one. The Servers
view lists them and reads one in place; the Agent's instructions say to follow them. On a
disposable server whose R is only on a module path, with a skill saying so, the skill's line
found R 4.2.2 where the person's check found none, and an Agent with Rho's tools only read the
skill, named a place with its setup line and wrote where the skill says. Claude
Code started in Rho loaded the person's own ssh-server-manager skill, ran its own shell and
waits on the person's choice. The serverctl on this machine's path is older than its registry
("schema 8 is newer than supported 5"), and Rho shows that. A session left running after a drop,
scheduler compute nodes and the real lab cluster were not exercised.

[A study on a lab server](REMOTE-EPISODE.md#a-study-on-a-lab-server): the pa14-qs case in
Rho-cases asks one paper's BixBench study in steps of an Agent with Rho's tools only, its data
on a disposable server reached through serverctl with its own skill. Its first run spent 15 of
23 calls finding operations and reported the place's folder missing while a session ran in it.
The protocol now describes the server operations, the first index summarizes each owner, a
resolve continuation may add knownRefs, and the kernel looks for the folder after the setup
lines. Steps 1 to 3 then found the server in five calls each and shared one live R session there
(graded 4/5, 6/11, 0/7: analysis choices and, in step 3, stored results that the Agent showed
do not come from the counts). The Overview, which said "No work yet", now shows the Notebook's work.

[Project skills](SKILLS-EPISODE.md) (Skills 0.1.0): how work is done in a project is kept as its own
skills, `SKILL.md` files in `.claude/skills/` that Claude Code loads and other Agents read through
Rho. Each change keeps its author, reason, evidence and versions; undo is a change; an edit outside
Rho is seen and kept before anything is written over it. The Skills page leads with a skill's newest
change beside Undo, and the Overview lists the newest changes. In pa14-qs with the person's notes,
every Agent listed the skills before its first cell, recorded the notes, and new Agents followed
them (step 1 again 5/5). A rule an Agent widened while recording carried over too; the guidance now
keeps the person's terms. Seed skills and records from failures are not built.

[Timeline events](TIMELINE-EVENTS-EPISODE.md): a plugin names a read of who did what and when
(Notebook 0.5.0 `kernel.events`, Console 0.3.0 `console.events`); the Graph, the Overview and a
conversation's Studio place its events by principal: the person's cells and commands in a lane
named You, an Agent's cells in its conversation's, others in Outside Rho. The Notebook keeps its
name: in four runs of the person's "在notebook 中演示一下ggplot2", Agents used the shared R session.
The conversation that made a Quarto file began before the Notebook existed and could not be
replayed. Agents now read that "in the notebook" means Rho's sessions, untested on old histories.

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
- `rho-screen-check` opens a page at four widths in a real browser, reports what it measures beside a screenshot per width, and changes nothing on the page ([record](SCREEN-CHECK-EPISODE.md)).

Earlier observations remain in the [home/project](HOME-PROJECT-EPISODE.md), [sidebar/canvas](AGENT-CANVAS-EPISODE.md),
[Graph](GRAPH-EPISODE.md), [Agent page](AGENT-PAGE-EPISODE.md), [Agent activity](AGENT-ACTIVITY.md) and
[backend acceptance](BACKEND-ACCEPTANCE.md) records, within their original scope.
## Verification

Passes from the baseline (Rho 223/223, Plugins 104/104, an explicit unchanged Core binary) to Sources recorded up to Rho 273/274 and
Plugins 151. Each first failure was an undeclared CSS variable, a stale count or limit in a check or a shell import, then fixed;
each later miss was the MCP v2 test at its 30 s limit or a `.rho` cleanup race (`ENOTEMPTY`), passing alone. Their pages, ui:u2,
person-files, agent-canvas, graph, agent-page, agent-ui, sources and review acceptances passed. The shell (editor focus at 390 px)
and interaction (a `/^workspace/` sidebar row) acceptances failed before the toolbar pass and remain open; Git history keeps each
count. Later passes (by-hand and plugin views, Rho 264/267, Plugins 161/161; timeline events, Rho 267/269, Plugins 163/163) had only
those misses, and their browser acceptances passed. The [episode](REVIEW-EVIDENCE-EPISODE.md) records contract, browser and
installed results; the fixed 0.5.1 candidate passed 230/230 ([preview](PREVIEW-0.5.1.md)). No failure is omitted to make a pass. The
0.5.2 packaging pass recorded Rho 269/270 and Plugins 165/165, and Windows 11 x64 Rho 259/273 (13 skipped, MCP v2 cancelled) and
Plugins 158/166 (8 skipped). The CI pass records Rho 275/277 and Plugins 165/166 on macOS in the [ledger](VERIFICATION.json). In
[CI](CI-EPISODE.md) run 7 every job passed: 275/277 on macOS and Linux x64, 262/277 on Windows (15 skipped), and all four
installations. The [screen-check](SCREEN-CHECK-EPISODE.md) pass ran 20 of 20 in a verification copy, and the installed tarball's `rho-screen-check` ran offline.

Automatic capture defaults: 8 MiB/snapshot, 64 snapshots and 32 MiB/turn, at most two
workers/project, Files 512 MiB/1024 resources; export 512 MiB/128 files/4 MiB metadata,
previews 200 rows/20 columns and 64 KiB text. Exhaustion preserves earlier evidence, output and uncertainty ([Headless](HEADLESS.md#retained-review-evidence)).
## Scope and follow-up

The product target is local WebUI on macOS arm64, Linux x64/arm64 and Windows x64, each installed from one tarball in CI.
No cloud/account/team/billing, native shell, automatic runtime download or signed release is included; npm publication
of a `v*` tag published `@rho-workspace/rho` 0.5.2, 0.5.3 and 0.5.4. From 0.5.2 the person installs the Agent clients; Rho pins their ACP
adapters. [Release](RELEASE.md) separates source, fixed composition, installation and future signed distribution. Offline evidence
is not a workspace restore or executable analysis format. Existing archives keep owner fields and reject older formats that would lose state.

The withdrawn 2026-10-25 frontend guidance and the [2026-10-26 design commission](design/2026-10-26/index.html)
are not requirements or templates for these screens. Current work advances by running real episodes and reviewing their results
([Development](DEVELOPMENT.md), [Frontend](FRONTEND.md)). No independent researcher
trial or physical IME observation has yet established ease of use. The workspace's first load made a 404 from `agent.activity.capture`: the preview asked for a capture of an R script, and the example's paths carried the projects-folder prefix. The preview no longer asks for files capture refuses, and new installations get project-relative paths ([record](SCREEN-CHECK-EPISODE.md)).
