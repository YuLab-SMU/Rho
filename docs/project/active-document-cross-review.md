# Rho Active And Proposed Document Cross-Review

Status: active documentation coordination record

Review date: 2026-08-09
Scope: unfinished or acceptance-active specifications, plans, and release gates

Manual acceptance ownership: the runnable example workflow and candidate-level
evidence template are `test/acceptance-project/MANUAL-ACCEPTANCE.md` and
`test/acceptance-project/acceptance-results/CANDIDATE-RESULT-TEMPLATE.md`.
These records are queued and currently NOT RUN; they do not replace exact
release-candidate or package-specific acceptance gates.

## Purpose

This record prevents unfinished documents from being implemented as competing
sources of truth. It records lifecycle status, authority, dependencies, and the
conditions that permit future work. It does not replace the underlying design
or acceptance documents.

## Authority Order

When documents overlap, use this order:

1. accepted ADRs define durable architecture decisions;
2. the active development roadmap defines milestone order and product gates;
3. an active milestone or release contract defines implementation scope,
   schemas, sequencing, and acceptance for that milestone or candidate;
4. an active feature specification governs only its named feature and cannot
   redefine a milestone or release GO decision;
5. proposed direction, posture, and visual plans require explicit authorization
   and cannot amend an active contract implicitly.

At the same level, stop and amend the relevant documents before implementation
when two contracts define different state, persistence, approval, or acceptance
semantics.

## Status And Ownership Matrix

