# Agent Result Transport Recovery

Status: active; ART-1 complete; ART-2 redacted Provider-failure projection, focused tests, and exact local persisted 404/429 UI acceptance passed 2026-08-19; broader installed acceptance open

Date: 2026-08-06

Change class: D1 defect repair

Risk: R2 cross-boundary workflow

Owner: existing desktop Agent R framed transport and broker-owned Workspace R
request projection

## Problem And Evidence

A long scientific execution can complete in Workspace R and advance the broker
identity, while Agent R reports `Agent transport closed before a complete frame
was received.` The broker response currently repeats every raw Ark kernel event
inside the tool result. Plot display payloads from workflows such as Seurat can
make that response exceed the protocol's 8 MiB frame ceiling after execution
has already completed and been persisted. The failed frame write closes the
turn before Agent R receives the new workspace revision.

Broker error responses also omit the current workspace identity. Agent R ignores
`workspace.identity` events while waiting for a correlated response, so a
rejection can leave the next tool request bound to an obsolete revision and
produce repeated `workspace state changed: expected ..., actual ...` errors.

## Invariants

- A completed Workspace R execution is never converted into an Agent transport
  disconnect solely because persisted kernel events exceed the frame budget.
- Raw kernel events and Plot display payloads remain broker/store-owned and are
  not duplicated into the model-facing Agent tool result.
- The normal bounded execution result, execution ID, Artifact fields, and
  current workspace identity remain available to Agent R.
- Every correlated broker response, successful or rejected, carries the current
  workspace identity; Agent R applies it before returning or raising the tool
  result.
- A workspace identity event received while waiting for a response is applied,
  not discarded.
- If a non-event result still exceeds the Agent response budget, the broker
  returns a bounded, truthful completion projection with explicit truncation
  metadata rather than closing the socket.
- Approval, execution admission, revision authority, durable Runs, Plots,
  Artifacts, project isolation, and the desktop/browser command contract do not
  change.

## Scope And Non-Goals

ART-1 owns only:

- model-facing projection of broker workspace results in
  `serve_desktop_agent`;
- response-level current workspace identity;
- Agent R identity synchronization for correlated responses and identity
  events;
- focused frame-budget and stale-recovery regression tests;
- the affected `rho.agent` package version and application NEWS entry.

It does not change the 8 MiB protocol ceiling, Ark event persistence, Plot or
Artifact payload storage, execution cancellation, provider retry policy,
approval semantics, project revisions, frontend state, database schema, or
release acceptance.

## ART-2 Redacted Provider Failure Projection

The project owner's `0.4.1-dev.1` local test reproduced a second result-loss
defect. Multiple turns reached the private `115-newapi` Provider and received:

```text
API request failed with status 429
URL: [REDACTED]/messages
Unknown error (could not read body)
```

The raw framed `desktop.agent_failed` event was persisted in the broker event
ledger, but `project_agent_turn_event()` omitted that event type and the normal
completion path finalized `agent_turns.error_message` as `NULL`. The UI could
therefore render only `Failed`, hiding the actionable Provider cause.

ART-2 is a D1/R2 repair with these invariants:

- `desktop.agent_failed` is a terminal failure with one redacted, bounded
  Provider error string;
- the same bounded value is persisted in `agent_turns.error_message` and as one
  visible `desktop.agent_failed` timeline event;
- Rust applies `redact_sensitive_text()` again at the host boundary and bounds
  the result before either projection, even though Agent R already redacts
  runtime-profile secrets;
- ordinary turn cards use controlled friendly mappings for HTTP 400, 401/403,
  404, 429, 5xx, timeout, and network failure, preserving the status code and a
  next action without exposing a URL, credential, raw response body, command,
  process, or transport identifier;
- expanded Activity may show the same controlled Provider failure message, not
  raw payload JSON;
- successful turns, tool failures, retry/cancel semantics, Provider selection,
  credentials, request shape, quota policy, and no-fallback behavior do not
  change; and
- no historical backfill guesses which raw broker event belongs to an old turn;
  the repaired projection applies to newly completed turns only.

Regression evidence must cover the observed 429 shape, 401/403, 5xx, unknown
redacted failure, 2 KiB bound, secret/URL removal, one terminal timeline event,
turn error persistence, successful completion remaining error-free, and
frontend card/activity copy. Local acceptance uses a synthetic persisted event
shape and then an owner-triggered Provider failure; Rho does not generate
automatic Provider requests for this repair.

ART-2 focused evidence on 2026-08-19:

```text
cargo test -p rho-server provider_failure --locked
  passed: 2
node --check desktop/dist/app.js
node scripts/test-human-facing-information-ui.mjs
node scripts/test-agent-output-review-ui.mjs
  passed
git diff --check
  passed
```

