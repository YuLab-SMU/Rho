# Developing Rho

Read [current focus](STATUS.md) and the relevant [architecture](ARCHITECTURE.md).
For Studio interaction work, also read [design principles](RHO-DESIGN.md) and
[user feedback](STUDIO-FEEDBACK.md). A proposed design is not implemented behavior.

## Working loop

1. Inspect `git status`, the relevant code and existing tests; preserve unrelated work.
2. Run `node scripts/governance.mjs impact --changed-auto` for mapped areas and checks.
3. Make a coherent change and iterate with the closest meaningful check.
4. Once behavior settles, run affected checks, inspect the diff and record actual
   results. Compare a failing test with the pre-change baseline before attributing it.
5. Update current documentation where it explains behavior or constraints. Keep
   detailed task plans with the issue/branch and run artifacts with the run.

Cargo commands share `target/`. Run only one Cargo build/test/check process at a
time, including client type generation, which invokes Cargo. Wait for background
commands to complete instead of polling them with sleep loops.

## Testing SOP

Generic project read coverage is separate from scientific reference interpretation.
`cargo test -p rho-sqlite --lib project_coverage --locked` and
`cargo test -p rho-operation -p rho-plugins --lib project_coverage --locked` check
principal/project boundaries, recorded lifecycle states and observation without
mutation or recovery. A journal without coverage support remains unavailable;
an empty visible page cannot stand in for that missing evidence.
`cargo test -p rho-host --test plugin_optional_requirements project_coverage --locked`
checks explicit grants and delegated visibility; the existing
`official_host_ports_bind_revisions_visibility_commit_and_release_without_r`
case in `--test plugins` checks direct Host access. Public protocol generation and
the independent TypeScript consumer include the coverage DTO and empty-input schema.
These checks establish metadata visibility, not Environment cleanup safety.

Source development uses `cargo test -p rho-plugins --test source_development --locked`
for binary/paged reads, full-file corruption detection, source-only history,
concurrent head conflicts and transactional rollback. The shared-port fixture is
`cargo test -p rho-host --test plugin_development --locked`; it covers pure checks,
explicit scopes, original Operation replay and an ordinary view's declared calls.
Run the existing package repository suite after changes to shared archive storage.
Public DTO changes also require client generation and
`node scripts/test-plugin-protocol.mjs`. These tests do not establish the Studio
editor, build/preview, scene application or real-R continuity.

Scenario application uses `cargo test -p rho-host --test plugin_scenarios --locked`.
The fixtures construct ordinary packages outside the checkout and exercise scoped
checkpoint/application ports, exact dependency/grant validation, delegated view
calls, transaction rollback, concurrent window conflicts, native work across
version switching and unavailable-default refusal. `--test plugins` covers the
shared view/lifecycle ports and `--test port_contracts` their public discovery.
These tests do not establish the management UI, iframe continuity in a browser or
real-R scenario acceptance. View resource context is qualified against bounded
retained metadata; the separate byte ports remain responsible for byte integrity.

Environment contracts, native execution and R helpers live in
`plugins/environment/api` and `plugins/environment/backend/owner`. The retiring
`rho-r-environment` adapter delegates to this owner. Iterate with
`cargo test -p rho-environment-api -p rho-environment-owner --lib --locked`.
`node scripts/test-environment-plugin-owner.mjs` copies six public/plugin crates
outside the checkout and runs the focused storage/observation tests without R.
`node scripts/test-environment.mjs` exercises the real R Host bridge, including
isolated pak/renv realization, cancellation, retention, recovery and restart
binding. It requires the already installed R, Ark and package prerequisites and
does not install tools. The ordinary backend is `plugins/environment/backend`. Iterate with
`cargo test -p rho-environment-backend --lib --locked`; generate public declarations
and contributed schemas with `node plugins/environment/generate-sdk.mjs` and
`node plugins/environment/generate-manifest.mjs` (both support `--check`).
`node scripts/test-environment-plugin-types.mjs` checks an independent TypeScript
consumer. `node scripts/build-environment-plugin.mjs /absolute/new/package`
assembles nine public/plugin Rust crates outside the checkout and builds offline
with locked dependencies. The shipped `python3 tests/protocol.py
/absolute/package/dist/rho-environment-backend` exercises the actual executable
without R. With an already built Host and the installed R prerequisites,
`RHO_ENVIRONMENT_PLUGIN_PACKAGE=/absolute/package node scripts/test-environment-plugin.mjs`
checks ordinary activation, original source/report authority, native pak/renv,
verification, installer cancellation, previous-instance resource reads, explicit
reference grants and material quarantine/restore/purge through that unchanged Host.
It retains failed evidence and only cleans test-owned native markers. Add
`--r-references` and set `RHO_R_PLUGIN_PACKAGE=/absolute/r-package` and
`RHO_ARK=/absolute/ark` for exact-session live-library and namespace retention,
including namespace use after removal from `.libPaths()` and eventual release.
Use `--checkpoint-references` with those variables and
`RHO_CHECKPOINT_HELPER=/absolute/verified/rho_checkpoint.so` to add recovery capture,
protection after namespace unloading and session release, an unstarted replacement
reader, ambiguous-reader refusal, explicit reader configuration and
pin/unpin, uncertain deletion and resolution retry, explicit completion and purge
before Environment material cleanup. Unpublished capture checks add a real namespace
dependency, protection after provider release, an uncertain disposal with missing
bytes, and explicit confirmation before cleanup. All original failed/uncertain
records remain unchanged; observation and disposal providers remain unstarted.
The native absence check can be unavailable when the OS hides a contemporaneous
process's environment or lifetime. Keep this acceptance run separate from
additional shell commands; preserve such a refusal as unavailable evidence and
do not weaken the native check to turn it into a pass.
The Host must include the public project-coverage capabilities; the script never
rebuilds or replaces it. Backend unit checks include bounded reference scans,
unavailable visibility, unknown recovery, changed observations, original scope,
absent-path references and uncertainty. The shipped wire check includes material
query purity and unsupported cancellation before EOF. Ordinary checkpoint references
are read through the public R owner; uncertain original captures/controls retain
material. `environment.library@2` is a pure original-realization observation;
`r.create_session@2` explicitly delegates native verification before starting R.
`RHO_ENVIRONMENT_PLUGIN_PACKAGE=/absolute/environment-package
RHO_R_PLUGIN_PACKAGE=/absolute/r-package RHO_ARK=/absolute/ark
RHO_R_HOME=/absolute/R node scripts/test-r-environment.mjs` exercises their
independently built packages through the existing unchanged Host. It checks grants,
preflight purity, library tampering, delegated verification, namespace failure,
two R revisions, replacement Environment instances, original records and retained
reports. All sessions and libraries belong to disposable fixtures. It also runs
the shipped R `tests/environment_protocol.py` against that executable for bounded
and reversed Host replies, lost verification acknowledgement and pending-call EOF.
That wire check can run directly with `python3 tests/environment_protocol.py
/absolute/r-package/dist/rho-r-backend`; its fake R/Ark must never be launched.
`cargo test -p rho-environment visibility --locked` verifies scoped realization,
retention and cleanup reads through the actual query gateway, including delegated
principals and denial before native observation.