| Document | Status after review | Owns | May proceed when |
| --- | --- | --- | --- |
| `project/active-development-governance.md` | active | required proposal-to-release development lifecycle, risk/test depth, review, versioning, and evidence rules | applies continuously to all non-trivial work |
| `project/active-development-roadmap.md` | active | milestone order and acceptance gates | continuously maintained from accepted evidence |
| `plans/active-2026-08-05-macos-arm64-support-spec.md` | active broader platform plan; MAC1-MAC5 complete for published Apple Silicon candidate `0.4.0-dev.24`; protected Release and live development manifest pass without asset replacement | Apple Silicon macOS 14+ platform adapters, Ark/R integration, Keychain extension, additive macOS update artifact, signed DMG handoff, repository-bound rehearsal lane, async notarization orchestration, and MAC5 publication admission | preserve immutable release evidence; macOS x64 and Linux x64 remain open milestone scope |
| `release/historical-0.4.0-dev.16-candidate-checklist.md` | historical; review-only rehearsals passed and the decision remained NO-GO before the baseline advanced | immutable `0.4.0-dev.16` rehearsal evidence and NO-GO snapshot only | cannot authorize or satisfy any later candidate, MAC5, or publication row |
| `release/historical-0.4.0-dev.17-candidate-checklist.md` | historical; CRED-UX2 local matrix, browser review, and unsigned app/DMG smoke passed before CRED-UX3 advanced the baseline | immutable `0.4.0-dev.17` local evidence and NO-GO snapshot only | cannot authorize or satisfy any later candidate, installed acceptance, MAC5, or publication row |
| `release/historical-0.4.0-dev.18-candidate-checklist.md` | historical rejected identity; CRED-UX3/CRED-UX4A local evidence passed, but owner installation exposed the settings-entry recovery deadlock | immutable `0.4.0-dev.18` source/artifact/hash, installed rejection, and NO-GO record only | cannot authorize or satisfy any `0.4.0-dev.19` candidate, acceptance, MAC5, or publication row |
| `release/historical-0.4.0-dev.19-candidate-checklist.md` | historical superseded identity; CRED-UX4A-R1 local matrix, browser review, security review, and unsigned artifact verification passed before Issue #6 advanced the baseline | immutable `0.4.0-dev.19` source/artifact/hash and NO-GO record only | cannot authorize or satisfy any later candidate, acceptance, MAC5, or publication row |
| `release/historical-0.4.0-dev.20-candidate-checklist.md` | historical rejected identity; local matrix/browser/unsigned artifact passed, but owner installation exposed the registered runtime-model mismatch and stale selected Data Viewer | immutable `0.4.0-dev.20` source/artifact/hash, installed rejection, and NO-GO record only | cannot authorize or satisfy any `0.4.0-dev.21` candidate, acceptance, MAC5, or publication row |
| `release/historical-0.4.0-dev.21-candidate-checklist.md` | historical rejected identity; R3/runtime/viewer automation and local unsigned artifact passed, but owner workflow review rejected the Problems-only repair entry | immutable `0.4.0-dev.21` source/artifact/hash, workflow rejection, and NO-GO record only | cannot authorize or satisfy any `0.4.0-dev.22` candidate, acceptance, MAC5, or publication row |
| `release/historical-0.4.0-dev.22-candidate-checklist.md` | historical rejected identity; R4 automation/browser/local unsigned artifact passed, but owner workflow acceptance exposed file parse errors still requiring manual selection | immutable `0.4.0-dev.22` source/artifact/hash, workflow rejection, and NO-GO record only | cannot authorize or satisfy any `0.4.0-dev.23` candidate, acceptance, MAC5, or publication row |
| `release/historical-0.4.0-dev.23-candidate-checklist.md` | historical superseded identity; PROBLEMS-AGENT-REPAIR-5 parser-token/schema-v11 implementation and affected automation/browser validation passed; no artifact or installed acceptance was run before Issue #9 advanced the source | immutable `0.4.0-dev.23` R5 source-validation and NO-GO ledger only | cannot authorize or satisfy `dev.24` artifact, acceptance, MAC5, upload, or publication rows |
| `release/historical-0.4.0-dev.24-candidate-checklist.md` | historical published candidate record; exact candidate, signed/notarized DMG, installed acceptance, MAC5 GO, protected Release run `31297462728`, and live update run `31297482853` pass | sole `0.4.0-dev.24` immutable asset/evidence binding, installed-acceptance ledger, publication evidence, and GO/RELEASED decision | preserve release/tag/update evidence; it cannot satisfy any successor source, artifact, acceptance, or publication gate |
| `release/historical-0.4.0-dev.25-candidate-checklist.md` | historical rejected candidate record; run `31336769848` passed macOS signing/notarization/stapling but failed the Windows CRLF-only source-contract assertion before installer construction, so draft assembly skipped | sole immutable `0.4.0-dev.25` run/artifact/notarization disposition and REJECTED/NO-GO decision | no tag, Release, publication, or update mutation exists; its run-scoped artifact, receipt, and evidence cannot be reused or composed |
| `release/active-0.4.0-dev.26-candidate-checklist.md` | active replacement-candidate record; Issue #5 behavior source/review/initial integration and bounded Windows contract portability repair/source verification pass; exact replacement integration/artifact, installed acceptance, MAC5, and publication remain open | sole `0.4.0-dev.26` identity, future exact-candidate evidence, installed-acceptance ledger, and GO/NO-GO decision | logical contract input is normalized without weakening content; a fresh exact-commit two-platform run is required, and hosted, installed, and publication facts remain separate |
| `plans/accepted-2026-07-25-0.3x-scientific-workflow-handoff.md` | active implementation contract; WP1-WP4 code landed, automated review accepted with follow-up, milestone manual acceptance open | `0.3.x` environment, viewer, artifact, skill contracts and final acceptance | remaining representative-project and manual UI acceptance; affected evidence reruns after BH1 |
| `release/active-0.2.0-release-hardening-spec.md` | engineering complete; release acceptance active | exact `0.2.0-dev.12` hardening and evidence contract | remaining candidate acceptance only |
| `release/active-0.2-release-checklist.md` | active | sole `0.2.0-dev.12` GO/NO-GO checklist | P0 human evidence against the exact candidate |
| `design/accepted-2026-07-25-about-and-update-check-design.md` | implementation active; MAC4 optional macOS artifact and multi-platform generator implemented/verified; live and installed acceptance open | About/update V1 schema, channel, endpoint, allowlist, redirect, and Pages gates | hosted candidate/publication may populate exact release and Pages facts; live/installed acceptance remains separate |
| `plans/active-2026-07-26-bh1-project-scoped-durable-identity-handoff.md` | accepted; Wave 1 exit gate passed | canonical project identity, project-scoped durable queries/context, retry and approval-continuation admission, and legacy-unscoped fail-closed behavior | BH4 is accepted; BH5 is active |
| `plans/active-2026-07-27-bh3-transactional-schema-v8-migration-handoff.md` | accepted | transactional `v7 -> v8` migration, fail-closed historical rejection, same-directory recoverable backup, and bounded migration diagnostics | BH4 is accepted; BH5 is active |
| `plans/active-2026-07-28-bh2-project-switch-state-machine-handoff.md` | accepted | broker-owned project-switch preflight, blocked/synchronized/committed/failed-restored outcomes, and deterministic switch recovery | BH4 is accepted; BH5 is active |
| `plans/active-2026-07-29-bh4-retention-privacy-artifact-lifecycle-handoff.md` | accepted | project-scoped retention, truthful hide/prune/delete semantics, artifact and plot lifecycle rules, tombstones/retained metadata, and privacy-facing documentation/tests | BH4 verification, independent review, and acceptance gate are complete |
| `plans/active-2026-07-31-bh5-incremental-module-boundaries-handoff.md` | accepted | behavior-neutral extraction of store and command modules by durable domain (runs, Agent, Artifacts, environment, project/session) | BH5 extraction and regression evidence complete per domain |
| `plans/active-2026-07-31-ra-rc1-run-comparison-handoff.md` | accepted | read-only deterministic two-run comparison over existing durable records | RA-RC1 is accepted; UX1 active |
| `plans/active-2026-07-31-ux1-interaction-foundation-handoff.md` | accepted | interaction inventory, terminology contract, state presentation contract, mock fixtures, usability protocol | UX1 accepted; UX2 may proceed |
| `plans/active-2026-08-02-agent-entry-and-direct-surface-polish-spec.md` | active; implementation and automated/browser verification complete 2026-08-02 | simplified Agent entry and current Agent-first Direct presentation only | policy and authority boundaries preserved; installed-app acceptance remains open; broader UX4 work still requires separate authorization |
| `plans/active-2026-08-02-agent-first-intuitive-modernization-spec.md` | active; implementation and automated/browser verification complete 2026-08-02 | second-round Agent-first navigation, progressive activity disclosure, and presentation density | internal posture/surface values and all authority boundaries preserved; installed-app acceptance remains open |
| `plans/active-2026-08-03-agent-first-adaptive-work-surface-spec.md` | active; UX4-AWS1 implementation and automated/browser verification complete 2026-08-03 | simple default Agent-first Task surface and explicitly opened file/run/Artifact/audit work surfaces over existing entities | installed-app acceptance remains open; no new Task schema or audit scope |
| `plans/active-2026-08-08-task-rail-mode-status-semantics-spec.md` | active; Issue #9 TASK-RAIL-SEMANTICS-1 implementation, complete affected validation/review, `dev.24` installed acceptance, publication, and update evidence pass | Task Rail-only separation of mode shape/accessibility, status color/name, and risk ownership over existing turn data | immutable `dev.24` evidence is historical; UX4-P2 and Agent/broker authority remain unchanged under Issue #5 Conversation rows |
| `plans/active-2026-08-09-agent-conversation-concurrency-spec.md` | active; Issue #5 authorized end-to-end 2026-08-09; CONV-1 through CONV-3 source checkpoints, independent R3 review, and initial upstream integration accepted; first candidate rejected by a Windows CRLF-only source-contract assertion, whose bounded repair is implemented and source-verified | durable project-scoped Agent Conversation identity, exact-thread context, bounded multi-turn admission, exact-turn cancellation/approval isolation, broker resource scheduling, Retry, selected-Conversation deletion, project-transition ordering, and its bounded cross-platform validation repair | replacement exact-commit integration/CI and installed acceptance remain; the repair normalizes logical test input only and does not move file-edit, AFO-1, BH4, Workspace, environment, release, schema, or credential authority |
| `plans/active-2026-08-04-interface-modernization-foundation-shell-spec.md` | active; M1 implementation and automated/browser verification complete 2026-08-04 | presentation-only semantic tokens, shared controls, local icons, shell hierarchy, tab roles, focus, and responsive geometry | installed-app/display-scale acceptance open; themes and workflow-surface redesign remain proposed |
| `plans/active-2026-08-04-interface-modernization-workbench-hierarchy-spec.md` | active; M2 implementation and automated/browser verification complete 2026-08-04 | Human-first editor hierarchy, existing tab and panel geometry presentation, and correct restoration of the existing `human_preset` value | installed-app/display-scale acceptance remains separate; themes remain proposed |
| `plans/active-2026-08-05-workbench-menu-command-organization-spec.md` | active; UX-MENU-1 implementation and automated/browser verification complete 2026-08-05; installed acceptance open | five-menu command organization, truthful local command state, and keyboard menu traversal over existing actions | M2 retains layout/panel authority; editor shortcuts retain command ownership; Format/Render retain behavior; Viewer/Outputs is a later independent package |
| `plans/active-2026-08-05-outputs-viewer-spec.md` | active; OUTPUTS-VIEWER-1 implementation and automated/browser verification complete 2026-08-05; HTML budget repair implemented and automated verified 2026-08-06; HTML-FRAGMENT-NAV-1 implemented and automated/browser verified 2026-08-06; installed acceptance open | Outputs projection and bounded central inspection of Plot, exact Artifact HTML, Markdown buffers, and CSV/TSV files, including a 32 MiB HTML-only budget and sandbox-local fragment navigation | WP3/P2-3A/P2-3B retain Artifact and Render truth; PLOT-UX1 retains Plot history; UX4-AWS1 retains Agent work surfaces; project containment, sandbox authority, blocked non-fragment navigation, the 4 MiB non-HTML budget, and remaining proposed WS3/WS5 scope are unchanged |
| `plans/active-2026-08-04-interface-modernization-scientific-agent-surfaces-spec.md` | active; M3 implementation and automated/browser verification complete 2026-08-04 | presentation-only status language, scientific/Agent state hierarchy, and distinction among existing review lanes | installed/display-scale acceptance remains separate; `0.3.x` manual gates remain open; Phase 4 remains proposed |
| `plans/active-2026-08-04-five-usability-repairs-spec.md` | active; UX-FIX1 through UX-FIX5 implemented and automated/browser verified in five separately reviewed packages | truthful Problem navigation, explicit save shortcut, clearer file hierarchy, Console focus, and human-reviewable Agent Runs/Review projection | WP3/UX4/M1-M3/CL1/WS2 authority preserved; exact installed-candidate acceptance remains open |
| `plans/active-2026-08-05-native-context-lint-problems-editor-shortcuts-spec.md` | active; all five bounded packages implemented and automated/browser verified in separate commits; exact installed-candidate acceptance remains open | desktop context-menu policy, installed Lint transport, Check code entry, transient diagnostic clearing, and common editor shortcuts | WS2 diagnostics/refactor/format, WP3 durable Problems, UX-FIX2 Save, and M1-M3 presentation authority preserved; no schema or new mutation authority |
| `plans/active-2026-08-05-audit-human-friendly-presentation-spec.md` | active; AUDIT-UX1 implemented and automated/browser verified 2026-08-05; installed acceptance open | shared human-friendly projection for the existing read-only project reproducibility check | RA-RC2 rules/schema/status truth, UX4-AWS1 work surfaces, and M1-M3 presentation authority preserved; no backend, persistence, repair, or execution scope |
| `plans/active-2026-08-05-audit-runtime-reliability-repair-spec.md` | active; AUDIT-REL1 implementation and automated verification complete 2026-08-05; installed acceptance open | Unicode-safe audit execution, existing Windows drive-path coverage, panic/timeout recovery, stale-request rejection, and dirty-source preflight | accepted RA-RC2 retains rule/schema/status truth; AUDIT-UX1 retains presentation language; no persistence, repair, automatic save, execution, or release scope |
| `plans/active-2026-08-07-project-check-source-filter-spec.md` | active; implementation and automated verification complete 2026-08-07; installed acceptance open | Check Project source-file admission limited to R/Rmd/Qmd/Rnw and extensionless source files | AUDIT-REL1 owns audit execution/recovery and AUDIT-UX1 owns presentation; no rule, persistence, mutation, or project-scope change |
| `plans/active-2026-08-07-project-skills-discovery-and-tree-repair-spec.md` | active; implementation and automated verification complete 2026-08-07; installed acceptance open | acceptance-project manifest repair and visible `.rho/skills` project-tree discovery | WP4 owns bounded untrusted skill discovery; project file visibility adds no execution, mutation, credential, or prompt authority |
| `plans/active-2026-08-06-agent-result-transport-recovery-spec.md` | active; ART-1 implementation, contract review, automated verification, and `0.4.0-dev.1` candidate version reconciliation complete 2026-08-06; installed acceptance open | bounded model-facing Agent result projection and response/event workspace identity synchronization | accepted scientific and Agent handoffs retain execution, revision, approval, event persistence, Plot/Artifact, and project authority; no schema, frontend, or release scope |
| `plans/active-2026-08-06-file-proposal-collapse-spec.md` | active; FPC-1 implementation and automated/browser verification complete 2026-08-06; installed acceptance open | native disclosure and compact summary for the existing Agent file-proposal review surface | implemented file-editing contracts retain proposal, persistence, stale, mutation, and undo authority; M3/Agent-first retain lane distinction and Task hierarchy; no schema or new authority |
| `plans/active-2026-08-07-file-proposal-completion-state-spec.md` | active; FILE-PROPOSAL-COMPLETION-1 implementation and automated verification complete 2026-08-07; installed acceptance open | post-accept compact state and verified-only Undo projection over the existing proposal surface | FPC-1 owns disclosure mechanics; implemented file-editing contract owns mutation, stale checks, persistence, and undo semantics; no new authority |
| `plans/active-2026-08-06-act-file-apply-and-generated-output-capture-spec.md` | active; AFO-1 implementation and automated/browser verification complete 2026-08-06; installed acceptance open | exact-turn Act session authorization for file proposal apply and bounded `workspace.execute` generated-file registration | file-editing retains validation/mutation/Undo; WP3 retains Artifact schema/provenance; Agent Outputs and Viewer retain projection/read authority; Environment/Git/package approvals excluded |
| `plans/active-2026-08-06-user-directory-first-start-spec.md` | active; PROJECT-DEFAULT-1 implementation and focused Rust verification complete 2026-08-06; installed acceptance open | no-history startup default root resolution from the current user's directory | project store, project identity, and saved-project restoration remain authoritative; installed first-start acceptance remains separate |
| `plans/active-2026-08-06-agent-output-copy-spec.md` | active; AGENT-COPY-1 implementation and focused frontend verification complete 2026-08-06; installed acceptance open | copy action for the selected final Agent answer using existing clipboard behavior | Agent turn persistence, event history, diagnostics, and backend authority remain unchanged; installed clipboard acceptance remains separate |
| `plans/active-2026-08-06-generated-output-review-spec.md` | active; OUTPUT-REVIEW-1 implementation and focused verification complete 2026-08-06; installed acceptance open | automatic Review previews and user-focused metadata for project-generated files, including image, table, and source content | existing project containment, Viewer security, Artifact provenance, and read-only authority remain unchanged; installed visual acceptance remains separate |
| `plans/active-2026-08-06-current-project-check-spec.md` | active; implementation and automated/browser verification complete 2026-08-07; installed acceptance open | current-directory-only Check Project scope and scrollable Agent Review presentation | historical project audit scope remains available to internal callers; no mutation, repair, or execution authority |
| `plans/active-2026-08-06-environment-approval-reconciliation-spec.md` | active; implementation and focused frontend verification complete 2026-08-07; installed acceptance open | direct environment approval terminal-state reconciliation and refresh-failure isolation | dedicated environment-operation request table, project/revision/snapshot stale guards, and separate Agent approval lane remain authoritative |
| `plans/active-2026-08-07-environment-demo-fixture-spec.md` | active; implementation and fixture validation complete 2026-08-07 | disposable Environment demo project with followable README, valid lockfile, and base-R example | Environment contract owns package/lockfile authority; fixture adds no application, mutation, credential, or release authority |
| `plans/active-2026-08-08-environment-information-hierarchy-spec.md` | active; ENVIRONMENT-UX-1 implementation in progress | Overview / Reproducibility / Variables hierarchy with Installed and Lockfile in a modal inventory | Existing Environment contract retains package/lockfile authority, operation approval, object inspection, and project scope; no backend or schema change |
| `plans/active-2026-08-05-human-facing-information-projection-spec.md` | active; WP1-WP4 implementation and automated/browser verification complete 2026-08-05; installed acceptance open | shared user-facing projection of internal identifiers, errors, statuses, paths, and implementation terminology | UX1 language authority and all existing workflow/backend authority preserved; installed/display-scale acceptance remains separate |
| `plans/active-2026-08-05-system-credential-and-simple-llm-settings-spec.md` | active; CRED-UX1/2/3/4A and CRED-UX4A-R1 implementation verified; owner authorized D3/R3 CRED-UX4A-R2 registered-runtime identity correction 2026-08-08 after installed `dev.20` rejection | shared native system-credential semantics, Model settings, bounded Provider discovery, three-layer Connection/Model/Capability routing, reviewed `aisdk.providers` integration, and canonical registered runtime identity in the isolated one-profile child | exact one-credential and no-fallback rules preserved; owner-installed replacement and live Provider/Keychain acceptance remain open; CRED-UX4B/C workers/media, hosted release action, and MAC5 remain unauthorized |
| `plans/active-2026-08-04-plot-review-surface-spec.md` | active; PLOT-UX1 implemented and automated/browser verified 2026-08-04; installed acceptance open | plot-first preview layout, side Plot navigation, progressive disclosure, and human-readable Saved outputs projection | WP3/BH4/PLOT-PAYLOAD-1/PLOT-ROOT-1/M1-M3 authority preserved; installed acceptance remains open |
| `plans/active-2026-08-04-agent-execution-output-review-repair-spec.md` | active; AGENT-LOOP-1 implemented and automated/browser verified 2026-08-04; duplicate-Plot repair implemented and automated verified 2026-08-05; adaptive long-running Act budget implemented 2026-08-06; HUMAN-OUTPUT-REFRESH-1 implemented and automated/browser verified 2026-08-06; installed acceptance open | display-only path cleanup, direct Act execution instruction, Agent-first Outputs-to-Review loop, single-execution duplicate Plot suppression, adaptive long-running Act liveness, and Agent-to-Human refresh of existing Plots and WP3 Artifacts | existing project/session filters, persistence, Workspace R identity, project/revision/approval/tool guards preserved; no new schema or authority; exact installed-candidate acceptance remains open |
| `plans/active-2026-08-04-plot-payload-normalization-repair-spec.md` | active; PLOT-PAYLOAD-1 implemented and automated/browser verified 2026-08-04; installed acceptance open | canonical PNG base64 ingress plus compatible historical preview/export | WP3 provenance/export, BH4 retention, and M3 presentation boundaries preserved; rebuilt installed-app confirmation remains open |
| `plans/active-2026-08-04-plot-project-root-query-repair-spec.md` | active; PLOT-ROOT-1 implemented and automated verification complete 2026-08-04; installed acceptance open | consistent durable project-root normalization for existing Plot list, retention, prune, and delete commands | WP3/BH1/BH2/BH4, PLOT-PAYLOAD-1, and M3 authority preserved; rebuilt installed-app QC confirmation remains open |
| `plans/active-2026-08-04-windows-project-path-console-window-repair-spec.md` | active; WIN-PATH-GIT-1 implemented and automated verification complete 2026-08-04 | Workspace R project-path projection and Windows no-console policy for existing supervised Git commands | canonical containment, project identity, switching/recovery, and all Git guards preserved; installed confirmation remains open |
| `plans/active-2026-08-02-console-logs-separation-spec.md` | active; CL1 implemented and automated/browser evidence passed | frontend-only separation of the Workspace R Console transcript from operational and Agent Logs | installed-app/manual acceptance remains open and separate |
| `plans/active-2026-08-02-ws4-reviewable-git-mutations-spec.md` | active; implementation and automated/browser verification complete 2026-08-02 | guarded local Git review, hunk/file stage/unstage, confirmed restore, and commit UI over the supervised CLI | installed-app acceptance remains open; repository replacement/adversarial hardening remain separate |
| `plans/active-2026-08-03-ws4-adversarial-git-hardening-spec.md` | active; WS4-G2 implementation, review, and automated verification complete 2026-08-03 | fail-closed repository/path/output admission and adversarial backend fixtures for the existing supervised Git workflow | repository replacement remains separate; no UI, schema, remote, or credential scope |
| `plans/active-2026-08-03-ws4-repository-replacement-spec.md` | active; WS4-G3 implementation, review, and automated verification complete 2026-08-03 | repository-instance-bound stale guards and disposable replacement/recovery fixtures | no Git identity persistence, frontend/schema, remote, credential, clone, or init scope |
| `plans/active-2026-08-03-ws3-broker-data-query-spec.md` | active; WS3-Q1 implementation verified; owner authorized D2/R2 WS3-Q1-R1 selected-view refresh correction 2026-08-08 after installed `dev.20` rejection | Workspace-owned literal search, stable sort, matched paging, visible-page export replay, and identity-bound automatic reinspection of the selected view | richer value presentation remains separate; monotonic/project guards preserved; no schema, Workspace mutation, polling, public protocol, or TanStack scope |
| `plans/active-2026-08-03-ws3-type-missing-presentation-spec.md` | active; WS3-Q2 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | additive Workspace-owned column type/cell-state metadata and truthful frontend/mock rendering | WS3-Q1 query/export authority remains unchanged; no schema, mutation, public protocol, tree, plot, or TanStack scope |
| `plans/active-2026-08-03-render-cancellation-reconciliation-spec.md` | active; P2-3A implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | exact render-job cancellation, restart reconciliation, and truthful frontend/mock terminal states | Runs remain durable authority; Artifact linkage stays separate P2-3B scope; no second job store or execution authority |
| `plans/active-2026-08-03-render-artifact-linkage-spec.md` | active; P2-3B implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | exact completed render job to existing durable `render_output` Artifact presentation | WP3 remains Artifact authority; P2-3A terminal truth unchanged; no schema, second record, or broader Viewer scope |
| `plans/active-2026-08-03-ws1-lockfile-inventory-spec.md` | active; WS1-L1 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | bounded read-only lockfile/installed union comparison and Environment presentation | WP1 project-root/status authority preserved; dependency/source and all package mutation remain separate |
| `plans/active-2026-08-03-ws1-dependency-source-spec.md` | active; WS1-L2 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | evidence-bound direct/transitive role and credential-safe package source presentation | WS1-L1 union/comparison authority preserved; WS2 navigation and all package mutation remain separate |
| `plans/active-2026-08-03-ws1-package-mutation-spec.md` | active; WS1-M1 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | single-package install/update/remove through the dedicated environment request lane | accepted WP1 lifecycle/evidence authority preserved; WS1 inventory is read-only evidence; no lockfile, arbitrary source, global-library, or general network authority |
| `plans/active-2026-08-03-ws2-local-help-location-spec.md` | active; WS2-H1 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | bounded installed package, local Help record, and safe source-reference presentation after project-definition miss | accepted Go-to-Definition and hover lanes reused; full Rd/examples/vignettes and WS1 provenance remain separate |
| `plans/active-2026-08-03-ws2-bounded-project-references-spec.md` | active; WS2-R1 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | bounded token-aware project reference discovery and editor navigation | accepted Go-to-Definition and project file containment remain authoritative; rename/refactor and persistence remain separate |
| `plans/active-2026-08-03-ws2-installed-help-and-example-spec.md` | active; WS2-H2 complete 2026-08-03; WS2-H2-R1 implementation, review, and automated/browser verification complete 2026-08-05; installed acceptance open | bounded installed Rd/version/vignette presentation, confirmed ordinary Workspace example execution, and final-result Console Help projection | WS2-H1 location truth and existing Run/Problems/execution authority preserved; CL1 remains Console presentation authority; no package mutation, Agent citation, hidden Rd execution, frontend R parser, or general viewer dispatch |
| `plans/active-2026-08-03-ws2-diagnostic-grouping-quick-fix-spec.md` | active; WS2-D1 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | bounded lintr normalization, deterministic Problems grouping, and stale-safe reviewed editor-buffer quick fixes | existing Problems and Agent persistent file-edit lanes preserved; no automatic save, multi-file edit, schema, or new write authority |
| `plans/active-2026-08-07-problems-agent-repair-spec.md` | active; R1 historical; R2-R4 rejected under `dev.20`-`dev.22`; R5 passed under superseded `dev.23` source and then exact combined `dev.24` candidate/installed/publication evidence | exact Workspace R expression and strictly validated parse-token diagnostics, schema-v11 project-scoped Problem ranges, bounded same-run context, canonical registered runtime identity, and one shared read-only tool-capable repair action at both Console error site and Problems history | immutable `dev.24` evidence remains historical; Runs/Workspace, R bridge, store, Problems, Console, credential, and Agent file-edit authorities remain unchanged under `dev.26` |
| `plans/active-2026-08-03-ws2-agent-local-help-link-spec.md` | active; WS2-AH1 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | explicit Workspace-derived Local Help context linked to one durable Agent answer | WS2-H1/H2 retain Help truth; Agent turn/event persistence is reused; no model-derived evidence, schema, execution, or approval authority |
| `plans/active-2026-08-03-ws2-refactor-review-spec.md` | active; WS2-R2 implementation, review, and automated/browser verification complete 2026-08-03; installed acceptance open | bounded project-token rename and same-file whole-line extract-function proposals applied only to editor buffers | WS2-R1 owns reference discovery; WS2-D1 owns single diagnostic fixes; no automatic save, Agent/Git/environment mutation, schema, or semantic scope claims |
| `plans/active-2026-08-07-editor-rename-recovery-spec.md` | active; implementation and automated verification complete 2026-08-07; installed acceptance open | proposal-first Rename entry, retryable failure recovery, and preserved symbol/name input over the existing refactor contract | WS2-R1 owns reference discovery and WS2-R2 owns proposal/apply safety; no new command, persistence, approval, or mutation authority |
| `plans/active-2026-08-03-ws2-formatting-review-spec.md` | active; WS2-F1 implemented; installed command-envelope repair authorized 2026-08-05; installed acceptance open | optional Workspace R/styler formatting preview bound to one open document version, plus typed Tauri projection of its broker execution result | refactor/quick-fix contracts retain their own edit semantics; the broker envelope remains internal authority; no frontend response guessing, formatter fallback, automatic save, Agent/Git/environment mutation, or semantic correctness claim |
| `plans/active-2026-08-03-ew-cr2-structural-claim-review-spec.md` | active; implementation and automated/browser verification complete after five repair commits 2026-08-03; installed acceptance open | project-scoped claim records, exact source/Artifact anchors, same-project Evidence links, and deterministic structural review statuses | Evidence entries remain EW-CR1 authority; WP3 owns Artifact provenance; BH1/BH3 own identity/migration; no semantic verdict, Agent authority, export, public protocol, or publication acceptance |
| `plans/proposed-2026-07-26-implemented-baseline-hardening-plan.md` | proposed broader direction; BH1-BH5 accepted, RA-RC1 authorized, and Waves 4-14 not authorized | BH1-BH5 baseline-hardening direction beyond the focused active handoffs | BH5 acceptance; RA-RC1 active |
| `design/proposed-2026-07-26-intuitive-interaction-and-guided-workflows-design.md` | proposed; independently cross-reviewed | task-level interaction, intent entry, consequence-based decisions, guided recovery, progressive disclosure, and user-facing terminology | UX1 may define contracts; behavioral packages wait for their owning hardening, posture, or feature entry gates |
| `design/proposed-2026-07-26-public-workbench-protocol-cli-mcp-design.md` | proposed; independently cross-reviewed | WB1 public read-only semantic contract, WB2 authenticated local CLI/MCP/events, and WB3 broker-admitted external R execution | `0.3.x` and BH1-BH3 accepted; each WB package separately authorized and stopped for review |
| `design/proposed-2026-07-26-reproducibility-audit-and-run-comparison-design.md` | proposed; independently cross-reviewed; RA-RC1 authorized under `active-2026-07-31-ra-rc1-run-comparison-handoff.md` | read-only deterministic audit and two-run comparison semantics | `0.3.x` milestone acceptance plus an approved RA-RC1 interface checkpoint and durable run-project identity contract |
| `design/proposed-2026-07-26-evidence-workspace-and-claim-review-design.md` | proposed; independently cross-reviewed | project-scoped scholarly evidence entries, citation normalization, claim-to-evidence linkage, and bounded claim-review semantics | `0.3.x` milestone acceptance, BH1-BH3 acceptance, RA-RC1 acceptance, and a separately authorized EW-CR1 handoff |
| `design/proposed-2026-07-26-rstudio-inspired-workflow-design.md` | proposed umbrella direction; partially implemented through separately accepted packages; reconciled 2026-08-02 | post-`0.3.x` scientific capability direction across WS1-WS7 | remaining WS1/WS2/WS3/WS4/WS5/WS6/WS6A scope and all WS7 work require separate focused authorization; implementation and manual acceptance remain distinct |
| `plans/proposed-2026-07-20-human-agent-workbench-posture-design.md` | proposed | Human/Agent posture and Direct/Monitor/Review information architecture | open decisions close and a separate posture package is approved |
| `plans/proposed-2026-07-26-interface-modernization-plan.md` | proposed umbrella; focused M1-M3 implemented with automated/browser verification 2026-08-04 | visual tokens, icons, component presentation, responsive behavior, themes | installed/display-scale acceptance remains open; Phase 4 requires separate approval |
| `plans/proposed-2026-08-01-next-phase-task-plan.md` | proposed coordination plan; focused P2/P3 packages reconciled 2026-08-02 | current decomposition of remaining acceptance gates and proposal gaps | each unchecked work package requires a focused handoff; P1 gates remain blocking |
| `architecture/proposed-aisdk-family-change-proposals.md` | proposed and deferred | catalog of possible upstream seams | a concrete current gap and separate cross-repository approval exist |

