# P2-2 Read-only Broker Grants And Trusted Permission UI

Status: active; complete Phase 2 direction and local-first exception authorized
2026-08-20; P2-2A schema/persistence, P2-2B trusted permission UI/fresh
handles, P2-2C `project.fs.read`, and P2-2D `workspace.r.inspect` checkpoints
complete locally; P2-2E `network.fetch` activated; P2-1
Windows/Linux hosted acceptance remains open and mandatory before final Phase 2
acceptance

Active work package: P2-2E only. P2-2F remains inactive until the HTTPS,
redirect, DNS, timeout, streaming, credential/proxy, and revoke-during-fetch
gate passes. P2-2E may add only bounded credential-free GET/HEAD requests to
approved public HTTPS origins; arbitrary network, private/link-local targets,
cookies, proxy credentials, custom headers, uploads, and non-HTTP protocols
remain absent.

Change class: D3 security, schema, approval, network, filesystem, Workspace R,
and cross-module behavior. Risk: R3.

## Purpose

P2-1 gives an enabled project plugin a no-WASI/no-import Wasm host with no
privileged capability. P2-2 adds the only initial privileged operations:

- `project.fs.read`;
- `workspace.r.inspect`;
- `network.fetch`.

Every operation remains a Rust-broker action behind an opaque handle. A
manifest requests permission but never authorizes it, a durable user decision
does not itself become a live handle, and the Wasm host still receives no WASI
or raw Rust/Tauri object.

## Authority And Cross-review

Owning and overlapping contracts:

- the active Phase 2 design owns capability/permission separation and package
  identity;
- P2-1 owns Wasm execution, Guest ABI V1, host instance identity, cancellation,
  and quarantine;
- `rho-store` owns SQLite truth and the transactional migration lane;
- BH1/BH2 own normalized project identity and switching;
- Workspace R and the existing broker own scientific-object truth and fixed R
  calls;
- environment operations retain their dedicated request table/dialog;
- Agent approvals retain `approval_requests`; P2-2 must not reuse either lane;
- credential contracts forbid raw credentials, credential-store access,
  inherited Provider headers, proxy environment, cookies, and secret logging;
- BH4 owns retention/tombstone policy;
- the public Workbench Protocol remains read-only and unchanged;
- P2-3 owns contributions; P2-4 owns durable enablement lifecycle,
  restart/upgrade/rollback, and uninstall.

The current TCMD-RUNS1 and P2-1 source slices may be present in the same branch,
but P2-2 may not edit their behavior or claim their hosted gates.

## Dedicated Permission Lane

P2-2 introduces `PendingPluginPermissionRegistry` in the trusted Rust desktop/
broker state. It is separate from Agent approvals and scientific environment
operations. The trusted shell owns the dialog, labels, consequence, buttons,
focus, and accessibility. Plugin text is bounded, plain text, visibly labelled
as untrusted purpose text, and never supplies HTML, button labels, warning
severity, resource summaries, or decision wording.

Proposed Tauri commands:

```text
list_workspace_plugins
request_workspace_plugin_enable
list_plugin_permission_requests
get_plugin_permission_request
respond_plugin_permission
list_plugin_grants
revoke_plugin_grant
```

Command names and response schemas become fixed only when this document is
activated. Browser/mock handlers and the generated command inventory change in
the same implementation slice.

User decisions:

- **Deny**: no grant or handle; durable denied event.
- **Allow once**: one successful operation; expires after five minutes if
  unused; never survives restart as an active authorization.
- **Allow for this project**: exact project/plugin/package/permission/
  constraint digest, maximum 30-day expiry, user-revocable; restart may restore
  the decision but always mints a fresh host/generation-bound handle.

There is no all-project, organization, permanent-without-expiry, or implicit
upgrade grant. Changed package digest, runtime kind, permission, constraints,
policy revision, or project opens a new trusted decision.

## Schema V13

P2-2 owns a transactional `v12 -> v13` migration with no historical backfill.
Existing databases gain empty plugin-permission tables; no legacy Agent,
environment, project, run, artifact, or plugin state is guessed.