SSH/Slurm contracts and native execution live in `plugins/remote/api` and
`plugins/remote/backend/owner`. Iterate with `cargo test -p rho-remote-api -p
rho-remote-owner --lib --locked`. `node scripts/test-remote-plugin-owner.mjs`
assembles only five public/plugin crates outside the checkout, runs the focused
checks and exercises fake SSH/Slurm transcripts. `node scripts/test-remote-protocol.mjs`
checks the retiring Host bridge, including authoritative idempotency, reconciliation
and query purity. Both use temporary local executables and never contact a real
cluster. They do not establish remote-host acceptance. The native owner has no
journal or automatic replay.
`cargo test -p rho-execution slurm --locked` verifies that the retiring query
gateway checks the original principal and read scope before contacting a scheduler.

The ordinary Remote RPC backend is `plugins/remote/backend`. Iterate with
`cargo test -p rho-remote-backend --lib --locked`. Generate its public declarations
and manifest with `node plugins/remote/generate-sdk.mjs` and
`node plugins/remote/generate-manifest.mjs` (both support `--check`).
`node scripts/test-remote-plugin-types.mjs` compiles an independent public consumer.
`node scripts/build-remote-plugin.mjs /absolute/new/package` assembles seven
public/plugin crates and builds with the locked offline dependency closure.
Run `node /absolute/package/tests/protocol.mjs /absolute/package/dist/rho-remote-backend`
for resource loss, source correlation, cancellation observations, settlement and
EOF fault checks. After building the current Host explicitly,
`RHO_REMOTE_PLUGIN_PACKAGE=/absolute/package node scripts/test-remote-plugin.mjs`
checks ordinary installation, configured invocation, retained output resources,
lost submission receipt, native observations and original-source recovery through
a replacement instance. It verifies unchanged Host bytes, uses disposable local
SSH/Slurm substitutes and never contacts a real cluster. Omit the package variable
to assemble a new standalone package first. Default activation stays disconnected;
preparing and observing local status never start SSH.

Local process launch and native recovery live in `plugins/process/backend/owner`.
Use `cargo test -p rho-process-owner --lib --locked` while
iterating, and `node scripts/test-process-plugin-owner.mjs` to assemble the public
protocol/API/engine/owner sources independently and run their native tests.
The retiring Host bridge is covered by `cargo test -p rho-host --test process
--locked`. `node scripts/test-process-recovery.mjs` builds the current binary and
checks actual Host interruption, original-operation recovery and unrelated-process
preservation in a disposable project. It never operates on a user Host.

The ordinary Process RPC backend is `plugins/process/backend`. Iterate with
`cargo test -p rho-process-backend --lib --locked`; generate its public declarations
and manifest with `node plugins/process/generate-sdk.mjs` and
`node plugins/process/generate-manifest.mjs` (both support `--check`).
`node scripts/test-process-protocol.mjs` compiles an independent public TypeScript
consumer. `node scripts/build-process-plugin.mjs /absolute/new/package` assembles
six public/plugin Rust crates outside the checkout, with locked offline builds.
After building the current Host explicitly, `node scripts/test-process-plugin.mjs`
builds the external package and verifies unchanged Host bytes while exercising
actual process execution, resource evidence, project targeting, original-request
idempotency, cancellation, settlement and replay after release. Set
`RHO_PROCESS_PLUGIN_PACKAGE` to reuse an independently built package. The included
`tests/protocol.py` additionally checks executable RPC failures and settlement
fencing, bounded/reordered original-operation reads and EOF cleanup of queued
recovery. The Host case also exercises tagged-process reconciliation, retained
original outcomes and source/recovery idempotency. Backend unit checks include
fresh native cleanup with unrelated work preserved. The Host case then kills only
its freshly observed disposable backend, verifies original uncertainty, and uses
a replacement instance to reconcile surviving work without changing or replaying
the source. These cases use disposable
projects and no R runtime; they do not establish SSH/Slurm behavior.

Editor context is an ordinary native backend in the Editor package. Use
`cargo test -p rho-editor-backend --lib --locked` for its bounded search, exact
source/version/digest checks, multi-page content verification and Unicode selection
behavior. Regenerate its contributed manifest with `node scripts/generate-editor-context.mjs`;
use `--check` to verify committed schemas. After independent assembly,
`python3 /absolute/package/tests/protocol.py /absolute/package/dist/rho-editor-backend`
checks executable RPC concurrency, correlation, errors and release. The public context DTOs are included in protocol generation and the
independent strict TypeScript consumer. The native `editor-plugin.spec.ts` path
also reads actual synchronized Editor captures through the context contribution;
assemble Editor with the native artifact target before that case. The three
Editor/Files browser fixtures now use that combined package target.

`cargo test -p rho-host --test plugin_view_delegation --test plugin_drafts
--test port_contracts --locked` checks Host-owned view restrictions through an
independent public-RPC backend, including nested delegation, preflight, controls,
close-time encoding scope and accepted work after closure. The fixture waits for
native settlement before releasing the instance; a terminal journal record alone
does not prove that backend settlement has finished.

The ordinary Console package has an independent build/model check,
`node scripts/test-console-plugin.mjs`. Its isolated editing case is
`npm run test:browser --prefix ui -- console-editor.spec.ts`; this case supplies
only a public MessagePort fixture and establishes no native R behavior. Build the
current client and Host before the browser checks. The real R package path is
`RHO_ARK=/absolute/existing/ark RHO_R_HOME=/absolute/existing/R/home node
scripts/test-r-console.mjs`. It builds the native and Console packages outside the
checkout, exercises the current Host, and checks that those package builds did not
change the Host binary. Synthetic composition events cover submission guards;
they do not establish native input-method acceptance.

The ordinary Objects package is assembled outside the checkout with
`node scripts/build-objects-plugin.mjs /absolute/new/directory`; model, action
capture and component checks run with `node scripts/test-objects-plugin.mjs`.
After building the current client and Host, use
`npm run test:browser --prefix ui -- objects-plugin.spec.ts` for its opaque-frame
presentation and explicit-action fixture. This fixture uses public SDK messages;
it does not establish native R behavior or production window lifecycle integration.
The native path uses explicit existing Ark/R and ggplot2 in a disposable project:
`RHO_ARK=/absolute/existing/ark RHO_R_HOME=/absolute/existing/R/home node
scripts/test-r-objects-plugin.mjs`. The wrapper builds both packages outside the
checkout and verifies an unchanged Host binary; set `RHO_R_PLUGIN_PACKAGE` to
reuse an existing native package while assembling current Objects sources.
To reuse both already built packages,
set `RHO_R_PLUGIN_PACKAGE` and `RHO_OBJECTS_PLUGIN_PACKAGE` alongside Ark/R, then
run `npm run test:browser --prefix ui -- r-plugin-objects.spec.ts`. It covers native
objects, automatic same-window inspection, preserved directory documents,
responsive table presentation, actual pointer receipt inspection, explicit plot
Operations and close-time state capture. The case uses the generic composition
entrypoint; default scenario delivery remains a separate acceptance.

