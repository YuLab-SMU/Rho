# LLM Credential Sources And Store Hardening

Status: active; the project owner explicitly authorized the complete upgrade
project (CRED-SEC1 through CRED-SEC5) on 2026-08-26 with the instruction to
complete the whole upgrade autonomously, and this document was renamed from
`proposed-` to `active-` on that authorization. Implementation state per
package is recorded in the evidence sections appended below as each package
reaches its acceptance gate.

Owning relationship: this proposal amends
`plans/active-2026-08-05-system-credential-and-simple-llm-settings-spec.md`
(the CRED-UX series) and the credential sections of
`design/implemented-agent-llm-configuration-design.md`. It does not replace
their provider/model/route authority, schema-V2 revision discipline, redaction
layers, or no-fallback rules. Per
`project/active-document-cross-review.md`, this document must be added to the
cross-review matrix before any implementation begins.

Change class: D3 (credential/security behavior crossing Rust backend, settings
schema, Agent R transport, and UI). Risk: credentials are a named high-risk
domain in `AGENTS.md`; every package below requires negative tests and
failure-injection/recovery evidence.

## 1. Background And Motivation

A 2026-08-26 survey of mainstream AI Agent tools (Claude Code, Codex CLI,
opencode, Cursor IDE/CLI, DeepSeek Harness, aider, Gemini CLI) found the
industry converging on: multiple credential sources with explicit precedence,
OS keyring as the preferred store, a permission-limited file fallback where no
keyring exists, session-only (ephemeral) credentials, secret/config separation,
and credential-access audit.

Rho's current implementation (verified 2026-08-26 against
`desktop/src-tauri/src/agent_llm.rs` and `desktop/src-tauri/Cargo.toml`):

- OS-native store on all three desktop platforms through keyring 4.1.6:
  Windows Credential Manager (`windows-native-keyring-store`), macOS Keychain
  (`v1`), Linux Secret Service over DBus (`v1`, zbus).
- A `SessionCredentialCache` (Zeroizing) that avoids repeated Keychain prompts
  within one app session.
- Settings metadata only in schema-V2 `llm-profiles.json`; credentials are
  never written to settings, SQLite, logs, prompts, events, or the frontend.
- The key is read immediately before use and injected only into the
  short-lived Agent R child environment.
- The 2026-08-06 simplification removed the `.Renviron` compatibility source;
  the system credential store is the only API-key source today.

This single-source design covers the interactive desktop case well but leaves
four concrete gaps relative to the surveyed industry baseline:

1. **No environment-variable source.** Headless Linux (SSH, container,
   AppImage on a server), CI-driven review, and power users who standardize on
   `OPENAI_API_KEY`-style variables have no supported path. Environment
   variables are the surveyed tools' universal lowest-common interface
   (Codex `CODEX_API_KEY`, aider, Cursor CLI `CURSOR_API_KEY`, Gemini CLI).
2. **No degraded mode when the OS store is unavailable.** On a Linux session
   without Secret Service, `keyring` returns an error and saving a key is
   blocked outright. The industry fallback (Claude Code on Linux) is a
   `0600`-permission file with a one-time warning.
3. **No session-only (ephemeral) mode.** Codex `ephemeral` and DeepSeek
   Harness's write-only reference pattern both serve users who must not
   persist a key: shared machines, borrowed accounts, one-off evaluations.
4. **No source visibility or access audit.** The user cannot see which source
   supplied the effective credential, and credential set/delete/use events
   leave no auditable (redacted) trace.

Secondary hardening gaps found while reading the current code:

5. **No entry-time key validation.** Control characters, embedded newlines,
   and per-backend size limits (Windows Credential Manager generic
   credentials cap the blob at 2560 bytes) are not rejected up front, so a
   long token surfaces as an opaque store error.
6. **No overwrite guard.** Saving a key for a provider that already has one
   silently replaces it.

## 2. Design Principles

Carried over from the active CRED-UX contract and the survey's consensus:

- Rho-owned configuration continues to store **metadata, never credentials**.
- Every credential source is **explicit per provider**; there is no silent
  fallback between sources and no silent store downgrade.
- The key material exists only in the desktop process (Zeroizing session
  cache) and the short-lived Agent R child environment.