### `plugin_permission_requests`

```text
request_id TEXT PRIMARY KEY
project_root TEXT NOT NULL
plugin_id TEXT NOT NULL
plugin_version TEXT NOT NULL
package_digest TEXT NOT NULL
runtime_kind TEXT NOT NULL
permission TEXT NOT NULL
constraints_json TEXT NOT NULL
constraints_digest TEXT NOT NULL
purpose_text TEXT
status TEXT NOT NULL
requested_at TEXT NOT NULL
resolved_at TEXT
decision TEXT
grant_source TEXT
reason_code TEXT
expected_project_revision INTEGER NOT NULL
```

Allowed status transitions are `pending -> granted|denied|cancelled|stale`.
Terminal rows never return to pending. Project switch, plugin crash/disable,
digest change, host replacement, or shutdown cancels the exact pending request.
Durable completion is reported only after the transition commits.

### `plugin_permission_grants`

```text
grant_id TEXT PRIMARY KEY
project_root TEXT NOT NULL
plugin_id TEXT NOT NULL
plugin_version TEXT NOT NULL
package_digest TEXT NOT NULL
runtime_kind TEXT NOT NULL
permission TEXT NOT NULL
constraints_json TEXT NOT NULL
constraints_digest TEXT NOT NULL
grant_source TEXT NOT NULL
policy_revision INTEGER NOT NULL
created_at TEXT NOT NULL
expires_at TEXT NOT NULL
revoked_at TEXT
consumed_at TEXT
status TEXT NOT NULL
originating_request_id TEXT NOT NULL
```

The raw capability-handle token, host instance ID, activation generation,
Workspace identity, response content, file content, URL query, headers, DNS
answers, credentials, and R object preview are never persisted here.

### `plugin_permission_events`

Append-only-in-meaning bounded audit records request, decision, handle minted,
call admitted/denied, call completed/failed/cancelled/uncertain, grant consumed,
expired, revoked, and stale events. It stores stable codes and bounded sizes/
durations, never raw handles, content, credentials, complete URLs, private DNS
answers, R values, or plugin-controlled unbounded strings.

Required indexes cover `(project_root, status)`, exact plugin/digest lookup,
pending requests, active grants, expiry, and event retention. Foreign keys and
status checks are enforced. Migration tests cover v7-v12 fixtures, backup,
injected failure/rollback, reopen/idempotency, unprovable legacy data, and no
premature schema-version advance.

## Opaque Handle Contract

- handles contain 256 random bits from the operating-system RNG;
- the raw token exists only in the broker and exact Wasm host session memory;
- only SHA-256 of the token is retained by the live grant reference monitor;
- SQLite persists the user decision/grant ID, not a reusable raw handle;
- handle identity binds exact normalized project, plugin ID/version, package
  digest, runtime kind, scope, activation generation, host instance, permission,
  constraints digest, policy revision, expiry, and Workspace identity/revision
  when applicable;
- restart, project switch, host crash, disable, digest change, revoke, expiry,
  or Workspace restart invalidates the handle;
- `allow once` is consumed only after the bounded operation succeeds. Failure
  before dispatch leaves it retryable until expiry; uncertain external network
  completion consumes it fail-closed and records `completion_uncertain`;
- revalidation and durable audit admission occur before every call; durable
  completion is recorded after the result is bounded and before UI/plugin
  success is reported.

The current pure `GrantStore` must gain injected clock/RNG and persistence
adapters rather than letting tests depend on wall clock or UUID coincidence.

## No-import Guest ABI V2 Broker Loop

P2-2 does not add synchronous Wasmtime host functions or WASI imports. Network
and Workspace operations are asynchronous and must not execute while guest
code holds the Wasm store. Guest ABI V2 therefore extends V1 with an explicit
yield/resume state machine:

```text
rho_begin(call_ptr: i32, call_len: i32) -> i64
rho_resume(result_ptr: i32, result_len: i32) -> i64
rho_cancel(call_id_hi: i32, call_id_lo: i32) -> i32
```