Use the smallest test tier that proves the current change. A small change must not
rerun the entire workspace by default; expand the scope only when the dependency or
owner boundary requires it.

Files/Git native sources now live in `plugins/files/backend/engine`; their public
data and provider contracts live in `plugins/files/api`. Shared bounded subprocess
supervision lives in `plugins/process/backend/engine` with public process reports
in `plugins/process/api`. Search and patch interpretation live in
`plugins/files/backend/owner`; the retiring adapters and project handlers reuse
these implementations. Iterate with
`cargo test -p rho-files-engine -p rho-files-owner -p rho-process-engine --lib --tests --locked`.
For the source boundary, `node scripts/test-files-plugin-engine.mjs` materializes
those five libraries and the public plugin protocol outside the checkout, and
runs their native tests with the installed toolchain. It is not a backend activation or packaging test.
Generate public Files declarations with `node plugins/files/generate-sdk.mjs`,
then run `node scripts/test-files-protocol.mjs`. Contract moves also require the
normal client generation check, even when wire shapes remain unchanged.
The Host boundary check is
`cargo test -p rho-host --test project --test ownership --test plugin_workspace_paths --locked`.
It covers the original file operations and public protected-path metadata,
including an external backend's explicitly granted reverse query.

The ordinary native Files package is assembled with
`node scripts/build-files-plugin.mjs /absolute/new/directory`. Iterate on its owner
with `cargo test -p rho-files-backend --lib --locked`; check its generated capability
manifest with `node plugins/files/generate-manifest.mjs --check`.
`node scripts/test-files-plugin.mjs` first compiles its Host acceptance target, then
builds Files outside the checkout from eight public/plugin packages using locked
offline dependencies. It verifies unchanged Host target bytes, runs executable
wire/fault cases, and explicitly runs the otherwise ignored native acceptance.
That case uses a disposable Git project, two exact revisions, real protected Host
paths and an injected journal commit failure. It does not require R or restart a
user Host. This is backend acceptance; it does not establish Files/Editor UI or
default scenario delivery. Set `RHO_FILES_PLUGIN_PACKAGE` to reuse an independently
built package while recompiling and testing a changed Host.

The combined Files UI has an independent model/connection/action check:
`node scripts/test-files-ui.mjs`. After building the current client and Host,
`RHO_FILES_PLUGIN_PACKAGE=/absolute/built/package npm run test:browser --prefix ui -- files-plugin.spec.ts`
uses the real Files backend, ordinary Editor and generic window in a disposable
project. `RHO_EDITOR_PLUGIN_PACKAGE` can also select an already assembled Editor;
omitting either variable assembles its fresh package first. It covers directories/search,
responsive input, close capture, reopening, external changes and exact Editor
navigation, native editing/saving and new unsaved documents. A file changed after
the Files capture is refused until an explicit refresh; saving then remains usable.
`cargo test -p rho-host --test plugin_self_requirements --locked` verifies that
combined packages can declare exact self-capability grants before first activation
without early publication, scope escalation or undeclared access.

`node scripts/test-editor-plugin.mjs` compiles the Editor owner outside the checkout
using only its locked dependencies, public plugin/UI SDK and Files/R declarations.
It checks resident text/undo, bounded exact file reads, queued captured drafts,
original-request recovery, receipt identity and failure/uncertain retention, plus
the native save controller's durable intent, later edits, non-blocking close and
conflict/explicit replacement behavior. Assemble the ordinary UI package with
`node scripts/build-editor-plugin.mjs /absolute/new/directory`.
Code-action checks cover explicitly observed existing sessions, capture before
asynchronous observation, selection/line/document requests, byte limits, original
admission and close/reopen recovery. Formatting checks verify complete retained
reports, exact request/session/source identities, unchanged-document application,
resident undo, later edits and version-fenced explicit comparison choices.
Saved-run checks verify the frozen file/R capture, original save completion before
R admission, unchanged-file observations, lost acknowledgements, failure and
uncertainty, later typing, close during both admission preparations and explicit
continuation only from the original view. Reopening and inspection do not start R.
Session-selection checks cover bounded project/principal-scoped capability
discovery, unstarted and unavailable providers, retained target selection and
original operations that remain attached to their captured provider after a switch.
Editor preference checks preserve document state and native file identities while
synchronizing bounded font/indent choices; the native file browser case checks
their actual rendering, indentation, undo and restoration after closing the view.
After building the current client and Host,
`npm run test:browser --prefix ui -- editor-plugin.spec.ts` uses independently built
Files and Editor packages in a disposable project; set `RHO_FILES_PLUGIN_PACKAGE`
and `RHO_EDITOR_PLUGIN_PACKAGE` to reuse exact built packages. It checks native file
saves, held admission during close, original-result restoration, Unicode Save As,
larger-than-view-state drafts, explicit disk comparison/replacement and responsive
CodeMirror presentation. Comparisons preserve local edits, recheck the captured
digest before choosing a base and do not write files; replacement retains undo.
This does
not establish R execution, native input-method behavior or default composition.

`npm run test:browser --prefix ui -- editor-code.spec.ts` exercises ordinary Editor,
R, Console and Files packages in a disposable native project. Supply existing
`RHO_ARK` and `RHO_R_HOME`; `RHO_R_PLUGIN_PACKAGE`, `RHO_FILES_PLUGIN_PACKAGE`,
`RHO_EDITOR_PLUGIN_PACKAGE` and `RHO_CONSOLE_PLUGIN_PACKAGE` can reuse exact built
packages. Build the current client and Host first. This case selects Editor's
optional R grants explicitly and starts R through Console. It checks formatting
without input evaluation, explicit file save, captured document execution and
Console output, delayed admission during closure, a restored original formatting
comparison, undo and responsive presentation. It does not install R packages,
restart user sessions or establish native input-method acceptance.

