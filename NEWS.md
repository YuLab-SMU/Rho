# Rho NEWS

This file records user-visible changes by release. It is intentionally
separate from the architecture plan: the plan describes intended work, while
this file records behavior included in a versioned build candidate.

## 0.4.0-dev.25 - 2026-08-09

### Added

- Agent history is now organized into durable, project-scoped Conversations.
  Users can start and switch to another Conversation while unrelated Agent
  work continues, up to the bounded two-turn limit.
- A terminal Turn can be retried without rewriting its original prompt or
  result, and one inactive selected Conversation can be deleted without
  clearing unrelated history.

### Improved

- Cancellation, approvals, model context, and status updates are isolated to
  the exact Turn and Conversation. Workspace R requests remain serialized,
  while independent Agent/model work and different-file changes can proceed
  concurrently.
- Agent file Apply and Undo are scheduled per normalized project file. Same-
  file conflicts fail stale instead of overwriting, and interrupted mutations
  recover after restart as verified applied, not applied, or outcome uncertain.
- Project switching is ordered against Agent-turn and file-mutation admission,
  closing the preflight race between a new resource claim and a project change.

## 0.4.0-dev.24 - 2026-08-08

### Fixed

- The Agent-first Task Rail no longer presents every Act turn as an error.
  Ask, Plan, and Act now use distinct neutral MessageCircle, ListChecks, and
  PencilLine shapes, while the independent status dot remains the only
  status-color slot.

### Improved

- Task Rail rows now expose explicit mode and status names, tooltips, a current
  selection state, and preserved keyboard focus. Empty previews remain
  truthful, and long or Unicode previews ellipsize without widening the rail.
- Selected mode icons may use the Rho accent, but approval, destructive-action,
  and review risk remain on their existing decision surfaces.

## 0.4.0-dev.23 - 2026-08-08

### Fixed

- File parse failures with an exact R parser location now carry a durable
  one-character `r_parse_token` diagnostic through Workspace, schema v11,
  Problems, and the Console error site. `Fix with Agent` selects that token
  automatically and starts the same read-only repair flow without asking the
  user to select code already located by the parser.
- Parser locations are accepted only from the bounded anchored parse phase and
  only when they identify an actual Unicode scalar in the submitted code.
  EOF, malformed, oversized, out-of-source, nested, or untrusted locations
  remain explicitly unavailable.

### Improved

- Console now distinguishes “exact diagnostic and failed run ready” from
  “failed run ready; exact source range unavailable,” while Problems and
  Console share the same closed `r_expression`/`r_parse_token` routing rules.
- Store schema v11 adds the parse-token range kind through a transactional,
  backed-up v10 migration without guessing or backfilling historical errors.

## 0.4.0-dev.22 - 2026-08-08

### Fixed

- Failed non-render R executions now show the shared `Fix with Agent` action
  directly beside the Console error. The action waits for the exact durable
  failed run and diagnostic range, then starts the existing read-only
  `problem_repair` flow without requiring a visit to Problems.
- Console repair actions reject late refreshes and become permanently disabled
  after a project switch. Failed history refreshes offer bounded recovery, and
  missing durable context asks for a new run instead of submitting partial
  evidence or creating a duplicate Agent turn.

### Improved

- Console and Problems now derive `Fix with Agent`, `Select code for Agent`,
  and `Set up Agent repair` from one action-state helper, so Provider routing
  and exact-range recovery remain consistent on both surfaces.

## 0.4.0-dev.21 - 2026-08-08

### Fixed

- `Fix with Agent` now starts registered-Provider repair sessions with the
  exact canonical model identity carried by the function-calling Act route.
  The read-only Ask policy and one-credential boundary remain unchanged, and a
  route/profile mismatch still fails before any Provider request.
- Environment now automatically re-inspects the selected R object after a
  Workspace state change, including executions that mutate objects before
  failing. The Data Viewer receives a current view token instead of asking the
  user to recover from its own stale revision.

### Improved

- Automatic object refresh preserves the selected view, literal query,
  compatible sort, page size, and bounded row/column window. It clamps windows
  when data shrinks, clears disappeared objects truthfully, and rejects late
  responses after a newer refresh or project switch.

## 0.4.0-dev.20 - 2026-08-08

### Fixed

- Problems now carries the exact failed R expression, traceback, executed code,
  and bounded run output into `Fix with Agent`. File-backed errors select the
  recorded range automatically and can create one reviewable file proposal
  without asking the user to find or select the same code again.
- Repair tasks always run under read-only Ask policy with auto-approval off,
  while resolving the effective function-calling Act route and only that
  Provider credential. Missing capabilities or credentials now open the exact
  Model routing card instead of starting an explanation-only turn.
- A project switch, changed source, missing run/file, failed Agent request, or
  foreign-project Problem creates no repair turn. Older and parse-error records
  without a trusted range offer an explicit select-code recovery path rather
  than guessing a replacement or claiming that rerunning always finds one.

### Improved

- Runtime error ranges are durable and project-isolated in store schema v10.
  The v9 migration uses a recoverable same-directory backup and leaves older
  records unlocated instead of deriving positions from error text.
- Console Problems attach the exact failed-run context for diagnosis while
  clearly avoiding a file-edit promise when no project file range is known.

## 0.4.0-dev.19 - 2026-08-07

### Fixed

- Check code now reports unsaved-file, lintr provider, and syntax-parse failures
  directly in Problems instead of appearing to do nothing; existing Run
  problems remain visible alongside these transient diagnostics.
- Environment operation controls now release immediately when polling observes
  a terminal result, instead of remaining disabled until another UI refresh.
- Environment package inventory now includes existing custom library paths
  carried by `R_LIBS`, `R_LIBS_USER`, or `R_LIBS_SITE`, even when R's startup
  sequence has not merged them into `.libPaths()`.
- Model settings remains reachable when its first settings read fails or no
  models exist. The composer model button stays available, opening settings
  performs one safe read-only retry, an explicit Retry action remains visible,
  and bounded startup diagnostics retain the underlying failure without
  exposing credentials.