The packed return points to one bounded UTF-8 `GuestStep` envelope in guest
memory:

```text
GuestStep =
  { type: "broker_request", call_id, handle_id, permission, operation, args }
  | { type: "complete", call_id, result }
  | { type: "error", call_id, code }
```

Rules:

- the module still imports nothing; the Rust host invokes exports only;
- each guest step runs under P2-1 fuel/memory/epoch limits, then returns control
  completely before the broker performs filesystem/network/Workspace work;
- Rust validates the exact handle and action, performs at most one bounded
  operation, writes a bounded result into guest memory, and calls `rho_resume`;
- maximum eight broker steps per top-level call, one active call per plugin,
  64 KiB step envelopes, and a 1 MiB cumulative broker-result budget;
- call ID is host-generated and bound to project/plugin/digest/generation/host;
- a different permission/operation than the handle, repeated completion,
  unknown call, duplicate step, out-of-order resume, guest pointer change,
  stale project/Workspace, revoke, cancellation, trap, or budget exhaustion
  quarantines or cancels according to the exact failure class;
- raw handles/results exist only in the exact guest memory and broker call;
  neither becomes a Wasmtime import, global host object, SQLite payload, log, or
  another plugin's input;
- the broker may return only typed redacted errors; it never serializes internal
  Store/coordinator/reqwest/filesystem objects into the guest.

V1 remains accepted for zero-permission diagnostic fixtures. A plugin declaring
P2-2 permissions must negotiate Guest ABI V2; no fallback silently drops or
broadens a permission.

## `project.fs.read`

Request:

```text
handle_id
project_relative_path
max_bytes
expected_project_revision
```

Rules:

- the broker supplies the explicit normalized project root; the plugin cannot
  select another root;
- path uses UTF-8 forward-slash normalized components; empty, absolute, drive/
  UNC, `.`/`..`, empty components, NUL/control, and alternate separator forms
  are rejected before matching;
- the grant glob is matched against the normalized relative path using the
  current deterministic `*`, `?`, and `**` grammar;
- project root and every path component are checked with `symlink_metadata`;
  symlinks, junctions/reparse points, nested repositories, non-regular files,
  root replacement, and canonical escape fail closed;
- reserved paths are always denied: `.git/**`, `.rho/**`, `.env`, `.env.*`,
  `.Renviron`, private-key extensions, SSH material, and OS credential-store
  locations;
- maximum is the smaller of manifest, durable grant, call, and 1 MiB; bytes are
  counted while streaming and just-over-limit fails without returning a prefix;
- metadata/root identity is checked before open and after read; change produces
  `file_changed` rather than success;
- only bytes plus media/encoding metadata are returned; no execution, parsing,
  directory listing, file handle, write, watch, mmap, or path outside the
  exact grant.

Tests cover Unicode/spaces, boundary bytes, `*` versus `**`, symlink/reparse,
root replacement, race/failure injection, reserved secrets, project A/B with
identical paths, stale revision, revoke-during-read, and restart.

## `workspace.r.inspect`

The guest never submits R code. It supplies an exact broker-issued object
reference obtained from a bounded Workspace snapshot plus `metadata` or
`preview`.

The reference binds normalized project root, Workspace ID, kernel instance,
state/project revisions, object name/type identity, and issue time. The broker
calls only existing fixed inspection requests with the explicit project root.

Bounds:

- metadata: 64 KiB;
- preview: 100 rows, 50 columns, depth 4, 256 KiB total;
- one active inspection per plugin and existing global Workspace scheduling;
- no assignment, package mutation, arbitrary method dispatch, active binding
  evaluation beyond existing safe inspection, source/eval/parse, plotting, or
  object serialization.

Workspace restart, project switch, object/revision change, grant revoke, host
replacement, or late response rejects the result. Tests cover two projects,
same object names, active bindings, S4/list/data-frame bounds, oversized and
malformed bridge results, cancellation, Workspace crash, late completion, and
no false durable completion.

