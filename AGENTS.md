# Working on the rebuilt Rho application

Read [Rebuild](docs/REBUILD.md), [Status](docs/STATUS.md) and the
[documentation index](docs/README.md) first. `main` is the selected new application
source line. The former controlled application is preserved on the published
`codex/legacy-app-before-rebuild` branch; the complete pre-clear snapshot is on
`codex/legacy-app-before-main-reset`. The new application is not implemented.
There is no current UI, SDK snapshot, composition lock or build entry.

## Ownership and development decisions

This repository owns application selection, assembly and presentation.
`../Rho-core` and `../Rho-plugins` are independent source owners. Read their
AGENTS.md before editing them. Core currently exposes managed execution and a
resident CLI; it has no new SDK or HTTP/MCP edge. Use demonstrated public
capabilities instead of restoring the former protocol or copying private source.
Plugins own scientific semantics, native conditions, artifacts and domain checks.
Reusable Agent evaluations belong in Rho-plugins; Core retains its own contract
regressions. Rho presents those owners' facts and does not create another
scientific execution path or a model loop in Core.

Start with a concrete user action and observable result. Try the existing public
capability and inspect its actual result; reuse valid evidence. Fix the smallest
demonstrated gap in its owner. Mature R tools, ordinary files and Git default to
reuse. New state models, transports, package frameworks and compatibility layers
need an observed consumer requirement. Historical subsystem maps, package counts,
old tests and data do not mandate reimplementation or migration.

Deliver one owner's selected boundary at a time. Other repositories may remain
incompatible. Cross-repository assembly is a separately selected task; do not
refresh consumer dependencies or invent a lock to close a single-owner change.
When assembly is implemented, record immutable source and artifact identities,
explicit local overrides and acceptance of the actual chosen combination.

Preserve original requests, caller/project visibility, native identity, partial
results, unknown outcomes and no-replay recovery. Query is bounded observation;
reading must not start or recover a runtime. An Agent's existing authorization
needs mechanical boundary checks, not another Rho approval. Models and retrieved
content cannot expand scope. Do not add a global scientific revision.

Resource limits must name the protected resource, configuration and exceeded-limit
behavior. Git history does not replace unsaved-buffer or concurrent-write checks.
Direct file edits do not require an Editor identity or another content history.

## Work and verification

Inspect Git status before editing and preserve unrelated work. Routine owner work
stays on `main`; use temporary worktrees only for independent tasks and clean up
ones you create. Keep the three source repositories and no root Cargo workspace.
Archive branches are references for specific questions, not implementation inputs.
Do not clean ignored artifacts, runtime state or user data as part of source removal.

Select a bounded flow and explicit completion conditions. Retain useful owner and
contract tests; retire checks that only enforce old directory layout or private
implementation shape. Run checks appropriate to the changed owner. Never run
Cargo builds/tests concurrently. Do not invoke deleted application commands or
claim an application build before an implementation exists.

Documentation changes need link/anchor checks and rendered-content inspection.
Render a coherent batch, inspect all changed pages, fix visible defects and recheck
affected pagination. Reuse unchanged observations and passing checks when valid.
Only executed checks are passes; retain failures, incomplete evidence and science
limits. A component check does not prove an application composition.

Inspect the diff, commit coherent authorized changes in the owning repository,
and check repository states before ending. [Status](docs/STATUS.md) is the single
current summary under 300 lines. Update it only when behavior, verification,
focus or unresolved work changes; Git keeps history. Do not add work ledgers or
current commit/PR/account details to this instruction file.

## UI and runtime continuity

Product-authored UI uses English and preserves Unicode user content. Substantial
layout or component redesign uses Paper and user review; reuse existing approval
within its scope. Read [UI principles](docs/RHO-DESIGN.md) before selected UI work.
Archive references do not select a replacement chat, Studio or all former panels.
Verify real behavior and representative widths after an actual UI is implemented.

Use disposable projects and owned Hosts for verification. Inspect existing work
before starting another Host on the same project. Do not restart a user Host or
R session without existing authorization. Preserve acknowledged content and
original task identity; missing acknowledgements are not saved data. Keep private
URLs, tokens and credentials out of Git, documents and shell search queries.
Skills and native tooling live with their real source owner. Validate resource
containment; links do not expand project scope.

## Source publication and future releases

Inspect the actual remote URL, branch and authenticated account before publishing;
`origin` may be a personal fork. Use `codex/` for new review branches. Publish
required components before an application reference and verify remote heads/trees.
Carry forward the user's existing authorization. Respect required PR and Code Owner
review; preserve selected commits with a merge commit, without force or bypass.
Source pushes, merges, binary publication and installation have separate evidence.

The future `Rho-releases` repository owns promotion of accepted compositions,
signing/notarization, official assets and installation/update channels. Create it
only for an explicitly selected official signed-distribution milestone. Build/test
jobs have no signing or publication credentials; the release stage verifies the
chosen candidate without rebuilding and records unsigned and signed digests.
Follow [Release](docs/RELEASE.md). Do not introduce release approvals into scientific
requests or publish as a build side effect.