### Improved

- Connections is now the first Model settings task. Provider presets use a
  visual card chooser, common connections expose an optional Base URL, and the
  reviewed `aisdk.providers` adapters add DeepSeek, Moonshot/Kimi, Stepfun,
  Volcengine, AiHubMix, xAI, OpenRouter, Bailian, and NVIDIA support.
- Blank Provider endpoints now resolve to Rho's reviewed defaults; undeclared
  ambient API keys and endpoint variables cannot override the selected
  system-credential connection.
- Provider model lists and model cards now show default `aisdk` type and
  capability evidence. Model options use visible capability switches instead
  of nine dropdowns, while manual changes remain explicit user declarations.
- Connections and Model routing now link in both directions. A model card can
  open its compatible route choices, and every assigned or candidate route can
  return to the exact connection and model without silently assigning or
  switching providers.

## 0.4.0-dev.18 - 2026-08-07

### Improved

- Model settings now separates Connections, the Model library, and typed Model
  routing. Chat and Act can use different language models, while image,
  editing, vision, and embedding routes preserve their capability contracts
  until their isolated consumers are installed.
- Provider discovery imports model type and capability evidence only from an
  exact pinned `aisdk` catalog match; Provider responses and manual declarations
  remain distinguishable, and unknown capabilities are never guessed.
- Existing V1 model settings migrate deterministically to the V2 `agent.chat`
  route. The first explicit change preserves a byte-identical V1 backup, route
  writes use revision checks, and Ask/Plan/Act resolve one route and one
  credential without silent Provider fallback.
- Add provider and Add model now fetch the configured provider's available
  models first for OpenAI, DeepSeek, Anthropic, Gemini, compatible, custom,
  and local endpoints. Choosing a discovered model still requires an explicit
  Save before settings change.
- Manual Model ID entry remains available in a secondary disclosure and opens
  automatically when discovery is unsupported, empty, or fails. Model-list
  requests are bounded, do not send prompts, do not follow redirects, and use
  the provider credential only in the required authentication header.

## 0.4.0-dev.17 - 2026-08-07

### Improved

- Model settings now opens on provider cards with a separate current-model
  summary, provider-specific model lists, readiness states, and per-provider
  Advanced controls instead of mixing routine selection with management.
- Add provider is now a guided Connection-then-Model workflow with built-in,
  compatible, custom, and local presets, conditional connection fields, and
  explicit handling for services that legitimately do not require an API key.
- API key, provider, and model operations now have separate surfaces and
  truthful working, success, warning, and failure feedback. Destructive
  provider/model actions are isolated in their own danger zones, while secret
  inputs clear at workflow boundaries and never become stored UI state.
- Model settings dialogs now contain keyboard focus, close the active layer
  with Escape, remove hidden menus from the accessibility tree, and adapt the
  provider rail for narrow windows.

## 0.4.0-dev.16 - 2026-08-07

### Added

- Integrated native Apple Silicon support for macOS 14 and later with the
  pinned arm64 Ark runtime, arm64 R 4.4+ discovery, Apple Keychain-backed model
  credentials, macOS-native open/reveal behavior, and Command-key editor
  gestures while retaining the latest upstream Windows behavior.
- Integrated the immutable cross-platform candidate pipeline for Windows x64
  and macOS arm64 with Developer ID signing, Apple notarization, stapling,
  Gatekeeper checks, checksums, and bounded evidence. Candidate creation remains
  unpublished until a separate installed-candidate GO.

### Improved

- Update manifests and the Rho download page accept a validated Apple
  Silicon DMG alongside the required Windows installer while preserving legacy
  Windows-only feeds and the existing user-initiated update policy.

### Fixed

- Signed macOS builds can start Workspace R when bundled Ark loads an official
  arm64 R installation signed by a different Apple Developer team. The final
  app and Ark signatures are checked for the exact reviewed hardened-runtime
  library-validation entitlement before notarization.
- macOS project fixtures now compare canonical `/private/var` aliases, local
  lockfile source details stay inside the active project, and Bioconductor
  fixture provenance no longer depends on packages installed on the test Mac.
- Check Project now limits source scanning to R, Rmd, Qmd, Rnw, and
  extensionless source files, so generated HTML and other non-R assets do not
  produce source reproducibility findings.

## 0.4.0-dev.15 - 2026-08-07

### Fixed

- Environment operations now display readable Windows project paths, show an
  explicit starting state after approval, and reconcile pre-execution failures
  as failed requests instead of leaving an unexplained approved state.
- Self-contained HTML reports up to 32 MiB now open in the central Viewer and
  Agent Output Review. Other preview types retain their 4 MiB limit, and files
  that exceed their limit now report the size restriction instead of a generic
  preview failure.
- Model settings now use a compact model chooser by default. Provider and model
  management, deletion, catalogs, and low-frequency connection fields are
  progressively disclosed under one Advanced settings section; Agent LLM API
  keys now use the Windows system credential store only.
- Switching projects now clears stale Runs, Plots, and Outputs immediately and
  refreshes the new project's output data without waiting for every session
  document to reopen.
- Agent Timeline, Task Rail, Monitor, and Outputs refreshes now preserve the
  user's active surface, scroll position, and focused item when new results
  arrive.
- Applied file proposals now collapse to a compact completed summary, and
  Undo is shown only after the edited file is verified unchanged.
- Problems now offers a direct `Fix with Agent` entry that opens the source,
  carries structured diagnostic context, and starts the existing reviewable
  file-proposal flow.
- Rename Symbol now opens Review only after a valid proposal is built. Lookup
  or source-state failures return to a retryable name prompt with the entered
  replacement preserved instead of showing an empty Review panel.

## 0.4.0-dev.13 - 2026-08-06

### Fixed

- Project check results now use a bounded scrollable region when the window
  cannot show all findings.
- Environment approval now reconciles terminal request states separately from
  post-approval view refreshes, so stale or completed requests no longer stay
  visibly stuck at `Requested`.

## 0.4.0-dev.12 - 2026-08-06

