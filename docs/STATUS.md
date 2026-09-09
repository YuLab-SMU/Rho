# Rho: current state and focus

Updated: 2026-09-09. This is the single current status summary. Git retains history.

## Parent-region docking refinement

The 2026-09-09 follow-up identified an unreachable/unclear parent docking path:
Agent could land beside Plots, while the requested destination was the common
right of Objects and Plots. The floating parent matrix was below the native
transparent drag overlay and included the source in region names. The new client
places reachable arrow targets at shared panel boundaries, highlights the whole
destination and previews the final occupied area. Native single-panel and workspace
edge drops remain available, with Move To for explicit placement. Target names omit
the dragged source; the engine can redistribute space released by that source.

The user's live trial window was moved through the existing placement command to
Agent beside the complete Objects/Plots column. No Host, Agent task or R session was
restarted. The running Host retains its embedded client; the improved drag targets
are in the rebuilt client for subsequent launches. Validation passed: 296 frontend
tests (including the parent/source-extraction regression), all 34 isolated Chrome
scenarios, frontend boundary checks/fixtures, typecheck, generated client consistency,
current binary build and governance checks. The real mouse-drag case verifies exact
preview/drop geometry, draft preservation, no Agent commands, undo and Escape.
Screenshots are `target/studio-browser/agent-parent-drag-{preview,result}.png`; the
full Chrome log is `target/agent-task-development/parent-docking-chrome.log`.

## Workspace Agent tasks