The local store then supplied owner-generated failures without a new automatic
Provider request. Newly completed turns persist bounded redacted 404/429 text
in `agent_turns.error_message` rather than `NULL`. Computer Use opened an exact
failed turn and confirmed visible copy: `Provider returned HTTP 404. Check the
model ID, Base URL, and compatible endpoint.` The UI exposed no URL, body, key,
process, or transport detail. Historical pre-ART-2 failures remain unmodified.

## Failure And Recovery Contract

For ordinary results, the broker removes the duplicate `events` array and
reports its count. If the remaining result exceeds a conservative response
budget, the broker preserves the operation identity, workspace identity,
terminal `execution.ok` value, and bounded error message where present, and
marks the response `response_truncated = true` with a stable reason.

The outer response remains successful when the broker operation completed;
truncation must not falsely report execution failure. A genuine authorization,
validation, stale, or execution rejection remains an error response, but it
includes current workspace identity. Agent R updates its identity before
raising that error, so a later tool call can recover without resetting the R
session.

## Cross-Review

- The [accepted scientific workflow handoff](accepted-2026-07-25-0.3x-scientific-workflow-handoff.md)
  retains Workspace R authority, broker revision checks, durable run/event
  truth, and bounded transport.
- The [implemented Agent handoff](implemented-0.2x-agent-handoff.md) retains
  correlated framed requests and the single Agent R process per turn.
- The [Agent execution output review repair](active-2026-08-04-agent-execution-output-review-repair-spec.md)
  retains user-facing output and Plot review behavior; ART-1 changes only the
  internal model-facing projection.
- The [human-facing information projection](active-2026-08-05-human-facing-information-projection-spec.md)
  retains ordinary UI error language. ART-2 may add only its controlled
  redacted Provider-failure category to the existing turn card and Activity
  surfaces; raw Provider payloads remain excluded.
- No competing schema, persistence, approval, policy, or project identity
  ownership is introduced.

## Verification Matrix

Rust/broker:

- a `workspace.execute` result containing a display event larger than 8 MiB is
  projected below the frame ceiling without losing execution or workspace
  truth;
- normal results preserve execution data and report the omitted event count;
- an oversized non-event result produces the bounded truthful truncation
  projection;
- success and error response envelopes carry current workspace identity.

R/Agent:

- a successful correlated response refreshes identity before return;
- an error response refreshes identity before raising;
- an interleaved `workspace.identity` event refreshes identity while the
  request continues waiting for its correlated response.

Affected validation:

```powershell
$env:PATH="C:\rtools45\x86_64-w64-mingw32.static.posix\bin;$env:PATH"
cargo +stable-x86_64-pc-windows-gnu fmt --all -- --check
cargo +stable-x86_64-pc-windows-gnu test -p rho-server desktop_agent
Rscript -e "testthat::test_local('r/rho.agent')"
node --check desktop/dist/app.js
git diff --check
powershell -ExecutionPolicy Bypass -File scripts/test-release-metadata.ps1 \
  -ExpectedVersion 0.4.0-dev.1 -Prerelease true -Json
  PASS: Cargo workspace, Tauri bundle, and desktop frontend all 0.4.0-dev.1
```

## Acceptance And Stop Point

ART-1 is explicitly authorized by the user's 2026-08-06 request to repair the
observed analysis-result disconnect. Stop after the bounded transport and
identity recovery slice, focused/affected automated verification, contract
review, package version/NEWS reconciliation, and diff review. Installed-app
acceptance remains open until a rebuilt candidate runs a representative
plot-producing analysis whose persisted kernel events exceed the former
response shape without disconnecting or requesting a session reset.

Automated evidence on 2026-08-06:

```text
cargo +stable-x86_64-pc-windows-gnu fmt --all -- --check
cargo +stable-x86_64-pc-windows-gnu test -p rho-server desktop_agent
  7 passed; 0 failed
cargo +stable-x86_64-pc-windows-gnu test -p rho-server
  42 passed; 0 failed
Rscript -e "testthat::test_local('r/rho.agent')"
  52 passed; 0 failed
node --check desktop/dist/app.js
git diff --check
```

Contract review found no authority or persistence deviation. Execution
admission and stale rejection remain broker-owned; raw events remain durable
and available to Plot/Artifact projection; the Agent-only response removes
their duplicate transport copy. Both ordinary and truncated success retain
terminal execution truth and current workspace identity. No frontend or mock
command changed.

Candidate reconciliation also corrected the release metadata validator's
required About/update contract path from the obsolete `active-` filename to
the existing `accepted-` lifecycle filename. This changes no release policy;
it restores the deterministic version gate before commit.

## Version And Release Impact

The `rho.agent` runtime contract changes, so its package version advances from
`0.1.1` to `0.1.2`. The user-visible repair is recorded in `NEWS.md` and the
synchronized application version authorities advance from `0.4.0-dev.0` to
`0.4.0-dev.1` for this named development candidate. This work does not
authorize a release; installed-candidate acceptance remains open.
