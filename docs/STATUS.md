# Rho status

Updated: 2026-10-30.

## Current focus

The selected work is result review, retained historical evidence, macOS arm64
0.5.1 preview delivery and a separately accepted offline reader. The
[episode](REVIEW-EVIDENCE-EPISODE.md) records baseline, observations, fixes and limits.
Native tools remain normal; Core is optional. No Core execution behavior changed.

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
and reruns the person's own (local browser only). Agent 0.4.19 keeps a command's
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
holds. A choice shows the option in use beside the others with what each gives; Use
this instead drafts a message, and nothing waits on the person. The Agent followed the
fixed subsections, linked its files and computed some alternatives, but described files
at the end of its run, not as it wrote them, even when told to.

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
Rho 245/245 and Plugins 117/117. The project notes pass records Rho 249/249 and
Plugins 120/120 in the [ledger](VERIFICATION.json). The agent-canvas, graph,
agent-page, agent-ui, review, ui:u2 and sources browser acceptances passed on that
build; ui:u2 first failed until the notes stopped opening with every project. The
meaning layer pass passed Rho 253/253 and the same seven acceptances.
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