## `network.fetch`

Request is HTTPS `GET` or `HEAD` only. There is no body, credential, cookie,
custom authorization header, proxy inheritance, client certificate, local
socket, alternate scheme, or plugin-controlled redirect policy.

Rules:

- URL length is bounded; userinfo, fragment, IP literal, non-443 port, control
  characters, and non-HTTPS scheme fail before DNS;
- hostname is canonical lower-case IDNA ASCII and matched against the exact
  grant host/wildcard grammar;
- trusted DNS resolution rejects every loopback, private, link-local, multicast,
  unspecified, documentation, carrier-grade NAT, and otherwise non-global IPv4/
  IPv6 result; the client connects only to the vetted resolved addresses while
  retaining the approved hostname for TLS/SNI;
- environment/system proxies and `.netrc`-style credential discovery are off;
- redirects are disabled in the HTTP client, followed manually at most three
  times, and each target repeats URL, host, grant, DNS/IP, method, size, time,
  project, digest, host-session, expiry, and revocation checks;
- TLS validation remains platform/default trust with no plugin CA override;
- request timeout is 15 seconds; response maximum is the smaller of manifest,
  grant, call, and 1 MiB; streaming stops before an over-limit result is
  returned;
- response exposes status, selected safe headers, final approved origin,
  content type, truncation=false, and bounded bytes. `Set-Cookie`, auth,
  connection, proxy, server internals, and other sensitive headers are dropped;
- returned bytes are data only and cannot become fetched executable code.

Tests use a fake resolver/server and cover DNS rebinding, mixed public/private
answers, IPv4/IPv6 special ranges, wildcard confusion, IDNA, trailing dot,
userinfo, redirect-to-private/foreign host, method/body/header injection,
credential/proxy absence, timeout, streaming overflow, revoke during redirect/
body, cancellation, TLS failure, and project/plugin isolation. Live internet or
developer credentials are never a required test.

## Trusted UI States

The Plugins surface covers loading, none discovered, disabled, permission
required, enabled-with-zero-permission, active grant, denied, stale digest,
expired/revoked, host unavailable, operation failed, and recovery. The dialog
shows:

- plugin name, version, short digest, project;
- permission and exact normalized constraints;
- fixed consequence and duration;
- untrusted plugin purpose in a separate quoted/plain-text region;
- Deny, Allow once, and Allow for this project actions;
- a revoke path and the statement that upgrades require review.

Escape closes without authorization. Focus trap/restore, keyboard order,
screen-reader names, narrow view, Unicode/long labels, malicious markup/URL, and
browser/mock parity are deterministic acceptance cases. Plugin content cannot
overlay or resemble Agent approval, environment operation, credential, updater,
or destructive dialogs.

## Work Packages And Stop Points

P2-2 activates only after P2-1 hosted acceptance and a filename/status update.
Once active, it proceeds vertically:

1. **P2-2A — schema + dedicated request/grant/event lane**, no privileged
   operation or UI success claim;
2. **P2-2B — trusted permission UI + enable/deny/revoke + fresh handles**, no
   filesystem/network/Workspace call yet;
3. **P2-2C — project.fs.read**, complete containment/isolation/recovery gate;
4. **P2-2D — workspace.r.inspect**, complete Workspace/revision/crash gate;
5. **P2-2E — network.fetch**, complete SSRF/redirect/DNS/timeout gate;
6. **P2-2F — combined restart/revoke/concurrency/browser/installed review**.

Stop after each slice. Later slices cannot make an earlier half-wired schema or
UI falsely authoritative.

### P2-2A checkpoint evidence

P2-2A is implemented locally in schema version 13 and the dedicated
`PluginPermissionQueryService` / `PluginPermissionMutationService` seam. The
three plugin-permission tables are separate from Agent approvals and scientific
environment requests. Migration performs no historical backfill, preserves a
backup, rolls back on injected failure, and rejects current-schema identity,
foreign-key, constraint, or live-authority tampering.