### Fixed

- Agent Outputs no longer register render paths that were not materialized as
  files inside the active project. Review now distinguishes available files,
  missing historical files, unsupported formats, and in-memory Plot previews.
- Missing source-document provenance is no longer shown as a misleading file
  review warning.

## 0.4.0-dev.11 - 2026-08-06

### Improved

- Agent Markdown previews now render inline and block LaTeX formulas offline
  with KaTeX while Copy continues to preserve the original Markdown source.

## 0.4.0-dev.10 - 2026-08-06

### Improved

- Check Project now checks the current project directory without treating
  deleted historical outputs as current failures. Project check results in
  Agent Review also use a dedicated scrollable content region.

## 0.4.0-dev.9 - 2026-08-06

### Improved

- Agent answers now render as a safe Markdown preview while the Copy action
  preserves and copies the original Markdown source.

## 0.4.0-dev.8 - 2026-08-06

### Fixed

- Agent Output Review now passes the desktop artifact detail command's
  `artifactId` argument correctly, allowing Viewer previews to load instead of
  falling back to misleading metadata-only and missing-file messages.

## 0.4.0-dev.7 - 2026-08-06

### Improved

- Agent Outputs now has a dedicated scrolling list for large result sets. Cards
  use concise file-type and source context labels, and Workspace R outputs no
  longer appear as falsely incomplete source links.

## 0.4.0-dev.6 - 2026-08-06

### Improved

- Generated files in Agent Outputs now open directly into Review with useful
  output, creation, provenance, and availability information. PNG/JPEG/GIF/WebP
  files preview as images, while CSV/TSV tables and R/Rmd/text/JSON files show
  bounded browsable content.

## 0.4.0-dev.5 - 2026-08-06

### Improved

- Selected Agent answers now provide a Copy action that preserves the complete
  Markdown or code output and reports clipboard failures truthfully.

## 0.4.0-dev.4 - 2026-08-06

### Fixed

- Long authorized Agent analyses can use more tool steps and more wall-clock
  time before the Agent R session is considered interrupted. Act receives a
  high exploratory budget, and each new request renews the idle lease. Rho
  still reports a failure when the Agent process ends without a terminal event.

## 0.4.0-dev.2 - 2026-08-06

### Improved

- First launch, or startup without a saved project, now opens the current
  user's directory instead of a machine-specific development path.
- File proposals in the Agent Task surface can now be collapsed like Project
  context, keeping long Before/After previews out of the way while preserving
  the existing review actions and proposal state.
- Authorized Act turns can apply their file proposals automatically through
  the existing project and stale-edit safeguards, without a second Accept.
- Files created or updated by successful R analysis runs are registered beside
  Plots in Outputs with their producing Run and project provenance.

## 0.4.0-dev.1 - 2026-08-06

### Fixed

- Long Agent-run analyses no longer lose their completed result to a transport
  disconnect when Plot/display events exceed the framed response limit. Agent
  requests now receive bounded result projections and synchronize the current
  Workspace revision after both successful and rejected broker responses.
## 0.4.0-dev.0 - 2026-08-01

### Improved

- Startup now caches validated R/Ark runtime discovery, records startup phase
  timings, shows the workbench while Workspace R connects, refreshes Agent
  runtime availability in the background, and loads secondary project data in
  parallel after the first usable view.
- The bottom Plots surface is now Outputs, with a central Viewer for Markdown
  previews, self-contained interactive HTML/htmlwidgets, rendered HTML
  Artifacts, static plots, and bounded CSV/TSV tables. HTML runs in an isolated
  sandbox and blocked external resources are reported explicitly.
- The workbench now uses five focused File, Edit, Run, View, and Help menus.
  Duplicate Agent and Environment navigation is removed; document execution,
  rendering, session control, surface focus, panel reset, truthful disabled
  states, and keyboard menu traversal reuse the existing command system.
- Model settings now keep API keys in Windows Credential Manager and present a
  single required-fields-first setup flow. Existing user `.Renviron`
  credentials remain a read-only fallback, while provider protocol,
  capability, catalog, and destructive controls stay under Advanced.
- Normal workbench surfaces now present outcomes, next actions, scientific
  source/output information, and friendly status labels without exposing
  opaque record IDs, raw backend errors, runtime paths, or implementation
  terminology. Exact support details remain available through diagnostics and
  logs. Model settings now show connection and model-selection fields first,
  with protocol and capability metadata under collapsed Advanced settings.

### Fixed

- Agent background polling now keeps both Agent history and Run history
  refreshes quiet when transient records disappear, preventing repeated stale
  information toasts while a task is running.
- Agent history polling now treats transiently missing turn details as stale
  list state instead of repeatedly flashing the same error toast; background
  refreshes quietly recover while the Agent list remains usable.
- `?topic` Console commands now unwrap the real Workspace Help response, so
  Local Help and installed documentation show the requested topic instead of
  an `undefined` or unavailable placeholder.
- Structured errors from Console and direct R execution now also appear in
  Problems with their source, call, and traceback context instead of remaining
  visible only in the Console transcript.
- Viewer no longer shows a redundant `Open Source` action when the source is
  already the active editor document; artifact sources still open in the
  editor and close the Viewer as expected.
- Render status now converges to `Done` when the exact completed render
  Artifact is available, even if the asynchronous job status briefly lags
  behind the generated HTML output.
- Git Review now uses the installed Tauri camelCase command envelope for diff,
  stage/unstage, restore, conflict resolution, and commit operations. Staged
  review and commit controls no longer fail because the browser mock accepted a
  different argument shape.
- Project reproducibility checks now survive Unicode source text, recognize
  Windows drive paths written with either slash style, report saved
  `setwd()`/unseeded random-number findings, and recover from backend failure or
  timeout. Checks explicitly ask for modified source files to be saved before
  scanning disk-backed project content.
- Format Document now unwraps and validates the typed Workspace R formatter
  result at the desktop command boundary, instead of rejecting the broker's
  execution envelope as an invalid formatter response.