The generic draft storage and public content contracts are checked with
`cargo test -p rho-plugins -p rho-plugin-protocol --lib draft --locked`. These
checks cover storage, bounded draft enumeration, captured/accepted chunk leases, version fences and source
references. `cargo test -p rho-host --test plugin_drafts --locked` exercises the
shared Host draft ports: scoped bounded listing/reads/staging, compare-and-swap saves,
discard fences, exact view grants, original replay, failed journal writes,
cleanup failure and original commit recovery after restart and successor edits.
Listing checks cover exclusive pagination after discard, exact source filters,
current metadata after edits, window and caller fences, and no implicit publication
or lease collection. A list is not a snapshot across pages or a claim about edits
that have not reached synchronized storage.
`node scripts/test-plugin-ui.mjs` builds the public UI SDK outside the checkout and
checks frozen captures, verified staging/read transfers, malformed content,
acknowledgement identity, interruptions and view cooperation. The Host draft target
also covers a draining instance's open view flushing large content through original
grants, refusal of another encoding, all-renderer preparation and the final write
fence. The SDK check verifies that preparation waits for the original save and
its synchronized reference state. After building the current client and Host,
`npm run test:browser --prefix ui -- plugin-drafts.spec.ts` uses an independent
ordinary view to flush more than 512 KiB while draining, hold the original receipt
before closing, and restore exact Unicode bytes in another view. It seeds bulk
fixture text after checking small normal input; it is not Editor input-performance
or native IME acceptance. `plugin-workspace.spec.ts` retains the general close,
lost-acknowledgement and saved-state recovery regression.
After contract changes, regenerate with `npm run generate --prefix ui` and run
`node scripts/test-plugin-protocol.mjs` for an independent TypeScript consumer.

