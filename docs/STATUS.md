# Rho status

Updated: 2026-10-29.

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
new CSS variable caused the application failure and was corrected. Current checks: Rho 232/232, Plugins 110/110 in the [ledger](VERIFICATION.json).
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