The persistence lane validates explicit normalized project identity, plugin
identity/version/package digest, canonical permission constraints, bounded
purpose/reason text, decision duration, reserved filesystem paths, and network
host/method shapes. Request resolution, grant creation, event creation,
cancellation, consume, revoke, expiry, and recovery are atomic, stale-safe,
idempotent, and project-scoped. Grant rows deliberately omit raw handles,
handle digests, host/generation/Workspace identity, response content, and other
live authority.

Local verification on 2026-08-20:

- stable and exact Rust `1.88.0` `cargo test -p rho-store --locked
  --no-fail-fast`: 138 unit and 34 scenario tests passed on each toolchain;
- the concurrent identical-decision regression passed ten consecutive focused
  repetitions; its first review run exposed a deferred-transaction
  `DatabaseBusy` race, after which every permission mutation was changed to an
  `IMMEDIATE` transaction and the full matrix passed;
- grant-insert failure rollback, v12 migration rollback/recovery, reopen,
  cancellation, expiry, duplicate/idempotent decisions, invalid payloads, and
  two-project isolation passed;
- stable and Rust `1.88.0` clippy completed with warnings capped. Strict
  `-D warnings` is not claimed because `rho-store` has existing crate-wide
  warning debt (principally the large `StoreError` result); the one new
  non-baseline structural warning was removed by replacing the positional
  ten-argument event writer with a named event draft;
- rustfmt and `git diff --check` passed before the checkpoint review.

P2-2A is non-routable and therefore does not advance application or R package
versions and does not add `NEWS.md` copy. Hosted CI, independent privileged
operation review, browser/installed acceptance, and release authority remain
open. This evidence closes only the local P2-2A stop gate and activates P2-2B.

### P2-2B checkpoint evidence

P2-2B is implemented locally as a separate `workspace_plugins` application
coordinator plus a thin `commands/plugins.rs` Tauri module. Seven fixed
commands cover discovery, explicit enable, dedicated request inspection,
decision, grant projection, and revoke. The browser mock implements each
command exactly once, and the generated command inventory fixes 125 registered
commands across 11 Rust source files.

The live reference monitor now uses 256 random bits from the OS-backed RNG,
injected clock/token sources for deterministic tests, redacted handle debug
output, canonical constraint digests, explicit completion for allow-once,
in-flight reservation, durable-grant replacement with a new token, and exact
bindings for normalized project, plugin/version/digest/runtime, scope,
generation, host, permission, constraints, policy revision, expiry, and
Workspace lineage. SQLite still receives no raw handle, handle digest, host,
generation, or Workspace authority. Restart revokes durable allow-once rows;
project switch and shutdown invalidate in-memory authority and recover pending
requests.

Permission-bearing modules must expose the complete no-import Guest ABI V2
export set; V1 remains valid only for zero-permission diagnostics. P2-2B detects
and activates V2 but deliberately executes no broker step or privileged
operation. Durable decisions that precede a package change or host failure are
reported truthfully as saved with `stale_digest` or `host_unavailable`, while
the live-handle count remains zero.

The trusted dialog renders plugin name, exact version/digest/project,
permission, normalized constraints, fixed consequence copy, duration choices,
and separately labelled untrusted purpose using DOM `textContent`. Deny, Allow
once, Allow for this project, revoke, Escape, focus trap/restore, and browser
mock parity are present. The surface never accepts plugin HTML, labels,
severity, or decision wording and never exposes a raw handle.

Local verification on 2026-08-20:

- stable and exact Rust `1.88.0`: `rho-extension-runtime` 169 tests,
  `rho-store` 174 tests, and desktop 212 passed with one existing opt-in
  Keychain smoke ignored on each toolchain;
- stable and Rust `1.88.0` extension-runtime strict clippy passed with
  `-D warnings`; rustfmt, lockfile use, JS syntax, and `git diff --check`
  passed;
- focused failures cover request-batch rollback, stale project/digest,
  duplicate/concurrent decisions, multi-permission denial, invalid constraints,
  host activation failure after durable success, one-shot restart recovery,
  fresh-token replacement, revoke, shutdown/project invalidation, and
  two-project persistence isolation;
