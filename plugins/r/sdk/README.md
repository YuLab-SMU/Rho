# Public R plugin protocol

Type-only declarations and language-neutral JSON Schemas generated from the R
owner's `api` crate. Copy this directory into an independent UI project or use
`@rho/r-protocol`; there are no runtime imports or private core dependencies.
From the R source package run `node generate-sdk.mjs` to regenerate, or add
`--check` to verify. Both use the existing Rust toolchain offline and must run
serially with other Cargo commands.

`r.execute@2` accepts `ExecuteR`: an exact `expected_session` and `run` containing
code, optional `output_mode: "console"`, and optional source labels. The code is
limited to 262144 UTF-8 bytes; source view ID, label and kind are limited to
160, 512 and 64 bytes. NUL is rejected. The queued source, original normalized
arguments and terminal `RExecutionResult` keep the submitted values. Source
labels are caller-supplied presentation metadata, not a verified document capture
or additional authority. `r.execute@1` retains its original code-only contract.
`RExecutionOutput` also represents confirmed cancellation before native execution
as `{operation_id, started: false}`; it is not a completed native report.

`r.format@1` accepts `FormatRCode` in an existing exact session, with at most
65536 UTF-8 bytes of code (empty input is allowed) and the same source-label
bounds. It uses the installed `styler` package without installing tools, evaluating
the input or writing a project file. The original `RExecutionOutput` preserves
source labels and has no Console output mode. Successful `value` is `FormatResult`;
if `value_in_report` is true, read and verify the complete retained report resource
instead. Formatted text is never silently truncated. A caller must still compare
its captured document before applying the result; formatter success cannot prove
that later edits match the original input. Formatting shares the native queue,
original commit settlement and pending-cancellation rules with execution.

`r.check_code@1` requires an existing exact session with no queued work or unsettled
result. It returns `CodeCompleteness` without evaluating the code. Refusal while
busy is not a successful code check. `r.output_events@1` observes the same exact
native owner while execution continues, with an original Operation ID and sequence
cursor. Each page has at most 100 events and a 256 KiB event-JSON budget; use its
returned `next_sequence` and `has_more`. Gaps and truncation remain explicit.
Output events never establish scientific success, failure or cancellation. After
owner release, use original terminal Operations and their retained report/event
resources through the generic read ports instead of recreating R.

All calls use the public plugin UI/backend SDK and an exact `ProviderBinding`.
Changing a view, scenario or current selection must not retarget accepted work.

Recovery contributions use `RCheckpointReference`, containing the original
project, provider, capture/reconciliation Operation, payload digest and byte count.
The reference grants no authority. `r.capture_checkpoint` returns
`RCheckpointCaptureOutput`; confirmed pre-start cancellation has `started: false`.
A successful result points to a complete `RCheckpointManifest` resource, including
skipped bindings, graph coverage, original Environment and observed library usage.
Unknown library/namespace dependencies remain `libraries.complete: false`.
The potentially larger native payload is read through `r.read_checkpoint` in
chunks of at most 65536 bytes; verify the complete reference digest when consuming
all bytes. The provider checks that reference against the caller-readable original
Operation, manifest, native scope and committed control history on every request.

`r.restore_checkpoint` requires the exact existing empty candidate session and
returns `RCheckpointRestoreOutput`. Its retained `CheckpointNativeRestoreReport`
contains the full restored names and namespace effects; a summary is not a claim
of functional equivalence for arbitrary R objects. `r.reconcile_checkpoint`
accepts an original failed/cancelled/uncertain capture Operation, preserves that
outcome and publishes an independent copy through a new Operation. Neither action
automatically starts R or reexecutes analysis.

`r.checkpoints` returns one journal page and `next_cursor`; it can return no
captures while still having another page. `r.checkpoint` returns current logical
pin/deletion state separately from `payload` presence. Present means native
identity and length were observed, not a new full hash verification. Pass the
observed `control_head` as `expected_control` to `r.pin_checkpoint` or
`r.delete_checkpoint`. Unpin before deleting. Core-confirmed deletion retires the
copy, then the owner attempts cleanup. `r.purge_checkpoint` retries physical
cleanup using the exact committed deletion Operation and confirms
`payload_removed: true` only after native removal. Original metadata remains.
Read grants are explicit optional dependencies; state-sensitive operations also
require project journal coverage so hidden records cannot be mistaken for no
controls. Missing, uncertain or unsupported control history stays unavailable.

`r.inspection_state@1` returns `RInspectionState` without entering R or starting a
session. Pass `expected_session: null` to observe an unstarted instance; after a
session is known, retain it in subsequent requests and the binding target. A
different session is refused. Ready means the observed native session is idle and
has no queued/unsettled work or occupied inspection lane. Busy/unavailable results
retain their native identity and notices.

Its `cache_key` is scoped to that exact instance and session and changes before
and after native execution, including failed or uncertain returns. This lets views
invalidate stale data even when a short run completes between polls. Read-only
inspections do not change it. It is a presentation invalidation hint, not a global
scientific revision, execution result, cancellation acknowledgement or native
precondition. Original Operation records still establish execution outcomes.

Read-only inspection contributions are `r.list_objects`, `r.observe_object`,
`r.read_object`, `r.inspect_object`, `r.packages`, `r.package_index` and
`r.read_help` (version 1). Every request must name the exact `expected_session`,
including the shared preview/package argument types where that field is optional
for the retiring local adapter. No query starts R, forces lazy/active bindings,
installs or loads a package, attaches it, changes library paths or tests loadability.

The result is `RInspection<T>`. Read `status` before `data`: busy and unavailable
observations contain no current data. The native session, source, observation time,
completeness and notices remain explicit. `diagnostic.code` preserves failures such
as `observation_expired`, `observation_invalid`, `content_changed` and
`budget_exhausted`. A view may retain its previous display with an explicit stale
label; it must not present that value as a new observation. A response larger than
256 KiB is unavailable with a budget diagnostic, never silently truncated.

Directory/object references bind to the original project, principal and native
session; request arguments cannot supply that scope. Continue with the original
reference, filters and returned offsets. Packages grouped counts, copies and static
index use the same `observation_id`; Help additionally fixes the index and help
file identities. Preserve expired/changed evidence rather than silently selecting
another object, package copy or observation. Available help-rendering providers are
read as-is; missing providers remain unavailable instead of being loaded by a query.