## Implemented Status Corrections

- `implementation/implemented-wp2-data-viewer-interface.md` is implemented in
  `8982b12`; its focused evidence is in `verification/wp2/`.
- `implementation/implemented-wp4-project-skills-interface.md` is implemented
  in `2415c3f` and hardened in `3d45af2`; its focused evidence is in
  `verification/wp4/`.
- These corrections do not close the `0.3.x` milestone. Package implementation,
  focused verification, milestone acceptance, and public release are separate
  states.

## Resolved Cross-Document Conflicts

### Navigation and layout state

The Human/Agent posture and task-oriented Task/Runs/Review navigation are now
implemented through the focused UX4 contracts. The adaptive-work-surface
contract owns the simple Agent-first Task default and contextual file, run,
Artifact, and audit surfaces. The modernization plan may style these states and
the Human-first Code/Analyze/Agent selector but cannot replace them, create a
competing top-level state, or change persistence semantics. The focused
2026-08-04 M1 contract authorizes presentation-only foundation and shell
hierarchy work. The separate M2 contract owns Human-first editor hierarchy,
existing tab/panel geometry presentation, and correction of the existing
`human_preset` restoration path without adding persistence or top-level state.
Scientific/Agent workflow-surface redesign and themes remain unauthorized.

The focused M3 contract may restyle and reorganize projections of existing
Runs, Problems, Plots, Environment, Agent events, approvals, and file-edit
proposals. It cannot redefine their status values, persistence, revisions,
mutation consequences, approval ownership, or recovery actions. Direct UI
environment requests and Agent approvals remain visibly and operationally
separate. Phase 4 remains unauthorized.