- Console commands such as `?mean` now open the matching installed
  documentation in the right-side Help panel while remaining recorded as
  ordinary Workspace Runs. Rho no longer starts R's separate HTTP Help viewer
  for these results.
- The former `Audit` action is now the clearer `Check project` workflow.
  Human-first and Agent-first share friendly result statuses, categories,
  finding titles, next steps, and evidence links without exposing rule IDs,
  backend field names, or opaque record identifiers. Human-first now reliably
  opens the result in Analyze instead of completing a hidden check.
- The editor now uses one common command system for Save, Close, Undo, Redo,
  Find, Replace, line comments, New File, and Open Project across keyboard
  shortcuts and menus. Monaco keeps its native editing widgets and history;
  the basic editor has bounded per-file history and search/replace dialogs;
  Console, Agent, forms, and dialogs retain ownership of their input shortcuts.
- Problems now provides a `Clear lint results` action that removes only
  transient `lintr` diagnostics and stale Quick Fix state; failed-Run Problems
  and their audit history remain intact.
- The active-file `lintr` action is now the `Check code` icon in the editor
  toolbar, where file-level actions belong; the unrelated execution-dock action
  has been removed and running no longer shifts toolbar geometry.
- Checking the active R file now sends the required document-version argument
  through the real Tauri command shape, so installed builds reach `lintr`
  instead of reporting a missing `documentVersion` key.
- Ordinary workbench surfaces no longer expose the WebView page context menu
  with irrelevant Refresh and Save as actions; Monaco and editable form
  controls retain their useful context operations.
- A single Agent or Console execution no longer records the same Plot twice
  when Workspace R emits duplicate display events; distinct Plots from the
  same execution remain separate and ordered.
- Agent-first now follows a complete Task, Runs, Outputs, and Review loop:
  Plots and saved results are discoverable without switching to Human-first,
  and selecting one opens a large review surface with human-readable source,
  timing, availability, and producing-run actions. Act now instructs
  tool-capable Agents to execute explicitly requested R work in the current
  turn instead of merely offering code or asking whether to run it.
- User-facing project, Run, Problem, Plot, saved-output, audit, and review paths
  now remove Windows extended-path prefixes for display, while background Runs
  use task labels instead of exposing internal Workspace R bridge expressions.
- Plots now make the selected image the dominant review surface, place a
  numbered navigator beside it, and keep Saved outputs collapsed until opened.
  Plot and output rows now use plain-language source, timing, availability, and
  review states; internal run, workspace, revision, payload, quota, and media
  details remain available to the application but are no longer default UI.
- Agent-first Runs now prioritizes scientific work over background workspace
  bookkeeping, and Run Review presents the request, R code, outcome, linked
  Plots/Saved outputs/Problems, limitations, and source details in a human-reviewable
  report.
- Selecting Console now places the caret in its enabled input automatically, so
  typing can begin immediately after a user or programmatic tab switch.
- Project folders are now visually distinct from files through familiar folder
  icons, stable disclosure chevrons, stronger labels, and hierarchy guides.
- The editor now handles `Ctrl+S` on Windows and Linux and `Cmd+S` on macOS in
  Monaco, the basic editor, and the active document context without stealing
  the shortcut from dialogs or unrelated inputs.
- Problems now treats `<console>` as an execution surface rather than a missing
  file, opens and focuses Console directly, and marks deleted sources as
  unavailable without a misleading navigation attempt.
- Running R code that creates a plot now opens Plots and selects the plot from
  that exact execution instead of updating a hidden preview.
- Plot previews and PNG export now accept Ark's unpadded base64 image payloads;
  new Plot history is stored with canonical padding and invalid images fail
  visibly instead of leaving a blank panel.
- Plot Session/History queries now use the same normalized Windows project key
  as persisted Plot records, so existing previews are listed instead of showing
  an empty panel while Retention reports stored rows.
- Console input now supports Up/Down command-history browsing with draft
  restoration.
- Selecting Act now immediately enables its session R-execution authorization
  checkbox when the Agent is idle and the selected model supports tools.
