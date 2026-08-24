# Run Current Line Cursor Advance Repair

Status: active; ISSUE-15-EDITOR-1 implementation, automated contract
verification, browser/mock review, and post-verification contract review
complete 2026-08-10; RSR WP11 continuity implementation and automated/real-
Monaco verification complete 2026-08-22; installed exact-app selection
acceptance open; WP15 complete-expression amendment implemented and verified
2026-08-23; WP15-R1 empty/comment-gap navigation repair owner-authorized and
automated/browser verified 2026-08-23, with exact-app owner acceptance open

Date: 2026-08-10
Authorization: user requested implementation of GitHub Issue #15 and a pull
request on 2026-08-10
Change class: D1 narrow editor behavior correction
Risk: R1 local frontend interaction and document cursor state
Work package: ISSUE-15-EDITOR-1
Owning contract:
`implemented-2026-07-16-wp2-monaco-editor-source-execution-design.md`

## Problem And Reproduction

With a project R document open and no selection, invoking **Run current line**
dispatches the correct line but leaves the editor cursor on that line. Repeating
the command therefore runs the same line instead of continuing through the
file. The shared `runSelectionOrCurrentLine()` path dispatches execution but has
no post-admission cursor transition.

Regression invariant: admitting a non-empty current-line execution advances
the originating document cursor exactly once to the start of the following
line without changing the code or execution request. Selection execution and a
rejected empty-line request never advance the cursor.

## Contract

- The toolbar action and Ctrl/Cmd+Enter continue to share one execution path.
- When that path admits a `line` request, it immediately advances the current
  document cursor to the start of the following line and keeps editor focus.
- Monaco and the basic textarea editor use their own exact next-line offsets;
  CRLF and LF documents must not place the cursor inside an end-of-line token.
- Running the final line clamps the cursor to the document end.
- A non-empty selection executes literally and retains its selection/cursor.
- An empty current line keeps the existing rejection and does not move.
- Later R success or failure does not roll the admitted cursor transition back.
- Current-line execution must not move focus to the Console input after
  completion. As authorized by Issue #33 on 2026-08-11, file and selection
  execution now follow the same no-steal rule; only a Console-origin request
  may restore Console focus, and only if no newer user interaction occurred.
- Cursor persistence continues through the existing document/session lane.
- No broker command, execution payload, schema, project identity, approval,
  filesystem, or R-session authority changes.

## Cross-Review

- Implemented WP2 remains authoritative for selection/current-line/file
  execution, source provenance, and document-owned cursor persistence. This
  repair only supplies the missing current-line cursor transition.
- `active-2026-08-05-native-context-lint-problems-editor-shortcuts-spec.md`
  retains ownership of the Ctrl/Cmd+Enter binding; this repair changes the
  shared command result, not shortcut admission.
- `active-2026-08-04-five-usability-repairs-spec.md` retains ownership of focus
  when the Console tab is explicitly selected. This repair only prevents a
  completed source execution from stealing focus from the editor.
- The proposed intuitive-interaction document describes `Run current line` but
  does not authorize or own execution semantics. No proposed scope is
  implemented here.
- No ownership, schema, policy, persistence, or sequencing conflict remains.

## Acceptance And Verification

- A deterministic regression test exercises Monaco and basic-editor next-line
  offsets, including CRLF and final-line clamping.
- The test proves selection and empty-line paths do not move and current-line
  source runs do not take Console-input focus.
- Run the focused regression, adjacent editor-shortcut and Console-focus
  contracts, all affected frontend contract scripts, JavaScript syntax, and
  `git diff --check`.
- Browser/mock review covers the toolbar and Ctrl/Cmd+Enter paths in Monaco and
  basic-editor modes. Installed Windows acceptance remains a separate gate.

## Version, NEWS, And Stop Point

This PR does not create or distribute a new application candidate. Application
version and `NEWS.md` entry are deferred to the next explicitly authorized
integration candidate; distribution of this behavior before that synchronized
step is not permitted. R package versions, schema, and release tooling are
unchanged.

Stop after this one repair, regression evidence, contract review, scoped
commit, and pull request. Do not expand into smart statement/block execution or
other editor navigation behavior.

## Implementation And Review Evidence

`currentLineExecution()` now records the exact next cursor offset from the
active editor model. `runSelectionOrCurrentLine()` admits execution first, then
applies that offset through the existing document-owned selection and session
persistence lane. The execution completion path excludes only `line` requests
from its legacy Console-input focus restoration; selection, file, Console, and
other execution focus behavior is unchanged.

The focused regression passed for Monaco and textarea LF/CRLF offsets,
end-of-file clamping, empty-line rejection, selection/foreign-document
non-movement, persisted cursor state, and focus. JavaScript syntax, editor
shortcut, Console-focus, desktop-platform, and diff checks passed. The complete
frontend UI glob was attempted: 40 scripts passed; the two unrelated Data
Viewer scripts remain failing on this case-sensitive Linux checkout because
their upstream `main` source reads `R/rho.bridge/R/workspace.R` while
the checked-in directory is `r/rho.bridge/R/workspace.R`. Those failures were
present before and are not reported as passing or changed in this work package.