The intuitive-interaction proposal may improve task-level wording, empty
states, Run scope, result handoff, and recovery without defining another
top-level navigation. Posture continues to own Human-first/Agent-first and
Direct/Monitor/Review. Modernization continues to own visual presentation.

### Agent intent and permission presentation

The intuitive-interaction proposal owns one default natural-language entry and
consequence-based escalation. It does not remove broker Ask/Plan/Act policy or
make natural-language intent an authorization. The posture proposal owns any
expert-visible placement of those policy modes and top-level Agent navigation.

The accepted decision uses one default `Ask Rho` entry, starts in the least-
authority policy lane capable of understanding the request, and retains
Ask/Plan/Act in an advanced Agent control. Posture changes do not change
permission, and protected actions retain their typed approval, file-edit, or
environment-operation lane.

### Scientific operations and approval lanes

The active `0.3.x` contract owns direct environment-operation requests and
their dedicated dialog. Agent approvals, file-edit acceptance, and environment
operations remain separate broker records and decision surfaces. Posture and
modernization work may project or restyle them but cannot merge them.

### Model settings progressive disclosure

The active system-credential specification is the single owner of Model
settings credential presentation, the CRED-UX2 original Issue #4 workflow, and
the CRED-UX3 discovery-first model picker. Its implemented CRED-UX4A package
owns the Connection/Model/Capability foundation and existing-turn routing.
Its active CRED-UX4A-R1 package owns the installed settings-entry recovery,
Provider-first ordering, reviewed `aisdk.providers` adapter allowlist, optional
literal Base URL overrides, model capability cards, and Connections/routing
navigation. It does not own a new credential source, network lane, schema, or
capability consumer. Owner and replacement installed-candidate acceptance
remain open. The future worker boundary remains proposed; CRED-UX4B/C are not
active.
CRED-UX2 supersedes only CRED-UX1's single global Advanced layout. It replaces
that layout with provider cards, one selected-provider Advanced disclosure, a
dedicated Add provider Connection -> Model workflow, a dedicated Model editor,
separated Danger zones, and deterministic operation feedback.