- Windows project roots passed to Workspace R now omit the internal `\\?\`
  filesystem prefix, so `getwd()` shows a normal drive or UNC path.
- Supervised Git refresh and review commands now run without opening transient
  console windows when project files change or R code produces outputs.

### Added

#### Render lifecycle

- Background document renders now have exact job-specific cancellation,
  distinct cancelled/failed/completed feedback, project isolation, and
  truthful Workspace R restart reconciliation. A missing ephemeral job is no
  longer reported as successful completion.
- Completed background renders now populate Last Render with the exact output,
  producing run, and source state, plus a Review saved output action bound to
  the durable `render_output` record actually created by the coordinator.

#### WB1: Read-only public Workbench Protocol

- Defined a versioned, paginated, project-scoped public protocol with typed
  entities (RunSummary, RunDetail, ProblemSummary, ObjectSummary, OutputSummary,
  EnvironmentEvidence, ApprovalSummary, ProvenanceLink) and bounded error
  envelopes.
- Server-owned cursors, field-level redaction, and size/page limits prevent
  accidental data exposure.

#### WB2: CLI binary, MCP server, and event replay

- Added `rho-cli` binary with `format` and `serve` subcommands.
- Added `rho-mcp` MCP server exposing the Workbench Protocol.
- Added cursor-based public event projection with replay.

#### UX4: Agent-first posture

- Added an Agent-first posture centered on task interaction, with contextual
  file, run, saved output, and audit work surfaces opened only when requested.
- Task rail with mode badges (Ask/Plan/Act), status dots, and preview text.
- Direct surface with Agent flow, Monitor (run list), and Review (findings)
  panels.
- Simplified the Agent composer to one primary `Ask Rho` entry with
  progressively disclosed Ask/Plan/Act controls and Act-only authorization.
- Improved the Agent-first Direct surface with a compact task rail, collapsed
  project guidance, a wider scientific work surface, and narrow-window
  fallbacks that avoid horizontal overflow.
- Replaced the changing posture button with an explicit Human/Agent selector
  and renamed Agent-first navigation to the task-oriented Task, Runs, and
  Review surfaces.
- Reduced Agent-first noise by showing each completed answer once, collapsing
  raw tool activity on demand, compacting the composer, and simplifying the
  Agent-posture topbar.
- Removed the permanently visible editor and execution dock from the default
  Agent-first Task surface while preserving active files, drafts, audit context,
  and the existing Human-first editor layout.

#### RA-RC2: Reproducibility audit

- Added `audit_reproducibility` store engine scanning runs, snapshots, problems,
  and artifacts with configurable scope (project/run/artifact) and limits.
- Added `audit_reproducibility` Tauri command and reproducibility audit UI panel.

#### Evidence workspace and claim review

- Evidence now includes project-scoped Claims linked to exact source ranges or
  durable Artifacts and up to 20 existing Evidence entries. Structural review
  distinguishes linked, missing Evidence, incomplete Evidence, unresolved
  anchors, and rejected cross-project access without claiming scientific truth.
- Claim review exposes the recorded excerpt, exact linked Evidence, and direct
  Source, Artifact, and Evidence navigation. Claim and Evidence deletion use
  explicit product dialogs, while stale sources and deleted links recover to a
  truthful review status.

#### WS2: Editor intelligence (Air backend)

- Added Air-backed R function index, dynamic Monaco completions, and hover help.
- Selected Air as the primary language backend after evaluation checkpoint.
- Go to Definition now opens a bounded Local Help panel after a project-source
  miss, showing the owning installed package, local Help record, library root,
  and only package-contained source references when available.
- Find Project References now shows bounded, token-aware project matches in a
  navigable References panel, with explicit partial and truncated result states.
- Local Help now shows bounded installed documentation, package version,
  arguments, examples, and vignette topics for one qualified package function.
  A complete visible example can be confirmed and run through the ordinary
  recorded Workspace execution path; hidden, malformed, or truncated example
  content cannot run.
- Problems now groups stable, bounded lintr diagnostics with source ranges,
  severity, rule, provider version, and truthful empty/error/partial states.
  Supported mechanical fixes open an exact before/after review and apply only
  to the unsaved editor buffer after project, file, version, and line checks;
  Save remains a separate action.
- A resolved installed Local Help record can now be attached explicitly to the
  next Agent question. The selected answer shows that package/topic/version
  context separately from model prose and can reopen the exact Help record;
  model-only answers do not receive a documentation evidence block.
- Rename Symbol and Extract Function now create bounded before/after reviews
  tied to the active project and exact editor versions. Accepted refactors
  change only editor buffers, keep Save explicit, and reject incomplete
  reference scans or stale files without partially changing other targets.
- Format Document now creates an exact Workspace R/styler before/after review
  for one open R buffer. Apply, Save, and Undo remain explicit editor actions;
  missing providers, parse errors, unchanged text, and stale proposals are
  surfaced without silently substituting another formatter.

#### WS1: Packages and environments

- Added reviewed one-package Install, Update, and Remove actions that target
  only the active project's confirmed renv library, preserve lockfile changes
  as a separate Snapshot action, and expose partial-write recovery warnings.
- Added Installed and Lockfile package tabs with one searchable, bounded
  installed-versus-locked comparison, explicit drift labels, and truthful
  missing, malformed, unavailable, and incomplete lockfile states.
- Lockfile rows now distinguish dependencies declared by DESCRIPTION from
  bounded transitive requirements and unclassified packages, and show
  credential-safe repository, remote, URL, or project-local source details.

#### WS9: lintr diagnostics

- Added lintr bridge producing normalized diagnostics from R source files.
- Integrated lintr findings into the existing Problems panel.

#### WS3: Data viewer interaction

- Added sortable columns and keyboard navigation to the data viewer.
- Data Viewer search, stable sorting, matched paging, and visible-page export
  are now computed by Workspace R over the complete bounded view rather than
  filtering only the rows already loaded in the browser.
- Column type labels, bounded visible-page missing counts, numeric alignment, and
  distinct `NA`, `NaN`, `Inf`, `-Inf`, and empty-string rendering make
  scientific table values easier to interpret without changing the source.

#### WS4: Git integration

- Added Git status, log, diff, staging, and commit via the system git CLI.
- File counts (untracked/modified/staged), ahead/behind tracking, and
  porcelain status parsing with full M/A/D/R/C/U/T coverage.
- Added a Git review tab for working and staged files, guarded file/hunk
  stage and unstage, explicit restore confirmation, and reviewed commits.
- Git mutations now reject stale revisions, reconstruct hunk patches from the
  broker-read diff, refresh after failure, and commit without project hooks.
- Hardened Git review against outer/nested repository confusion, symlink and
  case-alias paths, non-UTF-8 metadata, and oversized command/diff output while
  retaining guarded whole-file staging for large changes.
- Repository-bound SHA-256 review tokens now reject stale file, hunk, and commit
  actions if the Git authority at the same project path is removed, replaced, or
  switched to another worktree; an explicit refresh safely resumes review.

#### WS6: Async Quarto render job

- Added `render_document_job` Tauri command with async job submission.
- Render jobs return a job ID immediately; the render runs in a background task.

#### WS6A: targets pipeline inspection

- Added read-only `targets` pipeline inspection via the workspace bridge.
- `_targets` ownership is preserved; pipeline execution is not yet authorized.

### Changed

- Modernized the shared workbench shell with semantic visual tokens, consistent
  local toolbar icons, clearer Human/Agent and tab hierarchy, stable Run
  geometry, visible keyboard focus, and overflow-safe narrow layouts.
- Strengthened the Human-first editor with consistent action icons, explicit
  active-tab semantics, clearer resize handles, truthful panel ranges, and
  reliable Code/Analyze/Agent layout restoration across posture changes.
- Reworked the execution dock so Console is a continuous Workspace R transcript
  and prompt, while startup, Agent R, render, interrupt, and restart status is
  presented in a separate Logs tab.
- Version advances to `0.4.0-dev.0` to reflect Waves 4-14 implementation scope.

## 0.3.0-dev.0 - 2026-07-31

### Added

- Added Help menu access to About and Check for Updates. About exposes the
  installed version, build commit and bounded runtime diagnostics, while update
  checks use channel-specific manifests under `yulab-smu.top/Rho/` and leave
  installer download and execution under explicit user control.
- Added deterministic generation and GitHub Pages deployment of the Rho
  release page and stable/development update manifests, based on validated
  GitHub Release evidence rather than free-form release text.

### BH1: Project-scoped durable identity

- Every durable record (runs, Agent turns, approvals, plot history,
  artifact records, environment operations) now carries a canonical
  `project_root` field.
- Legacy unscoped records are detected and rejected during schema
  migration; queries default to the active project.
- Retry, approval-continuation, and workspace-state resolution are
  isolated by project.
- Cross-project leakage tests prevent reusing history, approvals, or
  run identity across different project roots.

### BH2: Project-switch state machine

- Project switching is now broker-owned with typed blocking preflight.
- Active Agent turns, pending approvals, and running environment
  operations block the switch with an explicit reason.
- Switching commits only after the full Workspace R → watcher → store
  → UI chain succeeds; failure restores the previous project identity.
- Fatal restoration failures surface a `restart_required` outcome
  instead of silently entering a mixed-project state.

### BH3: Transactional schema migration

- SQLite schema migrates from `v7` to `v8` inside a single
  transaction.
- A same-directory backup is created before migration and preserved
  when migration fails.
- Legacy unscoped records are detected, counted, and rejected during
  migration with a bounded reason code.
- Migration outcomes are diagnosed through structured status, version,
  backup path, and record counts.

### BH4: Retention, privacy, and artifact lifecycle

- Destructive actions now use truthful labels: Delete plot history,
  Delete output records, Delete Agent history, and Free preview
  storage.
- Free preview storage replaces plot payloads with tombstones instead
  of deleting rows; provenance, run identity, and metadata survive.
- A per-project retention summary shows plot rows, payload bytes,
  artifact rows, and artifact metadata broken down by session and
  project scope.
- Retention policy now carries concrete numeric limits (200 plot rows,
  50 MB payload, 500 artifact rows, 100 MB metadata, oldest-first
  prune order) rather than boolean flags.
- All delete and prune actions are confined to the selected project;
  cross-project guard tests prevent accidental data loss.

### BH5: Incremental module boundaries

- `rho-store` is now split into focused domain modules: `migration.rs`,
  `run.rs`, `agent.rs`, `artifact.rs`, `environment.rs`, `project.rs`,
  and `compare.rs`. The public crate surface is unchanged; all existing
  types and constructors remain available through the same `use`
  declarations.
- Each extraction has independent regression coverage and no
  behavioral change to any test, command, or frontend state.

### RA-RC1: Deterministic run comparison

- Added `compare_runs(left_run_id, right_run_id)` store and Tauri
  command. Two runs from the same project can be compared across five
  sections: identity & execution, source & request, environment,
  outcome & problems, and artifacts.
- Every field reports `same`, `different`, `unknown`, or
  `not_applicable`. Missing evidence is never treated as equal.
- The Runs sidebar now has a Compare toggle with left/right run
  selectors, a summary strip, and five expandable comparison sections.

### UX: Interaction improvements

- Runs, Agent activity, Problems, Environment, Render, and Plot surfaces now
  share clearer text-backed operational states and bounded technical metadata.
- Agent approvals, file-edit proposals, and direct Environment requests now
  use distinct review surfaces, while invalid Plot previews remain visible as
  failed previews without losing their history records.
- Empty-project states now read `Open an R project to begin` and
  `Open a project to get started` instead of internal terminology.
- Product dialogs replaced browser `prompt()` and `confirm()` for
  new-file creation, export paths, destructive deletions, draft
  restoration, and external-change detection. Each dialog names the
  operation, scope, and consequence.
- The Run button label now reflects the editor scope: `Run selected
  code`, `Run current line`, or `Run file`.
- Problems show plain-language titles such as `Analysis stopped at
  path` with `Go to source`, `Explain this problem`, and `Run again`
  actions instead of `Retry` and `Open Source`.
- The complete interaction surface (250+ strings across 15 panels) was
  inventoried and a terminology contract was defined mapping internal
  terms to user-facing labels.

### Changed

- Version scheme advances to `0.3.0`; every commit increments the
  dev suffix, and every completed Wave 2 hardening package
  increments the minor version after acceptance.

## 0.2.0-dev.12 - 2026-07-22

### Added

- Added a `0.2.0` release-hardening specification, version/tag/resource
  validation and a one-command Rust, R and frontend verification runner that
  writes machine-readable release evidence.
- Added Windows publish gates that verify a clean source checkout, build the
  installer, run bounded Workspace and optional Agent smoke tests, and attach
  the installer checksum and evidence JSON to the GitHub release.
- Added project regression coverage for paths containing spaces and non-ASCII
  text, session and atomic-write behavior under those paths, and deterministic
  truncation at the 2,000-file discovery limit.

### Fixed

- Agent `run_r` timeline results now show concise Output, Result, Messages,
  Warnings or Error sections instead of escaped broker JSON, execution IDs,
  protocol events and internal bridge code. Existing stored results are decoded
  by the desktop when displayed.
- Agent file-edit proposals now discard aisdk's internal execution environment
  before JSON serialization. The desktop can also recover a valid proposal
  from stored tool arguments, so the review diff and Accept action are shown
  instead of a false completion with no file change.
- Windows publish CI now installs and verifies the `rustfmt` component for its
  minimal GNU Rust toolchain before running the mandatory formatting gate.
- Windows release checks now materialize the bootstrapped Ark executable and
  notices before validating release metadata, fixing clean-checkout CI builds
  where ignored Tauri runtime resources do not exist yet.
- Agent R now receives an explicit stdin EOF after its broker token, model
  profile and prompt are written. This prevents Windows Agent turns from
  stalling before local broker authentication.
- Agent authentication failures now terminate the child process and retain
  bounded, credential-redacted startup stdout and stderr, making pre-provider
  failures diagnosable.
- Windows installer builds now skip copying Ark and its notices when the
  bundled resources already have the expected SHA-256, avoiding a false build
  failure when an identical runtime executable is in use.
- Closing Rho now shuts down the Ark-backed Workspace R session and terminates
  its process tree if graceful shutdown cannot complete, preventing orphaned
  `ark.exe` processes on Windows.
- Rho now keeps a recovery window open when R discovery or runtime preparation
  fails, with Retry, Rscript selection and diagnostic actions instead of a
  silent startup exit.
- Base R startup checks no longer load `aisdk` in the required probe. A broken
  or missing Agent dependency now disables only the Agent panel and can be
  retried without blocking the editor or Workspace R.
- Rho now resolves and explicitly loads the user's `~/.Rprofile` and
  `~/.Renviron` in Workspace R, preserving custom library paths and user-level
  configuration without allowing project startup files to take precedence.
- Missing user `~/.Rprofile` and `~/.Renviron` files are now treated as absent
  optional configuration. Rho no longer exports placeholder paths for them,
  while still preventing project startup files from being loaded implicitly.
- R runtime and Agent configuration probes now execute UTF-8 temporary `.R`
  scripts instead of passing multiline code through `Rscript -e`, avoiding a
  Windows argument-handling failure observed with R 4.4.2.
- Windows startup diagnostics now retain subprocess exit codes, bounded stdout
  and stderr, elapsed time and append-only error history.
- Kept the Agent model selector menu within the visible Agent panel when the
  panel is narrow, instead of allowing the menu to be clipped on its left edge.

## 0.2.0-dev.11 - 2026-07-21

### Fixed

- Fixed a frontend initialization ordering error that left the application at
  `Starting R` and `Loading project files` before Workspace startup could run.

## 0.2.0-dev.10 - 2026-07-20

### Improved

- Agent prompts now support project file references through both `@` mentions
  and the composer `+` menu, including current file, current selection,
  project file, and new-file context badges.
- Proposed Agent file edits now render as a review panel instead of raw JSON in
  the timeline, with explicit Accept, Reject, and one-step Undo actions.
- Accepted Agent edits now reopen the target file, highlight the inserted
  range, and clear stale highlights when you edit, switch files, or dismiss the
  review state.
- File edit proposals now carry explicit editor context source metadata, so
  stale selection and cursor anchors remain reviewable before any write occurs.
- The Agent composer now uses a configurable model selector instead of a
  hardcoded DeepSeek label, and `Manage LLMs...` adds provider/model editing,
  user `.Renviron` opening, credential refresh and bounded connection tests.

## 0.2.0-dev.9 - 2026-07-20

### Improved

- The Agent composer now resizes from a separator along its upper edge, with
  mouse, keyboard and double-click reset support consistent with other panels.
- `get_workspace_snapshot` tool events now show a compact workspace summary
  instead of escaped raw JSON, including R, project, objects, packages and
  rendering capabilities.

## 0.2.0-dev.8 - 2026-07-18

### Fixed

- Plot history is now isolated by project and defaults to the current
  Workspace R session when the Plots panel opens.
- The Plots panel now provides Session/History views and explicit actions to
  clear session plots or all plots in the current project.
- Startup package messages and warnings are rendered correctly when R returns
  a single string instead of a JSON array.
- Running selected R source no longer fails on a leading UTF-8 BOM or editor
  zero-width marker; the marker is removed without changing ordinary Unicode
  inside the code.
- Act mode now offers a session-level authorization switch for `run_r`, so
  approved sessions do not prompt for every individual execution.
- The Act authorization checkbox now reaches Tauri using the correct command
  argument name, and approved `run_r` calls compare their exact R code instead
  of rejecting harmless argument normalization performed by aisdk.
- Agent `run_r` executions use the same Ark Workspace R as manual Console
  commands and now mirror their code, output, warnings and errors into Console.
- Agent history can be cleared explicitly when no Agent turn is active.
- Agent R failures now return a structured failure event and preserve the
  underlying error instead of surfacing only an incomplete-loop message.
- The Code, Analyze and Agent workbench buttons now switch to distinct layouts;
  Code hides the context panel so it no longer opens on the Agent view.
- Agent responses are shown in full in the selected turn, and Monaco is
  relaid out after execution-panel resizing so the editor restores correctly.
- R selections normalize Windows CRLF line endings before parsing, fixing the
  `unexpected invalid token` error caused by a selected leading newline.

## 0.2.0-dev.7 - 2026-07-18

### Fixed

- Agent turns now receive a bounded history of recent user requests, outcomes
  and failure reasons instead of starting with only the latest message.
- Short follow-ups such as `再试一下`, `重试`, `继续`, `retry` and `try again`
  explicitly continue the most recent unresolved goal, preserving dataset,
  variable, output and formatting details rather than inventing an unrelated
  diagnostic action.
- Retried mutations still create a fresh approval request; conversation context
  never reuses a previous approval token.

## 0.2.0-dev.6 - 2026-07-18

### Fixed

- The Files panel now renders an expandable directory hierarchy instead of
  flattening project files into one list.
- Project discovery now includes common R package and scientific text files,
  including `DESCRIPTION`, `NAMESPACE`, `.Rbuildignore`, `.Rd`, Markdown,
  YAML, JSON and compiled-language sources, while excluding binary files and
  generated dependency directories.
- Useful project structure is scanned up to eight directory levels while the
  existing file-count and directory-entry bounds remain enforced.
- Left and right panel limits now preserve the editor's minimum width, restore
  safely after window resizing, and cap the right context panel at 520 pixels.
- Plot, editor and Agent containers now shrink within their grid tracks instead
  of overflowing across the right resize boundary or placing scrollbars inside
  the adjacent panel.

## 0.2.0-dev.5 - 2026-07-17

### Fixed

- Windows runtime probes, Ark Workspace R and Agent R now start with
  `CREATE_NO_WINDOW`, preventing intermittent terminal windows from flashing
  during startup, Workspace restarts and Agent turns.

## 0.2.0-dev.4 - 2026-07-17

### Fixed

- Windows project roots no longer expose the internal `//?/` extended-path
  prefix in the Files panel or project session metadata.