- command inventory, Phase 1 acceptance/version agreement, MAC4 release
  contract, Rust MSRV contract, and the Workspace Plugins trusted-UI contract
  passed;
- real local browser review passed at 1440x900, 1024x768, and 390x844 with one
  modal, no horizontal overflow, all decision buttons visible, malicious
  `<script>` purpose rendered as text with no child element, initial Deny focus,
  post-decision Refresh focus, Escape restoring the View menu trigger, approve
  and revoke state transitions, and no `handle.*` text. The only console
  diagnostics observed were existing Monaco cancellation messages during
  deliberate page reload; no plugin-specific warning/error was present.

Application metadata and browser fixtures advance together to
`0.4.1-dev.3`; `NEWS.md` records this first user-routable Phase 2 surface. R
package versions remain unchanged. Packaged-app, hosted six-leg, independent
privileged-operation review, and release acceptance remain open. This closes
only the local P2-2B stop gate and activates P2-2C.

### P2-2C checkpoint evidence

P2-2C implements a no-import Guest ABI V2 state machine with host-generated
call IDs, exact begin/resume/cancel sequencing, one active call per plugin,
eight-step, 64-KiB step, one-MiB raw broker-result, and bounded JSON/base64
framing limits. Each guest transition runs under the existing fuel/memory/
epoch limits and returns completely before Rust performs broker work. Raw
handles are redacted from debug output and exist only in the live reference
monitor, exact host memory, and current call envelope.

The broker-owned `rho-server::plugin_fs` lane accepts an explicit trusted
project root and fixed `ProjectFsReadRequest`. It rejects non-normalized,
absolute, drive/UNC, alternate-separator, empty, dot/parent, control, reserved,
symlink/reparse, nested-repository, non-regular, and canonical-escape paths.
It verifies every component, root/file identities and canonical paths before
and after a streaming `max + 1` read; no prefix is returned on overflow or
change. The effective maximum is bounded by call, live/durable constraints,
and the one-MiB hard limit. Only base64 bytes, media/encoding metadata, size,
and digest return—never a file handle, listing, watch, mmap, write, parse, or
execution surface.

Every call revalidates the exact handle before admission and again after I/O.
`call_admitted`, bounded completion/failure/denial, handle-minted, and
allow-once consumption facts commit through the dedicated Store service. A
result is resumed into the guest only after durable completion and a final
in-memory recheck. Revoke/project replacement during read withholds bytes;
completion persistence failure releases the one-shot reservation, cancels the
guest call, and permits a deterministic retry; a guest resume trap records
failed delivery, consumes fail-closed where completion was already durable,
quarantines the host, and exposes no success.

Local verification on 2026-08-20:

- stable and exact Rust `1.88.0`: extension runtime 173 tests, `rho-server` 71,
  `rho-store` 176, and desktop 216 passed with one existing opt-in Keychain
  smoke ignored on each toolchain;
- extension-runtime strict clippy passed on stable and Rust `1.88.0`; server
  clippy completed on both with no `plugin_fs` warning; rustfmt and locked
  builds passed;
- focused tests cover Unicode/spaces, exact and just-over byte limits,
  deterministic `*`/`?`/`**`, reserved secrets, symlink/reparse defense,
  nested repositories, root/file replacement, stale revision, identical A/B
  paths, wrong call/order, duplicate step, result/step budgets, exact cancel,
  revoke during read, allow-once consume, bounded audit with no handle, audit
  failure rollback/retry, and guest-resume quarantine;
- the new P2-2 broker contract and its negative self-tests pass and now run in
  Draft Fast and all stable/MSRV compatibility legs; the MSRV workflow contract
  verifies those commands and path filters.

P2-2C adds no Tauri command, contribution route, public protocol, new version,
or R package change. The implementation is real but not yet user-invokable
without the separately gated P2-3 contribution surface. Hosted Windows/Linux,
installed-app, independent cross-platform filesystem review, and release
acceptance remain open. This closes only the local P2-2C stop gate and
activates P2-2D.