The implemented Agent LLM V1 design remains authoritative for stable provider
and model IDs, global settings, model enablement, selected-model semantics,
capability gating, attribution, connection-test bounds, and no silent fallback.
The human-facing information specification remains authoritative for friendly
status/error projection and credential redaction. MAC3 remains authoritative
only for the Apple Keychain adapter and macOS-native acceptance. CRED-UX2 adds
no provider-enable persistence, command, schema, credential source, network
authority, project scope, or release authority. CRED-UX3 alone authorizes one
bounded read-only model-list request after an explicit setup action. It reuses
the existing stable Provider identity and system credential, prohibits
redirects and environment-derived endpoint expansion, and leaves the LLM V1
model record, capability, enablement, selection, attribution, and no-fallback
contracts unchanged. Provider results remain transient suggestions; the manual
Model ID path is the recovery authority when discovery is empty, unsupported,
or fails.

CRED-UX4 resolves a newly demonstrated mismatch with the exact `aisdk` commit
pinned by `rho.agent`: `aisdk` supports one default ChatSession model plus
arbitrary named session capability routes with language/embedding/image types
and required capability attributes. The former one-model Rho transport was the
gap; CRED-UX4A now resolves it for existing Ask/Plan/Act turns without enabling
the separately gated optional-route consumers.
The redesign does not transfer model semantics into the frontend and does not
authorize prompt-classified routing. Rho owns stable persisted references,
revision checks, credential isolation, typed consumer admission, and user-facing
projection; `aisdk` retains model construction and capability-route resolution.
CRED-UX4A-R1 adds `aisdk.providers` only through a pinned dependency and an
explicit Rho-owned constructor/preset allowlist. The package's load-time
registry does not authorize settings to name an arbitrary R package or
function. Provider model responses remain availability suggestions, while an
exact `aisdk` catalog match remains the only automatic default-capability
evidence used for model cards and route compatibility.