- Agent and run-history commands now pass Tauri's required camel-case command
  arguments, fixing Act history loading, Agent cancellation, run cancellation
  and failed-run retry actions.
- The Files panel now expands `OUTPUTS > plots` into the durable plot history;
  each entry opens its corresponding plot and shows its source when available.

## 0.2.0-dev.3 - 2026-07-17

### Fixed

- Rendering now requires the active `.Rmd` or `.qmd` document to be saved, so
  output and provenance cannot silently refer to different source content.
- Project file notifications advance `project_revision`, while duplicate or
  self-generated save events no longer trigger false external-change prompts.
- Project discovery skips symbolic links and out-of-root directory targets.
- Source editor reads and writes reject files larger than 8 MiB with a clear
  error instead of loading an unbounded CSV, TSV or text file into the UI.
- Source files and project-session JSON now use same-directory atomic writes,
  preventing a failed save or shutdown from truncating the previous content.
- File-watcher events are coalesced, and externally deleted files now close
  clean tabs while preserving dirty drafts that can be recreated with Save.
- A timed-out Workspace restart restores the previous session handles instead
  of leaving the desktop in a disconnected half-restarted state.
- Only one Agent turn can run at a time, preventing accidental concurrent model
  calls and competing Agent R processes.
- Running Agent turns can now be cancelled from the Agent panel without
  restarting Workspace R; pending approvals are marked interrupted as well.
