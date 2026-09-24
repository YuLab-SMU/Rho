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