The proposed worker boundary deliberately avoids injecting all optional-route
keys into the main Agent R. Existing Agent turns receive only the effective
`agent.chat` or `agent.act` credential. Future typed capability consumers must
be activated separately and use one broker-resolved route and one credential
in one isolated worker. Workspace R, project files, Artifact admission,
approval lanes, and Agent history remain owned by their existing contracts.

The Issue #4 provider reference shows an active/inactive control, but the
existing data model has no provider-enable state. CRED-UX2 therefore derives a
provider readiness badge from credential state and enabled models rather than
inventing a second enablement authority. Model enablement remains editable only
inside the dedicated Model editor, while deletion remains in a separate closed
Danger zone. This resolves the visual reference without conflicting with the
implemented configuration schema.

Safari/WebKit review resolved the child-dialog isolation detail without
changing ownership: Model settings, Add provider, and Model editor use sibling
modal roots. Opening a child removes the main root from rendering and the
accessibility tree, then exposes the child as the sole active dialog; inactive
siblings have no active role. WKWebView otherwise projects nested modal content
as an empty accessible container. This is the cross-platform implementation of
the existing containment rule, not a new persistence, credential, command, or
product-dialog authority.

### Artifacts and review

Implemented WP3 artifact records and provenance are the V1 authority. The
RStudio-inspired proposal may sequence richer artifact capabilities. The
posture proposal may define how artifacts are navigated and reviewed, but any
version, link, annotation, finding, or acceptance schema must be an additive,
migration-safe extension of WP3 after a focused design.

### Scholarly evidence workspace and claim review

The evidence-workspace proposal owns project-scoped scholarly evidence entries,
citation normalization, bounded evidence excerpts, and claim-to-evidence
linkage. It does not replace WP3 Artifact provenance, RA-RC internal evidence,
package help, or a full manuscript/publication system.

The accepted separation is:

- WP3 Artifact provenance answers what source, run, and environment produced a
  project result;
- RA-RC answers whether internal project evidence is reproducible and how runs
  differ;
- the evidence workspace answers which external scholarly evidence a project
  claim cites and whether that linkage is structurally reviewable.

An external citation does not satisfy internal reproducibility evidence, and a
clean internal audit does not prove that a manuscript claim is literature-
grounded. Claim-review statuses therefore remain bounded to `linked`,
`missing_evidence`, `unresolved_source`, `incomplete_evidence`, and
`cross_project_rejected`; they are not semantic truth verdicts.

The RStudio-inspired proposal continues to own broader post-`0.3.x`
capability sequencing. The evidence-workspace proposal narrows only the
scholarly evidence/claim slice and explicitly restricts core implementation to
small-footprint permissive-license components and open-data providers. Hosted
platforms and heavier literature services remain optional later connectors and
may not become the sole core dependency.

### Reproducibility audit and run comparison

The reproducibility proposal is a read-only derived evidence layer over
existing run, environment snapshot, Problem, and WP3 Artifact records. It does
not create a second audit database, durable review-finding lifecycle, Artifact
acceptance state, task model, job system, or repair channel. Its deterministic
facts remain independent of optional Agent explanation.

RA-RC1 is the first recommended post-`0.3.x` evidence workstream, but it is
blocked until baseline-hardening BH1-BH3 provide canonical authoritative
project identity, fail-closed historical commands, and accepted migration
evidence. Project
identity must not be inferred from source paths, current UI state, timestamps,
or Artifact filenames. RA-RC2 static project audit follows only after RA-RC1
acceptance and retains explicit parser, scan, and evidence limitations.

AUDIT-REL1 is a bounded repair to the implemented RA-RC2 path. It may harden
Unicode parsing and request recovery and may block a disk-backed check when an
open supported source document is dirty. It cannot change rule identity,
severity, persistence, project scope, or create automatic save/repair behavior.
AUDIT-UX1 remains the owner of shared Human/Agent result language.

### Implemented baseline hardening

The baseline-hardening plan owns repair of project identity, project-scoped
queries and model context, retry/continuation admission, project-switch
concurrency, schema migration, and retention semantics. It does not own a new
scientific capability or UI information architecture.

BH1-BH3 are prerequisites for any proposed feature that reads, compares,
continues, or executes historical project records. Existing WP1-WP4 contracts
remain authoritative for their feature behavior; affected evidence must be
rerun after hardening. Legacy records without authoritative ownership remain
explicitly unscoped and cannot be assigned from paths, timestamps, current UI
state, or filenames. Interface and posture proposals may present hardening
states but cannot redefine their persistence or concurrency rules.

The intuitive-interaction proposal projects BH2 switch blockers and BH4
retention semantics into user language. It cannot offer `Stop and switch`,
Undo, hide, prune, or delete behavior until the corresponding backend contract
exists and is tested.

For BH2 V1, any waiting approval capable of later continuation or mutation
blocks switching to another project. The user must accept, decline, or cancel
it first. Switching Human/Agent posture or Direct/Monitor/Review within the
same project remains allowed and preserves the pending decision.

### Background jobs

The RStudio-inspired workflow proposal owns the future broker job capability
contract. A posture implementation may display those jobs in Monitor or Review
but cannot define a second runtime, policy, or persistence model.

Quarto is the first scheduled broker-owned local-job adapter in Wave 13. The
RStudio-inspired proposal owns its typed render/job behavior; implemented WP3
continues to own V1 Artifact records and provenance. Quarto exit status defines
process success, while parsed diagnostics are bounded projections into the
existing Problems model. The adapter must not authorize a generic shell or
arbitrary process command.

`targets` follows the accepted Quarto/local-job contract in Wave 14. The
`targets` package owns `_targets` metadata and pipeline semantics; Rho owns
project/environment admission, durable job state, cancellation/restart
reconciliation and Artifact links. A pipeline process is not Workspace R or
Agent R, and importing a result into Workspace R is a separate recorded action.

### Editor Intelligence And Problems

Monaco remains the frontend editor. Air and R `languageserver` are alternative
providers behind one Rho-owned bounded language-service contract, not parallel
authorities. Wave 8 selects one primary provider; Wave 9 integrates it before
adding `lintr`. Provider results are bound to canonical project identity and
document versions and cannot redefine BH1-BH3 project ownership or switching.

The existing Problems model remains authoritative. Language-service, `lintr`,
Quarto and later job diagnostics identify their producer and are normalized,
bounded and deduplicated; no provider receives its own durable Problems store.
Formatting, quick fixes and refactors continue through reviewed file edits and
cannot bypass Agent proposal/Accept or direct user save semantics.

### Viewer Component Boundary

TanStack Table may own frontend virtualization, focus, selection and column
presentation in Wave 10. Implemented WP2 remains authoritative for supported
object classes, server-side pages, sorting/filtering semantics, byte and
dimension limits, state revisions and stale-object rejection. Implemented WP3
continues to own export and provenance; frontend table state cannot claim a
full-object export or current scientific truth.

### Git Ownership And Mutation

The RStudio-inspired proposal owns the future typed Git capability and prefers
`gitoxide` as an implementation candidate. BH1 owns canonical project identity;
Git must independently validate repository identity and current diff/revision.
Git history does not replace Rho runs, approvals or Artifact provenance.

Wave 11 is read-only. Wave 12 mutations require an exact selected file or hunk,
preserve unrelated dirty work, and use a Git-specific policy/recovery contract.
The public Workbench Protocol cannot expose Git mutation before the internal
contract is accepted. Credentials, remotes and network mutation remain outside
Waves 11-12.

### Public Workbench Protocol, CLI, and MCP

The public-protocol proposal owns the externally consumable semantic projection,
its independent version/schema/error contract, authenticated local CLI/MCP
transports, project-scoped event replay, and the later external-execution
admission contract. It does not replace the current internal framed protocol,
desktop frontend, coordinator, store, approval lanes, or Workspace R authority.

WB1-WB2 remain read-only and wait for `0.3.x` plus baseline-hardening BH1-BH3.
No public adapter may fill missing record ownership from the active workspace,
source path, timestamp, or filename. WB3 additionally requires a separate
security/approval checkpoint; external host confirmation is evidence, not Rho
authorization by default. A new Web control plane, thin-desktop migration,
remote gateway, and non-loopback deployment remain outside WB1-WB3.