- Rho probes Agent R at startup and reports the installed aisdk version or a
  dependency-loading error before the user sends a prompt.
- Runtime discovery now carries the user's effective `.libPaths()` into the
  profile-free Workspace R, so installed bioinformatics packages remain
  available without executing project or user startup code inside Ark.
- Startup now rejects R versions older than 4.4 with the documented minimum
  version in the error message instead of failing later during Ark launch.

### Changed

- Project discovery reports depth/file-count truncation and stops after 2,000
  supported files or 10,000 scanned directory entries instead of allowing a
  large results tree to block the UI.
- File, Edit, Session and Tools menus now invoke real workbench commands, and
  the Plots shortcut opens the plot dock; unimplemented Settings chrome was
  removed.
- Monaco now provides bounded local completion for R keywords, common
  functions and live Workspace objects, plus document symbols for simple R
  assignments and functions.
- The development roadmap now reflects the implemented `0.2.x` surface and
  identifies clean-install acceptance as the remaining M1 release gate.

## 0.2.0-dev.2 - 2026-07-16

### Added

- Native project selection with per-project restoration of open and closed
  document drafts, cursor positions and panel sizes.
- Monaco-based R editing with selection, current-line and complete-file
  execution in the authoritative Workspace R.
- Durable Runs, Problems, retry links, cancellation state and restart recovery.
- Broker-owned Agent turn history and explicit Act approval controls showing
  the exact tool, code, request id and workspace revision.
