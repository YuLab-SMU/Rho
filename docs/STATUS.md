# Rho: current state and focus

Updated: 2026-09-28. This is the single current status summary. Git retains history.

## Unified plugin refactor — active implementation

The user authorized the entire unified-plugin plan: all scientific owners and
views, coexisting versions, project scenarios, public SDKs and Plugin Studio as an
ordinary plugin. A Viewer-only pilot is not the final scope. PS01–PS07 were created
in Paper, inspected and explicitly approved on 2026-09-23; see [Design section
21](RHO-DESIGN.md#21-unified-plugins-and-plugin-studio--approved). Implementation
remains active. The fixed scientific composition has not yet been removed.

Agent native transport, native and component task state machines, metadata storage
and the Rig model driver now live in `plugins/agent/backend/client`, `backend/owner`,
`backend/store` and `backend/engine`. Public DTOs, TypeScript declarations and JSON schemas are in
the same package. These libraries have no private core dependency. The component
API references only the public plugin protocol and R media API. The driver uses
captured input and owner callback ports; scientific execution still uses the
original owners and Operation path.

The component task owner now contains the sole admission, continuation,
permission, recovery and budget implementation. The old Application implementations
were removed. Its temporary core adapter translates typed captures, preserves
structured errors and revalidates the original live controller for caller writes.
It injects the Agent-owned atomic repository and shares the same writer gate with
manual handoff; there is no second task store or approval flow. Full document
receipts retain native operation IDs, save/run steps, applied versions and save
acknowledgements. Only the six supported document actions are admitted; fixed-view
controls remain unavailable. Read-only restart projections preserve uncertainty
without recovering or replaying work. This is not a legacy-store reader.

The component extraction baseline passes 44 focused cases: nine public task-owner
cases and 35 Application cases. These include atomic write failure, scoped original
admission, live-controller loss, frozen permissions, late native receipts and
observation-only restart. Three boundary cases check serialized bytes/digests,
complete native document receipts, recovery states and structured errors. Public
SDK generation and an independent strict TypeScript consumer also pass for that baseline.

The sole Agent SQL implementation has now moved into `backend/store`. Core SQL for
native/component tasks, assets, handoff receipts, quotas and task-list projections
was removed. Its temporary adapter keeps one Agent store for both task owners at a
new `agent-v1.sqlite` sibling path, preserving the original transactional checks.
It does not read/import previous Application task tables or delete their files.
The package verifies its format and refuses unrelated/unsupported databases before
schema changes. All nine public store cases (seven moved, two new) pass. All 75
affected Host/storage cases now pass on the credential-extraction source, including
the two new core composition cases, all six handoff cases, 40 stored component
cases and 27 Host task/recovery cases. The focused Host history case also passes. Public dependency
containment, native-target metadata and architecture checks pass. The current
binary builds and its help/startup check passes with the new store. All 13 selected
component Chrome flows pass; two opt-in real-model cases were excluded. All nine
current normal/narrow/wide, settings and scientific-state captures were inspected
without visible clipping, missing glyphs or overlapping controls. The independent
assembly passes all 14 owner and 15 store cases and verifies the public schemas.
All 18 fixture-engine real-R source/execution cases pass with the new store; ten
live-model cases were excluded. The current binary build and selected manual-handoff
Chrome case also pass. All five fresh handoff captures were inspected: constrained,
320 px (including the scrolled target), wide and recovered receipt. Controls fit
without overlap or horizontal overflow; scrolling retains the action footer. These
are existing Agent views, not ordinary-plugin view acceptance. An initial
all-platform offline metadata query failed on an uncached non-host dependency;
the Apple Silicon filtered query passed without downloads.

Credential file persistence now also lives in `backend/store`, with the original
locking, atomic replacement, immutable key references, caller/project filtering and
redacted diagnostics. The Host keeps only temporary path selection and typed
forwarding. The public owner requires an explicit absolute path; missing-key reads
and removals do not create a credential directory. Four credential cases moved with
the implementation and two location/read-isolation cases were added. All six now
pass in the independent assembly; the first owner/store run predates this change
and remains a separate baseline.
No actual user credential files were opened or changed by development checks.

Manual handoff policy and contracts have now moved into the public Agent package;
the Application implementation is a typed forwarding adapter to the same atomic
repository. The original caller validator and target writer gates are retained.
All 14 public owner cases now pass, including the five new handoff cases. The
serialization/digest boundary case also passes. Public handoff SDK generation,
independent strict TypeScript consumption and independently assembled schema
freshness now pass. All six existing
SQLite handoff cases pass before the subsequent storage split, including write-failure
rollback, durable idempotency, stale material, scoped controllers and asset separation. This change
does not create a model turn, transfer uploads or move grants between tasks.

An independent source assembly, containing the Agent libraries plus the two public
API dependencies, passed all 29 execution/recovery cases (three model policy/error,
17 Rig HTTP/SSE/production-driver, nine task-owner). Its aggregate check was then
interrupted during an inactive doc-test stage with no executable documentation
examples. A repeat using explicit library/protocol targets was interrupted during
prolonged compilation before new tests ran. Both interruptions are retained as
incomplete checks, not passes. No business logic changed between those attempts.
The script now selects the actual library and protocol targets explicitly.

Client generation and all 67 affected Host/storage cases for the component
extraction pass (27 Host and 40 storage). That command compiled the component
libraries before the subsequent handoff source change; its result is a separate
baseline. On the handoff source before the storage split, all six SQLite handoff
cases, eight Host model-unit cases and 18 fixture-engine real-R cases pass. Ten
live-model cases were excluded. Client build and generated-type/embedded-asset
consistency and all 98 Agent client cases pass. The subsequent binary/browser checks use the new store;
the component browser result is recorded above and focused/cross-boundary storage acceptance is running.
Tool processes repeatedly remained inactive
without a compiler diagnostic; the cause is not established. A completed earlier
startup sample was predominantly `_dyld_start` before the harness, while later
compiler/debugger sampling produced no usable stack. A privileged system sampler
was unavailable and no privileges or system settings were changed. Preserve the
existing passing evidence while completing these affected checks; do not infer
current end-to-end acceptance from it. Details and commands are in
`target/plugin-refactor/agent-component-verification.txt` and the versioned logs
and interruption records alongside it. Inspect live verification processes before
starting another Cargo invocation.
That serial run completed successfully. The subsequent
`target/plugin-refactor/agent-storage-verify.py` runs the new owner/store and core
storage cases, regenerates the public SDK, checks an independent store/owner
assembly, repeats real R with the new storage and exercises the existing
manual-handoff Chrome flow. It has now completed successfully. Its exact results
are in `target/plugin-refactor/agent-storage-results-v1.json`. The new public-port
and ordinary metadata-backend verifier below is now the sole Cargo owner.

The preceding engine baseline at `1c871a8e` remains separate: 75 Host/storage cases,
18 real-R fixture-engine cases, 98 Agent client cases and 13 selected Chrome flows
passed; nine captures were inspected. Its ten real-model R cases and two opt-in
real-model browser cases were excluded. See
`target/plugin-refactor/agent-engine-verification.txt`. Unchanged native transport
fixtures remain in `target/plugin-refactor/agent-native-verification.txt`; they
have not been rerun for the current component extraction.

The public backend SDK now has a bounded asynchronous reverse-call client/pump
for Agent owner callbacks. It retains the containing owner's original request ID,
correlates concurrent replies, refuses queued/duplicate/mismatched replies, and
keeps abandoned waits reserved until response or disconnect. Pump closure fences
new calls and returns unconfirmed outcomes for queued/dispatched requests; it does
not replay, cancel or commit scientific work. Typed Host errors preserve recovery
without printing it in debug output. All seven focused tests, including a framed
exchange over bounded duplex I/O, and six existing transport cases now pass. This is a public
transport building block consumed by the new Agent metadata backend; model/native
dispatch integration remains pending.
The generic `views.caller` query exposes the original authenticated view, window
and connection identities without private tokens. Native ingress captures this
identity, backend hops retain it, and missing/closing/stale views fail. It reads
existing state and does not authorize future writes. The new generic Host fixture
passes for two delegation hops, forged selectors, lost scopes and closure during
accepted work. Existing draft/delegation passes are reused; fixture cleanup now
waits for native execution leases to retire before releasing the instance.

`plugins.delegated_operation` resolves the original reverse request from its
retained parent admission with exact project/principal/instance checks. It returns
only the original Operation identity; an absent record is partial evidence and
never permission to replay. The generic Host case passes for an active child,
discarded reply, foreign identity/scope/instance refusal, and read-only observation
after release/removal/reopen. It closes the original disposable Host before
rebinding the same journal to another project, respecting the single-Host lock.
The scoped delegation runtime case also passes. Public declarations and schemas,
an independent strict TypeScript consumer, client build and client check all pass
in the v5 verifier. Earlier failed fixture runs remain in their versioned logs.

The ordinary Agent backend composes the public task owner and store in an isolated
process. It contributes task queries, creation, draft saving, title/archive
updates, explicit controller takeover and versioned model configuration. Each
write observes its original native caller and consumes a one-use metadata
admission. Callers cannot select an identity/path. Original operation candidates
remain retained until native settlement. All six metadata/configuration framed
cases pass before the key-Control addition, covering concurrency, version/control
conflicts, invalid plaintext/embedded credentials, instance separation and
observation-only reopen. The independent package build in v5 passed, but its
subsequent test selected the system's Rust 1.88 instead of the project's 1.97.
The build and test scripts now share an explicitly resolved toolchain; this
correction and the generic Host acceptance are pending the key-Control verifier.
No compile failure is recorded as a successful independent test.

The credential file stores a secret and its scoped original-request reference in
one atomic replacement. Identical retries return the original reference; changed
reuse is refused. Read-only lookup survives reopen, and removal retains the
non-secret receipt so an old request cannot recreate the secret. All ten credential store cases now pass, including the four new cases for
original-request recovery, concurrent duplicates, missing storage and corrupt
receipt refusal. The independent assembly remains a separate pending check.

The backend now exposes `agent.model.key.store` as ephemeral Control, with original
caller observation and instance-owned credential storage, plus the read-only
`agent.model.key.receipt`. Missing receipts are explicitly partial observations.
No raw key is placed into an Operation, task, configuration, revision or scenario.
Controls and Operations share bounded transport capacity but only Operations
require native settlement. Four new framed fixtures cover lost replies/reopen,
wrong kinds/identity/scopes, disconnect before admission and mixed capacity.
The generic Host fixture also checks unchanged journal table counts and separate
instance receipts. All ten framed cases now pass, including those four new Control cases. Manifest
generation also passes. Independent assemblies and the generic Host case are
still running serially in `target/plugin-refactor/agent-key-control-verify.py`;
they are not yet passes.
The v5 public-port logs and results are retained separately.

This remains incomplete Agent migration. Model execution and native Agent transport
composition, context providers, Agent views, Studio Agent assistance and final
composition/default delivery remain active work. The metadata process does not
claim to run models or scientific actions.
Initial import warnings were corrected. Existing user Hosts and R sessions have
not been replaced; runtime acceptance uses disposable projects. No full-workspace
audit, installation or publication ran.

Archive downloads and the ordinary Manager/Studio transfer interfaces are implemented
and verified. The containing browser shares one download slot for archives/resources,
validates the complete archive and rechecks native read authority before requesting
a file. Manager and Studio capture exact source/artifact selections, retain original
request recovery and require a separate Download action. Studio retains archive state
with its source draft, exports immutable checkpoints independently of local edits,
and requires checkpointing edits before explicitly opening imported source. Transfers
do not implicitly build, activate code or apply a scenario.

All 18 affected Host archive, draft and preview cases pass. Public protocol/SDK
checks, independent Manager/Studio builds and models, client build/consistency,
all 531 client tests and the current binary build pass. All eight affected browser
flows pass across the recorded runs: ordinary resource/archive download, Manager
composition and import/export, Studio source/build/preview, disposable backend tests,
scenario application and archive transfers. Lost upload/import/export replies recover
without duplicate mutations or automatic downloads. Controlled fixture downloads
match the original digest/length and exact source/artifact selections. Other windows,
running instances and unsaved Unicode source remain intact. Keyboard artifact
selection retains focus. Twenty affected captures were inspected: Manager revision
and export, Studio editor/header and archive controls at normal, wide and constrained
sizes, including scrolled narrow download controls. No overlap or horizontal overflow
was observed. Unchanged list, scenario, instance and preview observations are reused.

The initial full client run aborted when a new 17 MiB deep-array assertion exhausted
the worker heap; the corrected assertion checks the same complete bytes without
formatting millions of entries. Focused and full reruns pass. Initial Studio models
failed only on an old diagnostic-wording assertion. The first browser run passed
seven flows; the independent archive fixture failed because appended JavaScript
redeclared a variable. Explicit module syntax verification and a scoped fixture
resolve it. Studio's passing archive fixture was also tightened to wait for the
selected source before capturing its edit; the corrected run passes. Failures and
exact commands remain in `target/plugin-refactor/archive-download-verification.txt`
and `target/plugin-refactor/studio-archive-verification.txt`.

New download admission requires a rebuilt Host and client. Manager and Studio assets
require explicit package snapshot/activation; old immutable instances stay unchanged.
User Hosts and R sessions were not replaced. No real-R/full-workspace audit,
installation or publication ran. Agent integration, remaining scientific migration
and removal of the fixed composition/default delivery remain active work.

Active Hosts now expose scoped package archive staging, inspection, import,
export, bounded reads, original transaction receipts and explicit transient-byte
discard through the same public ports. Native project/principal identity and exact
SHA-256/length references bind transfers; no caller filesystem path or fabricated
runtime resource owner is accepted. Import does not build or activate code. Export
captures the exact revision and selected artifacts, including source-only exports.
Original unresolved Operations retain their bytes/source protections. Catalog
receipts never turn uncertain Operations into success or authorize replay.

The public UI SDK captures immutable Blob content, stages identical bounded
chunks and verifies complete archive reads independently of the smaller media
limit. These helpers do not trigger browser downloads. Manager import controls are
implemented and verified in Chrome: captured local files, retained
upload inspection, identical-content reselection, explicit import and recovery of
the original request. Model checks cover partial/lost replies, replacement views,
uncertainty, receipt identity and explicit transient-byte discard. Studio archive
acceptance is recorded above.
The new ports require a rebuilt Host; existing user Hosts and R sessions have not
been replaced. All 30 affected repository/build/source-development tests pass on
the current implementation. Public protocol/SDK consumers, independent Studio and
Plugins builds/models, client build and all 528 client tests also pass. All 15 Host
archive/shared-port regressions and 9 native protocol tests pass. The backend SDK
library compiles (its library target has no tests), and client consistency passes.
Exact commands, initial fixture/build failures and results are retained in
`target/plugin-refactor/archive-verification.txt`.

The import baseline binary builds, and both affected Manager browser flows pass across
the recorded runs. Import resumes after a lost chunk acknowledgement, recovers a
lost successful import reply without duplication, explicitly opens the imported
revision and discards only transient bytes. Running instances and another window's
unsaved Unicode text remain unchanged. All 25 affected captures were inspected:
normal/wide/constrained import, list, revision, scenario and instance surfaces,
scrolled narrow import controls and the successful receipt. No overlap or horizontal
overflow was observed; long narrow contents remain scrollable. The initial archive
fixture placed two database files in one directory, which intentionally shares one
package repository. The corrected fixture uses separate repository directories and
asserts the subject is absent before import. No production behavior was weakened.
Exact commands and retained failures are in
`target/plugin-refactor/manager-archive-verification.txt`. No real-R or full-workspace
audit, installation or publication ran. New Manager assets require an explicit
package snapshot/activation; existing immutable instances remain unchanged.

Studio scenario application is implemented through the ordinary public ports.
The new surface selects a named scenario and plugin alias, stages an exact
previewed/tested revision and artifact with explicit new view states, saves a
checkpoint against its captured head, prepares runtime instances/views, and
atomically applies to the current window against its captured layout version.
Each step retains its original request in the synchronized draft. Lost replies,
partial preparation and replacement-view inspection do not proceed to later steps
automatically. History comparison and restoration create a new checkpoint; exact
active instances and live view drafts can be reused without releasing older
instances or rewinding scientific state. Configuration/dependency/provider/layout
editing and initial named-scenario creation remain in Plugins.

The generic containing window now refreshes its native layout observation before
returning a successful presentation-operation receipt to a plugin. The browser
flow exposed a stale-poll interval in which an immediate tab click could otherwise
submit the old layout and produce a version conflict. This refresh does not trust
a plugin-supplied layout, discard local edits, or rewrite the Operation outcome;
selected child-project requests do not refresh the parent window.

Studio model/recovery checks pass, including synchronized scenario payloads,
source/development guards, lost checkpoint/activation/application replies, partial
preparation reuse, layout conflicts and uncertain outcomes. All 528 client tests
in 53 files pass, as do client build/consistency, the current binary build, public
plugin boundaries, architecture and governance checks. Four affected browser flows
pass across the recorded runs: generic window composition, source/build/preview,
explicit backend tests, and scenario application/history restoration. The latter
keeps old and new instances alive, restores the old unsaved Unicode draft, and
preserves another window's unsaved text. Normal/wide/constrained scenario and
editor captures, narrow history navigation/application controls and the restored
live view were inspected; there is no overlap or horizontal overflow. The first
restored screenshot preceded iframe paint; the final capture waits for visibility
and painting and shows the retained draft.

Initial scenario runs exposed the selection-reset and stale-window-observation
bugs now fixed. Other failed runs were test timing/fixture issues: a wrong preview
button label, reading the head before restore completed, typing before initial
view state arrived, and incomplete model view metadata. The generated source index
was refreshed after its mapped command changed. All failed evidence is retained;
exact commands and current results are in
`target/plugin-refactor/studio-scenario-verification.txt`. No real-R, full-workspace
audit, installation or publication was run. New Studio package revisions still
need explicit snapshot/activation; existing instances retain immutable assets.
The shell change requires updated client assets, not a new Host capability. User
Hosts and R sessions have not been replaced. Agent integration,
remaining scientific migration and default delivery are still active work.

Explicit backend tests have a native disposable-project owner and ordinary Studio
controls. `plugins.test_create/test_stop` create and stop a separate generic Host,
package catalog and Operation journal for exact source/artifact selections.
Dependencies, configuration, grants, containment and native quotas validate without
borrowing current analysis. Open views, borrowed connections and accepted work
prevent stop; failed cleanup retains original records and source protections.
Confirmed stop preserves the independent directory and journal as evidence.
Observations and `plugins.test_operation` never restart a recorded child.

Studio's Build & preview surface now separates fixture preview from explicit
backend testing. Use selected build prepares a subject and optional exact
dependency selections. Creation, opening a test view, opening its workspace,
closure and stop are separate actions. Original requests and child selections are
saved before dispatch; lost results are inspected after reload without replay.
Replacement Studio views cannot resubmit an originating view's request. Known
child Operations remain readable through the parent after stop. Failed activation
and uncertain outcomes retain their original evidence. Live and recorded state
are distinguished; no replacement test starts automatically.

The public UI SDK selects child Query/Control/Invoke/GetOperation/Cancel calls over
the original private view channel. It requires explicit test-project access and
per-capability grants; selector scopes cannot expand those grants. Intrinsic
view state, close cooperation and presentation remain on the original view.
Selected draft writes are fenced during parent closure. Only the focused shell
can open the requested child workspace and construct its credentialed URL.
Session/HTTP, connected CLI and MCP retain their existing explicit selection and
never fall back to analysis. MCP holds a native lease until disconnect.

Six native lifecycle cases pass, including the new ordinary-view case for selection,
missing grants, fixture refusal, independent original requests and cancellation,
parent closure fencing and stopped-target refusal. Initial runs failed on fixture
assumptions: an insufficient declared grant is refused at activation; cancellation
is confirmed only when the fixture is configured to confirm it; parent idleness
also requires releasing the test's explicitly borrowed child lease. Corrected
fixtures pass without weakening native checks. Public protocol/SDK consumers and
Studio's independent build/model recovery checks pass. Two initial model runs
failed only on an expected error wording and a synchronous-throw assertion.
Client generation/build/consistency and all 522 client tests in 53 files pass.
The current binary build and both affected Chrome cases pass. Studio creates an
exact native test, recovers a lost creation reply after reload without duplication,
opens its separate workspace, calls its own backend, flushes the latest Unicode
view text and stops the child while analysis keeps unsaved text. All thirteen
affected captures were inspected: development/build diagnostics and backend
lifecycle at normal, wide and constrained sizes, including scrolled controls and
stopped state. There is no overlap or horizontal overflow; narrow controls remain
accessible by scrolling. Unchanged editor/history layout observations are reused.

The first two backend browser runs exceeded the native initialization timeout;
a separate direct launch of the unchanged Python fixture also exceeded ten seconds,
then the same script completed its handshake in 0.255 seconds. Subsequent browser
runs pass without changing production code or timeouts. The cause of the initial
launch delay is not established; failed traces and native observations are retained.
The first passing run needed additional scrolled captures for narrow controls;
the final run includes those and confirms exact close-time saved text. Native draft
and fixture-preview regressions pass all fourteen cases. Dependency and governance
checks pass. Exact commands, failures and current evidence are in
`target/plugin-refactor/studio-test-verification.txt`. No real-R or full-workspace
audit, installation or publication was run for this change. The overall migration,
Studio Agent workflows, broader scientific acceptance and default delivery
remain unfinished.

Destroyed plugin documents retire their exact close-handler registration through
the generic `views.release_renderer` Control. The shell assigns private document
identities and sends keepalive notification after destruction; hidden/cached
views remain registered. Retirement never claims a save, closes a view or releases
a backend. Missing notifications retain uncertainty and explicit saved-state
recovery. Prior nine native draft/close cases, affected browser cases and all 13
captures passed inspection; retained evidence is in
`target/plugin-refactor/renderer-verification.txt`. Previous transport and native
repository/lifecycle checks are retained in `test-project-edges-verification.txt`
and `test-project-verification.txt` in that directory. New native capabilities
require a rebuilt Host; browser refresh alone cannot add them. User Hosts and R
sessions have not been replaced.

The explicit `--plugins-only` development mode now opens the generic package,
window and Operation workspace through the shared Host ports. Its canonical
project lease is independent of a scientific owner. Empty repositories stay empty;
opening, switching projects and reading metadata do not discover R, apply saved R
configuration or fall back to fixed scientific composition. Ordinary instances
must still be activated explicitly. The older composition and dependencies remain
in the binary pending their removal; this mode does not complete default delivery.

Two focused native cases pass (`plugin-workspace-host-v2.log`): canonical project
exclusion and empty-catalog reopen, plus two independent backend projects whose
accepted work, identities and records remain separate. Removing the test package
and reopening its empty catalog retains visible original Operation results without
reinstallation. The CLI launch-argument case passes, as does the focused Workbench
library case for ignored R settings, refused R setup and plugin-only project
switching (`plugin-workspace-http-v1.log`). All 28 affected Host regression cases
pass for ownership, plugin paths, shared ports and project file/history boundaries
(`plugin-workspace-regression.log`). `cargo build --locked --offline` and the
startup help check pass. The isolated Chrome command `npm run test:browser --prefix
ui -- plugin-workspace.spec.ts studio-plugin.spec.ts --output
../target/plugin-refactor/plugin-workspace-browser-v1` passes both cases, including
Studio source/build/fixture recovery and cancellation through the generic Host.
All 22 captures were inspected: generic views at 1440/1920/390 px and narrow close
recovery; Studio canvas/development at 1440/1920/390/220 px, constrained navigation,
source/properties, history and build diagnostics. No overlap or page overflow was
observed. This reuses unchanged client assets; it does not establish real-R
acceptance or Studio's automatic disposable-project lifecycle. Existing user Hosts
and R sessions were not replaced. New startup behavior requires the rebuilt binary.
Evidence and exact commands are in
`target/plugin-refactor/plugin-workspace-verification.txt`. The initial native
fixture used invalid inventory paging input and failed; its corrected rerun passes.
The initial combined edge command was deliberately interrupted during unrelated
filtered-out CLI target loading; it is not an overall pass.

The native `plugins.build` port names an installed source revision, materializes
its declared files in a fresh original-Operation directory, and runs its literal
recipe with existing tools. It reuses generic supervision in `crates/process-engine`;
Process, Files, Remote and Environment no longer obtain that mechanism through the
scientific Process API. Builds require ordinary `plugins.write` and `plugins.run`
grants, retain source references, serialize managed execution, and publish only
validated artifacts for unchanged source. Aggregate quotas are checked inside the
artifact transaction so repeated builds leave an exportable package. Native work
directories and bounded reports remain recovery evidence. Uncertain Operations
keep source protection; reference reconciliation cannot claim native cleanup.
Builds do not activate instances or apply scenarios.

Verification passes: 8 supervisor cases (`build-supervisor-v2.log`), 7 build + 13
package-repository + 6 source-development cases (`build-repository-final.log`),
and the final uncertain-reconciliation assertion (`build-uncertain-final.log`).
Independent Process sources pass 4 native owner/recovery cases outside the checkout
(`build-independent-process.log`); independent Files/Git sources pass 13 read/search,
4 native owner and 8 supervisor cases without private core source
(`build-independent-files.log`). `npm run generate --prefix ui`, `npm run build
--prefix ui` and `npm run check --prefix ui` pass (`build-generate.log`,
`build-client-build.log`, `build-client-check.log`), as do the public/Process
NodeNext consumers and architecture, plugin-boundary and governance checks.
All evidence is under `target/plugin-refactor/`; `build-verification.txt` records
executed commands and the corrected initial failures: the first supervisor command
was refused by `--locked` before compilation, and the first owner compile found an
incorrect documentation-field type. No external dependency versions changed.

The native `plugins.preview` port now opens an exact built artifact as a fixture
presentation instance. It starts no backend, receives no native project path or
Host grants, and publishes no providers. Queries match captured fixture arguments;
missing fixtures remain unavailable. Scientific operations, controls, original
operation inspection/cancellation, resource downloads and external links are
refused. View state, close cooperation and explicit text copy reuse the ordinary
presentation owners. The shell labels preview mode outside the isolated iframe.
Preview cannot satisfy a scenario runtime or interfere with a real provider.

Runtime discovery excludes previews by default; normal instance and initialization
records retain their existing wire shape. Management explicitly includes previews
with consistent counts and pagination. Editor, Studio and Environment readers
also distinguish fixture instances from scientific runtimes. Preview uses normal
revision retention, scoped identity, view closure and explicit instance release;
restarting a Host does not reconstruct preview connections or fixtures.

The five native preview cases pass (`preview-host-discovery.log`), covering
artifact identity, fixture routing, refused writes, credential/sequence boundaries,
parent authority, provider/scenario exclusion, scoped discovery and pagination.
The prior affected Host run passed those five plus 11 scenario, self-grant, view
and shared-port cases (`preview-host-final.log`). The ten public contract cases
pass (`preview-contract.log`), including unchanged normal wire records. Public
protocol generation, independent protocol/UI SDK consumption, Manager, Editor
and Studio model checks pass. The two affected client unit files pass six cases
(`preview-client-tests.log`). Environment's reference scan passes one case and R
recovery passes three (`preview-environment-references.log`, `preview-r-records.log`).
The current `cargo build --locked --offline` and final client check pass
(`preview-host-build.log`, `preview-client-check-banner.log`). The isolated Chrome
command `npm run test:browser --prefix ui -- plugin-preview.spec.ts
plugin-view.spec.ts --output ../target/plugin-refactor/preview-browser-v1` passes
both cases (`preview-browser-v1.log`). It builds real source, exercises exact
fixtures and denied writes, preserves Unicode and state through refresh, copies
explicit text, closes/revokes assets and releases the instance. Preview captures
at 1440/1920/390/220 px and three normal-view/close-refusal captures were inspected
without clipping or overlap. This establishes fixture preview through the public
SDK. Studio's end-user controls are verified below; disposable-project testing
progress is recorded at the top of this page. Exact commands and the corrected initial compile
failure are recorded in `preview-verification.txt`.

The user's running Host and R sessions have not been restarted. Full native package assemblies, real-R scene acceptance
and the full-workspace audit were not rerun in this phase.

`plugins/studio` is an ordinary, independently assembled UI package using only the
public protocol and UI SDK. It selects immutable source or an existing development
branch, creates branches, reads bounded source pages, and checks/saves source
checkpoints through the native ports. Its authoring surface has a node tree,
fixture canvas, declaration/source editor and properties inspector. Text,
container/split/tabs, form/list/table, media placeholders and opaque custom
components share the public declaration; bindings, conditions, tokens and events
remain data. Canvas selection, drag and rendering cannot call scientific owners or
execute custom source. Source/canvas/property edits share undo, including across
checkpoints; invalid declaration text retains its last valid canvas.

Studio stores its source bodies, selection, history and original request intent in
the generic chunked document drafts. It keeps the branch's expected head and
verifies original Operation identity and prepared source revision before accepting
a receipt. Reopen does not replay source work. History compares immutable source
with its parent and restores selected bytes as a new checkpoint. Editing is limited
to UTF-8 files up to 128 KiB; larger/binary historical files restore by exact source
copy. Source and undo bodies have a bounded draft budget, and native checkpoint
quotas remain visible. The package's README records these limits. It declares
ordinary build and fixture-preview ports; it has no runtime activation, scenario
mutation or scientific execution grants.

Build & preview now builds the exact saved checkpoint, retains its original
Operation and bounded logs, and selects the acknowledged artifact without applying
it. Configuration text, fixtures, partial preview instances and original requests
share the synchronized draft. Reload inspects the original work without replay;
only the originating view can retry or request a build stop. Stop requests remain
unconfirmed until the original Operation reports its terminal result. Normal view
closure saves the preview's latest state; retained-state recovery and release are
separate explicit actions. Successful preview opens collapse the configuration
form so the retained instance and artifact remain visible on return.

`node scripts/test-studio-plugin.mjs` passes the independent assembly and source,
canvas, draft and development recovery checks (`studio-development-integrated-v9.log`).
The isolated Chrome command `npm run test:browser --prefix ui --
studio-plugin.spec.ts --output ../target/plugin-refactor/studio-development-browser-v5`
passes its full end-to-end case (`studio-development-browser-v5.log`). It checks
source/IME undo, clipboard, drag, immutable history, lost source/build receipts,
exact fixture queries, preview state on closure/release, and confirmed cancellation
of a real long-running build. The cancelled revision publishes no artifact, while
the previous successful revision retains its artifact. The complete paged
Operation history contains no scientific calls or duplicate checkpoints.

Canvas and preview captures at 1440/1920/390/220 px, navigation/source/properties
at 390/220 px, history at 1440/390 px, and running/cancelled build states were
inspected without overlap or horizontal overflow. Unchanged layout observations
from `studio-development-browser-v3/` cover the final UI; final diagnostics were
inspected in `studio-development-browser-v5/`. Earlier failed runs retain evidence:
v2 measured a tab before visibility settled, v3 read the previous source before
file loading completed, and v4 counted only the first Operation-history page.
These were corrected in the test rather than reported as passes. The initial
model compile/fault-injection failures and exact commands remain in
`studio-development-verification.txt` under `target/plugin-refactor/`.

Plugin boundaries, architecture and governance checks pass. The Studio UI stage
reused the native build/client verification above; it changed no Host capability
or embedded client source. The later generic-Host verification is recorded at the
top of this page. User Hosts and R sessions were not replaced.
Agent integration, default delivery and remaining scientific migration are
still unfinished. The inert editing canvas remains separate from executable
fixture preview.

Plugin source development now has public `plugins.source_tree/read_source`,
`plugins.branches`, `plugins.check_source` and `plugins.checkpoint` ports.
Reads page immutable file identities and return binary-safe byte slices after
checking the complete file digest. New branches record their origin; missing
origin evidence remains unknown. Source checks validate a proposed child without
installing it. Saving captures that proposed identity in the original Operation,
then atomically stores the source-only revision, blobs, references and expected
branch head. Put/remove/exact-source-copy edits preserve the previous revision's
artifacts, and restoration creates another child. Invalid manifests/declarations,
quota failures and stale heads leave the branch intact. Inline edits are bounded
to 128 KiB and the whole request to the shared 256 KiB argument limit; large
retained files can be copied without inline encoding. These ports do not compile
code, start providers or apply a scenario.

`cargo test -p rho-plugins --lib --test source_development --test
package_repository --locked --offline` passes all 41 cases (22 owner, 13 existing
repository and 6 source-development cases). The source cases cover binary/paged
reads, corruption outside the requested slice, immutable restore, large-file
rename, concurrent writers and forced reference-write rollback. Evidence is in
`target/plugin-refactor/source-owner-final.log`.
`cargo test -p rho-host --test plugin_development --test plugins --test
port_contracts --locked --offline` also passes all 20 cases. The two new cases
exercise pure checks, scope refusal, ordinary view grants, original-request replay,
concurrent saves and a forced write failure whose uncertain original record is
preserved without re-execution. Evidence is in `source-host-v1.log` in the same
directory. A final branch-update guard is additionally covered by the focused
`--test source_development` and `--test plugin_development` reruns (6 and 2 passed),
including a database-ignored update that must roll back all newly stored content;
see `source-owner-guard.log` and `source-host-guard.log`. The 17 protocol cases pass
in `source-protocol.log`. Independent strict NodeNext consumption and standalone
schema-reference checks pass (`source-public-types-v3.log`). Public bindings and
schemas are generated; `npm run generate --prefix ui`, `npm run build --prefix ui`
and `npm run check --prefix ui` pass (`source-generate.log`, `source-client-build.log`
and `source-client-check.log`). Native build and fixture-preview capabilities now
exist and are integrated into Studio. A running Host needs a rebuilt replacement
to expose the new ports; a client refresh cannot add them. Existing user Hosts and
R sessions have not been replaced during these isolated-project checks.

Named scenario checkpoints now have scoped storage and public
`scenarios.list/get/checkpoint` ports. Saving compares the current head and commits
immutable content plus protecting package references atomically. Old checkpoints
keep their references, including versions absent from the catalog and resource-owner
versions; importing a missing version does not erase that protection. Restoring a
former composition creates a new child. Optional capability selections remain
configuration and grant no activation authority. Queries and saves neither start
providers nor change a window.

Window application is implemented through `scenarios.prepare/apply` and
`windows.scenario/resolve`. The caller prepares ordinary instances and views;
application revalidates their exact artifacts, configuration, frozen grants,
dependencies, schemas and live readiness, then commits one window's layout and
provider selection together against its native layout version. Hidden and reused
views keep their current state and connection. View records can carry an immutable,
scoped resource context without gaining resource-read authority. Selected providers
are observed explicitly after release; resolution never falls back to another
revision.

The ordinary `plugins/manager` UI now assembles independently using only the public
SDKs. Installed inspection shows purpose, exact revisions/artifacts, contributions,
dependencies and protecting-reference counts; protected removal remains disabled.
Branch creation, instance inspection and opening an instance's view use shared
Host Operations. Scenario review captures a native window version, explicitly
selects new or reused instances/views, and prepares them before atomic application.
Partially prepared objects stay retained; a lost acknowledgement is inspected by
its original request, including from a replacement manager. Normal asynchronous
acceptance is observed before continuing. JSON checkpoint drafts retain invalid
text and save independently from applying a scene. Older checkpoints remain intact.
Narrow details replace the list, with Back preserving selection, scroll and focus.
Async tab-title observations no longer attempt to save an old composition over a
newly selected scenario.

The manager's independent model/build checks pass, including explicit reuse,
partial preparation, original-request recovery, fresh pre-admission refusal,
uncertainty, layout preconditions and prototype-like native aliases. The 13 focused
layout/state/frame cases pass. `npm run build --prefix ui`, `npm run check --prefix
ui` and `cargo build --locked` pass. Browser acceptance through an independently
assembled package verifies two coexisting UI revisions, unchanged iframe identity
and unsaved Unicode text after switching back, lost-application-acknowledgement
recovery without a second operation, branch creation, exact-instance view opening,
invalid draft retention and immutable checkpoint parents. The complete
`npm run test:browser --prefix ui -- manager-plugin.spec.ts plugin-workspace.spec.ts`
run passes both cases; the manager rerun also verifies read-only navigation while
an original request remains unresolved. Installed/scenario and instance details
were inspected at 1440, 1920, 390 and 220 pixels, along with normal and constrained
view-opening dialogs. Initial browser failures and corrected fixture timing remain
under `target/plugin-refactor/manager-browser*`; the final captures wait for both
iframe geometry and compositor painting. Import/export still use
the CLI. Plugin Studio now supports visual/source editing, native builds and
fixture previews and explicit disposable-test controls as described above. Real-R scene
continuity, default delivery and removal of the fixed composition remain unfinished.
The manager is not silently installed into existing user projects.

The complete 13-case package repository suite and 17 protocol cases pass, including
concurrent head conflicts, project/principal visibility, immutable history, missing
version protection, invalid metadata and transactional reference-write failure.
All 22 Host cases pass: four scenario cases, 13 existing plugin cases and five
shared-port cases. They cover original-request replay, scope refusal, pure
preparation, exact dependency/grant/state/resource validation, failed-write rollback,
concurrent application, retained live views and an external plugin's delegated
reads/writes without a management privilege. A held native operation completes
through its original revision after window switching; releasing that provider
leaves an explicit unavailable selection without fallback. The 22 plugin-owner unit
cases also pass. The executed commands include `cargo test -p rho-plugins --lib
--locked --offline`, `cargo test -p rho-plugins --test
package_repository --locked --offline`, `cargo test -p rho-plugin-protocol --lib
--test contract --locked --offline` and `cargo test -p rho-host --test
plugin_scenarios --test plugins --test port_contracts --locked --offline`.
Independent strict TypeScript consumption and standalone schema checks also pass.
`npm run generate --prefix ui`, `npm run build --prefix ui` and
`npm run check --prefix ui` pass, as do architecture, plugin-boundary and
documentation checks. The 34 focused window/frame/layout/close/client model cases
and the independent UI SDK checks also pass. Real-R scenario-switching acceptance
has not run; the new manager browser acceptance uses ordinary UI fixtures.

The initial `cargo test -p rho-plugins --test package_repository scenario_ --locked
--offline` was interrupted with exit 130 while macOS waited to load a compiler
dynamic library; it is not a pass. Its log and sample are retained under
`target/plugin-refactor/scenario-repository-initial.log` and
`target/plugin-refactor/scenario-rustc-sample.txt`; the complete repository rerun
passed. These new ports require a rebuilt Host; existing user Hosts and scientific
sessions have not been restarted.

Package activation now supports explicitly selected optional capability grants.
Unselected declarations add no authority, even when the provider is available;
configuration and subsequent views cannot expand the frozen selection. View
delegation still intersects the current parent's scopes. The 56 affected protocol,
plugin-owner, backend and package-repository cases and all 20 Host optional/self
grant, lifecycle and shared-port cases pass. The Files manifest constructor is
updated for the public field; its three backend cases and generated-manifest check
pass. Public protocol generation, an independent strict TypeScript consumer, client
build and generated/embedded-asset checks pass. This change requires a newly built
Host; existing user Hosts and R memory have not been restarted.

The ordinary R package now exposes object, Packages and Help inspection, verified
through disposable native R and an unchanged Host binary. Shared input validation
lives in `plugins/r/api`; the retiring adapter delegates to it. Exact sessions,
busy/unavailable results and native diagnostic codes cross the public protocol.
The R owner now also exposes session-scoped inspection readiness and a cache key
that changes around execution. Objects has a public-SDK connection for this
observation; its independent model checks and the new native readiness acceptance
pass. The Host binary remained unchanged for the independent R package check.
The ordinary R owner also exposes `r.format@1` with exact existing-session and
UTF-8 byte checks, source retention and the shared execution/commit queue. It
uses installed `styler`; complete results remain in original retained reports.
The four public API and ten backend tests pass after generating the contributed
manifest. Independent native acceptance passes through the unchanged Host:
empty/Unicode input, no input evaluation or project-file write, restored options,
large retained results, syntax failure, original-request replay, pending
cancellation and result reads after release. Existing versioned Console execution
also passes in that fixture. The first native run was unconfirmed because the
transport route was omitted; that route is fixed. Two later fixture failures
expected a duplicate Console value and reused a stale pause identity; the fixture
now checks printed output and observes the current pause before explicit resume.
Those failed runs remain retained; the complete rerun passed. Native R tools,
independent public types, generated SDK freshness, client generation/build/check
and architecture/boundary/governance checks pass. Editor now has optional R actions
against an exact configured existing session, plus independently checked captured
selection/line/document requests and formatting-result verification. The controller
synchronizes the original intent before admission, preserves later edits and close
recovery, and refuses replay from a replacement view. Unchanged documents receive
one undoable formatting edit; retained comparisons re-read the original result and
apply only against the displayed document version. These changes do not save a
file implicitly. Independent models, package assembly and native Editor/R/Console
browser acceptance pass, as does the file-only Editor regression. The native case
verifies no implicit R startup, formatting without evaluation, explicit save,
Console output, close/reopen recovery and exact original runs. Editor and formatting
comparison screenshots at 1440, 1920, 390 and 220 pixels were inspected. The first
run exposed a missing normalized null precondition in the captured request;
Editor now preserves that public default. Two subsequent runs failed fixture
viewport assertions (container borders and an element-evaluation argument);
both assertions are corrected and the complete rerun passes. Failed evidence
remains retained. Save-and-run now captures file bytes and the existing R session
together, confirms the original native file receipt before R admission, and
preserves later edits. Unchanged files require a fresh observation without another
write. Its independent checks pass for both admission boundaries, conflicts,
uncertainty, lost acknowledgements and explicit original-view continuation.
Native acceptance passes for the keyboard action, delayed file acknowledgement,
Console output, new-file Save and Run and close/reopen without an unsubmitted R
run; the file-only Editor regression also passes. The updated four-width toolbar,
recovered saved-run state and narrow new-file dialogs were inspected. Editor now
also offers optional session selection through bounded public instance/manifest
queries. Choosing an unstarted provider does not start R; the exact selection is
retained with the draft, separately from each original execution target.
Independent checks and two-provider native acceptance pass: explicit Console
startup, target switching during a run, distinct R memory and restored selection.
The file-only regression passes. Four-width session dialogs were inspected; a
truncated narrow toolbar label was corrected, the complete native rerun passes,
and the affected narrow layouts were inspected again.
Editor font size and indentation now use public view defaults and per-document
settings retained with the draft. Independent checks preserve text, selection,
document version and native file state. Both native browser cases pass, including
actual font size, two-space indentation, undo and restoration after close. The
settings dialog and larger-font Editor were inspected at all four widths, as were
the affected narrow R controls. Shared defaults and default composition remain
within the continuing Editor migration.

The generic `documents.list@1` query now returns bounded synchronized metadata
for one explicit window, with exact source filtering and an exclusive identity
cursor. It excludes discarded drafts, preserves caller/window fences and does not
read content, collect staging leases or start providers. Each page observes current
state; content consumers must verify the returned version and digest. The 12 focused
draft/protocol cases pass, including changes between pages and continuation after
discard. Generated public types, independent TypeScript consumption and client
build and generated-content checks pass. All 11 Host draft/shared-port cases pass
(`cargo test -p rho-host --test plugin_drafts --test port_contracts --locked`),
including closing-source restrictions and refusal of listing after instance drain.
Editor publishes names, paths, text versions, selections and read-only flags with
the same synchronized capture. Its independent controller checks and outside-checkout
package build pass, including later typing, selection-only changes and save-result updates.
Editor now registers ordinary native search/preview contributions, using public
bounded context DTOs and an owner-defined selector. Search matches synchronized
names/paths for an exact Editor revision and window. Preview verifies the original
draft version, digest and all content pages before returning document text or the
captured selection. It preserves Unicode boundaries, labels read-only prefixes,
refuses changed sources and omits captured file/R actions. The independently built
combined UI/backend package depends only on public SDKs and leaves the freshly
built Host binary unchanged. Its four backend cases and executable framed-RPC
fixture pass, including 16 concurrent reads, reversed replies, excess-read refusal,
native errors and release. Native Editor browser acceptance passes for retained
unsaved text after close, stale-reference refusal, selection and bounded large-file
previews without changing disk bytes. The initial three-case browser run timed out
initializing Files before any test body; that failure is retained separately from
the passing reruns of all three cases (Editor, Editor/R/Console and Files).
No initialization deadline changed. The current narrow Editor screenshot was
inspected; existing presentation is unchanged.
Public type generation, independent TypeScript consumption, the Editor model,
client build/check and generated context manifest check pass.

The Host now carries original view window/close-time source restrictions separately
from serialized plugin RPC. Nested backend calls, preflight, controls and accepted
operations preserve that scope; a backend cannot replace it through arguments.
The focused runtime case and all 12 affected Host delegation/draft/shared-port
cases pass. The first delegation fixture attempted release before native settlement;
the final fixture waits for settlement and passes without weakening release rules.
These capabilities require the newly built Host. Existing user Hosts and R sessions
have not been restarted; native acceptance uses disposable projects.

The ordinary Objects, Packages, Help and Plots views are assembled. Packages-to-Help
and pinned Plots comparisons now pass native acceptance in the generic window;
Original Plots export also passes before and after R release. Default scenario
composition remains in progress. The remaining scientific composition, scenario integration and
Plugin Studio stay in scope.

Files/Git contracts, native implementation and search/patch interpretation now
reside under `plugins/files`; shared subprocess supervision and reports live under
`plugins/process`. Retiring adapters and project handlers reuse these owners.
Local process request validation, canonical launch scope and native
inspection/reconciliation now also live under `plugins/process/api` and
`backend/owner`. The retiring process adapter delegates to this implementation.
Native evidence still binds same-user process lifetime and original operation
markers; inaccessible environments remain unknown. The four migrated native
inspection cases pass, as does their independent build/run using only public
protocol/API/engine/owner sources. Both Host process cases pass, covering scope
refusal, shared scheduling, cancellation/commit and original-request idempotency.
Client type generation, build and generated/embedded-content checks pass.
`node scripts/test-process-recovery.mjs` also passes with the current rebuilt
binary: interruption preserves original uncertainty, explicit reconciliation
cleans the tagged parent and detached child, unrelated processes survive, and
repeated original requests do not execute again. All native work used disposable
fixtures; existing user Hosts and R memory remain untouched.

The ordinary `org.rho.process` package now contributes local execution and explicit
reconciliation at version 2, their read-only preflights, and bounded native activity
at version 1. Its independent assembly contains six public/plugin Rust crates and
no private Host dependency. Output bytes and native cleanup evidence use a
verified resource. Unconfirmed report transfer retains uncertainty and bounded
output evidence without re-execution. The native lane stays held until exact
original-operation settlement, and release refuses unsettled work.

Reconciliation obtains a visible terminal original through a scoped `operation.get`
reverse query. It fixes the original project's admitted provider/version/instance
binding; caller-supplied PIDs or replacement scope cannot qualify. Native cleanup
rechecks same-user lifetime and original tags before signalling, records partial
visibility, and leaves the source outcome unchanged. Channel loss ends queued
recovery before signalling rather than waiting forever for an old settlement;
already-started bounded native inspection completes with its actual evidence.

The current independent backend suite passes all nine tests, including native
cleanup preserving unrelated work and queued-recovery disconnect behavior. The
public TypeScript consumer, generated declaration/manifest checks and architecture,
plugin-boundary and documentation checks pass. Executable RPC acceptance passes
transfer uncertainty, false-success settlement refusal, queued cancellation,
16 bounded original reads, reversed reply correlation, missing-source errors,
recovery EOF cleanup, release and forged-provider refusal. Current real CLI
acceptance passes exact Unicode/NUL bytes and resource digests, target refusal,
idempotency, active cancellation, tagged reconciliation and native closure.
A further actual backend-crash case passes: the source becomes uncertain, a new
instance explicitly cleans its surviving tagged process, original uncertainty
and recovery stay immutable, and repeated source/recovery requests do not execute
again. Resources remain readable after provider loss and replacement release;
the preceding normal-release case also passed with this implementation. Independent
construction and all native runs left the previously built Host bytes unchanged.

The first local-execution fixture used the wrong operation identity field; its
corrected run passed. Three earlier combined runs failed backend initialization
before their execution bodies. Sampling the disposable backend found its main
thread at `_dyld_start`, before plugin code, with a 96 KiB footprint. Those timeouts
remain recorded failures; later current-package native and replacement acceptance
passed without changing the startup deadline. This is not a claim that intermittent
system startup delays have been eliminated. SSH/Slurm and the remaining scientific
composition stay in progress. The updated standalone Files/Git closure includes
the public plugin protocol with its five native/API libraries; all 25 file, owner
and process-supervision checks pass after the Process API added resource references.
SSH/Slurm contracts, validation and native execution now live under
`plugins/remote/api` and `backend/owner`; the retiring SSH adapter delegates to this
single implementation. The native owner depends only on public protocol and
plugin-owned Process libraries. It validates the canonical local project before
native work and checks the entire original job reference before cancellation,
including already-terminal observations. Transport loss remains uncertain,
scheduler cancellation requests remain separate from terminal job observations,
and the caller retains source authorization and the authoritative journal.
The retiring Slurm query now requires authenticated context and verifies the
original principal before native reads, closing its previous unscoped read path.
The ordinary `org.rho.remote` package now assembles from seven public/plugin crates
outside the checkout. Its ten contributions provide explicitly configured SSH
execution and Slurm operations, preflight and bounded observations. Default
activation stays disconnected. Original submissions are read through a scoped
`operation.get` grant; recovery freezes the source binding and exact target even
when a replacement instance performs it. Native work stays serialized until core
settlement, and only the core commits operation records. Resource-transfer loss
retains uncertain output evidence without replay. The six focused backend cases
pass in both the main and independent source workspaces. The standalone public
TypeScript consumer and generated SDK/manifest checks also pass. The independent
test first rejected the older default Rust compiler; selecting the already installed
required toolchain passed, and the package build instructions explain that selection.
The executable RPC fixture passes resource loss, bounded/reordered source reads,
pre-start and active-transport cancellation, unsupported scheduler cancellation,
settlement fencing, replacement, EOF and forged-provider refusal. The ordinary
Host transcript passes configured activation, exact target checks, Unicode/NUL
resource bytes, failed/uncertain native exits, original-request idempotency, lost
submission receipt without resubmission, query purity, cancellation observations,
ambiguous-job refusal and immutable source recovery after provider release.
Retained resource reads and original replay also pass after both providers release.
The Host binary was unchanged throughout this independent-package acceptance.
Earlier attempts include an activation timeout and a framed-command reply timeout;
those remain failures, not passes. The complete current rerun passes without
changing deadlines. Fixture corrections normalized macOS temporary paths, bound
fake tool state directly instead of relying on forwarded test environment variables,
and read recovery through the public owner-recovery envelope. These local fake
executables establish no real remote-cluster acceptance. Environment, Agent,
annotation/context, remaining scenario/Studio work and removal of fixed composition
remain part of the active whole-plan implementation.
The six focused API/native cases also pass in an independent five-crate build.
Its executable local transcript passes strict SSH options and literal quoting,
exit-code classification, pre-start cancellation, uncertain timeout, lost submission
receipt, scheduler lookup and cancellation observation without resubmission.
Those checks use fake local executables and do not establish real-cluster acceptance.
The retiring Host transcript also passes original-request idempotency, immutable
source recovery, query purity and ambiguous-job refusal. Its first attempt failed
because the complete capability catalog exceeded the test capture's default 1 MiB
buffer; the corrected bounded capture passes without changing runtime deadlines.
The focused query-gateway test passes native-read refusal for another principal,
missing scope and context-free access, while preserving the authorized principal's
agent reads. Its initial fixture omitted the related operation-read registration;
the complete registered fixture now passes. No real remote target or user session
was changed. Public/client generation, client build/check and architecture,
plugin-boundary and documentation checks pass.

Environment contracts and the sole native implementation now live in
`plugins/environment/api` and `backend/owner`, with their R helpers. The retiring
Host adapter delegates to those public/plugin sources and translates native
uncertainty and confirmed cancellation into the core operation port. The helper
bytes are unchanged; staging, recovery markers and live-library retention remain
in force. The seven focused API/native cases pass. Realization, retention and
cleanup queries now require the original principal throughout the source chain;
the query-gateway regression passes foreign/missing identity equivalence, scope
denial before native reads, authorized Agent reads and mismatched cleanup/source
principals. The same seven cases pass from six public/plugin crates assembled
outside the checkout. Full `node scripts/test-environment.mjs` acceptance passes:
real pak/renv, installer cancellation, live-library retention, quarantine/restore/
purge, commit reconciliation, CLI activation and actual disposable Host crash
recovery, with original outcomes and user libraries preserved. The first run found
an outdated lost-commit assertion; the fixture now verifies durable pending state,
read purity and explicit idempotent reconciliation before purge. A second run
retained material when native process absence could not be established; the
unchanged complete rerun passed. Those failures remain recorded. Client generation,
build/check and architecture, package-boundary and documentation checks pass.

The ordinary `org.rho.environment` package now assembles from eight public/plugin
crates outside the checkout. Its thirteen contributions cover explicit configuration
refresh, pak/renv planning and isolated realization, verification, original native
recovery, inventory, pure library selection and admission queries. Activation and observations do not start
R. A cooperating owner exclusively holds its material directory until release;
replacement requires the same admitted native scope and original source record.
Full reports use bounded, digest-verified resources, including principal-scoped
Host reads of previous-instance reports. Unconfirmed resource transfer retains the
original identity and uncertainty without replay. Accepted work holds its native
lane until matching settlement; EOF abandons queued work and preserves recovery.
The current two public API, six native-owner and eleven backend cases pass in the
checkout, including incomplete resource reads, cancellation, directory replacement,
observation bounds and current library bytes. The previous independent backend
suite passed ten cases; current independent executable wire checks pass
resource failure, settlement fencing, bounded/reordered source queries, queued
cancellation, EOF and forged-identity refusal. `node scripts/test-environment-plugin.mjs`
passes through the existing Host without rebuilding it: real pak/renv, isolated
libraries, failed digest verification, actual installer cancellation with confirmed
descendant cleanup, original idempotency, replacement-instance source consumption,
recovery and retained reports after release. Host SHA256 remains
`405cdc322923c2649ff950dc862f488461b20e7b9319116526943a01b11df2b8`.
Two initial Host initialization timeouts remain recorded, without changing deadlines.
A subsequent run exposed a fixture distinction: refused initialization leaves the
original lifecycle operation uncertain and the instance failed. The corrected
test verifies both states, the native lock refusal, absent process and unchanged
original owner; the full run passes. Public TypeScript consumption, manifest/SDK
consistency, client generation/build/check, architecture/package boundaries and
documentation checks pass. Subsequent material and reference work is described
below; this package does not yet replace the entire Environment feature.
Existing user Hosts and R sessions were not restarted;
the relocated Host adapter requires a new binary.

The ordinary R package now supports explicit Environment binding through
`r.create_session@2`. Three optional grants are selected at activation; default
creation still works without Environment. Preflight pins the exact provider,
original realization, report, library digest and configured R installation without
starting R. Creation delegates native verification as a child of the original
Operation, checks its complete retained report and unchanged library, then launches
Ark and confirms the actual R installation. Lost replies retain original recovery
identities without automatic replay. Session observations distinguish verification
failure, uncertainty and native launch; existing sessions keep their original binding.
The four public R API and twelve backend cases pass. Both independent packages build
outside the checkout using only public/plugin sources; R adds only public Environment
and Process contracts. Its shipped wire test passes grant refusal, 16 bounded and
reversed reads, lost/failed verification, no retry, exact settlement, release, forged
identity/reply refusal and EOF during delegation without starting R. Native
`scripts/test-r-environment.mjs` acceptance passes through the unchanged Host above:
default/bound R revision coexistence, digest refusal, parent/child records, idempotency,
actual package use, failed namespace validation without session creation, replacement
Environment consumption of the old realization and retained reports after release.
The first wire fixture used an invalid uppercase instance alias; it was corrected
and the complete rerun passes, with failed evidence retained. One slow test startup
was sampled at the system loader entry before test code; all tests subsequently
completed, without changing any startup deadline.
The default-session `scripts/test-r-format.mjs` native regression also passes,
including Console execution, original results, failed syntax and pending
cancellation. Independent public types, both generated SDKs and the Environment
manifest, client generation/build/check, architecture/package boundaries and
documentation checks pass. These ordinary package changes require importing the
new revisions, not rebuilding the verified Host; no running user session was changed.

The generic core now implements `operation.project_coverage@1` and
`plugins.project_coverage@1`. Both require an explicit `project.references.read`
grant plus the normal owner read scope. They expose only whether the authenticated
principal can see all recorded project operations or instances, including failed
and released instances; foreign records and identities stay hidden. Unsupported
journals remain unavailable. This closes a prerequisite for ordinary Environment
reference inspection: an empty principal-filtered page cannot establish that no
other references exist. Coverage neither starts nor recovers a provider and does
not freeze references or authorize cleanup. All three focused storage/owner cases
and eight Host cases pass, including explicit grants and original-principal
delegation through an ordinary view. An initial plugin test fixture passed an owned
path where a reference was required; it is corrected and the complete focused rerun
passes. Public protocol generation, an independent strict TypeScript consumer,
client build and generated/embedded-asset checks pass. Architecture, plugin-boundary
and documentation checks pass; the focused cases are in the source/check index.
These capabilities are included in the new test Host below; existing user Hosts
and R memory have not been restarted.

The ordinary Environment backend contributes 21 capabilities, including bounded
material retention/status queries and explicit quarantine, restore and purge with
their preflights. Optional public reads check project coverage, original successful
results, recorded provider instances and idle R library/namespace usage. Ordinary
R capture and reconciliation results are now recognized through the public R API.
Environment verifies the original admitted result, asks an active `r.checkpoint@1`
reader to qualify its current control state, then protects the library, namespace
and selected Environment paths in the digest-verified public manifest. It reads no
private R archive or control files. Logical deletion removes graph dependencies,
including pending physical cleanup; missing payload bytes alone do not. Incomplete
dependencies and unsupported versions remain retained. Unsuccessful captures use
the optional public `r.capture_attempt@1` observation: only an exact committed
disposal, confirmed source-provider release and absence of both graph and staging
bytes release their protection. Missing bytes alone remain insufficient. Failed
or cancelled captures are also excluded when R confirmed the capture never started.
Uncertain pin/delete requests and resolution attempts use an additional optional
`r.checkpoint_control@1` read. Only an exact committed resolution closes their
uncertainty; the original successful capture is still checked for live dependencies.

`checkpoint_reader` selects an exact active supported instance. Without an explicit
choice, the original active reader is preferred, then a unique active replacement.
Ambiguity and an unavailable explicit choice retain material. An unstarted reader
can qualify old copies without starting R or selecting a capture helper. Missing
grants, foreign coverage, changing observations and busy/disconnected R remain
conservative refusals. Mutations re-read the admitted source chain and validate
native process absence, owned paths and preview fingerprints. Original paths stay
protected after quarantine; an unconfirmed quarantine remains inspectable without
promoting its outcome. Original records and reports survive material removal.
The scan is not a reference lease or an atomic cross-owner snapshot.

`cargo test -p rho-environment-backend --lib --locked --offline` passes all 20
backend cases, including 16 checkpoint-evidence scenarios, nine uncertain-control
resolution scenarios, 12 capture-disposal scenarios, exact reader selection and the existing 22 reference-scan
scenarios. Public SDK/manifest checks, independent TypeScript consumption, client
generation/build/check and architecture/plugin-boundary checks
pass. The nine-package standalone build and its wire tests pass. Full native
`node scripts/test-environment-plugin.mjs --checkpoint-references` acceptance passes:
two live R sessions, paginated original records, library/namespace protection,
checkpoint capture, protection after namespace unload and provider release,
unavailable-reader retention, unstarted replacement reads, ambiguous-reader refusal,
exact configured selection, pin/unpin, uncertain deletion and resolution retry,
retention before explicit completion, unpublished capture protection, uncertain
disposal with missing bytes, explicit disposal confirmation, purge, stale fingerprints, material
quarantine/restore/purge, idempotency and unchanged original records/reports. The
Host remains byte-identical, SHA-256
`3a9db963f49aeaa313e7db75f25f345a8c84fb7d20877eb1a5754be849bfe24a`.

The first native capture-disposal acceptance returned unavailable because a same-user
process lacked observable environment or lifetime evidence, before reaching the new
cases. Its log and disposable project remain retained; the evidence location is
recorded in `target/plugin-refactor/environment-capture-disposal-native-v1.log`.
The complete isolated v2 run passed without changing guards or deadlines. Unfiltered
workspace metadata was unavailable because `combine 4.6.8` was not cached; the
affected offline build and independent package's host-filtered metadata passed.
Existing user Hosts and R sessions were not restarted. Studio integration and
removal of fixed composition remain active.

The ordinary R owner now exposes capture, bounded listing/reads, restore,
pin/unpin, logical deletion, physical cleanup and explicit capture reconciliation.
Public recovery references name the exact project, provider, original Operation,
digest and byte count. Complete manifests and restore reports use core resources;
larger graphs retain the scoped native archive's 16 GiB limit. Original core
admission, caller visibility, retained manifests and native evidence must agree.
Project journal coverage is required before interpreting control absence. Native
control files establish no scientific truth; artifact leases remain held through
matching core settlement. Deletion commits logical retirement before physical
cleanup, whose failure remains observable and explicitly retryable. Unknown,
missing or unresolved uncertain control history remains unavailable. Queries,
controls and reconciliation never start R. Restore requires the exact existing
empty candidate and verifies the full payload and native prerequisites. The existing verified
helper is selected explicitly before session creation, without installation.

Reconciliation copies complete native evidence from a terminal failed/cancelled/
uncertain capture into a new identity and never rewrites the original outcome.
Missing capture context preserves unknown namespace dependencies. Partial bytes
without complete native evidence cannot be adopted. Automatic capture requires an
idle settled queue; pending cancellation retains `started:false`. Argument digests
freeze normalized semantics, including equivalent JSON numbers across languages.

Terminal failed/cancelled/uncertain pin/delete requests now have explicit resolution
through version 2 of the same capability. `r.checkpoint_control@1` exposes the
original outcome, committed resolution and latest attempt. Apply checks the
original precondition and creates a new control head; discard closes only the
request, preserving the current state and head. A failed/cancelled/uncertain resolution
requires the exact latest attempt before continuing. Original outcomes remain
unchanged, and only Core-successful applied deletion authorizes payload cleanup.
Old readers reject the new control version.

Unpublished failed/cancelled/uncertain capture material now has an explicit
inspection and disposal path. `r.capture_attempt@1` observes a fixed set of native
metadata without hashing graph bytes or creating absent storage. Its opaque
fingerprint fixes the exact preview. `r.discard_capture@1` requires confirmed release
of the original provider and removes only payload/staging bytes, preserving metadata,
native leases and original outcomes. Failed/disconnected/cleanup-failed providers
do not prove writer absence. A lost result after removal stays uncertain; a fresh
explicit disposal can confirm absence. Successful published copies continue through
normal deletion controls. Independently adopted copies remain restorable.

The current four API, 26 backend and 31 engine library cases pass.
`cargo test -p rho-r-api --lib --locked --offline` covers the public API;
`cargo test -p rho-r-backend -p rho-r-engine --lib --bin rho-r-backend --locked
--offline` covers the owner, archive and routing changes against the generated
manifest. Independent public types,
generated SDK/schema consistency, client generation/build/check, architecture,
plugin boundaries and documentation checks pass.

`scripts/test-r-recovery.mjs` passes through an independently built ordinary package
and unchanged Host: explicit grants, pure observations, partial Unicode graph and
alias preservation, original replay, pending cancellation, replacement reads,
bounded bytes, digest damage, empty-candidate restore, pin/delete preconditions,
explicit apply/discard, repeated uncertainty for pin and deletion resolution,
unchanged original outcomes, payload retention until confirmed deletion, cleanup,
retained history and reconciliation after a rejected result. Capture-disposal
acceptance adds partial graph/metadata files, stale-preview refusal, source-release
requirements, lost confirmation after actual removal, fresh explicit confirmation,
retained originals and restoration from an independent adopted copy. An explicitly supplied
older package refuses version-2 controls without starting R; version-1 deletion
remains covered; the old reader also cannot adopt a disposed payload. Missing capture context is also tested. Initial checks found an
unsupported cancellation enum and a stale generated index; both were corrected. A fault fixture first changed a
registered contract and was correctly refused; it now faults only the returned
plan. This exposed and fixed strict `10.0`/`10` comparison. A later fixture backend
initialization timed out; that run remains failed evidence. A separate test process
was sampled at the system loader, and the complete native rerun passed after
other checks finished, without changing deadlines or guards. The current resolution
acceptance passed in its first full isolated run. The current R capture-disposal
acceptance also passed first run; Environment's complete rerun is recorded above.
A slow engine test launch was sampled at macOS `_dyld_start`; its original
process subsequently completed all tests without a timeout. Studio recovery
integration, the remaining whole-plan migration and removal of fixed composition
remain active. No user Host or R session was restarted.

The ordinary `org.rho.files` backend now assembles outside the checkout from eight
public/plugin packages, with no private core dependency or independent journal.
Its nine capabilities expose bounded file/Git observations and explicit patches.
The public `workspace.paths@1` query supplies Host-owned protected paths under
`project.read`, without changing backend initialization fields or accepting caller
configuration as authority. The original native libraries' 25 standalone cases
and 23 Host project/ownership/path cases remain the prior regression evidence.
Three backend unit cases and independent executable protocol/native Host
acceptance pass. They cover exact revisions, protected stores and aliases, native
hash/head preconditions, unchanged staged/dirty/untracked files, journal failure
after a real patch, original-result reconciliation and historical replay after
release/removal/restart. The compiled Host acceptance target remains byte-identical
across the external package build. Returned patches retain their lane until exact
journal settlement; a transport acknowledgement cannot confirm cancellation.
Query/preflight failures now retain provider codes across the generic Host bridge.
The 26 Operation and 10 plugin unit cases pass; updated native Files acceptance
verifies changed-content, wrong-target and busy diagnostics, plus writes from both
exact revisions with separately owned facts. Generated Files capability schemas
match their public types. All 19 Host lifecycle/shared-port/path regression cases
pass (`cargo test -p rho-host --test plugins --test port_contracts --test
plugin_workspace_paths --locked`). Transient Control diagnostics remain redacted.
The same Files package now includes its public-SDK view, built outside the checkout
without changing the Host binary. The directory/search model has one owner in the
package; the retiring UI delegates to it. The view binds its own exact backend,
preserves cached continuation pages during background refresh and serializes its
presentation state. Opening captures a native file identity and retains the
original navigation request before invoking the exact configured Editor instance.
Missing Editor configuration disables navigation; a new draft does not create a
file. Exact self-capability requirements can be granted before first activation,
without publishing capabilities before readiness or expanding caller scopes.
The focused Host self-grant case passes, as do 26 independent Files UI cases,
the 506-case client suite, the later nine-case retiring Files model check, client
build and generated/assets check. Native Chrome acceptance now passes in the
generic window: directory/search, explicit buttons and Enter inside the sandbox,
synthetic composition guards, exact navigation, close capture/reopening and an
external file change. Screenshots at 1440, 1920, 390 and 220 pixels were inspected.
The initial browser failure exposed blocked form submission; explicit events fixed
it without relaxing the iframe sandbox. Native input-method
acceptance is not established by synthetic composition events. An optional ad-hoc
browser TypeScript check was unavailable because Node type definitions are absent;
the standard browser runner executed successfully. The fixed Files/Editor
composition is not yet replaced. A newly built Host is required for the added
query and self-capability grants; existing user sessions have not been restarted.
All 18 Host plugin/shared-port regression cases also pass after the combined-package
grant change (`cargo test -p rho-host --test plugins --test port_contracts --locked`).
Files now opens the actual ordinary Editor through explicitly declared navigation
scopes, intersected with the caller. Native browser acceptance passes for opening
and editing a selected file, creating an unsaved document then explicitly saving,
and detecting a file changed after the Files capture. Explicit refresh opens that
new observation and subsequent editing/save works. The independent Files build,
26 UI cases, three backend cases and generated-manifest check pass. The Host binary
remains unchanged. The four responsive Files screenshots and its Editor destination
were inspected. Navigation grants do not create direct Files draft/write grants.

Editor migration now has a generic draft contract and repository owner, separate
from the 256 KiB view-state record. It verifies bounded chunks and complete content,
uses document-specific versions, preserves concurrent upload leases and protects
the exact source revision. Core-only retention hooks keep accepted captures until
original settlement, including across repository reopening and successor edits.
Discard refuses pending settlement; explicit completed discard leaves a tombstone
to fence delayed saves. All 34 affected protocol, plugin-owner and package-repository
cases pass, including 11 draft-specific cases (`cargo test -p rho-plugins -p
rho-plugin-protocol --lib --test package_repository --locked`). Generated public
declarations compile in an independent strict TypeScript consumer; client build
and generated-type/embedded-asset checks pass. The shared Host now registers scoped
`documents.inspect/read/stage/save/discard` ports. Save admission retains the exact
capture; original commit settlement releases it. All five Host draft cases pass
(`cargo test -p rho-host --test plugin_drafts --locked`), including greater-than-1-MiB
Unicode content, view grants/window fences, stale versions, discard/removal,
original replay, failed cleanup and durable commit recovery after restart and
successor edits. An uncertain result without a durable candidate retains its bytes
and refuses discard; matching current content cannot establish the lost outcome.
Public SDK byte capture/staging/verified reads also pass
the independent strict TypeScript consumer and transfer checks
(`node scripts/test-plugin-ui.mjs`), and client build/check pass. Close-time flushing
now permits exactly the declared self-draft staging/save ports while retaining
original scope and source fences. A draining instance's open view can finish its
flush; all renderers must acknowledge before further writes are sealed. Open views
still prevent completing instance release. The focused Host target covers this
lifecycle and 13 existing Host plugin regression cases pass after the change
(`cargo test -p rho-host --test plugins --locked`).
The independent native-browser draft fixture passes (`npm run test:browser --prefix
ui -- plugin-drafts.spec.ts`): greater-than-512-KiB Unicode content, holding the
original save receipt before closure, exact restoration in another view, two
original saves, final release/discard/removal and unchanged sandbox. Both screenshots
were inspected. The generic window browser case also passes. The initial large-text
Fill attempt timed out before saving; the retained failure is separate from the
passing rerun, which seeds bulk fixture text after a small normal input. This is
transport/close acceptance, not Editor input performance or native IME acceptance.
The first lifecycle test also incorrectly expected release to succeed with an open
view; its corrected expectation preserves the established draining lifecycle.
The ordinary Editor source now has independent document, exact Files-read and
draft-synchronization models (`node scripts/test-editor-plugin.mjs`). Their external
strict TypeScript build and checks pass: BOM/mixed newline preservation, resident
undo/selection, later edits after a captured save, bounded read-only previews,
page/full-content verification, queued frozen drafts, original-request inspection
and retry, copied-view refusal to replay, and failure/uncertain retention. Large
invalid-UTF-8 files retain a bounded replacement preview. The independently built
Editor owner currently has no retiring-client import.
The ordinary Editor now assembles outside the checkout as an installable UI package,
without changing the Host binary. Its file controller durably captures the native
save intent before admission, verifies the original receipt, and preserves edits
made while that save is pending. Close preparation captures outstanding work without
waiting for native completion. Independent controller checks pass, including native
conflicts, explicit Save As replacement, idempotent retry and false-receipt refusal.
Native Chrome acceptance passes (`npm run test:browser --prefix ui -- editor-plugin.spec.ts`):
real CodeMirror edits, held admission reply during close, restored later edits and
original-result inspection in a new view, exact BOM/newline file bytes, Unicode
Save As and a 333,903-byte file whose retained draft exceeds the view-state limit.
The current test observes exactly four native file writes and no R execution. Screenshots
at 1440, 1920, 390 and 220 pixels, narrow Save As and the restored large file were
inspected. The initial run failed only its final history query's excessive page
size; the rerun uses bounded pagination and passes. The first independent build's
composition-event typing error was corrected before the successful assembly.
Disk comparison now retains the exact observed bytes in the synchronized draft and
survives reopening. Both choosing the disk version and retaining local edits check
that the observed native digest still matches. Neither choice writes the file;
an explicit later save uses that base. Model and native browser checks cover another
external change, explicit refresh, retained local edits, exact disk replacement and
resident undo. A withheld admission acknowledgement also leaves the comparison
dismissible and the original draft-save inspection reachable; native file bytes
and later edits remain unchanged. This uses a live-channel error reply. Its first
fixture instead aborted transport, correctly fencing the frame, and was corrected
to test the intended dialog recovery without changing transport behavior.
Comparison screenshots at 1440, 1920, 390 and 220 pixels were inspected after
waiting for the iframe's actual resized viewport; no clipping or overlap remains.
The first combined browser
run timed out initializing the Files backend before the Editor test body; its
failure evidence is retained separately. Files passed in that run, and the isolated
Editor rerun passed with the same artifacts. No startup deadline was weakened.
Native input-method acceptance is not established. Dynamic outer tab labels
and default composition remain to be completed. The retiring Editor still owns
the default workspace experience.
These draft ports require a newly built Host; no existing user Host was restarted.
All 20 existing Host plugin, scoped-path, self-grant and shared-port regression
cases also pass (`cargo test -p rho-host --test plugins --test port_contracts
--test plugin_self_requirements --test plugin_workspace_paths --locked`).

The Host regression exposed a lease-release case reproducible with the pre-change
ownership source: a duplicated descriptor kept the project locked after its last
owner ended. The last owner now explicitly unlocks. Its focused check and all
seven ownership cases pass, including retention by accepted work and reacquisition
without removing the lock file.

### Implemented behavior

`rho-plugin-protocol` defines public package, revision, instance, provider, scenario,
visual-document and RPC contracts. `rho-plugins` owns immutable source/artifact
identities, validated local archives, transactional import/export, revision
references, branch compare-and-swap, source comparison and bounded repository
pages. Sources, dependency locks and build instructions are required. The recovery
CLI, `rho plugins --store ...`, works without a scientific Host. Packages are not
activated or reinstalled implicitly, and native builds are explicit trusted local
code. Scenario storage is implemented above; it and the visual-document contracts
do not establish their product UI or atomic window switching.

Backend instances run immutable artifacts in separate processes. Exact readiness
precedes atomic contribution publication. Binding resolution is explicit; accepted
work retains its original provider through draining. Bounded framed RPC checks
identity/order, keeps logs off control messages and enforces parent authority for
reverse calls. Cleanup requires acknowledgement and process exit. Failed or
historical instances retain diagnostics and references without being restarted by
a query. Public Rust and TypeScript SDKs build independently of private core code;
the protocol generates TypeScript declarations and language-neutral JSON schemas.

The plugin bridge uses the existing Operation/Query gateways and SQLite journal.
Native preflight freezes the qualified request before admission. Repeating an
accepted request returns the original record after unload without another preflight
or execution. Invalid candidates and uncertain outcomes retain recovery material.
Validated native results are staged and committed through the original journal;
`operation.commit_status` and `operation.reconcile_commit` expose explicit original
commit recovery. A committed result releases its live provider protection only
after exact native settlement acknowledgement. Timeout or lost acknowledgement
retains the result and lease; reconciliation resends confirmation without repeating
science. Recovery attempts remain Host-owned across edge disconnection.

Host, CLI and MCP use the shared ports for repository/lifecycle operations,
contributed capabilities and scoped observations. MCP follows current registrations,
with content-bound cursors and change notifications. CLI execution, query and
control capacity are separately bounded; a full execution queue does not block its
reader or controls. Ephemeral native controls preserve original authority and do
not create an Operation or persist stdin answers.

The generic resource owner stores immutable project/principal/instance-bound bytes.
Native uploads use an ephemeral per-instance socket with an active parent request;
large bytes stay off the control pipe. Length/digest checks, leases and byte/count
quotas precede retention. Incomplete transfers never become evidence. Scoped
`resources.list`, `inspect` and `read` remain available after provider release,
package removal and Host restart. Resource claims are checked before scientific
commit; no adapter owns a second result database.

The generic view container serves UI-only packages in opaque iframes with private
MessagePorts. Asset/call credentials are separate, and generic Host credentials
stay in the containing shell. Window, principal, grant, sequence and quota checks
apply to each connection. Normal Operations own opening, closing and versioned
state updates; acknowledged state survives closure and restart. Closing revokes
future view calls and leaves accepted native work running. The standalone frame
still needs integration into scenario layouts, along with public focus, theme,
menu, shortcut and context cooperation.

The generic window layout source now stores bounded split/tab arrangements under
project, principal and window identity. Public read/update ports validate view
ownership and expected layout versions; view callers are restricted to their own
window. Private view connection credentials are also refused to plugin callers,
even with a declared query grant. Reads and saved placeholders do not reopen views
or alter their state.
`windows.open_view` now creates the view, retains its revision and selects it in
an explicit tab group in one transaction. It checks the exact active instance,
schemas, window scope and expected layout version before admission and again at
execution. Failed writes roll back the view/reference/layout together; original
request replay cannot create a second view. Direct view opening also refuses a
view caller's attempt to open another window. All eighteen Host plugin/port-contract
cases pass, including forced storage failure and concurrent placement conflicts.
A generic docking adapter, fixed iframe content layer and serialized
presentation-save model now use the shared Host ports. Their unit checks and
isolated Chrome fixture pass, including actual pointer dragging, hidden tabs,
layout reconstruction, focus and retained Unicode drafts at 1440/1920/390 px.
The fixture delegates closing without removing the frame. The generic application
entrypoint now passes composed-window browser acceptance; default
scenario application and removal of the fixed workbench layout remain pending.

View closure now defaults to cooperative draft flushing. The public SDK registers
each document, refuses preparation during text composition, pauses interaction
while its handler captures state, and acknowledges the original close Operation
and exact saved version. The owner fences new actions and waits for all registered
documents; refusal, conflicting versions or the 15-second deadline preserve the
open view. Final closure, exact tab removal and revision-reference release share
one transaction. Forced storage failure rolls them all back. Accepted scientific
work is unaffected. Objects, Console and Viewer install close handlers; Console
refuses an unsent transient answer rather than persisting it. A lost preparation
reply remains unconfirmed. Reload/disposal cannot attest to a destroyed buffer;
explicit retained-version recovery is available without claiming those edits were
saved. Host shutdown retains acknowledged state and layout placeholders. Native
Host and SDK checks pass. Chrome verifies the synthetic composition refusal, real
view-state storage failure, draft/focus recovery, successful final capture and
fenced delayed clipboard completion. Console and Viewer also pass their updated
disposable native R paths. Objects now verifies close-time capture, reopening and
actual pointer receipt inspection in the generic window. Its older standalone
path has an unresolved pointer-routing failure after a second page is resized.

Public text-copy cooperation now validates the exact live view, window, principal
and current parent authority before the containing browser reserves a native write.
The focused frame must have a current user gesture. Asynchronous collection can
complete after that gesture expires; failure, expiry or pre-submission closure
releases the reservation. Success requires browser acknowledgement. Direct iframe
clipboard access stays disabled; the SDK exposes no clipboard read, text retention
or additional Operation. A submitted native write is not described as reversible.

R-owned contracts live in `plugins/r/api`; the sole R implementation and seven
unchanged bridge files live in `plugins/r/backend/engine`. The legacy Host adapter
still reuses that implementation while the remaining composition migrates. The
ordinary `org.rho.r` package builds outside the checkout from its sources, public
SDK/protocol and pinned Jet. Initialization receives the normalized Host project
root and a unique retained data directory. Activation and queries do not start R.
Explicit session creation starts one native session per exact instance; existing
sessions are never attached to a different revision.

`r.execute@2` accepts native run options and preserves caller-supplied source labels
in the queue, original Operation and result. Labels do not attest to synchronized
document capture. Console mode prints native visible expressions. `r.check_code`
uses an existing idle parser without evaluation; `r.output_events` reads bounded
ordered pages with exact owner/session, cursors and gap/truncation notices. Reports,
event logs, PNG and HTML use retained resources. Lost sessions are observed without
replacement. Native stdin uses exact session/operation/request/reply identities,
UTF-8 limits and transient controls; input and reads remain available while draining.

Seven contributed R inspection queries cover object directories, binding previews,
progressive object reads, installed package copies, static indexes and Help. Trusted
Host identity supplies observation scope; payloads cannot supply project or
principal. Queries require the exact existing native session and return explicit
busy/unavailable envelopes without starting R. Continuations preserve original
references, filters and file identities. Results exceeding 256 KiB become an
explicit budget failure. Inspection does not force active/lazy bindings, load or
attach packages, change search/library paths, test loadability, or create execution
records. Grouped package counts and copy details share one observation. Missing
Help-rendering providers remain unavailable instead of being loaded by a query.

`r.inspection_state` observes the existing owner without entering R. Its cache key
lets views invalidate data after a short run completed between polls, including
failed or uncertain native returns. Read-only inspections do not change the key.
It establishes neither a scientific precondition nor an Operation outcome.

The R package owns a FIFO of 33 original operations, including returned work
awaiting settlement. Pause/resume use exact queue/pause identities and optional
operation-scope fences. Failure, cancellation, uncertainty or uncommitted results
pause followers; Host restart never replays them. Pending-only cancellation now
negotiates `pending_cancellation_v1`. The owner atomically fences a waiting run and
waits for the original journal cancellation signal before completing it. Running
or unsupported work is refused without an interrupt. Lost replies and journal
write failures retain the same identity for retry. Returned invocations retire
unanswered preparations and accept only matching late replies. Cancellation is a
callable Host Control handler delegating to the original gateway, shared by typed
and generic requests and retained across view disconnection.

The ordinary `org.rho.viewer` package independently reads original terminal R
Operations and digest-verified retained HTML. It pins the producing instance,
revision and artifact, checks source labels and supports execution versions 1/2.
History, source inspection and rendering do not invoke R. Saved selection survives
reopening; HTML runs in a second opaque iframe and remains readable after release,
removal and restart.

The ordinary `org.rho.console` package passes its isolated editing and disposable
real-R browser paths. It pins one R instance and provides a selectable
CodeMirror transcript, original source/run details, independent command drafts,
native completeness, live/retained events, immutable queued code, pending-only
cancellation and explicit Interrupt. Draft capture must succeed before submission
or retry; acceptance preserves newer edits. Captured request identity cannot be
replayed from a different view. Stdin is a separate transient field; buttons and
Enter use the same explicit Control, with composition and duplicate-send guards.
Password values never enter saved state or history.

Console history scans bounded pages past unrelated view-state writes and retains
100 completed runs plus active work. The limit is visible; exhausted pagination
never restarts at the first page or drops recent work to display an older page.
Clear View records observed event positions, so later output from the same active
run appears and Show History restores the retained transcript. Transcript updates
preserve unchanged text, and saved scrolling is restored after content is laid out.
The isolated browser check verifies selection across transcript updates and saved
scroll restoration. The real-R path verifies native input and visible expressions,
immutable queued code and pending cancellation, acknowledged draft restoration,
execution continuing after view closure, and retained transcript reads after the
R instance is released and its revision removed. The close-time handler now drains
local acceptance/capture tasks and saves the current editor draft without waiting
for R execution. The updated real-R browser case verifies immediate final capture,
R still running after closure, eventual completion and retained draft restoration. Plot navigation and full
native interaction acceptance remain unfinished.

The Objects model and React directory, table, vector, field and summary components
now have independent sources under `plugins/objects`. They consume public R
inspection envelopes and preserve native diagnostic codes. Connection-local
services replace the private Studio context. Copy actions reserve the container's
native gesture before collecting complete values and retain their original
observation fence. Model, expanded-view and copy-flow tests pass outside the
checkout. Its channel connection pins the exact provider and first native session,
including after restoring saved state. Busy reads defer retries, and owner changes
invalidate retained observations. State writes are serialized so reverting an edit
during an in-flight save cannot lose the final state; failed saves remain visible
and retryable.

Objects now assembles as an independent ordinary package with directory and object
contributions. Open in New Tab targets an explicitly configured group (or its own
observed group) through the atomic window port. Explicit Render plot captures its
original request, view, R provider, session and code before execution; failed state
capture prevents submission. Lost replies retain the request for explicit retry.
Copied pending state cannot replay from another view; bounded original-operation
reads can recover an acknowledged receipt without submitting work. The independent
build, all 64 model/component/action checks, prior isolated browser flow and disposable
native R flow pass. Native reads leave R unstarted, exact objects open through the
atomic window port, explicit plotting commits a PNG on the original Operation,
and reopening restores acknowledged filters and can inspect the original receipt.
The SDK exposes the Host-scoped request ID used for receipt matching and read-only
recovery. All nine directory/table/action screenshots at 1440, 1920 and 390 px were
inspected. The close handler pauses observation and captures the latest presentation choices;
its connection and native browser checks pass, including immediate close before
autosave. The current native case passes in the generic window (9.0 s body,
27.1 s total), including automatic inspector placement, retained directory identity,
actual pointer receipt inspection and close/reopen recovery. All six directory and
table screenshots at 1440/1920/390 px were inspected. The prior standalone pointer
failure remains separate; the current case does not claim to fix that path.
Default scenario wiring and remaining native interaction acceptance are still
required before replacing the old UI.

The ordinary `org.rho.packages` package now assembles outside the checkout with
its approved compact list, wide inspector, copy-specific source details and
read-only R/library dialog. Counts, index pages and installed-copy details remain
pinned to one observation and native session. Native expiry codes retain the
original observation until explicit refresh. The public-SDK connection pins the
provider/session, labels busy observations and captures final presentation choices.
Documentation captures the chosen copy before observing layout, saves the original
request, then opens the explicitly configured Help instance through the atomic
window port. Lost replies retain the request identity; copied state can inspect
its original Operation without replaying it. Source and project links use generic
external-link cooperation. Thirty-one independent checks and the isolated browser
flow pass; five normal/wide/narrow/source/busy screenshots were inspected. The new
native Packages-to-Help case also passes in the generic window (12.0 s body,
30.4 s total): original copy navigation, unchanged namespaces/search/library paths,
actual pointer receipt inspection, closing while R remains busy and restored
choices. All four native screenshots were inspected. Default scenario composition
and the separate Environment configuration destination remain pending.

The ordinary `org.rho.help` package now builds outside the checkout with only
public R/plugin contracts. It pins the selected installed copy's original provider,
native session, package observation, library and version. Topic/alias indexes and
UTF-8 content continuations retain file identities; expired observations and changed
files require explicit reselection. Late responses cannot replace a newer topic.
Static HTML is rebuilt without executable content or fetched resources; incomplete
markup stays raw. Same-copy links and anchors work, while cross-package links
require another installed-copy selection. Explicit external links now use the
public container interface, with errors left visible and Copy Link retained. Its
SDK contract, isolated presentation and actual containing-browser link checks pass.
The browser verifies a new tab without an opener or referrer, explicit gesture
admission and unchanged Operation history. Image resource delivery remains to be added.
Topic, search, index choices, raw display and scrolling are captured on cooperative
closure. Forty-one independent model/connection/content checks, the isolated browser
flow and disposable native R flow pass. Native `stats::lm` reading preserves loaded
namespaces, search/library paths and execution count; closing during execution
retains choices without ending R. The 1440/1920/390 px reading views and narrow topic
list were inspected. Packages-to-Help presentation passes its isolated fixture;
native same-window navigation passes; production scenario placement remains
integration work. The
retiring Help implementation is still present.

Plots now has an independently assembled ordinary package using the existing
presentation. Original Operation/provider/session/source/resource identities are
checked before accepting retained PNG, JPEG or SVG output. Bounded byte reads
verify the final digest before creating view-local image URLs; the cache protects
selected originals and revokes URLs on disposal. History scans continue through
unrelated view writes without repeatedly returning to their first page. Selection,
zoom, pan and follow/history choices are captured independently of R. Opening a
pinned comparison saves its exact original resource and request before the atomic
window action, and lost replies cannot retarget it. Reopened comparisons prefer their final saved
selection over their initial configuration. Thirty-one independent checks
and the isolated browser flow pass. Normal, wide, 390 px, 240 px and details
screenshots were inspected. Native acceptance also passes in the generic window
(12.2 s body, 28.5 s total): actual PNG reads, an independent pinned comparison,
actual pointer receipt inspection, closure during R execution, final choice capture
and retained image reads after R release. Original export uses the generic container
feature; actual downloads preserve exact PNG bytes and identity both before and
after R release without another execution. Download status remains visible inside
Details. All six current native screenshots were inspected, including settled
narrow Fit, export, pinned and following views. Default scenario placement remains
pending. This is not the finished replacement.

The generic `?plugin-window` entrypoint now uses the shared layout and view ports
to compose contributed frames. Window observations keep original scope and
instance identity, retain hidden documents and discard them only after confirmed
closure. Local layout saves preserve original requests across lost acknowledgements.
Closing a tab requests a cooperative flush; an uncertain acknowledgement retains
the original request, while a confirmed failure permits another explicit attempt.
Affected model/component checks, client build and client check pass. Actual
composed-window browser acceptance passes (5.8 s body, 15.1 s total), including
automatic placement, retained drafts, close refusal and retrying a lost original
acknowledgement. All three viewport presentations were inspected. A confirmed
flush failure now offers explicit recovery using the
observed saved version, with a cancel choice that keeps the view open. The close
request captures that version; an uncertain acknowledgement cannot be retargeted.
The shared-port client retains structured diagnostics correlated to the original
frame and request. This lets an invalid close preparation (including a missing
document handler) offer recovery without misclassifying transport loss or an
uncertain Operation. Fifty affected model/component/transport checks, client build
and frontend boundary checks pass. Browser acceptance verifies cancel preserving
the unsaved buffer, exact retained-version recovery and missing-handler admission
rejection without an Operation. The final 390 px recovery dialog was inspected,
including its stacked controls and single failure message. This remains an integration entrypoint; the
fixed default shell has not yet been removed.

Generic original-resource download now has a public request, Host admission and
containing-browser wiring. Six unit checks cover bounded allocation, exact
identity, continuations, digest verification, final authority rechecking and
closure; public SDK and standalone protocol compilation also pass. The independent
browser primitive previously passed exact-byte SVG download with a Unicode
filename and refused corrupted bytes (1.4 s total). Affected Rust and client checks
pass. Actual scoped SDK browser acceptance also passes (1.7 s body): a 2,100,003-byte
original survives multiple chunks with its Unicode filename and exact digest;
automatic/foreign requests are refused, and closing during collection prevents
the later download. These interactions add no scientific Operation. Native Plots
export and composed Objects acceptance pass separately as described above.

### Current verification

Cargo checks remain serial with `CARGO_BUILD_JOBS=1`. Slow local compiler and test
executable startup is allowed to finish; silence is not treated as a test failure.

| Executed check | Result and scope |
| --- | --- |
| `cargo test -p rho-files-owner --lib --locked` | Four passed: native hash/absence preconditions, success/failure/uncertain effect classification, recovery after post-write observation failure, and query-bound search continuation. The retiring project handlers delegate to these same functions. |
| `node plugins/files/generate-sdk.mjs`, `node plugins/files/generate-sdk.mjs --check`, `node scripts/test-files-protocol.mjs` | Public Files declarations/schemas generated and verified; an independent strict TypeScript consumer passed without private client imports. |
| `node scripts/test-files-plugin-engine.mjs` | Standalone locked/offline build and all 25 cases passed (13 Files, four owner interpretation, eight subprocess supervision), using five public Files/process libraries plus the public plugin protocol and third-party dependencies. The copied sources contain no private core dependency; this check does not build or restart the Host. |
| `cargo test -p rho-host --test project --test ownership --test plugin_workspace_paths --locked` | All 23 passed (15 project, seven ownership, one public-path integration). Covers original native preconditions, dirty/staged/untracked files, protected stores, aliases, original Operations, uncertain effects and a declared external reverse query. The first run exposed the old duplicated-descriptor lock behavior; the original failure and deterministic pre-change reproduction are retained under `target/plugin-refactor`. Full affected checks passed after the explicit unlock fix. |
| `cargo test -p rho-host --lib ownership::tests::last_owner_releases_the_lock_despite_a_duplicated_descriptor --locked` | One passed; 50 unrelated cases filtered out. Accepted work retains the lease, final-owner release permits reacquisition despite an extra descriptor, and closing that old descriptor does not unlock the replacement owner. |
| `cargo test -p rho-host --test plugins original_download --locked` | Passed. Requires declared read scope and current parent authority, refuses changed resource/name/size and close preparation, reads retained bytes after provider release, redacts diagnostics and makes no download or extra-Operation claim. |
| `npm run test --prefix ui -- host-client.test.ts plugin-window-close.test.ts plugin-window-client.test.ts plugin-window-views.test.ts plugin-workspace-window.test.tsx` | 50 passed across five files. Includes correlated admission diagnostics, uncertain/rejected distinction, explicit saved-version capture and original-request retries. |
| `npm run test --prefix ui -- plugin-download.test.ts` | Six passed. Exact bounded chunks/digest, Unicode basename/control validation, final authority refusal and closure during collection/recheck. |
| `cargo test -p rho-plugin-protocol -p rho-plugins -p rho-host --lib --test plugins --test port_contracts --locked` | 80 passed (4 protocol, 10 plugins, 48 Host library, 13 Host plugin, 5 port-contract); two Host library cases ignored and not counted as passes. Adds scoped original download admission and retained reads after provider release. Retains exact window placement, cooperative multi-document closure, atomic storage rollback, current authority, private connection containment, external-link/text-copy acknowledgement boundaries and unchanged original scientific Operations. |
| `node scripts/test-objects-plugin.mjs` | Independent compilation and 64 checks passed across eight files. Adds draining the active read, pausing new observations and final unsaved-choice capture. Retains exact provider/session, bounded busy reads, serialized state, capture-before-submit and original-request recovery. |
| `node scripts/test-r-packages.mjs --output=<packages-native-browser>` with existing R package and explicit Ark/R | Passed (30.4 s total) in the generic window. Four screenshots inspected; unchanged Host SHA-256 `e248cd09aaa9d5a1fb29ce7188d3eedf1deca75ca30ca9a8ff9a7ea3009af24c`. |
| `node scripts/test-packages-plugin.mjs` | Independent source compilation and 31 model/connection/navigation checks passed. Adds selected-copy capture before Help navigation, exact target instance/window, failed-save admission prevention and original-request recovery. |
| `npm run test:browser --prefix ui -- help-plugin.spec.ts packages-plugin.spec.ts --output=<help-packages-external-browser>` | Two passed (10.6 s total). Help explicit external-link request plus retained reading/scrolling/closure; Packages approved responsive inspection, busy/source details, failed capture before exact-copy Help navigation and original receipt inspection. The fixture does not establish native R or actual external-window behavior. |
| `node scripts/test-r-plots.mjs --output=<plots-export-native-browser-final>` with existing R package and explicit Ark/R | Passed (12.2 s body, 28.5 s total) in the generic window, including exact original PNG downloads before/after R release without another execution. Six screenshots inspected; unchanged Host SHA-256 `6c2925db212fcd970558d9572b0c41a5df059b5106860f6690d52663637b5dd5`. |
| `node scripts/test-plots-plugin.mjs` | Independent source compilation and 31 checks across eight files passed. Original output identity, bounded history continuation, checksummed image cache, independent transforms, serialized final capture, saved pinned selection, captured comparison navigation and the captured original export model. |
| `npm run test:browser --prefix ui -- plots-plugin.spec.ts --output=<plots-browser-2>` | Passed (one case, 7.5 s total). Opaque frames, original SVG reads, normal/wide/narrow layouts, pointer pan, keyboard Fit, original details, failed-save admission prevention and pinned comparison despite a newer output. Five screenshots inspected. Native PNG and original export remain separate acceptance. |
| `node scripts/test-help-plugin.mjs` | Independent strict compilation and 41 checks in three files passed. Exact-copy identities, UTF-8/file continuations, expiry, busy backoff, late responses, serialized final capture, topic/alias selection and static HTML/link handling. |
| `npm run test:browser --prefix ui -- help-plugin.spec.ts --output=<help-browser-3>` | Passed (one case, 3.5 s total). Actual opaque iframe, same-copy and cross-copy links, no external resource requests, Unicode, exact scroll restoration and cooperative final capture. The initial 1 px scroll-restoration failure is retained under `target/plugin-refactor/help-browser`; disabling scroll anchoring resolved it. |
| `npm run test:browser --prefix ui -- r-plugin-help.spec.ts --output=<help-native-browser-2>` with independent R/Help packages and explicit Ark/R | Passed (one case, 25.0 s total). Native installed-copy/index/HTML reads, unchanged namespaces/search/library paths, no execution from viewing, closure during an original R run and restored choices. Four current screenshots inspected; unchanged Host SHA-256 `a580823ad8bc10fd0b3dd56386362f93d7c3c77a47e31d07707207f95f7dcf12`. |
| `cargo test -p rho-r-api -p rho-r-backend --lib --bins --locked` | 11 passed (3 API, 8 backend); shared validation, caller-scope rejection and bounded inspection envelopes. Exporter target had no tests. |
| `cargo test --manifest-path <external-package>/Cargo.toml -p rho-r-backend --bins --locked --offline` | 9 passed from the independently assembled package, including the new manifest-to-transport route check. |
| `cargo test -p rho-workspace --lib --locked` | 14 passed after extracting query validation into the R package. |
| `node plugins/r/generate-sdk.mjs`, `node scripts/test-r-protocol.mjs` | New R declarations, schemas and manifest generated; strict independent consumer passed. |
| `node scripts/build-r-plugin.mjs <external-package>/r` | Independent current R package built with locked dependencies and no private core source. Existing Host SHA-256 unchanged. |
| `cargo test -p rho-plugin-protocol -p rho-plugin-sdk -p rho-operation -p rho-workspace -p rho-r-backend --locked` | 61 passed; protocol/SDK and original cancellation owner checks. Subsequent Workspace changes are covered below. |
| `cargo test -p rho-plugins -p rho-workspace --lib --tests --locked` | 51 passed, including shutdown with a prepared fence, original authority, failed journal writes, lost/late replies and unchanged original invocation identity. |
| `cargo test -p rho-host --test plugins pending_cancellation_survives --locked` | Focused corrected case passed. |
| `cargo test -p rho-host --lib --test plugins --test port_contracts --locked` | Corrected full run: 62 passed (48/9/5), two library tests ignored. Includes callable cancellation grants, view disconnect and unrelated admission, original scopes, commit recovery and visibility. |
| `node scripts/test-console-plugin.mjs` | Independent package build and model checks pass: original source/resource identity, ordered/deduplicated events, UTF-8/history bounds, captured drafts/retries, clear positions and transient stdin. |
| `npm run test --prefix ui` | 479 passed across 47 files. Adds generic layout conversion, fixed frame DOM order, serialized versioned saves, lost-acknowledgement retry, in-flight reversals and shared-port scope/outcome checks; retains clipboard reservation coverage. |
| `npm run test --prefix ui -- plugin-window-close.test.ts plugin-window-views.test.ts plugin-window-client.test.ts plugin-window-state.test.ts plugin-frame-layer.test.tsx plugin-layout.test.ts` | 29 passed across six files. Scoped connection and closure, retained hidden documents, original-request retry, versioned layouts and stable frame identity. |
| Architecture, plugin and frontend boundary checks; governance validation | Pass. |
| `cargo test -p rho-mcp --lib --test plugins --locked` | 16 passed: 15 library tests and the existing-connection plugin lifecycle case. |
| `cargo fmt --all --check` | Fails with formatting differences in 128 files, including 107 files unchanged by this work; no repository-wide reformat applied. |
| `npm run generate --prefix ui`, `npm run build --prefix ui`, `npm run check --prefix ui` | Pass after the Files owner and scoped-path changes. Public declarations include `FilePrecondition` and `WorkspacePaths`; existing client declarations and embedded assets remain byte-identical. |
| `node scripts/test-plugin-protocol.mjs`, `node scripts/test-plugin-ui.mjs` | Independent strict consumers and schemas pass. SDK checks close capture/version, action fencing, joined observations, refusal/resume/disposal, synthetic composition guard and lost acknowledgements; download feature negotiation, exact wire identity, bounded Unicode filenames and requested-only acknowledgement. No native IME claim. |
| `CARGO_BUILD_JOBS=1 cargo build --locked` | Passed (7m19s), then final presentation rebuild passed (1m12s). Includes scoped resource-download admission and saved-state recovery. Last production binary SHA-256 `6c2925db212fcd970558d9572b0c41a5df059b5106860f6690d52663637b5dd5`; it predates the current Files/path source changes. Current Host test targets compile that source. Existing user Hosts and R sessions were not restarted. |
| `npm run test:browser --prefix ui -- objects-plugin.spec.ts` | Pass (1.6s body in the affected two-case command). Independent read-only browsing, captured navigation, save failure/retry and original receipts; pointer clicks on Inspect Operation send the query at 1440/1920/390 px. Three screenshots inspected. No native R or production-layout claim. |
| `node scripts/test-r-objects-plugin.mjs --output=<objects-composed-native-browser>` with existing R package and explicit Ark/R | Passed (9.0 s body, 27.1 s total): generic-window automatic object placement, exact source/session, original PNG Operation, retained directory draft, cooperative detail closure, immediate unsaved filter capture, unchanged R session and actual pointer receipt inspection. Six screenshots inspected; unchanged Host SHA-256 `3f6672fe4f82cc56f60e70222d8e4e18f77f7d405ae9e8d1012c0290970b2f03`. Older standalone pointer failure remains separate. |
| `npm run test:browser --prefix ui -- plugin-layout.spec.ts` | Corrected full run passed (1.2s body, 2.2s total). Three opaque iframe documents loaded exactly once across selection, native pointer dragging, saved-layout reconstruction and resizing. Unicode input, native focus and owner-delegated closure passed; all three viewport screenshots inspected. No Host persistence, close-time flushing, native IME or scenario application is established by this fixture. |
| `npm run test:browser --prefix ui -- plugin-resource-download.spec.ts plugin-workspace.spec.ts plugin-view.spec.ts --output=<resource-export-browser>` | Three passed (45.7 s total) on Host `3f6672fe…`; actual SDK multi-chunk download/Unicode/digest, foreign/automatic refusal and closure fencing, scoped window composition/recovery, external links without opener/referrer and unchanged scientific history. Six normal/wide/narrow window and conformance screenshots inspected. No native IME claim. |
| `npm run test:browser --prefix ui -- plugin-workspace.spec.ts --output=<window-recovery-browser-final>` | Passed (5.8 s body, 15.1 s total) on current Host `6c2925db…`. Adds awaited recovery-modal inspection at 390 px, cancel preserving unsaved state, exact saved-version closure and correlated missing-handler refusal without an Operation. Twelve affected close/component checks passed after the final single-error presentation fix. |
| `npm run test:browser --prefix ui -- console-editor.spec.ts` | Pass (2.7s body). Public MessagePort fixture: editing/composition guards, selection, transient password answers, controls, clear/new output, saved draft and scroll restoration. 1440/1920/390 px screenshots inspected. |
| `npm run test:browser --prefix ui -- r-plugin-console.spec.ts` with independent R/Console packages and explicit Ark/R | Pass (16.1s body). Current close-time draft capture, R still busy after closure, eventual original completion, reopened draft/output and retained reads after release/removal. Retains readiness, failed/short-run invalidation, native input, queue, cancellation and Unicode coverage. Three screenshots inspected. |
| `npm run test:browser --prefix ui -- r-plugin-viewer.spec.ts` with independent R/Viewer packages and explicit Ark/R | Pass (16.3s body). Two revisions, original resource identity, cooperative closure without ending accepted R work, explicit recovery after reload and retained HTML after release/removal/restart. All eight HTML/DT/source screenshots inspected. |
| `cargo test -p rho-host --test r_plugin_real_r --locked -- --ignored --nocapture` with independently built R package and explicit Ark/R | Current run passed (one case, 24.95s). Adds unstarted/busy inspections, directory/table continuation, non-forcing bindings, foreign/expired references, package counts/copy identity, Help continuation/changed files, unchanged namespaces/search/library paths and unchanged Operation history. Existing instance, queue, stdin, cancellation, settlement and retained-resource regression also passed. |

The initial six-case cooperative-close browser command had four passes and two
failures. The conformance fixture fabricated a failed reply without delivering its
sequence to the Host, so the next message was correctly rejected. It now injects
an actual disposable SQLite write failure. Subsequent assertions were corrected
to check the SDK refusal and the retained uncertain update; the conformance case
then passed. No message checks or native deadline changed.

The initial Files extraction check refused a stale Cargo lock. The first offline
metadata request then attempted to resolve uncached dependencies for unrelated
targets; restricting metadata to the native target completed offline. An initial
compile also found the retiring process recovery adapter still needed its Unix
`nix` dependency; that dependency was restored and the complete 26-check rerun
passed. A read-only sample of slow test startup showed `_dyld_start` before test
code; the original run was allowed to finish and all executable checks passed.
Logs and the sample are retained under `target/plugin-refactor`.

The first generic-window boundary check rejected a direct docking-library import
in the containing window. Moving title updates into the existing layout adapter
resolved the violation; the corrected frontend boundary check and build passed.
The first containing-component check used unavailable DOM matchers; direct DOM
value/connection assertions corrected that fixture, and both cases then passed.
The first `npm run typecheck --prefix ui` for saved-state recovery failed because
the default close mode widened to a string. Explicitly typing and freezing the
captured mode corrected it; subsequent client builds and the 50 affected checks
passed. The failed typecheck log remains under `target/plugin-refactor`.

The first recovery-modal screenshot was taken before the observed saved version
finished loading; the final fixture waits for the dialog and checks horizontal
containment. It also exposed duplicate error banners, now consolidated. The first
narrow native plot snapshot captured the resize transition; the final fixture
waits for the original image to fit its canvas. Both complete browser reruns pass,
and final screenshots were inspected. Earlier images remain as diagnostic evidence.

The first external-link client build failed because a runtime SDK import lay
outside the client's TypeScript source root. The browser now validates URLs
independently; the corrected build, client check and seven link/clipboard unit
checks passed. The first Plots cache check referenced Node's global Buffer without
its types; using browser byte encoding fixed the strict compilation. The first
independent Plots build reached bundling but failed its lock lookup after an
incorrect package-name substitution; the corrected locked build passes through
the browser runner. The first Plots browser run exposed a zero-height panel caused
by an unmatched copied CSS selector. Correcting the rule restored the layout and
the complete browser case passed. Failed logs and traces remain under
`target/plugin-refactor`; none is recorded as a pass.

The native Objects footer pointer issue remains reproducible: after resizing a
second standalone page, pointer events target the outer iframe instead of its
button, although DOM geometry and focus match. Closing that second page or adding
a temporary stacking context did not resolve it. Keyboard activation sends the
original query and permits the complete close/reopen path; a fresh reopened view
also accepts the pointer. The isolated same-page fixture passes actual pointer
queries at all three widths. An intermediate diagnostic used an unsupported
hover matcher and failed before testing that claim; the corrected CSS-hover probe
also failed. Diagnostic styles/listeners were removed. These failures and traces
remain under `target/plugin-refactor/view-close-*`; a keyboard-path pass does not
close the pointer issue. Those preceding native cases used Host SHA-256
`a580823ad8bc10fd0b3dd56386362f93d7c3c77a47e31d07707207f95f7dcf12`.

The first isolated Objects browser check matched both responsive scalar summaries;
the corrected selector targets the visible content. The first native run refused
navigation because the opening grant omitted the target view's scopes. Its ordinary
manifest now declares those scopes explicitly; Host guards remain unchanged and
regression coverage verifies narrow/revoked authority is refused. A subsequent
native case asserted a virtualized offscreen column at 390 px; it now checks the
full table at normal width before capturing each size. Two later runs timed out
during backend initialization before entering the test body. They are failures,
not passes; logs, traces and temporary projects remain retained. Their cause is
unconfirmed. A read-only startup probe of the existing and freshly written backend
returned the expected closed-stdin diagnostic in 0.309/0.257 seconds; it does not
establish initialization health. The full subsequent native run passed without
changing either package, the Host binary, or initialization deadline. No user
session was stopped.

The first atomic-open Host command failed compilation because the new capability's
documentation override was placed inside its schema expression. The placement is
corrected; the full 16-case Host/port rerun passes. The failed log is retained.

The first window-container client build failed type checking because splitter
size was supplied as a JSON global attribute. It now uses the library's supported
model setter; the corrected build, generated-asset check and focused layout tests
pass. The first browser fixture clicked during the asynchronous 1920-to-390 px
resize and failed its focus assertion. It now waits for the frame and the actual
docking content rectangle to agree before coordinate-based interaction; the
corrected full run passes without a production focus or permission change. Both
initial failure logs and the browser trace remain retained.

The first readiness browser run failed because the R transport dispatch omitted
the newly declared query. Its route is now registered and checked against the
manifest; the corrected full native browser run passes. The first corrected
standalone artifact rebuild selected Rust 1.88 from the external directory and
failed its compiler requirement. Rebuilding with the already-installed Rust 1.97
used by the original assembly passed. Both failed logs remain retained.

The first copy-container client build failed because a local reply was used before
its declaration; the corrected build and generated-asset check pass. The first
Objects component compilation lacked CSS module declarations; the corrected
independent compilation and 43-test run pass. The first copy browser case failed
with native write refusal: its clipboard-read permission override also denied
clipboard-write. The fixture now grants read only around known-text assertions and
clears the override before user actions. The corrected full browser run passes
with unchanged production permissions and binary. Initial logs, trace and failed
fixture remain retained; these initial failures are not passes.

The first combined owner command failed to compile a new test because an identifier
was moved while borrowed; its corrected rerun passes. The first combined Host
command passed 48 library tests (two ignored) and eight plugin tests but failed the
new cancellation-view case during activation. Cancellation had metadata without a
callable handler, which the grant validator correctly refused. The adapter fix
passes the focused and full reruns above. That first failed command did not reach
`port_contracts`. The initial Console browser attempt failed because its fixture
omitted the opaque-frame asset CORS header. The corrected fixture passes;
production isolation policy did not change. The first native Console browser run
failed on a test-only `views.get` typo after the input/queue checks; it now uses
`views.inspect`. A second attempt timed out during backend initialization before
the test body. A subsequent full run passes with unchanged native/core artifacts;
the timeout cause is unconfirmed and no deadline was relaxed. The later combined
browser command passed the isolated case but submitted immediately after reload,
before the first R observation, so the existing guard correctly refused execution.
The native fixture now waits for Ready after reload; its corrected full rerun
passes (11.2s test body, 25.5s total). Failed logs and
browser traces remain in local test artifacts; none is counted as a pass. No full
workspace test suite ran for this change.

The preceding committed native baseline passed `node scripts/test-r-plugin.mjs`
with independently built R sources and explicit existing Ark/R. It verified two
revisions/sessions with isolated objects, Unicode/PNG/HTML, native cancellation and
failure, original commit failure/recovery, FIFO/full queue, Console source labels,
parser completeness, streaming during stdin, identity/UTF-8/duplicate-answer
rejection, controls during draining and retained results after removal/restart.
The unchanged engine also passed its independent copied-tree tests and actual-R
check. These are preceding baselines; current contributed inspections are covered above.

The preceding Viewer Chrome baseline passed the version 2 R/Viewer path without
changing the core binary. All eight 1440px/1920px/390px HTML, DT and source-detail
screenshots were inspected, including Unicode input. The public UI conformance
browser passed opaque boundaries, state, controls, sequence recovery and view
closure; normal/narrow screenshots were inspected. The prior client generation,
build/check and 456 tests across 42 files remain the preceding baseline. The
current conformance case establishes SDK text copying in Chrome. Native OS IME,
keyboard copy/paste, drag, cross-window shortcuts and full scenario continuity are
not established by these checks. The earlier exploratory `cargo build --locked` that
was interrupted after a reverted CSP edit remains incomplete, not a pass. Existing
scientific real-R regression evidence is retained below and in Git; automatic
continuation and optional real-model/alternate-R cases remain unexecuted.

### Remaining work and restart boundary

Finish current storage/credential and handoff boundary acceptance, then compose
the ordinary Agent backend through public context, document and scientific ports,
and migrate Agent views. Native transport, task/handoff policy, metadata, credentials
and model engine are package-owned prerequisites, not yet a loadable package. Studio's
Agent workflow must capture an exact development branch and preserve the separate
checkpoint, build, preview and scenario-application actions. Remaining annotation
and Agent context sources must register through public contributions.

R, Files/Git, Process, Remote, Environment, Editor, Console, Objects, Packages,
Help, Plots, Viewer, Manager and Studio now have ordinary package sources and
individual acceptance evidence above. Complete their final scenario integration
and the outstanding cross-plugin workflows; source extraction alone does not
establish the complete replacement. In particular, Console still needs recovery
of an unconfirmed submission from a newly opened view, and Objects needs an
explicit way to set aside an unconfirmed request while retaining its recovery
identity without claiming cancellation or non-acceptance. The older standalone
frame pointer-routing failure remains separate from the passing generic-window
pointer checks. Abrupt browser disposal cannot establish that unacknowledged
edits were saved; recovery stays explicit.

Default delivery must use the same repository and lifecycle, with all feature
plugins removable and no silent reinstall. Remove replaced fixed registrations,
panels and scientific/Agent branches; permanent dual composition is not accepted.
New storage does not read or migrate abandoned formats. Complete the full-plan
acceptance matrix against the final composition: independent external providers,
all feature packages removed/reimported, versions and running R across scenario
switches, retained drafts and operations, faults, and native interaction behavior.
The earlier focused results do not establish that complete end state.

Existing user Hosts and R memory have not been restarted. New Host capabilities
require the rebuilt binary; a client refresh alone cannot add them. Inspect live
work and preserve its session before any separately authorized replacement. All
new native acceptance uses disposable projects and explicit existing Ark/R.

## Bundled real Rho demo project

The welcome page and `rho --demo-project workbench` now materialize a writable,
base-R Gapminder project with provenance, reusable scripts and an optional
Quarto source. Running `run_demo.R` creates real workspace objects, PNG plots,
processed RDS files and an isolated HTML Viewer report; opening the demo does
not run R, install packages or contact an Agent. The embedded browser acceptance
case opens the demo, runs the file, and verifies Objects, Plots, Viewer,
Packages and Agent panels.

## Ark console widgets and execution safety

Rho's Ark 0.1.252 console now installs a Rho-owned `print.htmlwidget` path after
Ark's Positron override. Standalone widget HTML is inlined and retained as a
`text/html` artifact without a `positron.ui` comm; the Studio Viewer mints a
short-lived isolated HTML capability and keeps HTML separate from Plot PNG
outputs. Normal bridge-level R errors remain failed Operations, while missing
or invalid transport/result confirmation is uncertain and retains recovery
material without automatic replay.

Console, Run Selection and Run File share one per-session submission gate and
R parser preflight. Incomplete, invalid, busy or unavailable checks do not
create a run Operation; a captured File run holds the same gate through its
save. Transport loss fences the old session and preserves the original
uncertain Operation; a live/unconfirmed native process is never replaced
silently. Focused real-R, HTML-widget/Plot, Viewer browser, recovery, frontend
and Rust checks have passed. The broad serial workspace run remains subject to
its external time budget; ignored real-R cases remain explicitly ignored.

## Current implementation: Help, Viewer, and annotation infrastructure

The annotation, Help and Viewer runtime foundations are implemented and verified
with HTTP/Application/SQLite tests. Help reads package Rd files through the same
exact-copy reader people use; nothing is loaded or executed. HTML Viewer captures
the R `viewer()` option with inlined local assets; saved artifacts are retrieved
through the same output reader. Annotations freeze evidence through the validated
preview path that Ask already uses; each revision is bound to the observed source
version. Agent context sources now include `help`, `viewer` and `annotations`.

**Implemented in the current source:**

- Help reads package Rd topics converted to text or HTML (Rd2HTML with dynamic=TRUE
  relative links), paginated to 512 KiB chunks. Studio Help panel displays HTML help
  with navigation history. Package inspector "Documentation" button opens the package
  overview in the Help panel. Agent context includes full text or first 12 lines.
- Viewer captures the R `viewer(url)` option with tokenized isolated document URLs.
  Pending HTML output is inlined with local images/CSS/JS converted to data: URIs
  to preserve standalone rendering; external https: URLs pass through untouched.
  Agent context includes the retained text/html source or a byte-count summary.
- Annotations freeze evidence through the existing `component_source_preview` at
  selection start. Each revision binds to the observed source version and lineage ID;
  later source changes keep old notes historical. SQLite repository tracks CAS
  preconditions, tombstone deletions and 8 MiB captured-view budget. Agent context
  includes note text, anchor, fragment and optional captured PNG/JPEG.
- The shared ApplicationViewType enum adds Help, Html (for saved HTML documents),
  and ObjectViewer (for the proposed table detail). Studio layout wires Help and
  Viewer panels with open/history/refresh controls.

**Not implemented in this iteration:**

- Studio annotation UI: no Annotate or Comment affordances exist yet, and Agent
  drafts cannot add annotation references. The schema and Host service support
  Freeze/Capture/Create/Update/Delete/Preview/Evidence; the Studio wiring is deferred.
- Lighter chrome: the proposed continuous surfaces and quiet toolbars from Paper
  boards HV01–HV07 are not implemented. The existing chrome remains unchanged.
- Viewer panel "Open in system browser" is a stub; the Host does not serve isolated
  HTML views outside Studio, and no external URL assignment exists yet.
- Help navigation within topics (internal # anchors) is not intercepted; clicking
  one reloads the whole panel rather than scrolling to the fragment identifier.

The user confirmed version-bound annotation history: artifact updates make old
notes historical; new versions receive new linked notes rather than moved marks.
Five annotation Paper boards (AN01–AN05) and seven Help/Viewer boards (HV01–HV07)
are pending final user visual review.
[Design section 20](RHO-DESIGN.md#20-component-annotations-for-people-and-agents--proposal)
records the shared annotation layer, and
[Design section 19](RHO-DESIGN.md#19-r-help-interactive-viewer-and-lighter-controls--proposal)
records Help and Viewer interactions.

## macOS preview delivery scope

The user has limited initial installation and experience delivery to the same
environment as this machine: **macOS 26.5.2 (25F84), Apple Silicon arm64**. The
next delivery work is one complete macOS installation/startup/configuration path;
multi-platform packaging and additional compatibility targets are out of scope.
Automatic CI and the manual binary-build workflow now target macOS arm64 only;
Linux and Windows jobs are disabled. No new installer,
signing, notarization or publication is claimed by this scope change. See
[Build and release](RELEASE.md) for the current artifact and delivery boundary.

## Unified Agent implementation and acceptance

The user approved implementation of the unified Agent plan on 2026-09-14. The
current source uses the original Agent panel, task list and composer for Rho,
Codex, Kimi and DeepSeek. The separate Built-in Assistant page has been removed
from Paper; the [Agent review page](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/6-2)
contains the approved unified interactions and a new **A20 manual handoff** preview.
A20 was reviewed and approved by the user and is now implemented with scoped
Application/HTTP/browser verification. See
[Design section 18](RHO-DESIGN.md#18-rho-in-the-unified-agent-panel--review-revision).

### Implemented in the current source

- One project/principal-filtered task projection reads the existing native task
  and Rho conversation owners in a single snapshot, with stable pagination,
  attention, rename/archive and full versioned drafts. Typed task references
  dispatch commands to the original owner; Rho is not a native CLI provider.
  Seven Ask entrances preserve the current editable task, append real source
  references, retain text and never send or switch the existing task's Agent.
- The unified composer preserves IME input, attachment uploads, per-task reading
  position and the next draft while a response runs. Rho and native tasks share
  settings entry points and permission controls. Scientific operation state is
  read from original Operation records, independently of model response state.
- Ask is the default. Explain/Edit/Run and Allow saving are removed from the UI.
  The execution Agent records its interpretation of the original user request
  once; Application freezes that bounded intent and stores action receipts and
  parameter-bound permission decisions. Explicitly requested work proceeds;
  additional work uses deterministic Ask/Auto approval/Full access rules in
  `rho-agents`, without a second model reviewer. Component profiles only suggest
  context. Current targets remain subject to native version/session/path checks.
  Fresh messages from supported older drafts default to Ask; original pending
  requests, Continue and Retry retain their original authority.
- Rho can open or create an exact project document during a task, then edit,
  save and execute through the existing Application bridge. Continue checks
  authoritative current document/file/session evidence and unresolved receipts.
  Lost acknowledgements of completed document creation reuse the original
  receipt; later user edits are not silently adopted. Ordinary follow-up turns
  receive bounded conversation history and source references without inheriting
  previous permission grants.
- API keys persist by default in the user's local `rho/model-credentials.json`,
  independent of the project and Application database. Locked atomic writes and
  settings CAS retain the previous valid configuration on failure. Accepted runs
  freeze their configuration; queries/history/drafts return only references and
  status. Replace/remove and optional environment references remain available.
- Application failures over component HTTP preserve typed Diagnostic codes, submission certainty,
  original request identity and visible verification reads. Duplicate diagnostic
  Tests observe the original request. Model admission remains ten total/two
  executing, with at most one queued/running Test. Task budgets are uniformly
  twelve model calls, sixteen tool calls and ten minutes, independent of policy.
- Managed native connections receive revocable task-bound MCP credentials.
  HTTP initialization, RPC, GET and DELETE validate connection/session ownership;
  actual transport replacement revokes the old lease while preserving task and
  deduplication identity. In-place controller takeover preserves the native
  session/lease and fences the old window. Legacy journal attribution is not guessed.
  Native usage preserves source and scope, distinguishes context occupancy from
  consumed tokens, retains unknown fields and does not add cumulative/replayed data.
- Post-Send persistence failure retains uncertain acceptance and the original
  draft/request. Disconnection flushes final events durably before releasing the
  observation source. Per-task Weak gates preserve one live lock while allowing
  unused entries to be reclaimed. No new scientific lifecycle or global R lock
  was introduced.

### Current verification and remaining acceptance

A20 is implemented: source/target previews share the existing task owners; edited
handoff text and original references append to the target draft with CAS, under
its original owner lock. Target text, attachments and permission/session settings
are retained. Uploaded source attachments remain in the source task with an explicit
notice. A missing acknowledgement retains the exact request and can be reconciled
through its receipt. The default Goal falls back to the retained user message for
completed native tasks, while Confirmed is never inferred from an assistant answer.

Current A20 verification passed **6 SQLite integration tests** (including all four
source/target owner combinations and transaction rollback), **21 Workbench HTTP
checks**, and **438 frontend tests in 41 files**. The HTTP tests also verify original
Operation references through the shared reader, reject stale file sources without
a target write, and prove no model/session/scientific work starts during handoff.
Generated bindings, embedded assets and the final binary build passed.
Two final **embedded-client browser cases** passed: the shared mixed task list and
full bidirectional handoff, including target draft conflict, existing attachments,
source preview/removal, 320 px layout and lost-acknowledgement recovery after refresh.
Log: `target/agent-handoff-embedded.log`; screenshots:
`target/studio-browser/agent-handoff-{320,320-target,constrained,wide,receipt}.png`.
The layout and receipt views were inspected. No independent third-party model
acceptance was run for this change.

The preceding unified-Agent baseline had **423 frontend tests in 39 files**. Recovery tests passed **4/4**, including lost-create-result
recovery and real current-document validation before Continue admission. Host
unit tests passed **47**, with one explicitly real-R test excluded from that run.
The actual HTTP MCP identity suite passed **4/4**, covering isolation, revocation,
Resume attribution and original-request deduplication. Native usage observation
fixtures passed **6/6**. Workbench HTTP tests passed **19/19**, and SQLite tests
passed **28 unit + 40 component tests**, including the final permission-target
summary regression.
Architecture, frontend boundaries, governance, vendor and vendor fixtures,
Agent harness self-test and evidence-pack fixture checks passed.

Before the A20 addition, the complete `cargo test --workspace --locked -- --test-threads=1` run passed:
**408 passed, 38 explicitly ignored**, followed by the final 40-test SQLite
component suite for the later permission-title change. Log:
`target/unified-agent-workspace.log`; the later scoped suite is in
`target/unified-agent-sqlite-final.log`.
The additional real-R test with **two Rho tasks and a human Console in one native
queue** passed, proving original FIFO order, separate operation callers/receipts
and correct stdin attribution (`target/unified-agent-shared-r-queue.log`).
Final generated-client/embedded-asset agreement and current binary build passed.

The current frontend has passing evidence for ten native
Agent and thirteen Rho browser scenarios, including the final five layout,
attachment and IME regressions. The five viewport screenshots (320 px panel and
600/1024/1440/1920 windows) plus real scientific Running/Succeeded screenshots
were inspected. Pure width changes now resize the shared textarea without
interrupting IME; saved long drafts remain fully visible.

These browser runs used current development assets with an isolated test Host.
The two real-model browser cases were excluded. Initial Host/discovery startup
timeouts were retained and affected cases passed on rerun without extending the
original deadlines. After the final client check and binary build, five representative
cases passed **using embedded assets**: same-project mixed tasks and unsent drafts,
native IME, all requested widths, permission controls without work modes, and real
R operation/plot navigation. Log: `target/unified-agent-embedded-browser.log`.
The final embedded screenshots were inspected as well.
Screenshots are `target/studio-browser/component-{320-panel,600,1024,1440,1920}.png`
and `component-scientific-{running,complete}.png`. The same-project mixed list and
selector are in `agent-mixed-project-{tasks,selector}.png`; both owners retain
independent unsent drafts without starting a model. The last shared-input run is
`target/studio-browser-unified-input-final`. In the measured fixture, Console
input p95 was 32.2 ms idle / 32.0 ms during streaming and frame p95 was 16.7 ms in
both phases. This is a bounded measurement, not a retained-memory claim.

The complete `node scripts/test-real-r.mjs` run passed, including sixteen component
mutation/recovery cases, real owner sources, R session state, cancellation,
checkpoint protection, clean restart and persistent CLI behavior. Both
`node scripts/test-mcp.mjs --real-r` and `node scripts/test-workbench.mjs --real-r`
passed. Logs are `target/unified-agent-{real-r,mcp-real-r,workbench-real-r}.log`.
Standalone output-media and R-checkpoint acceptance also passed.

The new real-model matrix defines **33 cases** (the seven component contexts,
repair flows, generic task creation and Objects-to-script work, each repeated
three times), plus a separate ordinary follow-up regression. These have **not**
run against a real model because this session has no supplied Rho credential.
The prior **27/27** real-model matrix on `b288a081f2f862398eb907f5e6096ce616bfb59a`
remains historical baseline evidence in
`target/component-matrix/2026-09-13T12-01-56.815Z/summary.json`; it does not verify
the new permission or unified-UI implementation.

The user clarified that third-party Agents do **not** require independent acceptance
by Rho. Rho verifies its own identity binding, protocol/data transport, draft
handling, receipts, recovery and truthful usage display. Previous exploratory
native-provider logs remain in `target/agent-native-acceptance-2026-09-14/`; they are
not a third-party capability certification or a release gate. The prior Kimi image
result is outside this scope and does not block completion.

A20 verification covers Rho-owned draft persistence, transport and recovery. It
does not send a prompt, overwrite existing text, copy another task's asset IDs or
transfer authorization.

All current acceptance runs use disposable projects. Existing user Hosts, R
memory, drafts and native configuration are preserved. The running user Host has
not been replaced. New backend capabilities require a current Host binary;
a browser refresh alone does not update them. Inspect active tasks/R sessions and
existing restart authorization before replacement. No installation, signing or
publication was performed. See [Operations](OPERATIONS.md#built-in-component-assistant)
for configuration and use.

## Multiple R sessions and recovery copies

The instance foundation, recovery copies, automatic protection and approved Studio
R04–R10 surfaces are implemented. [Design section 17](RHO-DESIGN.md#17-sessions-and-recovery--approved-interaction)
records the authorized interaction; [Architecture](ARCHITECTURE.md#multiple-r-instances-and-recovery-copies)
records ownership and safety boundaries. R01–R03 remain proposals.

R Sessions now has Overview, Runs, Recovery copies and Details, with Main first across
catalog pages, separate inspection and execution targets, scoped Console/Objects
navigation, view pinning, stopped-session continuation and installed-R session creation.
The management page preserves editor and Console drafts; narrow layouts provide
list/detail/Back navigation. Copy details read the immutable full manifest when the
catalog shortened its object-name previews. Counts use the owner's totals.

The recovery states explain opening, partial restoration, validation failure and
connection loss. Notices refer to the actual restore operation and source copy;
saving a partial copy does not imply anything was restored. Dismissals persist with
window preferences. A first-copy notice is shown once. Selecting an alternative
installed R/environment for a separate restoration still requires matching version,
architecture and native package validation.

Restart, Stop and Quit report consequences and operation results in one panel.
Restart creates empty memory in a new continuation lineage. A failed or partial
protection step leaves R open until remaining loss is explicitly accepted. Quit
synchronizes drafts, cancels waiting work, observes active cancellation, saves supported
objects, confirms local R termination and then requests Host shutdown. Closing a view
alone leaves R running. Host shutdown refuses live or unconfirmed process receipts and
fences later launches. Opening/restore cancellation forwards to the original child,
waits for the launch handshake and confirms candidate termination before reporting
cancellation. Ordinary in-flight reads drain behind a stop fence; consumer holds and
scientific operations remain blockers.

Runtime & recovery settings expose App → Project → Session inheritance per field,
Reset, object inclusion/exclusion, performance/storage controls and advanced limits.
Server defaults and project storage accounting are published by the settings owner;
the UI does not duplicate default constants. Recording default R does not replace any
live R binding. An empty Host can create a session explicitly from the new-session
entry after R is configured.

The factor-predictor model exclusion is fixed: R's base `deferred_string` ALTREP is
accepted after recursively classifying its storage. A test-only foreign provider
verifies unknown ALTREP roots and nested graphs remain excluded without invoking
length, data or serialization callbacks. Cold processes verify predictions for both
character/factor predictor lm/glm, alongside existing aliases/cycles, Unicode/hidden
values, factors/time, sparse/SCE values, RNG/options and unevaluated nested promises.

Environment retention now follows committed recovery manifests even when all R
sessions are stopped. The added real-R regression first reproduced the missing
reference, then passed after the fix; explicit deletion releases that old copy's
library reference. Incomplete bookkeeping blocks cleanup instead of discarding an
unknown dependency. Component delivery validates explicit R arguments and is exercised
in an isolated install layout with matching manifest paths and byte hashes.

### Current verification

- Full serial Rust workspace: **284 passed**, **10 opt-in cases ignored**, not counted
  as passes. An unchanged Agent protocol fixture timed out once during the first run;
  its focused rerun and the full serial rerun passed without changing Agent code.
- Frontend: **362 tests passed**; typecheck, generated DTOs/client build, architecture,
  frontend boundaries and all 24 boundary fixtures, vendor integrity and fixtures passed.
- Full Chrome suite: **46/46 passed**, including four new real scenarios: isolated multi-session recovery and empty
  restart; session creation and per-field settings reset; full coverage beyond a
  truncated catalog; and active/queued cancellation followed by save, Quit, Host reopen
  and automatic recovery. They acquire a component beside a temporary Ark and launch
  through normal discovery, with no explicit helper override. Editor/Console drafts
  and keyboard target selection are checked. Screenshots cover 600/1024/1440/1920 px.
  The fixed load case measured input p95 **34 ms** and frame p95 **16.7 ms**.
- `scripts/test-r-checkpoints.mjs` passed, including foreign-provider exclusions,
  numeric/factor models and isolated component delivery. The recovery-library test
  passed both retained-reference and deletion assertions. The real-R, Environment,
  MCP, Workbench, output-media, process/remote protocol, Agent recovery/harness and
  evidence-pack checks also passed.

The final review corrected two concurrent-update cases: Quit flushes document and
view-state owners in acknowledgement order before checking synchronization; whole-vector
copy waits through transient busy periods on its original reference. Recovery capture,
pinning and deletion do not invalidate object/package observations. Actual scientific
execution still invalidates them. HTTP size checks retain the 413 assertion using
100-continue, MCP media checks explicitly await completion, and the IME fixture uses a
separate deliberate key gesture instead of depending on frame timing.

Evidence for this continuation is in `target/runtime-final-*.log` and the check
manifest `target/runtime-final-checks.json`; screenshots are
`target/studio-browser/runtime-*.png`. Functional evidence does not replace further
user feedback on the interaction.

### Remaining release boundaries

- The native component is still an explicit per-machine acquisition and has not been
  added to a signed packaging or first-run installer. Opening R or browsing copies
  never invokes a compiler or installs packages.
- Two genuinely different R installations require `RHO_ALT_*` and remain opt-in.
  Cross-platform, long-run/destructive-failure and added-wait latency acceptance have
  not been established by these local tests. No release-wide performance claim is made.
- Environment receipts have no user-facing display name, so the interface uses a
  generic description and keeps the exact receipt/path in Details.
- Raw Ctrl-C/server termination ends owned R processes without guaranteeing a fresh
  object copy. The explicit Quit panel is the protected shutdown path.
- Connected CLI and Agent requests require `workspace_instance_id`; no implicit
  target is guessed. A new real-model Agent acceptance run is separate from the
  deterministic protocol/bridge checks.

### Restart paths

The primary repository checkout on `main` is now the only local worktree. It includes
all session/recovery work through `0d3112e3`. Current verification logs and screenshots
were retained under `target/` when the auxiliary worktrees were removed. The primary
checkout passed `cargo build --locked`, generated-client consistency, CLI startup,
documentation checks and backup verification after consolidation.

Original branch refs and history are preserved in
`.git/cleanup-backups/20260912T130405Z/branches.bundle`; the same private directory
contains the retired kernel checkout's local state/artifacts and the cleanup inventory.
These are manual administrative backups, not supported inputs for the current runtime.
Routine development continues in this checkout; temporary worktrees should be removed
once their work has been integrated.

Inspect current processes before a real launch or replacement. Existing user Hosts
and R memory were not restarted during consolidation. New browser and native tests
use disposable projects. No application installation, signing or publication was performed.

## Shell navigation and configurable status bar

The user approved [Paper Shell S01–S04](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/8-0)
and requested optional persistent CPU, memory and disk values. The implemented
48/168 px navigation rail focuses/restores existing modules, offers multiple-view
selection and retains Agent attention/settings entry points. Layout is available
from the top bar. A 30 px footer separates R/queue/input state, user-pinned metrics
and draft synchronization. Narrow windows retain all pinned metrics, using a
second row below 700 px. Project paths live in the top project disclosure.

The shared Project query observes volume total/free/available space with `fs4` at
the canonical project path. It does not scan files, enumerate other disks or start
R. CPU/memory retain their actual Ark/R-process scope. Files and Session retain
observation/error/freshness independently; missing or stale values stay unknown.
Preferences merge against current shared settings. Draft sync now also checks the
ApplicationBridge document acknowledgements, independently of disk-file saving.

Validation passed: 327 frontend tests; all 15 Host project tests; 18 tests across
Contract, Project and Git; generated client/asset consistency, typecheck, Rust
formatting, architecture/frontend boundaries and fixtures, and documentation checks.
All 40 existing Chrome scenarios passed in the full run; both new shell scenarios
passed in a separate final run after correcting their temporary project's canonical
path. These 42 cases cover keyboard controls, retained preferences/drafts, native
input, disconnected metrics and 1920/1440/1024/800/600 px screenshots. Real-R HTTP
and MCP checks passed. The broad Rust workspace suite was not rerun.

A viewport test now awaits ResizeObserver geometry without weakening its bounds.
The new shell cases use a separate temporary Host instead of exceeding the main
suite's 32-window project budget. Native Host rejections that omit `result` retain
their actual error message rather than being obscured as an invalid reply. The
native disk test finishes in 0.10s after replacing slow whole-machine sampling
with the direct filesystem call. Evidence: `target/shell-{frontend-final,rust-domain,
project-tests,browser-verified,browser-isolated-final,workbench-real-r,mcp-real-r}.log`
and `target/studio-browser/shell-*.png`.

A separate preview at `target/experience/shell-review-5dR1zl/study` contains the
synthetic `workspace-demo.R`, its live objects and plot. It uses refreshable assets;
its browser is retained for user review with all three metrics pinned. Existing
Hosts and R sessions were preserved. Inspect current processes before launching
another Host. Native launch credentials remain in ignored local material.
Further first-version visual/usability feedback remains open.

## Object priority and whole-vector viewing

The user approved [Paper boards O07–O10](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0)
on 2026-09-09 and authorized further refinements from real scenarios. The directory
now defaults to Name, Content and Type. Content shows values, dimensions, function
signatures, levels or colors. Fields controls and header dragging reorder, hide
and resize Content/Size/Type; Name stays first. Widths and visibility persist with
the view. Narrow panels retain compact semantic summaries and return to the saved
columns when widened.

Complete small palettes open as one strip or tile set in inline and dedicated
viewers. Selecting a color shows its original value, rendered hex and opacity.
Ordinary string vectors do not automatically open one string's detail. Long vectors
use ranges, explicit item inspection and a scrolling body with visible navigation.
Copy vector preserves original strings, names, NA, supported classes and complete
factor levels; explicit formats offer hex or selected/shown ranges. The shared
Objects owner gathers every requested page and text continuation on one native
observation before writing to the clipboard. Expiry, cancellation, missing pages,
unsupported exact representations and the 1 MiB / 100,000-value limits fail without
publishing a partial copy. A view opened during transient R activity resumes the
same observation when idle; it does not start or re-run R work.

Validation passed: 320 frontend tests, all 40 isolated Chrome scenarios, plus a
final two-scenario Chrome run after narrow-view refinements. Tests cover mouse/keyboard
field controls, saved order/width, approximately 320 px docked views with measured
visible color height, whole palettes,
Unicode continuations, duplicate names, factor levels, missing values and rejected
partial copies. A 252-value copied expression passes `identical()` in real R. Hex
conversion fails on a non-color value beyond the first page without changing the
clipboard. Table ordering/filtering, arrays and SCE browsing still pass. Real-R MCP
and Workbench checks, typecheck, generated-client consistency, architecture/frontend
boundaries and documentation checks also passed. The broad Rust workspace suite
was not rerun for this frontend change. Evidence is in `target/object-refinement-*.log`
and `target/studio-browser/object-{fields,palette}-*.png`.

The existing demo Host has been refreshed with new development assets; its live
objects, plots and unsaved script are preserved. No R Host was restarted to deliver
this refinement. Both inline and independent vector views use the same owner.
Further user feedback on information priority and real vector workflows remains open.

## Object viewers and directional collapse

The user authorized implementation of the six [Objects Paper boards](https://app.paper.design/file/01M1XBMB0B5QB82XMDV0Z6VHET/7-0)
on 2026-09-09, plus correction of full-column minimize behavior.
[Design section 14](RHO-DESIGN.md#14-objects--approved-viewing-experience) records the
approved interaction and named storage readers. Object lists now display bounded
native samples, values, dimensions, string lengths and canonical R colors.
Inline inspection and main-area viewers share the Objects owner, including
retained view preferences, nested containers, factor labels/codes, source text,
array slices and SCE/sparse storage. React Data Grid supplies the actual table
surface. Whole-table order/filter reads retain original row indices; oversized
copies, unsupported calendar filters and the one-million-row processing ceiling
are explicit limits. Current Host metadata controls extended table features.

Groups collapse along their parent split: full columns release width into a
38 px side rail; stacked panels release height. Original limits/weights restore,
and startup view reconciliation preserves collapsed state. Explicit activation
still restores the group. The user's existing development Host and R memory are
preserved; a frontend refresh cannot install the new native reader capabilities.
A reproducible synthetic review script is in
`target/experience/object-viewers-ready/study/objects-demo.R`.

Validation passed: 309 frontend tests, all 39 isolated Chrome scenarios, four
contract tests, all five real-R integration cases and the real CLI/session runner.
The native object script verifies full-table ordering/filtering, Unicode/special
values, array slices, non-executed source, R color interpretation and real SCE
counts/colData/PCA storage. Real-R MCP and Workbench checks passed, as did generated
bindings/client consistency, typecheck, architecture/frontend boundaries, Rust
formatting and governance checks. A broad Rust workspace run was interrupted;
it is not recorded as a complete pass. Current evidence logs are
`target/object-viewer-{browser-verified,frontend-final,contract-tests,real-r-suite,mcp-tests,workbench-tests}.log`.

The review Host is running for
`target/experience/object-viewers-ready/study`, using refreshable development
assets. Its retained browser has executed `objects-demo.R`; the 2,700-row table,
canonical colors, SCE and plot objects are real synthetic R fixtures. Inspect this
Host before starting another instance for that project. Its private launch URL
remains in ignored local material. Existing user Hosts were not restarted.
Screenshots are under `target/studio-browser/`; successful inspection does not
replace further user feedback on interaction quality.

## Agent Chinese input composition

The reported Pinyin-to-literal-text bug was reproduced through Chrome's native
composition protocol: `ni → nihao` produced `ninihao`, with JavaScript value writes
back to the previous text between input events. This occurs before draft autosave;
the controlled textarea was backed directly by asynchronously notified task state.
The message input now leaves native preedit in the DOM, reconciles external text
only outside composition, and sends confirmed text to the draft owner. Resizing
and @ completion also wait for committed input. IME confirmation/229/post-end keys
cannot submit, and an ownership change retains a local conflict copy.

Focused tests passed: native Chrome composition across autosave/poll intervals,
delayed draft ACK during composition, committed-only saving and explicit subsequent
Enter. These are browser-native CDP tests. The user separately tested the corrected
ime-test page with their actual input method and confirmed it works on 2026-09-09.
This confirms that configuration, not every possible OS/IME combination. Validation
passed: 300 frontend tests, all 36 isolated Chrome scenarios, frontend boundary
checks/fixtures, typecheck, client build/generated-asset consistency, current binary
build and governance checks. The regression also preserves the original attachments
when composition finishes after another window takes control. The task selector
now has a distinct accessible label from the New task action. Evidence is in
`target/agent-task-development/ime-{unit,chrome-final}.log`. The user's existing
trial Host/page is preserved. A separate `target/experience/agent-ime-review/ime-test`
workspace uses refreshable development assets for testing the corrected client.

## Agent activity and real-analysis integration

The user's ggtree trial exposed failures beyond panel presentation. The recorded
connection took about two seconds; native thinking then continued without a visible
phase. Rho's fixed 600-second ACP prompt deadline stopped observing a native turn
that completed after about 729 seconds. The final response was lost. An invalid
`output_mode: all` was obscured by an incompatible MCP structured-error envelope.
A subsequent corrected R submission waited behind a failed-run pause and hit the
native MCP request timeout. The original successful R operation saved a PNG but
did not emit a Plots artifact; the native final message incorrectly claimed it did.

Implemented: bounded native phase observations and an animated conversation status,
including quiet time, driven by existing Coordinator observations; ACP prompt
correlation until native completion/transport closure; readable MCP rejections;
typed R output modes; default R acceptance receipts with queue-state read links;
live Studio context and document/media guidance in native input. Structured
window/document/action/media identities are expanded in the tool schema after a
real GLM run repeatedly encoded reference-only parameters as strings. Native
permission callback content/diffs are retained, not just the tool title.

Real Kimi/GLM analysis also reproduced a captured-save bug: a partial Rust-generated
patch encoded unchanged context as removed/added lines and Git rejected it despite
the correct file digest. Captured saves now emit real unified-diff context. The
regression applies start/interior/deletion/unchanged/Unicode/CRLF/no-final-newline
edits through Git and checks exact bytes. The external Agent remains responsible
for its R code; failed scientific operations retain their actual outcomes.

Verified with Kimi Code 0.41.0 and `b-ai/glm-5.3-flash`: the same native session
resumed after upgrading the disposable Host, retained the corrected Editor draft,
saved and ran it successfully, read the real image through MCP, explicitly selected
it in Plots and returned a final response with a succeeded submission receipt.
The 800×600 PNG is retained by its producing R operation; the original failed runs
and intentionally interrupted turn retain their actual statuses. Refresh preserved
the saved script, selected image and conversation. Native image inspection rejected
an incomplete reference; the Agent corrected it using the full owner reference.
This validates recovery and completion, not error-free model-generated R code.

Checks passed: 250 Rust workspace tests (seven opt-in cases skipped), all five
real-R cases plus the real CLI/session runner, 303 frontend tests, 37 isolated Chrome
scenarios, real-R MCP acceptance/paused-queue recovery, native task crash/resume
fixtures, generated bindings/client checks, architecture/frontend boundaries,
governance and vendor integrity. All nine focused Chrome cases passed after the
permission-detail disclosure and selected-plot unread-count fixes; 29 native-client
tests passed after the final permission-excerpt redaction review. Evidence logs
and the verified preview `ggtree-final.png` are in `target/agent-task-development/`.
The configured Kimi global Rho MCP entry remains disabled; existing user Hosts were
preserved. Only owned disposable Hosts were restarted. Actual provider thinking
latency remains variable; it is now visible rather than converted into a false
terminal timeout.

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
The unified-plugin work described above now authorizes exact plugin revision
import and plugin execution. R package-management UI, abandoned-data migration,
product installation and publication remain outside that implementation scope.
The external acceptance runner is test tooling, not a product Agent behavior loop.