### Implementation sequences

The `0.3.x` work-package sequence remains the historical authority for the
current scientific milestone. Other documents' Phase A-D or Phase 1-4 labels
are local to those documents and do not unlock, supersede, or run inside a
`0.3.x` package without an explicit contract amendment.

The cross-proposal schedule is the Wave 0-14 Implementation Program in
[`active-development-roadmap.md`](active-development-roadmap.md). This record
defines the coordination constraints that apply to that schedule:

The current program state is **Waves 1-14 implementation code committed (2026-08-01)**.
BH1-BH5 are accepted with verification evidence. RA-RC1, WB1, WB2, UX4, RA-RC2,
WS2 (Air selected), WS3 (basic table), WS4 (git CLI), WS6 (async Quarto job),
WS6A (targets read-only inspection), and WS9 (lintr) are committed. Per-wave
verification and manual acceptance evidence are pending for Waves 4-14; each
exit gate must be independently closed. The next-phase task plan
(`proposed-2026-08-01-next-phase-task-plan.md`) decomposes the remaining work
into sequenced work packages.

| Wave | Coordination result |
| --- | --- |
| 0 | `0.3.x`, exact `0.2.0-dev.12` release acceptance, and About/update acceptance may proceed independently; no track's evidence closes another track |
| 1 | BH1 is the primary implementation; UX1 and modernization Phase 1 may run only as contract, inventory, fixture, usability-baseline, token, icon, dimension, and behavior-neutral component work |
| 2 | BH3 retains a migration gate even when developed with BH1 schema work; BH2 waits for BH1 and owns project-switch truth; UX cannot promise switching or recovery semantics early |
| 3 | RA-RC1 is the first new post-`0.3.x` capability and stops for review; it remains read-only and cannot create a second evidence store |
| 4 | UX2 owns the novice first-use-to-result workflow; modernization may style it but cannot introduce structural posture navigation |
| 5 | WB1 owns the public read-only semantic boundary; no CLI, MCP, or external execution contract may become authoritative first |
| 6 | WB2 owns authenticated local CLI/MCP/events and remains read-only; cross-platform transport validation consumes the accepted WB1/WB2 contract |
| 7 | RA-RC2 precedes a separately selected EW-CR1, UX3, UX4, or UX5 package; BH4 precedes retention/deletion, posture precedes UX4 Agent-entry placement, and EW-CR1 requires accepted `0.3.x`, BH1-BH3, and RA-RC1 evidence |
| 8 | Retain Monaco and compare Air with R `languageserver`; select one primary backend before product integration |
| 9 | Integrate the selected language backend, then normalize optional `lintr` findings into Problems; providers never write files directly |
| 10 | TanStack Table may enhance the UI only; implemented WP2/WP3 remain data, bounds, staleness, export and provenance authorities |
| 11 | `gitoxide` read-only status/diff/history only, bound to canonical project and repository identities |
| 12 | Selected Git mutations require their own stale/rejection/failure/recovery gate; no credentials or remotes |
| 13 | Freeze a narrow local-job contract through Quarto rendering; no arbitrary process execution or second Artifact store |
| 14 | Stop after read-only `targets` inspection, then separately authorize execution and pipeline-to-Quarto composition |

Only one new post-`0.3.x` product-capability stream may be implemented at a
time. Independent acceptance/release work and behavior-neutral design-system
foundation may run in parallel. Parallel work must not depend on an unaccepted
schema, public protocol, navigation state, approval lane, project-switch rule,
or retention behavior.

Moving between waves is not implicit authorization. For each bounded package,
record entry evidence, activate or create its focused implementation handoff,
update this matrix, and name the next mandatory stop point. Later packages in
the same proposal remain proposed.

### Release boundaries

The active release checklist is the sole GO/NO-GO authority for the exact
`0.2.0-dev.12` candidate. About/update V1 was implemented afterward and has its
own Pages and installed-app gates. It cannot be included in, block, or validate
that candidate retroactively; inclusion requires a revised candidate and new
affected evidence.

The macOS arm64 specification does not amend or reuse the exact
`0.2.0-dev.12` release contract. The rejected `0.4.0-dev.1` rehearsal and its
repaired `0.4.0-dev.2` rehearsal remain historical fork evidence. Upstream
independently advanced through `0.4.0-dev.15`; after non-rewriting integration,
the combined source first became `0.4.0-dev.16`. Its checklist and passing
review-only runs are now historical because Issue #4's user-visible changes
advanced the live candidate through `0.4.0-dev.17`, CRED-UX3 advanced it to
the rejected `0.4.0-dev.18`, and CRED-UX4A-R1 reached the now-historical
`0.4.0-dev.19`. Issue #6 first produced rejected identity `0.4.0-dev.20`; its
installed corrections produced `0.4.0-dev.21`, whose remaining Problems-only
navigation was rejected by owner workflow review. The Console error-site
correction produced `0.4.0-dev.22`, whose installed parse-error path still
required the user to select an already parser-located token. R5 produced
`0.4.0-dev.23`, whose source validation passed but whose artifact was not built
before Issue #9 advanced the combined identity to `0.4.0-dev.24`. MAC4
implemented parallel candidate construction, signed/notarized macOS packaging,
immutable draft assembly, and separately gated publication. The exact upstream
`dev.24` candidate then passed installed acceptance, MAC5, protected
publication, and live update-site verification without asset replacement.
Issue #5 advanced behavior source to `0.4.0-dev.25`; none of the immutable
`dev.24` artifact or acceptance evidence was reusable for that successor.
Candidate run `31336769848` then consumed and rejected `dev.25` after Windows
failed a CRLF-only contract assertion, despite its macOS artifact passing
signing/notarization/stapling. The bounded validation repair advances the fresh
candidate identity to `0.4.0-dev.26`; neither earlier identity is composable.

MAC4-R is a bounded pre-merge evidence lane owned jointly by the active macOS
specification and exact-candidate checklist. It may use fork repository secrets
to build both platforms and upload short-lived Actions artifacts, but it cannot
create a tag or Release and its evidence cannot satisfy candidate, MAC5,
About/update, Pages, or publication gates. Candidate mode remains restricted to
`YuLab-SMU/Rho`; no other document owns or consumes rehearsal evidence.

Hosted MAC4-R failures may repair only an existing owning contract: WS1-L2
continues to own fail-closed local-source containment, MAC2 continues to own
Apple-Silicon R architecture policy, and the exact-candidate checklist continues
to own synchronized Cargo identity and the existing candidate workflow
contract. Windows path handling and CRLF/current-host test portability do not
transfer those authorities to MAC4-R. CRLF repair applies uniformly at the
release-contract test input boundary while leaving every workflow and metadata
assertion unchanged. Any repair must be regression-covered and accepted by a
new exact-commit two-platform rehearsal; cross-run artifact composition is
forbidden.

The exact-candidate checklist also owns the final-DMG notarization boundary.
Tauri may sign the app and DMG, but MAC4-R removes notarization API variables
from that bundle command so it can explicitly submit the final DMG once,
validate that submission's own bounded Accepted receipt, and only then staple,
assess, smoke, and emit platform evidence. This repair neither transfers
release ownership to Tauri nor permits an app-only receipt, a repository-wide
history inference, or evidence composed from another run. The macOS
specification owns the bounded arm64 diagnostic; shared runtime and R
architecture policy remain unchanged.

MAC4-R2 is the closed bounded installed-app repair lane jointly recorded by the
active macOS specification and current candidate checklist. It added only
`com.apple.security.cs.disable-library-validation` to the macOS signing plist,
validated that exact final signature on Rho and Ark, advanced the fork
application identity, and passed replacement rehearsal evidence. It did not authorize
DYLD/JIT/unsigned-memory/debugger exceptions, bundling or modifying R itself,
MAC5, candidate/draft creation, tag, Release, Pages, or publication. The
`0.4.0-dev.1` artifact is historical rejected evidence and cannot be composed
with replacement evidence; the `0.4.0-dev.2` artifact is historical passing
fork evidence and cannot satisfy any later candidate.