When one cross-boundary check needs several packages, prefer one Cargo invocation
with multiple `-p` selections and the required target selectors when possible.
Cargo [unifies their dependency features](https://doc.rust-lang.org/cargo/reference/resolver.html#feature-unification),
which can avoid rebuilding the same shared dependency with different feature sets
in consecutive commands. Keep the intended test set and the serial Cargo rule;
this is not a reason to expand a focused check into a workspace audit.

### Test tiers

- **L0 — focused iteration.** Run the nearest test or filter while editing:
  `cargo test -p <crate> <filter> --locked` or
  `npm run test --prefix ui -- <test-file>`. Use this for a local function, model,
  or component change.
- **L1 — affected module.** After behavior settles, run the complete affected crate
  or frontend suite, plus `typecheck` for client changes. Typical commands are
  `cargo test -p rho-r-engine --lib --locked`, `cargo test -p rho-host --lib --locked`,
  `npm run test --prefix ui`, `npm run typecheck --prefix ui`,
  `npm run build --prefix ui`, and `npm run check --prefix ui`.
- **L2 — cross-boundary acceptance.** Use this for Host/Operation/Runtime,
  Contract, recovery, output, Viewer, Plot, Console or document execution changes.
  Run the affected Rust and UI suites, a disposable real-R check, and the relevant
  isolated browser case. Build the current binary before browser tests.
- **L3 — merge/release gate.** Run the complete serial Rust workspace suite and
  all required product checks only for merge, release, or an explicitly requested
  full regression.

### Common L2 commands

Scenario metadata changes use `cargo test -p rho-plugins --test package_repository
--locked`, `cargo test -p rho-plugin-protocol --test contract --locked` and
`cargo test -p rho-host --test plugin_scenarios --locked` serially. They cover
immutable history, concurrent head changes, protecting references, visibility and
ordinary external-plugin calls. They do not establish live window switching,
scenario readiness or Plugin Studio interaction acceptance.

HTML widget, Viewer and Plot changes should cover both native and browser paths:

```sh
Rscript --vanilla scripts/test-r-tools.R
RHO_ARK="$PWD/target/debug/ark" \
RHO_R_HOME=/Library/Frameworks/R.framework/Resources \
cargo test -p rho-host --test html_widgets_real_r --locked -- --ignored --nocapture
npm run test --prefix ui -- viewer.test.ts
npm run test:browser --prefix ui -- e2e/widget.spec.ts
```

Runtime/recovery changes should cover the focused Host tests and the R-free process
recovery check:

```sh
cargo test -p rho-operation -p rho-sqlite --lib --locked
cargo test -p rho-host --test port_contracts --test observer --test recovery --locked
cargo test -p rho-plugins --test backend_runtime --locked
cargo test -p rho-plugins --lib --test resources --locked
cargo test -p rho-host -p rho-mcp --test plugins --locked
cargo test -p rho-host --lib --locked
node scripts/test-process-recovery.mjs
```

Real R acceptance uses disposable projects and explicit bindings. The independently
packaged R backend path is checked with explicit existing
`RHO_ARK` and `RHO_R_HOME` using `node scripts/test-r-plugin.mjs`. Native queue changes
also use `cargo test -p rho-r-backend queue::tests --locked`. Session routing changes
use `cargo test -p rho-cli --test session --locked`, including an external plugin
that fills execution/query capacity while transient controls remain responsive.
The real-R acceptance injects an original journal commit fault, verifies FIFO
recovery, failed/pending-cancel pauses and resuming accepted work during draining. It assembles
public SDKs plus R sources outside the checkout and tests original Operations,
coexisting revisions, cancellation, native stdin and retained resources through
the Host. The input case waits for an actual native prompt, rejects stale identity,
oversized UTF-8 and duplicate answers, then completes the original execution while
its instance drains. The generic Host plugin test separately proves that transient
controls create no journal/result/event entries or direct resource uploads.

The complete native matrix is:

```sh
node scripts/test-real-r.mjs
```

For the ordinary R recovery archive, iterate with `cargo test -p rho-r-engine
--lib recovery:: --locked`, then run the engine library cases after changes settle.
`node scripts/test-real-r.mjs --plugin-recovery` selects the focused native
capture/restore/adoption check. Supply existing `RHO_ARK`, `RHO_R_HOME` and
`RHO_CHECKPOINT_HELPER` paths; the helper's adjacent manifest and bytes are verified
before launching R. This mode does not install or build a helper. It creates and
stops disposable sessions and tests exact sessions, pre-start cancellation,
Unicode graph aliases, bounded payload reads, nonempty-candidate refusal and
retained native evidence. `node scripts/test-r-plugin-engine.mjs --recovery`
checks the same native layer from an independent public/plugin source tree.
Archive checks include separate-process lock contention and process exit without
a destructor. For ordinary RPC publication and original-operation authorization,
run `cargo test -p rho-r-backend --locked --offline`, generate the R SDK, and build
an independent package with `scripts/build-r-plugin.mjs`. With that package selected
as `RHO_R_PLUGIN_PACKAGE`, run `node scripts/test-r-recovery.mjs` using the same
three native prerequisites and an already built Host. The test verifies unchanged
Host bytes, optional read grants, pure observations, partial Unicode graph capture,
replacement-provider reads, bounded bytes, payload damage, empty-candidate restore,
pin/delete preconditions, explicit application/discard of uncertain controls,
an uncertain resolution retry, unchanged original outcomes, post-commit cleanup,
retained metadata and explicit reconciliation of a capture whose public output
was rejected by the core. Capture-disposal cases cover confirmed original-provider
release, stale previews, partial graph/metadata files, lost commit after removal,
fresh explicit confirmation, intact adopted copies and original outcomes. Set `RHO_OLD_R_PLUGIN_PACKAGE` to an existing prior
version-1 recovery package to also verify it refuses version-2 control history.
The test-owned fault proxy preserves registered contracts and native evidence;
it changes only returned plans. The test uses
disposable projects and native sessions and preserves failed evidence. It does not
establish Studio recovery UI.

Skipped or unavailable real-R, browser, external-provider, and environment checks
are not passes. Run them only with their documented prerequisites; preserve the
failure log when the prerequisite is missing.

The ordinary Help package uses `node scripts/test-help-plugin.mjs` for independent
model/connection/static-content checks and the isolated `help-plugin.spec.ts` browser
case. `node scripts/test-r-help.mjs` builds the packages and runs its disposable
native browser case with explicit `RHO_ARK` and `RHO_R_HOME`. An explicitly selected
existing `RHO_R_PLUGIN_PACKAGE` reuses that native artifact when R sources have not
changed; this establishes no new native build. Pass a distinct `--output` directory
to retain each browser run. Help viewing must preserve namespace/search/library
state and must not create scientific execution records.

The ordinary Packages package uses `node scripts/test-packages-plugin.mjs` for
independent source compilation and model/connection/navigation checks, and
`packages-plugin.spec.ts` for the approved responsive inspection, explicit source
links and capture-before-Help flow. `node scripts/test-r-packages.mjs` assembles
Packages and Help and runs the disposable native cross-package path. It has the
same explicit Ark/R prerequisites and optional unchanged R-package reuse as Help.
Its navigation receipt must identify the original selected copy, provider and
session. Closing either view must preserve the native R session.

The independent Plots package is built and checked with
`node scripts/test-plots-plugin.mjs`; `plots-plugin.spec.ts` covers its isolated
presentation. `node scripts/test-r-plots.mjs` builds the UI outside the repository
and runs the native PNG acceptance with explicit existing `RHO_ARK` and
`RHO_R_HOME`. Set `RHO_R_PLUGIN_PACKAGE` to reuse a previously verified native
package without invoking Cargo. Native Packages and Plots checks use the generic
window, including newly opened Help and pinned comparison tabs. A written fixture
is not a passing result; current executed evidence is in Status.

### Optional workspace audit

The complete workspace audit is intentionally not part of every development
completion. Run these commands serially for a release, a periodic audit, or when
the user explicitly requests the full workspace result:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
cargo build --locked
```

The workspace command uses incremental compilation, but it still executes every
workspace test target. `--test-threads=1` makes tests serial within each target;
it does not restrict the run to crates changed by the last edit. A time-budget
limit or an incomplete audit therefore does not block normal completion when the
affected-module and cross-boundary checks have passed.

### Timeouts and reporting

A test process that reaches its time budget is **incomplete**, not passed. Record the
last completed target and retain its log. Do not turn an ignored, skipped,
unavailable, or timed-out check into a pass by rerunning a narrower command; report
the two results separately. Compare a failure with a pre-change baseline before
attributing it to the current edit.

A completion report should list:

```text
Implementation: affected owners and user-visible behavior
Focused checks: exact commands and results
Cross-boundary checks: exact commands and prerequisites
Workspace audit: passed, incomplete, or not run
Unresolved: failures, ignored checks, timeouts and their evidence
Workspace: unrelated changes preserved; commit status
```

## Frontend iteration

The client uses React, FlexLayout and CodeMirror with Rust-generated contracts.
Edit `ui/src/`; treat `crates/workbench/assets/` as generated output.

```sh
npm ci --ignore-scripts --prefix ui
npm run generate --prefix ui
npm run build --prefix ui
npm run check --prefix ui
```

For iteration without ending the R session, run `npm run dev --prefix ui`. This
writes watched assets to `target/studio-assets`. Start the workbench with
`--dev-assets /absolute/path/to/target/studio-assets` after the `workbench`
subcommand. Reload the browser after a rebuild. Production uses embedded assets.

Panels consume module-specific hooks and commands; HostClient owns transport behind
narrow ports. Domain snapshots are read-only. Document and undo state survive panel
lifecycle changes. Layout changes must not execute code. Keep visual feedback tied
to actual owner state. Studio only composes and manages the client lifecycle.

## Object viewer acceptance fixtures

The object viewer uses `react-data-grid` with React 19. Real native-storage checks
in `scripts/test-r-objects.R` require Matrix and SingleCellExperiment in addition
to the existing jsonlite/rlang bridge providers; tests never install them. Use
`node scripts/test-real-r.mjs` for the complete native suite. The Studio browser
scenario exercises a real 501-row table, Unicode text, array slices and SCE assay
storage. Check ordinary/wide/constrained layouts and copying, not only snapshots.

## Checks

| Change or verification need | Closest entry point |
| --- | --- |
| Rust behavior | `cargo test -p <crate> <filter> --locked` |
| Shared capability contracts and result validation | `cargo test -p rho-contract --locked`, then `cargo test -p rho-operation --locked` |
| Application windows, captures and CAS receipts | `cargo test -p rho-application --locked`, SQLite tests and `ui/tests/application-bridge.test.ts` |
| Skill sources, resource identity and method binding | `cargo test -p rho-adapter-skills --locked`, then `cargo test -p rho-host --test skills --locked` |
| Frontend model/component behavior | `npm run test --prefix ui` |
| Client types and embedded assets | Generate, build, then check as above |
| Studio interaction and real local R | `npm run test:browser --prefix ui` |
| Rust architecture/dependency ownership | `node scripts/check-architecture.mjs` |
| Component assistant Studio | `npm run test:browser --prefix ui -- component-agents.spec.ts` (build current client and binary first); local Anthropic fixture, native context, IME, control/recovery and performance comparison |
| Component Agent integration | `node scripts/test-component-agents.mjs`; Rig HTTP/SSE, SQLite admission and direct Host project-query checks; real R remains separate |
| Frontend ownership and dependency boundaries | `npm run check:boundaries --prefix ui` and `npm run test:boundaries --prefix ui` |
| Vendored Jet snapshot / verifier | `node scripts/vendor-jet.mjs check` and `node scripts/test-vendor-jet.mjs` |
| Documentation/map only | `node scripts/governance.mjs check` and `node scripts/test-governance.mjs` |

The component browser suite defaults to a local Anthropic protocol fixture and
starts an isolated Host/project. Its real-model cases are opt-in: supply
`RHO_COMPONENT_BROWSER_URL`, `RHO_COMPONENT_BROWSER_REAL_MODEL` (the model ID), and
`RHO_COMPONENT_BROWSER_SECRET` through the process environment, then run
`npm run test:browser --prefix ui -- component-agents.spec.ts --grep "opt-in real model"`.
These cases verify a native file read and an actual resident Editor edit/save/R run.
Keep credentials out of tracked files and command logs. Use a distinct Playwright
`--output` directory to retain each run's traces and performance report.

Broader Rust checks, run sequentially when affected:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
```

The component Agent diagnostic's explicit `--real-model` option checks a synthetic
tool/image and reads a random marker from a disposable project through the Host.
Set `RHO_COMPONENT_MODEL_BASE_URL`,
`RHO_COMPONENT_MODEL_ID`, `RHO_COMPONENT_MODEL_PROTOCOL` (`anthropic` or
`openai_completions`) and `RHO_COMPONENT_MODEL_KEY_ENV` naming an environment
variable already containing the credential. Never put the credential in a tracked
file. HTTPS is required except for explicit loopback HTTP. It does not read native
CLI authentication or existing user projects. Logs and a scope-labeled summary are retained
under `target/component-agent-probe/`; absence of `--real-model` means real model
testing was not run. These probes do not replace real R, component UI or authorized
write/recovery acceptance.

`node scripts/test-component-agents.mjs --real-sources` additionally uses explicit
`RHO_ARK` and `RHO_R_HOME` to create a disposable R project and verify Objects,
Packages and native plot context with the configured model. The deterministic
source/byte checks are in `cargo test -p rho-host --test component_sources_real_r
--locked -- --ignored` with the same R environment. These tests do not install
packages or reuse an existing user's R process.
The real-source probe first runs the explicit synthetic connection/tool and image
diagnostics. Image context requires a passed image diagnostic matching the current
model configuration; a changed model does not inherit that result.
For the explicit direct-R mutation probe, run the `component_source_probe` Host
example with `--with-run` in that same configured environment. It verifies one
authorized R operation and the model's use of its native result. Captured document
save/run and final seven-component acceptance remain separate.

Native/transport verification:

| Script | Scope and prerequisites |
| --- | --- |
| `test-real-r.mjs` | Installed Ark and R with jsonlite, rlang, lintr and styler; real R, progressive object/package queries, non-forcing inspections, cancellation and code tools |
| `test-r-checkpoints.mjs` | Installed R with jsonlite; builds the private native checkpoint component for that R, then exercises the classifier and a capture/cold-restore round trip in disposable `--vanilla` processes. `--print-library` prints the component path for `RHO_CHECKPOINT_HELPER` |
| `npm run test:browser --prefix ui` | Current `cargo build --locked` binary, installed R, and an `ark` **beside that binary**. The specs launch the workbench without R flags, so R comes from discovery, which looks next to the running executable and then on PATH. With no ark the Studio opens with no R and most specs fail on disabled run controls instead of naming the missing prerequisite |
| `test-workbench.mjs`, `test-mcp.mjs` | Real local transports; add `--real-r` for Ark/R and Environment observations |
| `test-environment.mjs` | R/Ark with pak, renv, ps and jsonlite; installs small local fixtures into temporary libraries, checks user-library preservation and recovery |
| `test-process-recovery.mjs` | R-free native process crash/reconciliation |
| `test-remote-protocol.mjs` | Local SSH/Slurm transcript fixtures; does not validate a remote cluster |
| `test-remote-live.mjs` | Opt-in real jobs on an explicitly selected host/scratch directory; see Operations |
| `test-agent-interface.mjs` | Optional client-driven observations of Rho interfaces using an explicitly selected Codex installation; deterministic self-tests cover the harness without calling a model |
| `test-agent-clients.mjs` | Optional investigation of Rho integration with installed/authenticated Codex/Kimi/DeepSeek; real-provider answers are observations, not a Rho acceptance gate |
| `test-deepseek-inbox.mjs` | Checks the installed, lock-matched native Inbox replay/clear implementation with a disposable journal; no provider calls or session scan |
| `test-agent-task-recovery.mjs` | Rho-owned recovery with a local ACP fixture by default: disposable Host crash, original identities, draft/receipt preservation, refreshed MCP and image-byte delivery; real-provider modes are optional investigations |

Interactive Rho integration checks need a disposable analysis project outside the Rho
checkout's ancestry, so the native Agent does not inherit repository-development
AGENTS.md instructions. Use a real analysis, verify its captured Editor script,
original R operation and retained Plots media in the same live window. A successful
greeting does not establish this integration. `test-mcp.mjs --real-r` also covers
model-readable invalid arguments and prompt acceptance behind a failed-run queue
pause, including duplicate-request identity and explicit queue recovery.

These scripts live in `scripts/`. R tests accept `RHO_ARK` and `RHO_R_HOME` where
applicable. Ignored or unavailable checks are not passes; optional third-party Agent
observations are separate from required Rho checks and do not block their completion.
The shell scenarios are in `ui/e2e/shell.spec.ts`, with their own disposable Host.
Keep independent suites isolated rather than raising the product's retained-window
budget for tests. Geometry checks wait for ResizeObserver layout to settle.

Playwright uses isolated Chrome and disposable projects; build the current client
and `rho` binary before running it. Keep real interactive workbench sessions in
the integration checkout, separate from disposable test projects.

The approved workspace Agent task UI is in Design section 13. Focused Chrome tests
are `ui/e2e/agent-tasks.spec.ts`; local native protocol fixtures never call a model.
Rho acceptance covers connection identity, protocol delivery, permission handling,
drafts, original receipts, Rho's recovery behavior and faithful native-usage display.
Deterministic protocol fixtures and HTTP/browser tests can establish these contracts.

Third-party Agent capabilities, answer quality, image recognition and each platform's
independent lifecycle belong to that platform. Rho does not independently qualify
Codex, Kimi or DeepSeek. A Kimi image answer is not a completion gate for Rho;
image tests at this boundary verify the bytes, metadata and references Rho delivers.
Missing native text or usage stays missing, and a native end-of-turn is not evidence
that a requested answer or scientific result exists.

For the routine isolated recovery check, run:

```sh
node scripts/test-agent-task-recovery.mjs
```

The real-provider switches of this script and `test-agent-clients.mjs` remain
available only for an explicitly requested integration investigation, not routine
Rho acceptance. Such runs use independent test Hosts and preserve native config
hashes; never point them at a research Host. Keep prior raw logs and failed attempts
as recorded. Changing the acceptance scope does not change an old failure to a pass.
The reviewed Kimi adapter source was tag `@moonshot-ai/kimi-code@0.41.0`, commit
`95478e8c7ba248fd2470d5bb151555ec7fedd19d`; that provenance does not certify the
third-party product or require its current models to pass an independent evaluation.

## Contract and source changes

The R owner source is under `plugins/r/api` and `plugins/r/backend/engine`.
Iterate with `cargo test -p rho-r-engine --lib --locked`; after changes to its public
types, also cover the current `rho-contract`, `rho-operation` and `rho-workspace`
consumers and regenerate client contracts. `node scripts/test-r-plugin-engine.mjs`
constructs a standalone tree outside the checkout and runs the native owner's
unit tests with no private core source. Add `--real-r` with explicit `RHO_ARK` and
`RHO_R_HOME` to run its disposable native acceptance. These checks invoke Cargo;
run them serially with all other Cargo and generation commands. The script keeps
pinned dependency versions from the existing lock and resolves offline; it does
not install tools. The existing `node scripts/test-real-r.mjs` suite verifies the
remaining Host composition against the same relocated native implementation.

The public plugin contracts live in `crates/plugin-protocol` and generate the
standalone `sdk/plugin-protocol` TypeScript/schema package through the same
`npm run generate --prefix ui` command. Public packages must not depend on private
Host/Studio modules. Plugin source is snapshotted before use; import, inspection
and validation must never invoke a build recipe. Focused foundation checks are
`cargo test -p rho-plugin-protocol --locked`,
`cargo test -p rho-plugin-sdk --locked` and `cargo test -p rho-plugins --locked`.
For runtime iteration use `cargo test -p rho-plugins --test backend_runtime --locked`
and `cargo test -p rho-host -p rho-mcp --test plugins --locked`.
Its `operation_bridge` filter exercises the actual process through the generic
Operation/Query gateways and SQLite journal: fixed preflight qualification,
principal/revision containment, removal during execution, cancellation,
invalid candidates, crash without replay and original-record cleanup.
Registry changes also require `cargo test -p rho-operation --lib --locked`;
shared Operation DTO changes require affected journal/Host checks and generation.
Its external Python fixture exercises actual independent processes and requires
Python 3 on PATH. `node scripts/test-plugin-backend.mjs` copies the public Rust
crates outside the repository and compiles the example with no private source;
it invokes Cargo, so run it serially with every other Cargo command. Public
TypeScript consumption is checked by `node scripts/test-plugin-protocol.mjs`.
Capability-grant changes require both `plugin_self_requirements` and
`plugin_optional_requirements` Host tests. The optional case covers activation
without an available optional provider, explicit exact selection, invalid scopes,
unchosen grants and current-parent intersection when a view calls the Host.
The protocol's optional requirement tests also check combined declaration bounds,
duplicate versions and unchanged serialization when no optional entry is present.
R-owned public declarations and capability schemas are generated with
`node plugins/r/generate-sdk.mjs`; use `--check` for freshness and
`node scripts/test-r-protocol.mjs` for a strict independent TypeScript consumer.
The generator invokes Cargo and runs serially. Generate before backend checks so
the transport-routing test checks the current contributed manifest. R Console protocol changes require
`cargo test -p rho-r-api -p rho-r-backend --locked` and the existing real-R
`node scripts/test-r-plugin.mjs`, whose Console fixture checks parser nonexecution,
source retention, visible Console output, live event pagination during stdin,
pending cancellation and exact instance boundaries. Full Application document
capture and Console UI acceptance remain separate migration work.
The ordinary R formatting capability has a separate native check:
`RHO_ARK=/absolute/ark RHO_R_HOME=/absolute/R/home node scripts/test-r-format.mjs`.
It requires the existing `styler` package, builds the R package outside the checkout,
and exercises the unchanged Host in a disposable project. It checks explicit
session selection, nonexecution of input, restored formatting options, exact
retained large results, original-request replay, syntax failure and pending
cancellation. Set `RHO_R_PLUGIN_PACKAGE` to reuse an already assembled package;
the default build invokes Cargo and must run serially. Failed native evidence is
retained; only the fixture's own Host is stopped. Editor application of the result
and later-edit protection require their separate UI acceptance.
R inspection changes use the same native acceptance: its inspection fixture reads
object directories and table continuations, refuses foreign/expired references,
reads Packages and Help from one observed copy, and verifies that queries neither
force active/lazy bindings nor change loaded namespaces, search paths or library
paths. The fixture explicitly loads its test prerequisite before taking the
read-only baseline. It also checks busy/unstarted behavior and unchanged Operation
history. Public declarations alone do not establish those native results.
The native Console browser case also checks `r.inspection_state`: short runs and
failed scripts with prior object mutations invalidate cached inspection data,
while read-only queries preserve the key. The backend's manifest-to-route test
checks that every declared query/operation reaches the proper transport handler.
Generic window layout changes use the `rho-plugin-protocol` and `rho-plugins`
library checks, followed by `cargo test -p rho-host --test plugins --test
port_contracts --locked`. These cover bounded layout structure, scoped view
references, expected versions, original request replay and retained closed views
after package removal/restart. They do not establish a visual window shell,
scenario switching, or iframe drag/focus behavior; those need their own browser
acceptance once assembled. The independent `plugin-layout.spec.ts` browser fixture
checks retained opaque iframe documents/input while tabs move, hide, resize and
restore from saved layout. Its close gesture must reach the owner callback without
removing the frame. It does not exercise Host persistence or close-time flushing.
The `plugin-layout`, `plugin-frame-layer`, `plugin-window-state` and
`plugin-window-client` unit checks cover protocol conversion, fixed DOM order,
versioned saves, lost acknowledgements and original Operation outcomes. The
`plugin-window-views` and `plugin-window-close` checks add scoped connections,
retained hidden documents, confirmed closure and retries of the original request.
`plugin-workspace.spec.ts` exercises the generic `?plugin-window` composition with
real Host ports and an independently built fixture package. It checks automatic
placement, retained drafts, close refusal, lost-close acknowledgements and explicit
saved-state recovery after both a flush refusal and a missing handler. This
entrypoint is under integration; the final default scenario replaces the fixed
shell after all feature packages are available.
`node scripts/test-objects-plugin.mjs` compiles the in-progress Objects model and
React components in a fresh external directory using public R/plugin declarations,
the UI SDK and existing locked tools. It covers directory/reference bounds,
stale/busy behavior, independent expanded-view demands, exact vector copying,
reservation before collection, native confirmation and scalar/color/field semantics.
Connection checks cover exact restored session/provider binding, busy deferral,
owner cache invalidation, failed state saves and reverting edits during a save.
It does not start R or establish a working plugin view; native and browser acceptance remain
separate checks when that package is assembled.
`node scripts/test-plugin-ui.mjs` compiles the public UI SDK outside the checkout
and exercises its channel using real MessagePorts. After client generation/build
and `cargo build --locked`, use `npm run test:browser --prefix ui --
e2e/plugin-view.spec.ts` for the independent UI-only package, opaque iframe,
scoped reads, state persistence, Unicode input and revocation. It also verifies
native text copying, delayed collection beyond transient activation, refusal of
automatic/direct iframe writes, and no clipboard replacement after failed
collection or view closure. Clipboard-read permission belongs only to that
disposable browser context while asserting known text; clear the permission
override before the next user action so it cannot deny normal writes. The fixture
uses a disposable project, not a user's active scientific session, and retains
its project on failure. `ui/tests/plugin-clipboard.test.ts` separately checks
reservation expiry, bounds and native refusal.
`plugin-resource-download.spec.ts` uses independently built ordinary UI/backend
fixtures and real Host ports to check scoped original-byte downloads, Unicode
filenames, unchanged Operation history, automatic-action refusal and closure
during collection. `plugin-download.spec.ts` checks the browser download primitive
and checksum refusal without establishing Host admission. The Plots native case
separately checks original PNG export before and after releasing its R provider.
`node scripts/test-viewer-plugin.mjs` independently builds the ordinary Viewer and
checks original Operation/resource identities. `node scripts/test-r-viewer.mjs`
requires explicit existing `RHO_ARK`, `RHO_R_HOME`, the R package `DT`, Chrome and a
current `target/debug/rho`. It builds R and Viewer outside the checkout, then runs
`r-plugin-viewer.spec.ts` with disposable native sessions and unchanged core binary
hashes. It invokes Cargo for the external R backend, so run it serially with other
Cargo commands. The browser case covers interactive retained HTML, separate R
revisions, history/refresh, closure during execution, removal/restart recovery and
normal/wide/narrow screenshots. Inspect those screenshots before claiming visual
acceptance; programmatic Unicode input does not verify native IME composition.
These do not replace later real-science and
iframe/browser acceptance for the full migration.

Add capabilities to their owner and register them through Host. Keep input,
concrete payload/recovery schemas, documentation, examples and related read paths
in the same descriptor. Query schemas describe `QuerySnapshot.data`; operation
schemas describe `OperationRecord.output`. Shared helpers generate envelopes.
Validate actual results as well as requests; do not disguise a known result shape
as generic JSON. Dynamic native values and host-owned metadata must be explicitly
identified as such.

Continuation tests must cover identity changes and exhausted work budgets, including
zero-result search pages and Unicode/long-value boundaries. Source tests distinguish
strict local standard Skills from host-attested native discovery semantics. Fixtures
must not rewrite, rename, execute or install a host's method package. Application
checks must retain window/incarnation/resource identity and original Agent actor
through capture, save verification, execution and lost-acknowledgement recovery.
Add affected paths/checks to governance and dependency maps, then regenerate DTOs
and assets before verifying the current binary.

## Optional external-client observations

For managed native task recovery, `node scripts/test-agent-task-recovery.mjs`
runs an isolated protocol fixture. For a separately requested integration investigation,
`--real-codex`, `--real-kimi` or `--real-deepseek` select a real provider. `--model EXACT_NATIVE_MODEL_ID` overrides
the test session's model without changing the native platform's configuration.
Use a model actually reported by that installation; retain failed attempts when
changing it. These checks distinguish ordinary text/MCP recovery, image input and
reported native usage. A successful native end-of-turn alone is not proof of an
answer, correct image interpretation or token usage being reported.

[`test-agent-interface.mjs`](../scripts/test-agent-interface.mjs) and
[`scripts/agent-interface/`](../scripts/agent-interface/) are development tests,
not a product Agent harness. They run isolated Codex sessions via `codex exec --json`
and temporary MCP configuration. Scientific fixtures and answers are outside the
Agent working directory; scientific reads/actions must use Rho. Only the native
Skill-equivalence case grants access to its explicitly listed method resources.
The runner does not install prerequisites or restart existing user Hosts.

Inspect available categories and validate the deterministic harness separately:

```sh
node scripts/test-agent-interface.mjs --list
node scripts/test-agent-interface.mjs --self-test
```

For an explicitly requested client-driven experiment, first commit a clean tree
and build matching DTOs/assets/binaries, then run:

```sh
node scripts/test-agent-interface.mjs --final \
  --binary /absolute/path/to/Rho/target/debug/rho \
  --ark /absolute/path/to/ark --r-home /absolute/path/to/R/home \
  --codex /absolute/path/to/pinned/codex
```

`--final` names this optional runner profile, not Rho's product completion gate.
It runs ten core categories repeated three times, native/Rho Skill
resource equivalence and two adaptation cases: 34 runs. Model/reasoning, Codex
version and binary digests are fixed by the runner and recorded with the source
tree. Each task has an 80-call, 1 MiB UTF-8 text and ten-minute budget; native image
bytes and actual token usage are counted separately. Read-only investigation cases
cannot use `run_r` to bypass query interfaces. Programming/analysis cases can use
the scientific execution capabilities their task permits.

`--filter` and `--runs` are debugging options; their results do not establish the
full optional experiment. Preserve every attempt, JSONL/tool/resource trajectory, original
operation record, assertion, screenshot and artifact hash. Missing prerequisites,
exceeded budgets, identity mixing, repeated execution, silent overwrites or false
completeness must remain visible in the record. Investigate whether a finding belongs
to Rho or the third-party Agent. Fix Rho-owned defects with focused deterministic
regressions; a new real-provider experiment needs its own explicit scope. When running one, do not encode an answer or mandatory tool sequence into the task
prompt. Evidence defaults to `target/agent-interface/acceptance/`; summaries and
outstanding verification belong in [Status](STATUS.md).

## Review quality

Use sustained scientific scenarios alongside focused regression tests. Preserve
realistic accumulated files, objects, output history and layout changes. Check
focus, keyboard navigation, accessibility, cancellation, conflicts and recovery,
not only the successful screenshot. Do not automatically expand the feature scope
to match every feature of a reference application or tutorial.

`STATUS.md` is the single current progress summary. Architecture owns durable
technical constraints, design owns proposed interaction principles, and feedback
owns the user's reported problems. Replace obsolete explanation; Git keeps history.


## Maintain the Jet core snapshot

`vendor/jet-core` is generated third-party source, not a second Rho workspace.
Maintain the ordered patches and checksums in `patches/jet`; the
[patch README](../patches/jet/README.md) documents offline checking, independent
upstream replay, rebuilding and preparing an explicit upstream commit for review.
The original upstream license must remain intact.

Run `node scripts/vendor-jet.mjs check` for offline integrity and reverse/forward
replay, and `node scripts/vendor-jet.mjs verify` to rebuild independently from the
checksum-pinned archive. `prepare` writes a proposal under `target/`, so a patch
failure or changed inherited dependency cannot silently update production source.
Verification/preparation and the script regression tests can invoke Cargo metadata;
serialize them with other Cargo invocations. CI is configured to run offline
integrity and regression checks on macOS arm64, the current CI target.