- Project environment diagnostics for R, library paths, `renv`, Bioconductor
  and attached packages.
- Bounded object previews, durable plot history with provenance, and optional
  Quarto/R Markdown render diagnostics.

### Fixed

- Agent mutations now require a single-use broker approval bound to the exact
  request arguments; Ask and Plan cannot bypass the mutation policy.
- Cancel and Interrupt no longer wait behind the active Workspace execution
  lock, and restart cancels Agent tasks and stale approvals before relaunch.
- Project file and render paths are rejected before any out-of-root filesystem
  side effect or document execution can occur.
- Closed dirty drafts have synchronous browser fallback persistence so recent
  edits survive normal application close and restart.
- Project file writes and project switches now advance `project_revision`.
- Object previews cap long strings and nested cells instead of bounding only
  row and column counts, including long list element names.
- Render and plot provenance now use the editor's actual document version and
  no longer mark Console-only plots as complete source provenance.

## 0.2.0-dev.1 - 2026-07-16

### Added

- First `0.2.x` development build for real project files.
- Broker-safe project root and source-file listing.
- File-tree and multiple document-tab state in the workbench.
- Read, save and create-file commands for supported source files.
- Workspace R working-directory synchronization when a project is opened.

### Not Yet Complete

- Native directory picker, durable document restoration, language-aware
  completion, approval dialogs, cancellation and crash recovery remain in the
  rest of the `0.2.x` milestone.

## 0.1.1 - 2026-07-16

### Added

- Draggable horizontal divider between the source editor and the Console,
  Plots and Problems dock.
- Draggable vertical dividers for the Files and Agent/Environment panels.
- Persistent panel sizes, keyboard arrow adjustment and double-click reset.
- Expand/restore control for the execution dock, useful for inspecting plots.
- Mouse and Pointer Event support for panel resizing.
- Windows NSIS installer rebuilt with the resizable workbench.

### Changed

- Prototype version advanced from `0.1.0` to `0.1.1`.
- Windows prototype documentation now describes panel layout behavior and
  the current development boundary.

## 0.1.0 - 2026-07-16

### Added

- First installable Windows Tauri prototype.
- Ark-backed persistent Workspace R session with no Python or Jupyter Server.
- Rust broker using direct Jupyter/ZeroMQ transport.
- R source editor, live Console, Environment object manifest, Plots and
  structured Problems surface.
- Ask, Plan and Act Agent modes backed by `YuLab-SMU/aisdk`.
- DeepSeek end-to-end Agent turn against the same Workspace R session.
- Broker-owned SQLite event store, workspace revisions and stale-context
  rejection.
- Windows installer carrying Ark, `WebView2Loader.dll` and runtime notices.

### Verification

- Rust workspace tests, `rho.agent` tests and `rho.bridge` tests pass.
- Installed release verified to launch Ark from the installation directory.
- Desktop smoke test verified R execution, plot output and Environment state.