Browser/mock review passed in both editor modes. Monaco toolbar execution moved
line 1 column 2 to line 2 column 1, and the command registered to Ctrl+Enter
moved line 2 to the trailing line 3 column 1. The basic editor toolbar moved
offset 1 to 19, and Ctrl+Enter moved offset 19 to the document-end offset 31.
Both modes retained editor focus, left Console unfocused, and recorded the exact
executed ranges.

Post-verification review found no contract deviation, backend payload change,
schema/policy/project authority change, new dependency, or unrelated source
edit. The active lifecycle is retained because installed Windows acceptance is
not run. No roadmap milestone or release decision changes.

## Issue #33 Coordination Amendment

`active-2026-08-11-workbench-focus-stability-repair-spec.md` supersedes the
legacy non-line completion-focus allowance from this repair. Current-line
cursor advancement and immediate editor focus remain owned here. File,
selection, and line completion may not transfer focus to Console; explicit
Console-tab selection and interaction-revision-guarded Console-origin
restoration remain valid. The original Issue #15 evidence remains historical
for its exact implementation baseline and does not prove the amended rule.

## Surface Runtime Continuity Amendment (authorized 2026-08-22)

The RSR cutover retained Monaco, shared Resource drafts, Console Surfaces, and
Runtime execution but omitted the WP2 Run action and shortcut from the new
`SourceEditor` adapter. The owner explicitly requested restoration after
observing the current Source/Console composition. WP11 of
`active-2026-08-22-studio-design-language-and-ux-overhaul-design.md` owns the
bounded RSR integration and multi-Console target rule; this document continues
to own the invariant that an admitted current-line request advances exactly
once, persists the new cursor, retains editor focus, and is not rolled back by
later Runtime failure. Selection and empty-line behavior remain unchanged.

The continuity implementation must reuse the exact chosen Console's existing
Runtime execution lane and instance-local output. It adds no smart statement
expansion, backend payload, schema, or execution authority. The 2026-08-10
evidence remains historical and does not by itself prove the RSR adapter;
WP11's new focused and complete affected verification is recorded below.

WP11 has now restored the shared action in the RSR adapter. Six pure range
tests, eight App regressions, the 105-test complete frontend gate, and real
Monaco toolbar/current-line/advance/empty-line/focus review pass. The selected
Console retains exact Runtime/Surface origin and its independent draft/output;
rejection and later failure do not falsely move or roll back the cursor. Real
browser automation could not deterministically produce a Monaco-native mouse
selection, so the original literal-selection contract remains covered by pure
and App-level regression evidence while owner exact-app selection feel
acceptance stays open.

## WP15 Complete R Expression Amendment (authorized 2026-08-23)

The owner's demonstrated multi-line R call supersedes this document's
physical-line-only and no-statement-expansion restrictions. With no selection,
the shared toolbar/Command+Enter path now resolves the smallest lexically
complete top-level R expression containing the cursor line. This is a bounded
frontend lexical operation, not a semantic R parser, chunk runner or whole-file
fallback. A literal selection remains unchanged.

An admitted expression advances once to the first physical line after that
expression, persists the cursor and retains Source focus. Incomplete or
unbalanced expressions reject before Runtime admission and do not advance;
later Runtime semantic failure still does not roll back an admitted advance.
WP15 in the active Studio design contract owns expression boundaries and
optional Source provenance. This document continues to own cursor, selection,
focus and shortcut-parity invariants. All historical evidence above remains
accurate for the superseded physical-line baseline rather than evidence for the
new resolver.

WP15 verification passed the 152-test complete frontend gate, including a
Command+Enter regression from inside the demonstrated nested `do.call`/
`lapply`/`function` expression, plus seven Runtime contract tests, two desktop
range tests, Rust check/format, browser smoke and rebuilt debug-app review.
Literal selection, one post-admission cursor transition and Source focus remain
unchanged. Owner shortcut feel acceptance in the exact app remains open.

WP15-R1 amends the cursor transition target only: after a complete expression,
the cursor lands on the next executable expression rather than an intervening
blank/comment-only line. Invoking the shortcut on such an intervening gap is a
navigation-only action with no execution or error; a terminal gap is a quiet
no-op. This does not change literal selection, complete-expression scope,
post-admission ownership, editor focus, Runtime admission, or failure history.

WP15-R1 verification passed LF/CRLF and continued-expression gap tests,
toolbar/Command+Enter navigation, delayed Console-persistence sequencing,
raw-string Runtime rejection projection and live History reload. The focused
gate passed 108 tests and the complete frontend gate passed 158 tests with
typecheck, lint, build/asset/cutover checks and browser smoke. Seven Runtime
contract tests, two desktop range tests, Rust format/check and diff validation
passed. The raw debug binary was rebuilt and launched without closing older
windows; exact-app owner interaction acceptance remains open.