- A stored value is never redisplayed; the UI shows source and detection
  state, never the value, length, prefix, or suffix.
- Workspace R never receives these credentials.
- Failure states are actionable and truthful: an unavailable store is an
  error with a named recovery action, not a guess.

## 3. Proposed Work Packages

Each package is separately authorizable and independently shippable. CRED-SEC1
is the foundation; CRED-SEC2 and CRED-SEC3 depend on it; CRED-SEC4 and
CRED-SEC5 depend only on the current code and may proceed in parallel.

### CRED-SEC1 — Per-provider credential source (schema V3)

Add an explicit `credential_source` field to `AgentProviderProfile`:

```text
system_store   (default; current behavior)
environment    (read-only from the desktop process environment)
session_only   (CRED-SEC2; rejected as unknown in V3 until SEC2 lands)
```

- **Schema migration.** Settings schema V2 -> V3 is additive: the field
  defaults to `system_store` for every existing provider. Reuse the V1->V2
  discipline: in-memory default on read-only open, byte-identical backup
  before the first V3 write, atomic replace, stop on corrupt source or failed
  backup. `revision` keeps its monotonic stale-writer rejection.
- **Environment source semantics.** When `credential_source = environment`,
  resolution reads the variable named by the existing `api_key_env` field from
  the desktop process environment at connection-test or Agent-turn time.
  Rho never writes, edits, migrates, or deletes that variable; the provider
  editor shows an immutable hint naming the variable instead of a key input.
  This deliberately does not reintroduce `.Renviron` parsing: the variable
  must be present in the environment Rho was launched with, keeping the
  2026-08-06 "no environment-file fallback" decision intact.
- **Precedence.** Within one provider there is exactly one configured source.
  The session cache (existing) sits in front of whichever source is
  configured; it never widens the source.
- **Settings projection.** `agent_llm_settings` gains per-provider
  `credential_source` and a derived `effective_credential_status`
  (`detected | not_detected | not_required | store_unavailable`) so the UI can
  render "Key: from environment `OPENAI_API_KEY`" or "Key: system store"
  without exposing values.

Acceptance gate: migration round-trip tests (V2 file -> V3 memory -> V3 file),
stale-revision rejection, redaction regression suite green, and the existing
Keychain smoke unchanged.

### CRED-SEC2 — Session-only credentials

- Saving with `credential_source = session_only` stores the key **only** in
  the existing `SessionCredentialCache`. Nothing touches the OS store, the
  settings file, or disk.
- The cache entry lives until app exit or an explicit Clear. The provider row
  carries a persistent "Session only — cleared when Rho quits" badge; the
  composer status shows the same state.
- Deleting the provider or switching its source clears the cache entry first,
  matching the current Keychain-first-then-cache ordering rule (mutate the
  durable side before the cache, preserve the cache on failure).
- Switching a provider from `session_only` to `system_store` requires a fresh
  key entry; the cached value is never promoted to durable storage implicitly.

Acceptance gate: negative tests proving no keyring call occurs (mock store
asserts zero set/delete invocations), cache cleared on provider deletion,
badge states in browser/mock review, and restart behavior (key gone, status
`not_detected`, no error).

### CRED-SEC3 — Linux degraded store fallback (explicit opt-in)

When `credential_source = system_store` and the Secret Service backend returns
"unavailable" (DBus absent, no collection):

- Save returns a classified `store_unavailable` error naming one recovery
  action: **Enable file-based storage for this provider**.
- Opting in sets `credential_source = file_fallback` (V3 vocabulary addition
  gated to Linux) and writes the key to
  `<app_config_dir>/credentials/<sha256(provider_id)>` with `0600`
  permissions, atomic write, and a one-time warning dialog stating the file
  is only protected by filesystem permissions.
- The provider row permanently shows "Stored in file (weaker protection)".
- Detection probes distinguish `not_detected` from `store_unavailable` so
  headless users see the difference.
- macOS and Windows never offer this fallback; a keyring failure there
  remains a hard actionable error.

Acceptance gate: failure-injection tests with a faulting store backend (save
rejected pre-opt-in, opt-in write has `0600` and survives restart read),
permission assertions, redaction of fallback paths in diagnostics, and proof
that non-Linux builds contain no fallback code path.