### P2-2D checkpoint evidence

P2-2D adds a broker-owned `WorkspaceObjectReferenceRegistry`. References are
issued transactionally only from the existing bounded Workspace snapshot and
bind the normalized project, Workspace ID, kernel instance, state/project
revisions, object name/classes/type/preview identity, and issue time. The guest
receives only bounded reference views; it cannot provide a project root,
Workspace identity, R environment, method name, or R code.

Preparation produces only fixed `workspace.inspect_object` arguments containing
the reference-bound object name and exact expected Workspace revisions. Result
validation rejects another project, kernel restart, state/project revision
change, same-name type/class/preview identity change, malformed response,
oversized/deep/row/column-heavy preview, and late completion. Metadata is capped
at 64 KiB; preview at 256 KiB, 100 rows, 50 columns, and depth four. Function
source is never projected to a workspace plugin.

The desktop adapter dispatches through the existing Ark/Coordinator request
lane and performs no direct R call. Guest execution yields before dispatch and
resumes only after reference validation, final live-grant revalidation, bounded
audit persistence, and allow-once consumption. Workspace crash, stale late
result, project switch, restart, revoke, completion persistence failure, and
guest-resume failure return typed failures without false live completion.
Project switch, Workspace restart, and shutdown invalidate references, hosts,
and live handles while bounded project decisions may later mint fresh handles.

The R bridge also closes the pre-existing active-binding evaluation gap:
snapshots now describe active bindings as opaque without calling them, and
fixed inspection rejects them before `get()`. This exported package-contract
change advances `rho.bridge` from `0.1.14` to `0.1.15` with synchronized package
NEWS; `rho.agent` remains unchanged.

Local verification on 2026-08-20:

- stable and exact Rust `1.88.0`: `rho-server` 75 and desktop 218 tests passed
  with one existing opt-in Keychain smoke ignored on each toolchain;
- `rho.bridge` passed 581 tests with no failure, warning, or skip, including an
  active binding whose invocation counter remains zero through snapshot and
  rejected inspection;
- server clippy completed on stable and Rust `1.88.0` with no
  `plugin_workspace` warning; rustfmt, locked builds, the P2-2 broker contract,
  negative self-tests, and MSRV workflow/path enforcement passed;
- focused tests cover metadata/preview projection, dataframe/list/S4-shaped
  generic bounds, transactional reference issue, scalar active-binding class,
  same object name in two projects, kernel/state change, object identity
  change, malformed/oversized result, fixed request arguments with no R code,
  allow-once consumption, late completion, Workspace crash, and absence of
  source or raw handles from durable audit.

P2-2D adds no Tauri command, public protocol, application version, or
user-facing contribution route. Hosted/installed Workspace crash and platform
review remain open. This closes only the local P2-2D stop gate and activates
P2-2E.

## Verification Matrix

Every state mutation covers success, invalid input, policy denial, stale state,
persistence failure, cancellation, restart/recovery, idempotency/duplicate, and
two-project isolation. Schema uses historical fixtures and injected failure.
Payloads test boundary and just-over-bound shapes. Privileged operations test
revocation during call and no result after stale project/host/workspace state.

Required completion evidence includes focused crate tests, rho-store migration
and scenario matrices, rho-server broker tests, desktop command/unit tests,
browser/mock contract and three viewport review, Rust 1.88/stable six-leg CI,
all three packaged-platform smokes, R suites, independent filesystem/network/
Workspace security review, version/NEWS agreement, and exact candidate handoff.

## Version, NEWS, And Release

The first user-routable P2-2 slice allocated application development version
`0.4.1-dev.3` and added truthful NEWS copy describing local project plugins and
permission prompts without claiming P2-3 contributions, P2-4 durable
restart/upgrade completeness, a marketplace, signing, or public release.

No R package version changes unless an exported bridge contract changes. No
source merge alone authorizes distribution; exact installed candidate
acceptance and a separate release decision remain required.
