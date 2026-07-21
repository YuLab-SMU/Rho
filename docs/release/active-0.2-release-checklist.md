# Rho 0.2 Release Checklist

Status: active release acceptance

Date: 2026-07-22
Candidate: `0.2.0-dev.11`

This checklist is the go/no-go contract for the first daily-use Windows
release. A box is complete only when another person can locate the evidence.
The implementation and evidence contract is defined in
[`active-0.2.0-release-hardening-spec.md`](active-0.2.0-release-hardening-spec.md).

## P0 Release Gates

- [ ] Install the NSIS package in a clean Windows user profile without Rust,
  Node, Rtools or the Rho source tree.
- [ ] Launch with R 4.4 or later and confirm Ark-backed Workspace R reaches
  `R idle` without a developer environment.
- [ ] Launch without R and with R 4.3; confirm the recovery view remains open,
  classifies the failure, and supports Retry and native Rscript selection.
- [ ] Force a base R probe to exit non-zero with empty stderr; confirm the UI
  remains open and copied diagnostics retain exit code, stdout and elapsed time.
- [ ] Open projects whose paths contain spaces and non-ASCII characters.
- [ ] Edit, save, close and restore multiple documents, including a closed dirty
  draft, without content loss.
- [ ] Execute selection, current line, complete file and Console code; inspect a
  resulting object and plot.
- [ ] Interrupt a long R execution and confirm the durable run becomes
  `interrupted` rather than remaining active.
- [ ] Restart Workspace R during or after an error and confirm the project,
  documents and audit records remain available.
- [ ] Run DeepSeek Ask and Act turns; verify approval, rejection, stale approval
  cancellation and single-active-turn behavior.
- [ ] Open `Manage LLMs...`, verify the effective user `.Renviron` path,
  credential refresh, default-model switching and bounded connection testing.
- [ ] Configure or select a chat-only model and confirm Ask/Plan still work
  while Act is disabled with an explicit reason.
- [ ] Remove or break an aisdk dependency and confirm Rho reports Agent
  `Unavailable` with a useful dependency error while Workspace R remains usable;
  restore the dependency and confirm Retry Agent recovers without restarting.
- [ ] Modify, delete and recreate an open file outside Rho; verify clean tabs,
  dirty drafts and `project_revision` behave as documented.
- [ ] Render a saved `.Rmd`, and verify an unsaved document is blocked. Verify a
  missing Quarto installation produces a structured capability problem.
- [ ] Resize all three panel dividers at the 1024 x 680 minimum window and a
  normal desktop size; restart and confirm sizes restore.
- [ ] Uninstall Rho and verify the expected application/runtime files are
  removed. Record whether project-session data is retained or removed.

## Automated Evidence

- [x] Rust workspace tests cover protocol bounds, revisions, Unicode/space
  project paths, the 2,000-file discovery boundary, atomic persistence,
  restart recovery records and approval authorization.
- [x] `rho.bridge` tests cover bounded Workspace/object previews.
- [x] `rho.agent` tests cover broker identity and single-use approval handoff.
- [x] Browser-mode validation covers saved/dirty Render state, project revision,
  successful R Markdown render and zero browser console errors.
- [x] Workspace smoke passes against the release binary.
- [x] DeepSeek Agent smoke passes against the release binary. The 2026-07-22
  release check completed a real `deepseek:deepseek-v4-flash` turn against the
  shared Workspace R and recorded it in
  `target/release-evidence/rho-0.2-release.json`.
- [x] Final NSIS package contents, byte size and SHA-256 are recorded in
  `docs/implementation/implemented-windows-build-environment.md`.
- [x] `scripts/test-release-metadata.ps1` rejects version/tag mismatch, missing
  bundle inputs, whitespace errors and a dirty publication worktree.
- [x] `scripts/invoke-0.2-release-checks.ps1` runs Rust, R and frontend checks,
  supports bounded release smoke tests and writes machine-readable evidence.
- [x] The manual GitHub publish workflow runs verification before release
  creation and uploads the installer, checksum and release evidence together.

## P1 Daily-Use Quality

- [ ] Verify lightweight completion for R keywords, common functions and live
  Workspace object names.
- [ ] Verify File/Edit/Session/Tools menus and keyboard shortcuts.
- [ ] Exercise a project with at least 1,000 supported files and confirm the UI
  remains responsive and reports discovery limits.
- [ ] Exercise a project with a large generated-output tree and confirm the
  directory-entry scan limit reports truncation without traversing indefinitely.
- [ ] Exercise a near-limit source file and confirm files over 8 MiB are rejected
  without freezing the editor.
- [ ] Run for at least two hours with repeated plots, Agent turns and Workspace
  restarts; record memory growth and SQLite size.

## Release Decision

`GO` requires every P0 item, an installer hash tied to the tested source commit,
and an explicit decision about unsigned distribution. P1 failures require a
documented workaround and owner; they do not automatically block an internal
preview but should block a general public release when they affect data safety.