### CRED-SEC4 — Credential access audit

Emit redacted audit events through the existing audit runtime for:

- credential set / replace / delete (provider id, source, outcome);
- connection-test credential read (provider id, source, detected/not);
- Agent-turn credential injection (provider id, source, turn id).

Events never contain the value, length, prefix, suffix, or environment
contents. Failure to write an audit event does not block the credential
operation but surfaces as an audit-runtime error per existing audit policy.

Acceptance gate: event schema tests, redaction tests feeding known sentinel
values through every event path, and two-event ordering checks
(Keychain-first ordering preserved under failure).

### CRED-SEC5 — Entry-time validation and overwrite guard

- Reject keys containing control characters or newlines; trim nothing
  silently — reject and let the user fix the paste.
- Enforce per-backend maximum length before save: 2560 bytes (UTF-8) when the
  Windows backend is active; a generous uniform cap (4096 bytes) elsewhere.
  Violations return a classified `credential_too_long` error, not a store
  error.
- Saving over an existing stored key requires one explicit confirmation
  naming the provider; the confirmation text never echoes old or new values.

Acceptance gate: validation unit tests (boundary lengths, newline injection),
confirmation-flow browser/mock review, and mock-transport parity in
`desktop/ui/src/transport/mock.ts` for every new command.

## 4. Explicitly Deferred

Recorded so later proposals do not silently absorb them:

- **apiKeyHelper-style dynamic resolution** (a user-configured command that
  returns a key, re-invoked on 401). Valuable for enterprise rotation;
  introduces process-execution authority and needs its own D3 proposal.
- **OAuth 2.0 / device-code login** for providers that support it.
- **Per-project credentials** (still deferred from V1).
- **Workload identity / short-lived federated tokens.**
- **Centralized gateway patterns** (LiteLLM virtual keys). Already usable
  today through an `openai_compatible` provider with a custom Base URL;
  document the pattern in user docs rather than adding code.

## 5. Expected File Changes

- `desktop/src-tauri/src/agent_llm.rs` — source enum on
  `AgentProviderProfile`, V2->V3 migration, environment-source resolution,
  file-fallback backend (Linux only, `cfg`-gated), validation, audit hooks.
- `desktop/src-tauri/src/commands/agent_llm.rs` — new/changed Tauri commands:
  save with source, opt-in file fallback, clear session credential,
  confirmation-gated replace.
- `desktop/ui/src/transport/mock.ts` — mock parity for every new command
  (enforced by `scripts/test-rsr-contract.mjs`).
- `desktop/ui/src/transport/generated/agent-settings.ts` — regenerated types.
- `desktop/ui/src/...` Agent settings surface — source selector, badges,
  opt-in dialog, overwrite confirmation, per-source status text (design
  tokens only, per AGENTS.md styling rules).
- `scripts/test-agent-settings-bindings.mjs` and focused Rust tests per
  package.
- `NEWS.md` and application version metadata when a package ships in a
  development candidate (per governance versioning gate).

## 6. Sequencing And Stop Points

1. CRED-SEC1 (schema + source abstraction) — stop after migration and
   projection are green; no UI source switching yet beyond the environment
   source.
2. CRED-SEC2 (session-only) — stop after cache-only persistence is proven.
3. CRED-SEC3 (Linux file fallback) — independent stop; Linux-only evidence.
4. CRED-SEC4 (audit) — may run parallel to SEC2/SEC3 in a separate lane.
5. CRED-SEC5 (validation/overwrite guard) — may run parallel; smallest slice.

Each package ends at its own acceptance gate; do not merge half-wired
schema/backend/frontend states. The checked-in baseline stays buildable and
testable at every boundary.

## 7. Residual Risks

- Environment-source keys are visible to any process that can read the Rho
  process environment; documentation must state this boundary, matching how
  the V1 spec documented the `.Renviron`/Workspace R boundary.
- The Linux file fallback weakens protection to filesystem permissions; the
  opt-in and permanent badge are the mitigation, not a silent default.
- keyring 4.1.6's Linux `v1` backend behavior on partially available DBus
  sessions must be mapped to `store_unavailable` vs `not_detected` carefully;
  misclassification would mislead the UI state machine.

## 8. Implementation Record — 2026-08-26