MAC4-R3 is the implemented bounded orchestration lane historically owned
jointly by the macOS specification and `0.4.0-dev.16` checklist. It may split
the existing one-DMG
notarization into macOS submission, Ubuntu fixed-endpoint wait/log retrieval,
and macOS staple/verification finalization while preserving immutable
version/commit/run/submission/hash binding. It introduces no new application,
credential, entitlement, release, or publication authority. Only the waiter
receives the three notarization API-key secrets; the finalizer receives no
Apple secret. Intermediate unstapled artifacts cannot enter candidate evidence,
and failed-job reruns must reuse the same request instead of resubmitting.
Exact-commit fork run `31163017077` passed this contract and its independently
verified seven-file review artifact while using 13 minutes 51 seconds of macOS
runner time. The draft job skipped and read-only audit found no tag, Release,
draft, or Pages site. This closes MAC4-R3 at its review-only mandatory stop; it
does not satisfy authoritative candidate or MAC5 gates.

Upstream subsequently advanced through `b5800ae`. Ordinary merge `9d3086e`
retains the new independently owned Check Project source-filter contract and
passed the complete affected local matrix, but it changes exact source after
run `31163017077`. Post-merge exact-commit run `31165265090` and its
independently verified seven-file artifact passed with 12 minutes 10 seconds
of macOS-runner use. The draft job skipped and no tag, Release, draft, or Pages
site exists. This closes the refreshed review-only stop without expanding
authority.

The historical `0.4.0-dev.23` checklist carried the registered Agent runtime,
selected Workspace view, Console error-site correction, bounded parse-token
admission, and schema-v11 recovery after the exact `dev.22` workflow rejection.
The historical `0.4.0-dev.24` checklist carried those behaviors forward, added
the Issue #9 Task Rail projection, and now preserves its completed candidate,
installed, publication, and update evidence. The rejected `0.4.0-dev.25`
checklist preserves Issue #5's first candidate attempt. The active
`0.4.0-dev.26` checklist owns its replacement identity and must earn its own
exact-source matrix, artifact, and installed-acceptance ledger; no earlier run,
notarization receipt, hash, or artifact is composable with it.

### PROBLEMS-AGENT-REPAIR-5 parser-token cross-review

R5 narrows, rather than removes, R2's prohibition on message-derived source
locations. Only `rho.bridge`, while handling the exact `parse(text=...)` phase,
may decode the bounded anchored `<text>:line:column:` prefix. Localized reason
text, ordinary runtime messages/calls/tracebacks, filenames, and every other
component remain non-authoritative. Exact submitted code independently proves
that the coordinate names an existing Unicode scalar; failures remain
unlocated. This resolves parser ownership without giving the frontend, store,
Agent, or arbitrary Provider text authority to infer source.

Schema v11 belongs to the existing Problems diagnostic stream, not BH3's
broader identity ownership and not a new diagnostic store. It expands only the
closed `error_range_kind` CHECK from `r_expression` to `r_expression` or
`r_parse_token`. The v10-to-v11 rebuild reuses BH3's same-directory backup,
single transaction, assertion, injected rollback, and reopen/recovery
semantics. It copies existing values and never backfills historical parse
messages. Thus R5 does not guess historical ownership, weaken project scoping,
or create a competing migration policy.

Runs/Workspace execution remains the diagnostic source of truth; Problems
remains durable history; Console remains an entry projection; Agent file-edit
remains the sole proposal/Accept mutation lane; CRED-UX4 retains route and
one-credential authority. A parse token is diagnostic context, not execution,
approval, edit permission, or semantic replacement. EOF and unvalidated
locations retain explicit user-selection recovery.

The `dev.22` owner rejection is immutable and cannot be repaired in place.
Application `dev.23`, `rho.bridge 0.1.13`, and store schema 11 were synchronized
R5 identities; Issue #9 later advanced only the application identity to
`dev.24`, leaving the R package versions and schema unchanged. The cross-review
found no unresolved ownership, credential, approval, persistence, project,
release, or sequencing conflict. The immutable `dev.24` candidate later passed
the complete exact-candidate, installed, MAC5, publication, and update gates.
Those facts remain historical and do not satisfy the active `dev.26` contract.

### macOS arm64 platform ownership

The M3 roadmap retains full cross-platform milestone authority. The active
macOS specification owns only the Apple Silicon implementation stream; it may
record a macOS-arm64 sub-gate but cannot close M3 while macOS x64 and Linux x64
remain open.

The accepted About/update design retains endpoint, channel, allowlist, SemVer,
fetch, size, timeout, and user-initiated-install policy. Completed MAC4 adds one
optional schema-v1 macOS artifact, platform-unavailable admission, and
multi-platform page projection under the recorded two-way amendment. It does
not make updater installation or a draft release authoritative.

The active system-credential specification retains stable provider IDs,
redaction, precedence, Agent-only injection, and failure semantics. Its
Windows production backend remains unchanged. Completed MAC3 added Apple
Keychain behind the same abstraction and tests; the macOS specification owns
that adapter and its acceptance while the credential specification retains
shared semantics. It introduced no project credentials, sync, OAuth, key
export, or new credential state.

UX-KEYS-1 retains the common command router, input/dialog ownership, and editor
action semantics; accepted WS2 retains definition lookup/navigation. MAC3 may
add only the macOS Command gesture adapters and deterministic platform fixture,
with existing Ctrl behavior preserved. The fixture is browser/mock test state,
not a second runtime platform authority.

WS1-L2 retains package-source normalization and project-containment ownership.
The MAC2-observed escaped local-source failure contradicts its already active
"provably inside" contract, so MAC3 may repair that implementation deviation
and add regression cases without widening file or navigation authority. The
`/private/var` temporary-directory alias and installed-Bioconductor version
comparisons are test-portability repairs only and do not redefine Lint, Viewer,
fixture, package, or scientific behavior.

BH1/BH2 retain canonical project identity, containment, switching, and recovery
authority. MAC1 may select a platform-appropriate default directory only before
the existing normalization and validation boundary. Jet and the current Ark
session retain process-launch and watchdog authority; the macOS stream may add
only the bounded fallback cleanup named in its active contract.

### aisdk family work

No upstream `aisdk` family change is on the current `0.3.x` path. The proposal
is a deferred catalog. Every external repository change requires a newly
demonstrated gap and separate approval; `aisdk.bioc` remains deferred beyond
`0.3.x`.

## Remaining Open Gates

All installed-app/UI items below are intentionally consolidated under the
candidate checklist and example workflow named above. Completing automated or
browser evidence does not check them off.

- complete the `0.3.x` representative-project reproducibility workflow
  and manual three-viewport UI acceptance;
- retain the passing 2026-07-26 final cross-package validation evidence and
  rerun it after any affected repair (BH1-BH5 and Waves 4-14 may have shifted
  storage, query, migration, or switching behavior);
- retain the accepted WP3 runtime DOM evidence; fresh `1024 x 768` and narrow
  captures remain part of manual acceptance;
- retain the current WP4 package-check result of zero errors, warnings, and
  notes; the local roxygen version mismatch prevented re-documentation;
- complete `0.2.0-dev.12` P0 installed-application acceptance and distribution
  decision;
- complete About/update live endpoint and exact installed-candidate acceptance;
- close per-wave verification and manual acceptance evidence for Waves 4-14;
- define additive artifact acceptance semantics before posture Phase C;
- approve only one Phase-3 capability workstream at a time per the next-phase
  task plan.

## Implementation Start Checklist

Before implementing any unfinished document:

1. follow `active-development-governance.md` and classify the change/risk;
2. identify the owning row in the matrix above;
3. verify its entry condition is satisfied with locateable evidence;
4. confirm no higher-authority active contract forbids or narrows the change;
5. amend conflicts before editing product code;
6. keep browser/mock behavior aligned with Tauri state changes;
7. preserve dedicated mutation and approval lanes;
8. report version/NEWS outcome, automated evidence, manual acceptance,
   worktree state, and release decision as separate facts.