The user approved the fourteen [Paper Agent boards](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/6-2)
and authorized the complete first-version implementation, using Kimi Code with
`b-ai/glm-5.3-flash` (GLM 5.3 Flash, B.AI) for real development tests.
The independent Agent page retains those boards; the general workspace page was
not repurposed. [Design section 13](RHO-DESIGN.md#13-workspace-agent-tasks--approved-interaction)
records the approved interaction and native-capability distinctions.

The singleton dockable Agent panel now owns daily task chat, a wide task rail or
narrow selector, per-task saved drafts/conflict copies, rename/archive, native
permissions beside the composer, attachments and @ context previews. Settings
retains discovery, explicit installation, models, manual MCP and independent Test.
No CLI is scanned or model request sent merely by opening the panel. Window-local
selection/reading state stays in ApplicationPersistence; R-session changes do not
remove Agent tasks. Files/editor/R tables/plots use their existing read owners;
plugins have a read-only information-source registration seam, not an installed
illustrative analysis plugin.

ApplicationStore has additive typed task/attachment/draft/receipt/event/asset tables.
The Host task service owns admission and native lifetime, request deduplication,
draft CAS, controller/generation fencing, eight-connection budgets and bounded
observations. Receipts and terminal states persist immediately; durable cursors
are distinct from in-flight native observations. A stopped/uncertain connection
cannot bypass old-process proof through Disconnect or Resume. Native CLI history
is never reconstructed from Rho's display cache or used to replay scientific work.
Codex uses exact thread resume and native pages; Kimi uses verified exact-ID load
and context replay; DeepSeek uses resume/close/resume after interruption to clear
its native Inbox. User configuration and the disabled global Kimi rho MCP entry
remain unchanged; each task receives a fresh explicit MCP connection.

Executed evidence in `target/agent-task-development/`:

- `kimi-task-acceptance.log`: real Kimi 0.41.0 / B.AI GLM 5.3 Flash; two same-model
  tasks return separate alpha/beta responses, duplicate request IDs do not replay,
  both resume the same native ID, and the resumed Agent performs a new MCP overview
  read of the correct disposable project. Original configuration hashes unchanged.
- `kimi-recovery.log`, `codex-recovery.log`, `deepseek-recovery.log`: each real
  runtime survives a forced, independent Host crash through explicit same-ID Resume.
  The saved next draft and old uncertain receipt remain. Kimi/Codex identify a new
  red-square image; DeepSeek accepts only the new instruction. All three actually
  perform an MCP overview read through the new Host endpoint/credentials afterward.
- `codex-task-acceptance.log`: real Codex / gpt-6-astra; two concurrent tasks,
  exact separate responses, request deduplication and same-ID resume passed.
- `deepseek-task-acceptance.log`: real DeepSeek / 115-newapi deepseek-v4-flash;
  two same-model tasks, duplicate-request protection, same-ID resume and resumed
  native MCP overview passed. Native configuration hashes remained unchanged.
- `deepseek-native-inbox.log`: the installed lock-matched native Inbox implementation
  restores input queued before a crash, persists its removal on clear, and claims
  only a fresh instruction after another reconstruction. No model or user session
  is used by this deterministic native-code test.
- `fixture-recovery.log`: deterministic ACP crash/restart verifies no prompt during
  resume, changed Host MCP address/credential fingerprint, original uncertainty and
  image delivery. Native protocol tests cover Codex quiet/history/cursor rules,
  Kimi replay/session fencing and DeepSeek queued-Inbox cleanup/failed-close refusal.
- `chrome-final.log`: the full isolated Chrome suite passed **33/33**, including
  normal/narrow/wide Agent layouts, native permission modes/options, archived-task
  reminders while closed, two-window takeover, attachments, real R tables/plots,
  independent diagnostics and existing editor/layout/scroll/execution regressions.
- `frontend-tests.log`: **295 frontend tests** passed. Source ownership boundaries,
  generated bindings/embedded assets, typecheck and strict workspace Clippy passed.
- `task-service-final.log`: **10 focused Host task tests** passed, including plugin
  source containment, stale ownership, stop/closing races and uncertain resume.
- `workspace-tests.log`: **244 full-workspace Rust tests** passed; **7 conditional
  external tests** were ignored, not counted as passes. The final native-client
  run passed **25 tests**, including unconfirmed native submission errors.
- Real R, MCP and Workbench checks passed, including MCP/Workbench with real R.
  Environment, native-process recovery, local SSH/Slurm protocol, output-media,
  vendor integrity, governance and Agent-harness self-tests passed. These local
  protocol/self-tests do not claim remote-cluster or new scientific acceptance.

Live integration caught DeepSeek's lack of embedded-resource capability; text
context now uses native text input with its source retained. Chrome review corrected
file-kind filtering, the plot query name, constrained-picker clipping and a test's
window-list pagination. Native progress commentary remains separate from the final
answer; acceptance assertions now inspect the final native message.

Existing user Hosts and their R memory were not restarted. All new test Hosts use
disposable projects. The older native integration remains the basis for explicit
DeepSeek component setup (official 0.1.2-alpha.2) and manual MCP settings. Kimi's
global rho MCP entry stays disabled; task-specific injection has independently
passed real MCP reads. Build/runtime installation/publication remain separate;
this work does not install or replace a user Host automatically. An independent
trial project is available at `target/experience/agent-tasks-ready/study`, with a
blank Kimi task set to GLM 5.3 Flash (B.AI). It was opened in the app browser without
sending a model prompt. Its launch material stays in ignored local files; inspect
that project's live Host before starting another instance.

## Agent interface acceptance baseline

The Agent interface and standard Skills delivery is implemented and verified.
The frozen runtime/harness acceptance version is
`4bcd30903b55568844b20fb93589294b1a8c5f9d`. Evidence-packaging changes through
`a3f08a6` did not change that verified scientific runtime, client assets or
acceptance harness. The connection work above extends the current transport;
the frozen acceptance remains evidence for its recorded baseline only.

Shared Host discovery, concrete capability/result/recovery contracts, diagnostics
and read navigation cover the existing scientific owners. Objects and text use
bounded version-bound reads; package indexes bind exact installed copies; help
renders once from the selected database into retained text. Output reads share
verified originals, bounded native image previews, crops and resource chunks.

Application owns window identities, synchronized drafts/context, CAS receipts and
immutable scientific captures. The resident Studio bridge preserves concurrent
input and startup view choices. Saving/running retains the original caller through
the existing OperationGateway. Standalone CLI queries do not start R, acquire a
writer lease or recover operations; connected CLI requests use the existing Host.

Standard `.agents/skills` and launcher-attested native sources retain their original
resource bytes, enablement and source identities. Read receipts and explicit method
bindings are application metadata. Skills do not grant authority or run an Agent
loop. Native queries do not reload deliberately unloaded inspection/JSON providers.

## Verified evidence

- Rust workspace: 199 default tests passed. All seven separately enabled real-R
  and Environment tests passed through the native verification scripts; none was
  counted as passed while ignored. Strict whole-workspace Clippy passed.
- Frontend: 270 tests and 24 ownership/boundary fixtures passed. Generated DTOs,
  embedded assets and the current binary were checked together.
- Chrome: all 26 cases passed. Normal, wide and constrained screenshots were
  inspected. The fixed Gapminder load case measured typing p95 34.4 ms and frame
  p95 16.8 ms; additional views did not duplicate shared reads.
- Real Workbench/MCP, exact help, native image/resources, pak/renv realization,
  installer cancellation, retention/quarantine/restore/purge, lost-commit recovery,
  restart binding, CLI connection/query purity, process recovery, local SSH/Slurm
  protocol fixtures, architecture/governance and Jet checks passed. The original
  user R library was unchanged. No live remote-cluster acceptance is claimed.
- Independent Codex: **30/30 core runs and 4/4 Skills/adaptation runs passed**, with
  zero violations/failures, exact native/Rho method equivalence, and unchanged
  source/binary hashes. Model `gpt-6-astra`, reasoning `high`, Codex 0.153.4.
  Each run stayed within 80 calls, 1 MiB text and ten minutes. Maximum observed:
  30 calls, 524,698 text bytes and 197,407 ms. Images were metered separately.

The formal run retained 614 hashed artifacts (58,627,766 bytes) and took 16m55s
with three independent workers. Totals: 382 model tool attempts, 380 matched MCP
deliveries, 4,060,795 text bytes and 136,584 image bytes. Actual usage fields:
10,820,205 input tokens; 9,443,328 cached input; 46,945 output; 1,822 reasoning output.

The authoritative formal result is
`target/agent-interface/acceptance/4bcd30903b55-1788916155502-8ec26ea9/manifest.json`.
It records `acceptance=true`, `passed=true`, `fixed_tree=true`, all 34 results,
resource equivalence, original operation identities and the artifact inventory.
All earlier failed attempts remain under `target/agent-interface/acceptance`.
Command logs are under `target/agent-interface`; visual reviews are under
`target/studio-browser`. The evidence packer preserves originals, includes failed
attempts, sanitizes credentials in text/nested traces and records source/archive
hashes. Its tests and CI mapping are separate from scientific acceptance.

Frozen acceptance binary SHA256:
`c1b0157931004efa6af2fd76f8b9c6eab2f58bb08211877d8ce67a074f2dad91`.

## Operational boundaries

Existing user Hosts, R memory and configuration were preserved. All acceptance
instances were disposable. No product installation, signing or publication was
performed. Read [Operations](OPERATIONS.md) before starting another Host; inspect
current ownership and processes rather than reusing old PIDs, ports or tokens.
All Cargo invocations remain serial; build and verify from the integration checkout.

Native session evidence covers the managed fork/exec helper family. Unobservable
same-family processes and missing original evidence stay protected; independent
service-manager jobs and rollback of arbitrary external effects are not implied.

The approved Packages interaction remains in
[Paper](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/3-0).
Multiple runtimes/R-version switching, plugin execution, package-management UI,
abandoned-data migration, product installation and publication remain deferred.
The external acceptance runner is test tooling, not a product Agent behavior loop.