### Contract amendment recorded at implementation time

The proposal text described a settings schema "V2 -> V3" migration for the new
`credential_source` field. At implementation time the live schema was already
V3 (context-capacity fields from the 2026-08-24 runtime-output contract), so
this change lands as schema **V3 -> V4**: `AgentProviderProfileV3` is the
legacy provider shape, V1/V2 legacy envelopes now decode through it, and the
V3 backup file `llm-profiles.v3.backup.json` joins the existing backup
discipline. No other contract term changed.

A second naming adjustment: the settings *view* already emitted a
presentation-only `credential_source` string on provider rows. To avoid a
flattened-field collision with the new persisted `credential_source`, the
presentation field was renamed to `credential_effective_source` in the view,
the generated TypeScript bindings, the mock transport, and both fixture
suites.

CRED-SEC4 was implemented against a new bounded append-only JSONL log
(`<app_local_data_dir>/agent-credential-audit.jsonl`, 256 KiB cap with
line-aligned tail retention) instead of the reproducibility-audit runtime,
which is project-scoped and R-run-specific and therefore not a fit for
application-global credential events. Audit-write failures never block the
credential operation and are recorded through the existing startup log.

### Acceptance evidence per package

- CRED-SEC1 (per-provider source + V4 migration): `credential_source`
  persisted with vocabulary validation; `environment` resolves from the
  desktop process environment at test/turn time and never touches a store;
  V3->V4 in-memory migration on read-only open without rewriting the source,
  byte-identical V3 backup on first mutation, V4 round-trip preserving all
  three configured sources, and platform/vocabulary rejection tests.
- CRED-SEC2 (session-only): `session_only` writes and reads only a
  dedicated Zeroizing in-memory map; an injected mock store records zero
  get/set/delete calls. Implementation review caught that the existing
  credential-refresh action cleared the shared session cache, which would have
  destroyed session-only keys on a mere refresh; session-only entries now live
  in a separate map that refresh never touches, with a regression test
  proving they survive refresh and are removed only by explicit delete or
  process exit.
- CRED-SEC3 (Linux file fallback): `file_fallback` is rejected by validation
  on macOS/Windows; the Linux round-trip test (0600 file, 0700 directory,
  atomic write, delete, per-source status projection) runs on the Linux CI
  legs and is `cfg`-gated locally.
- CRED-SEC4 (audit): set/replace/delete, connection-test, model-discovery,
  and turn-inject paths append redacted JSONL events; tests prove a sentinel
  secret never appears in the log, event fields are complete, and the 256 KiB
  budget holds with parseable lines after truncation.
- CRED-SEC5 (entry validation + overwrite guard): control-character and
  line-break rejection, exact-boundary size acceptance (2560 bytes on
  Windows, 4096 elsewhere; the previous 16 KiB constant was replaced),
  unconfirmed-replace rejection preserving the existing value, and confirmed
  replace success.

### Validation matrix (2026-08-26, macOS arm64 development checkout)

- `cargo test -p rho-desktop`: 385 passed, 0 failed (22 pre-existing ignored,
  including the opt-in Keychain smoke).
- `cargo check --workspace --offline`: clean; `cargo fmt --check -p
  rho-desktop`: clean; `cargo clippy -p rho-desktop --tests`: no errors.
- `npm run rsr:check --prefix desktop`: complete matrix passed (typecheck,
  lint, identity, 196-command inventory, all binding contracts including
  regenerated agent-settings bindings, RSR contract fixture, 319 frontend
  tests across 50 files, build, assets, cutover, real-Chrome browser smoke,
  real-interaction acceptance, dev-lanes, visual-acceptance harness
  self-test).
- `node scripts/test-agent-execution-bindings.mjs`: passed.

### Open acceptance and residual risk

- Linux-file-fallback runtime behavior is verified only by the `cfg`-gated
  test on Linux CI legs; no installed-Linux-app acceptance was run.
- The new credential sources are backend-complete; the current Studio Agent
  surface exposes source/status as read-only text next to model capacity,
  while the full provider-management UI rebuild remains owned by the CRED-UX
  series and its separate acceptance.
- Installed-candidate acceptance, live-provider acceptance, and release
  decisions remain open under their existing release contracts; this change
  creates no release authority.
