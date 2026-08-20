# System Credential And Simple LLM Settings

Status: active; CRED-UX1 authorized by the project owner on 2026-08-05 and
implemented; the separately owned macOS Keychain adapter was implemented and
verified in MAC3 on 2026-08-05; CRED-UX2 was explicitly authorized by the
project owner on 2026-08-07 to complete the original Issue #4 requirements;
CRED-UX2 implementation and local verification completed on 2026-08-07, while
exact installed-candidate acceptance remains open; CRED-UX3 provider model
discovery was explicitly authorized by the project owner on 2026-08-07 and is
implemented with deterministic verification; its candidate handoff is paused
because the project owner requested a capability-routed redesign on 2026-08-07;
CRED-UX4A routing foundation was explicitly authorized by the project owner on
2026-08-07; implementation, the complete affected automated matrix,
deterministic browser review, and an independent security/contract review are
complete, while owner and exact installed-candidate acceptance remain open;
CRED-UX4A-R1 Provider-first recovery and provider-catalog integration was
explicitly authorized by the project owner on 2026-08-07 after the installed
`0.4.0-dev.18` DMG exposed an unrecoverable settings-entry state; its
implementation, complete affected local matrix, independent security/contract
review, browser review, and unsigned arm64 replacement-DMG verification are
complete, while owner installed-app and live-Provider acceptance remain open;
CRED-UX4A-R3 one-confirmation Provider removal was explicitly authorized by the
project owner on 2026-08-10; its implementation, complete affected automated
matrix, deterministic wide/narrow screenshot review, and independent R3 review
are complete, while final interactive and installed-app acceptance remain open;
CRED-UX4A-R4 Issue #25 Provider-context and model-deletion modal repair was
explicitly authorized by the project owner on 2026-08-10; its implementation,
complete affected automated matrix, deterministic browser review, and
independent destructive-state/accessibility review are complete; the project
owner authorized push, upstream merge, and Issue reply on 2026-08-10; PR #31
merged the reviewed source into upstream `main` at `e89ed70`, and the
application identity is synchronized to `0.4.0-dev.28`, while owner
installed-app acceptance remains open;
CRED-KEYCHAIN-R1 lazy Provider credential access was explicitly authorized by
the project owner on 2026-08-18 after the unsigned `0.4.1-dev.0` macOS test app
prompted once per configured Keychain item during ordinary startup; the
bounded repair, complete affected automated matrix, security review, and local
`0.4.1-dev.1` UI acceptance completed 2026-08-18;
CRED-KEYCHAIN-R2 zeroizing session reuse was explicitly authorized by the
project owner's failed acceptance on 2026-08-18 after R1 still prompted on
every conversation using the same Provider; implementation is active below;
CRED-UX4B isolated workers and CRED-UX4C media interaction remain unauthorized

Change class: D3 credential boundary and cross-process execution configuration

Risk: R3 because the work creates, reads, replaces, and deletes model
credentials, injects one credential into a supervised Agent R or isolated
capability-worker process, uses a credential for a bounded provider
model-discovery request, and proposes a settings migration plus typed
capability-execution boundary.

Owning documents: this specification owns the Windows system-credential
boundary and the simplified model-configuration workflow. The implemented
Configurable Agent LLMs V1 specification remains authoritative for provider,
model, capability, selection, attribution, and no-fallback behavior except
where this document replaces its `.Renviron`-only and no-key-input decisions.

Implemented work package: CRED-UX1, system credential storage plus the smallest
complete provider/model/key settings workflow.

Implemented work package: CRED-UX2, the original Issue #4 provider-card,
provider-scoped progressive-disclosure, guided provider setup, separated
management, and operation-feedback workflow. Mandatory stop: contract review,
automated verification, and representative macOS installed-app acceptance
before release handoff. CRED-UX2 does not authorize OAuth, account sync,
per-project credentials, model routing, a new credential backend, or provider
network discovery beyond the existing explicit connection test and catalog.

Authorized work package: CRED-UX3, discovery-first model selection for the
guided Add provider flow and Add model editor. It adds one read-only bounded
Provider request and retains manual Model ID entry as a truthful fallback.
Mandatory stop: contract review, automated verification, independent safety
review, and a new local macOS candidate before release handoff. CRED-UX3 does
not authorize background polling, model auto-save, model routing, OAuth,
account sync, a new credential source, or a settings-schema change.

Implemented work package: CRED-UX4A, capability-routed model foundation. The
project owner explicitly authorized implementation on 2026-08-07 after review
of the three-layer redesign. This activates only schema V2, deterministic V1
migration, metadata provenance, settings routing UI, existing Ask/Plan/Act
route resolution, and one selected-route credential per Agent child. The next
mandatory stop is the CRED-UX4A verification and owner-acceptance gate.
Capability-worker execution, new media tools, optional-route credential use,
CRED-UX4B, and CRED-UX4C remain separately gated.

Authorized work package: CRED-UX4A-R1, installed-app recovery plus a
Provider-first Connections -> models -> routing workflow backed by the pinned
`aisdk.providers` adapter catalog. It may extend named Provider presets,
Provider-specific runtime construction, optional literal Base URL overrides,
model capability presentation, and Connections/routing navigation. It may not
add a capability worker, use an optional-route credential, infer a route from
prompt text, auto-assign an imported model, or broaden the existing credential
and Provider-network lanes. The mandatory stop is a new `0.4.0-dev.19` local
candidate, complete affected verification, independent credential/contract
review, and owner installed-app acceptance.

Authorized work package: CRED-UX4A-R3, revision-bound one-confirmation Provider
removal. It may remove the selected Provider's imported models, optional route
assignments, and one system-store credential in one guarded compensating
operation after presenting their exact impact. It may not infer or silently replace the required
`agent.chat` route, remove another Provider/model/credential, weaken
credential rollback, or introduce a second settings authority. The mandatory
stop is focused destructive-state and recovery tests, complete affected
frontend/Rust validation, deterministic browser review, independent R3
contract review, and owner installed-app acceptance before release handoff.

Authorized work package: CRED-UX4A-R4, the bounded Issue #25 repair. It may
make the Connections Chat summary relative to the selected Provider and replace
the generic model-deletion confirmation with a Model-settings-owned sibling
modal. It may not change route persistence, choose a route, cascade model
deletion, change the existing model-deletion command, or broaden Provider,
credential, schema, project, or network authority. The mandatory stop is a
focused failing regression, complete affected frontend validation,
deterministic wide/narrow modal review, an independent destructive-state and
accessibility review, and owner installed-app acceptance before release
handoff.

Authorized follow-up: simplify the delivered settings surface and make the
Windows system credential the only Agent LLM API-key source. Legacy
`.Renviron` credential detection, editing, and fallback are intentionally
removed; this does not change Workspace R's separate project-environment
workflow.

Authorized defect repair: `CRED-KEYCHAIN-R1` removes secret reads from settings
projection and ordinary application startup. It may add one process-local,
non-secret observation per Provider (`unchecked`, `detected`, `not_detected`,
or `unavailable`), update that observation after an explicit credential
read/write/delete, and defer Keychain access until the user actually invokes,
tests, discovers models for, or destructively changes that exact Provider. It
may not combine Provider secrets, cache secret values, add a second credential
store, persist an observation, infer a credential from the environment, or
weaken backend missing/denied/no-fallback enforcement.

### CRED-KEYCHAIN-R1 reproduction and invariant

The unsigned `0.4.1-dev.0` app reproduced the defect on 2026-08-18. Local
metadata contained eleven API-key-required Providers. Ordinary startup called
`loadAgentLlmSettings()` -> `agent_llm_settings` -> `settings_view()` ->
`credential_status_map()`, which invoked Keyring `get_password()` for every
Provider-specific item under service `Rho Agent LLM`. macOS authorization is
item-scoped, while the test app is ad-hoc/linker-signed with no Team ID and a
cdhash-based designated requirement that changes after rebuild. The result was
a queue of password dialogs before the user chose any Provider.

The repaired invariant is:

- `agent_llm_settings`, application startup, metadata-only settings reload,
  route/model/provider save, and rendering perform zero credential-store reads;
- an API-key-required Provider with no process observation is projected as
  `credential_status=unchecked`, never as missing or detected;
- `unchecked` does not block a route or model in the frontend, but the backend
  still reads only the effective Provider before a turn/task and rejects a
  missing or denied credential truthfully;
- model discovery and connection test read only their selected Provider;
- successful set/delete and explicit reads update only non-secret process
  observation state; no credential value is retained by that cache;
- concurrent or repeated metadata rendering cannot create Keychain prompts;
- Provider deletion retains its existing selected-Provider read/delete/restore
  transaction and may prompt because it is an explicit destructive action; and
- stable signing may improve operating-system ACL reuse later, but correctness
  does not depend on signing or `Always Allow`.

Regression evidence must cover zero-read startup/settings projection, unknown,
detected, missing, unavailable, set/delete transitions, exact selected-Provider
turn/task/discovery/test access, no fallback, frontend `unchecked` projection,
mock parity, secret non-persistence/redaction, and existing Provider deletion
recovery. This is D1/R3 because it narrows credential access without changing
schema, provider IDs, Keychain service/account layout, network authority, or
public protocol. Version/NEWS and a rebuilt local macOS test app are decided at
the repair stop gate.

### CRED-KEYCHAIN-R1 implementation evidence

Implemented on 2026-08-18 for application candidate `0.4.1-dev.1`:

- settings projection now consumes only a process-local
  `CredentialObservation` map and cannot receive a `CredentialStore`;
- absent observations project as `unchecked/unchecked`; successful exact
  Provider reads, writes, and deletes update only `Detected`, `NotDetected`, or
  `Unavailable` and never retain the secret value;
- connection tests no longer scan every Provider before and after the selected
  probe; they read the resolved Provider once and then project observations;
- frontend routing, Agent repair, wizard, test, and deletion states distinguish
  `unchecked` from known missing, disclose "Checked when used", and preserve
  backend selected-Provider enforcement;
- browser/mock explicit use resolves `unchecked` against only the selected
  mock Provider, and an explicit `credential-unchecked` fixture protects the
  initial projection; and
- Provider deletion continues to read/delete/restore only its selected
  Provider, with an unknown item disclosed as "Check and remove key if
  present" before confirmation.

Automated evidence:

```text
cargo fmt --all -- --check
  passed
cargo test -p rho-desktop --bin rho-desktop --locked
  passed: 200; ignored: 1 existing opt-in native Keychain smoke
cargo check --workspace --all-targets --locked
  passed
cargo test --workspace --locked --no-fail-fast
  passed: 454; ignored: the same opt-in native Keychain smoke
Rscript -e 'testthat::test_local("r/rho.agent")'
  passed: 120
for test_script in scripts/test-*.mjs; do node "$test_script"; done
  passed: every tracked Node contract
node --check desktop/dist/app.js
git diff --check
  passed
```

An exploratory `cargo clippy -p rho-desktop --all-targets --locked --no-deps
-- -D warnings` is not a passing gate: current Rust 1.97 reports existing
warnings across untouched `agent_llm.rs`, `git.rs`, `git_review.rs`, and
`main.rs`. The repair introduced no reported lint at its changed lines; the
standard format/check/test gates above pass. The broader warning baseline is
not changed in this credential repair.

Local unsigned macOS arm64 acceptance rebuilt
`target/aarch64-apple-darwin/release/bundle/macos/Rho.app` as `0.4.1-dev.1`.
Its arm64 executable SHA-256 is
`e576503f0e625fd8a9c6090d03d4120246ce443c19a8b9c7d2a4252654fbb14a`.
The final app launched to a ready Workspace with eleven API-key-required
Provider metadata records and no Keychain/password dialog. Opening Agent and
Model settings also produced no dialog; the selected Provider displayed
"Checked when used" and "Check and remove key". No credential was entered,
read, changed, transmitted, or deleted during this manual review. The app is
left running for owner testing.

That R1-only binary was rejected by the owner because actual Agent turns still
prompted once per conversation. It is superseded by the R2 build below and is
not acceptance or release evidence.

Security/contract review found no blocking issue: the observation cache has no
secret-bearing variant, no persisted or browser credential state was added,
exact Provider reads and no-fallback behavior remain backend-owned, and the
Keychain service/account layout is unchanged. R package versions remain
unchanged. `NEWS.md` and all application version surfaces advance to
`0.4.1-dev.1`. No tag, Release, signing identity, publication, updater manifest,
or release GO is created.

### CRED-KEYCHAIN-R2 session-cache correction

Owner acceptance found R1 incomplete: it reduced an eleven-dialog startup
burst to one dialog per exact Provider access, but every Agent conversation
called `credential_override_with_store()` again. An ad-hoc app therefore
invoked Keychain `get_password()` once per turn even after a successful access.
This is a D1/R3 continuation, not accepted behavior.

R2 supersedes only R1's prohibition on caching secret values. It authorizes a
bounded process-session cache with these invariants:

- the first successful actual access to one Provider loads that Provider's
  Keychain value; subsequent turns/tasks/tests/discovery for the same Provider
  reuse it without another Keychain call;
- cache entries are keyed only by stable Provider ID and contain
  `zeroize::Zeroizing<String>`; replacement, deletion, explicit refresh, and
  graceful desktop shutdown remove and zeroize the value;
- a known-missing item may be cached as absence; a denied/unavailable read is
  not cached as a secret and remains truthfully retryable;
- `set` updates Keychain first, then replaces the cached value; `delete`
  updates Keychain first, then removes the cached value; failure preserves the
  previous cache and credential truth;
- Provider deletion retains read/delete/metadata-save/restore compensation and
  uses the same cache invalidation semantics;
- settings projection remains zero-read and consumes only non-secret
  observations; no secret crosses into its response;
- no cache value enters settings JSON, browser state/storage, logs,
  diagnostics, startup events, serialization, or a public API;
- forced process termination relies on operating-system address-space
  reclamation; the graceful shutdown path explicitly clears the cache; and
- no background unlock, all-Provider read, combined vault, persistent master
  key, OAuth, credential sharing, or permission expansion is introduced.

The lockfile already contains `zeroize 1.9.0`. R2 may make it a direct workspace
dependency for `rho-desktop` without changing the resolved version. Context7
review of the 1.9.0 API confirms that `Zeroizing::new` wraps `String`, implements
`Deref`, and invokes `Zeroize` on drop. The crate is already present under the
existing dependency/license surface; the direct-use reason is deterministic
cache eviction rather than cryptography or persistence.

Regression evidence must prove one underlying read across repeated same-
Provider requests, distinct reads for distinct Providers, missing caching,
replacement/delete/clear invalidation, failure preservation, exact
Provider-only access, zero secret serialization, shutdown clearing, and the
existing R1 zero-read startup/settings behavior. The local `0.4.1-dev.1` app
must then be rebuilt and owner-tested with at most one prompt for the first use
of a Provider and none for its next conversation. No CI or push is required by
the owner for this local correction.

R2 automated evidence on 2026-08-18:

```text
cargo fmt --all -- --check
  passed
cargo test -p rho-desktop --bin rho-desktop --locked
  passed: 202; ignored: 1 existing opt-in native Keychain smoke
cargo check --workspace --all-targets --locked
  passed
cargo test --workspace --locked --no-fail-fast
  passed: 456; ignored: the same opt-in native Keychain smoke
Rscript -e 'testthat::test_local("r/rho.agent")'
  passed: 120
for test_script in scripts/test-*.mjs; do node "$test_script"; done
  passed: every tracked Node contract
node --check desktop/dist/app.js
git diff --check
  passed
```

The tests prove same-Provider repeated access invokes one loader, different
Providers remain isolated, known missing is cached, denial remains retryable,
and set/replace/delete/clear update or remove the cache. Static contracts prove
the cache is non-serializable, uses locked `Zeroizing<String>`, settings
projection cannot receive a credential store, and graceful desktop shutdown
calls `clear_session_credentials()`.

Local unsigned macOS arm64 R2 build:

```text
App: target/aarch64-apple-darwin/release/bundle/macos/Rho.app
Version: 0.4.1-dev.1
Executable SHA-256:
  0a51a9308a28af8afd7a8c5903fe24b22b63645b90d81f362b455f474c0fd7ef
```

It launched to a ready Workspace with no startup Keychain dialog. The owner
must now complete the only credential-bearing acceptance step: use the same
Provider for two conversations, entering the macOS login password if requested
on the first. The first conversation may prompt once; the second must not.
Until that owner observation is reported, R2 remains active and is not pushed.

## Goal

Let a user configure an LLM with only information they normally know:

- provider;
- model;
- API key when the provider requires one;
- a custom endpoint only when using a compatible provider.

Rho stores API keys in Windows Credential Manager. The separately owned macOS
adapter stores them in Apple Keychain with the same semantics. Normal settings
do not ask the user to edit an environment file or understand provider IDs,
environment variable names, wire protocols, capability sources, or stream
options.

## Security And Ownership

- The Windows credential target service is `Rho Agent LLM`; the account key is
  the stable provider profile ID. Display names never address a credential.
- `llm-profiles.json` continues to store only non-secret provider/model
  metadata. Project files, SQLite, session snapshots, localStorage, prompts,
  event details, logs, diagnostics, and command arguments never contain a key.
- The frontend may hold the key only in the password input while the user is
  editing and while one save command is in flight. It clears the input after
  every success, failure, dialog close, provider change, and project change.
- Rust retrieves a key only for connection testing, an explicit model-discovery
  request, or the selected Agent turn. Connection testing and Agent execution
  inject the value under the profile's existing `api_key_env` name into a
  short-lived Agent R child process. Model discovery attaches it only to the
  provider-specific HTTP authentication header. Workspace R never receives it.
- Exact key values never cross back from Rust. Views return only `stored`,
  `environment`, `not_detected`, `not_required`, or `unavailable` projections.
- Agent LLM API keys are read only from the Windows system credential store.
  `.Renviron` is not inspected, opened, edited, or used as an Agent credential
  fallback. Workspace R environment handling remains a separate workflow.
- Replacing a stored key is explicit. An empty key never deletes or overwrites
  an existing key. Deletion requires confirmation and affects only the system
  credential for the selected provider.
- Credential-store failure is truthful: metadata is not reported as saved
  when its required credential write failed, existing credentials remain
  unchanged when validation fails, and the user can retry safely.

## Backend Contract

Add typed commands:

```text
agent_llm_set_credential(provider_id, credential)
agent_llm_delete_credential(provider_id)
```

Both commands validate the provider against current settings before touching
the credential store and return a fresh presentation-safe settings view.
Credential length is bounded to 16 KiB; empty values are rejected. Unknown or
key-optional providers are rejected for credential writes. Deleting a missing
credential is idempotent and returns the current view.

The credential backend is abstracted so tests cover success, validation
rejection, backend failure, replacement, missing-delete recovery, and provider
isolation without using a developer's real Credential Manager. Production on
Windows uses the operating-system credential store. Other operating systems
retain `.Renviron` compatibility and report system storage unavailable in this
Windows-focused work package.

The separately active macOS arm64 specification implemented Apple Keychain
behind this same credential abstraction in its MAC3 package. The extension
preserves this document's stable provider IDs, precedence, redaction,
Agent-only injection, failure behavior, and compatibility fallback; it does
not authorize project-scoped credentials, sync, OAuth, key export, or new
credential state. Unsupported non-Windows platforms still report system
storage unavailable. This document retains the credential semantics; the
macOS specification owns only the Apple Keychain adapter and macOS acceptance.

`run_agent` and the connection-test path resolve the credential immediately
before process launch. The existing non-secret runtime profile remains the
stdin contract. The secret is an environment override on the child process,
never a runtime-profile field.

## CRED-UX1 Simplified Interface Baseline

This section records the implemented CRED-UX1 baseline. Its single global
Advanced layout is superseded for CRED-UX2 presentation by the following
section; its credential, persistence, validation, and execution boundaries
remain authoritative.

The dialog becomes one primary setup flow. The normal visible fields are:

```text
Provider type
Model
API key                 only when required
Base URL                only for compatible/local providers
Display name            only when adding or renaming an entry
```

Primary actions are `Save`, `Test connection`, and `Use this model`.
Credential state is phrased as `Stored securely`, `Available from user
environment`, `Not set`, or `Not required`. The key is never redisplayed.

Provider ID, environment-variable names, Wire API, stream behavior, explicit
capability declarations, model enablement, catalog maintenance, and destructive
provider/model management remain under one closed `Advanced settings` section.
The default flow contains only the provider/model choice, API key, connection
test, save, and enable actions. Provider and model advanced fields are not split
into separate disclosure panels. Credential-file actions and environment
credential migration controls are removed.

Loading, empty, stored, not-set, unavailable, save-failure,
delete-confirmation, narrow-window, keyboard, and dialog-close states must be
deterministic in mock mode. Password fields disable browser spellcheck and
autocomplete uses `new-password`; no visible key-length or key-fragment hint is
allowed.

## CRED-UX2 Original Issue #4 Progressive Disclosure

### Problem And Acceptance Authority

Issue #4 asks for a provider-card default surface, provider-scoped Advanced
settings, separation between choosing a model and destructive management, a
guided Add provider flow, and consistent Save/Test/Use feedback. The CRED-UX1
follow-up implemented only a compact chooser plus one global Advanced section.
At CRED-UX2 authorization the issue remained open, and direct review of
`0.4.0-dev.16` reproduced the remaining gaps: Add provider cleared the shared
editor rather than opening a guided flow, Provider and Model fields remained
interleaved, and the credential status could temporarily contradict the
checked `API key required` field.

CRED-UX2 accepts the five numbered Issue #4 expectations and its four suggested
acceptance checks as the product baseline. The reference images define
information hierarchy, not a dark theme, provider logo catalog, remote model
discovery, or a new provider-enable schema.

### Default Provider Surface

The Model settings default surface contains only:

- a provider-card rail with each provider's display name, provider kind,
  derived readiness state, model count, and selected state;
- the current model and its provider;
- the selected provider's credential status and transient API-key input when a
  key is required;
- that provider's model list, including enabled/disabled and current-model
  status;
- `Save API key`, `Test connection`, and `Use this model` actions;
- non-destructive `Add provider`, `Add model`, and `Edit model` entry points.

Provider readiness is a presentation-only derivation from the existing
credential projection and whether the provider has an enabled model. CRED-UX2
does not add a persisted provider-enable flag. Model `enabled` and global
`selected_model_id` remain the existing backend authorities.

Provider and model configuration fields are not duplicated in the default
surface. Switching provider cards clears every transient credential input,
selects a model owned by that provider when available, clears stale test and
operation feedback, and collapses the newly selected provider's Advanced
section. Models from other providers are never shown in the selected
provider's default list.

### Provider-Scoped Advanced And Destructive Separation

Each selected provider has one closed `Provider Advanced` disclosure in its
detail panel. It owns that provider's display name, Base URL, registered
provider ID, API-key environment-variable name, Base URL environment-variable
name, Wire API, key requirement, and stream behavior. Common OpenAI,
Anthropic, Gemini, and existing DeepSeek configuration does not require opening
it. A custom compatible provider remains fully configurable through this
explicit entry.

Saving provider metadata is inside Provider Advanced. Provider deletion is
inside a separately labelled, initially closed Danger zone below the ordinary
save action. It is never beside `Use this model`, connection testing, API-key
save, or model enablement. The existing backend continues to block deletion
while models reference the provider and continues to preserve metadata when
credential deletion fails.

Model selection rows are read-only selectors in the default surface. Adding or
editing a model opens a dedicated Model editor. The editor contains model ID,
display name, Provider, enabled state, and a closed capability Advanced
disclosure. Model deletion appears only in a separately labelled Danger zone
inside the editor and never beside the enabled control or default-model action.
Deleting the selected model retains the existing replacement-model guard.

### Guided Add Provider Flow

`Add provider` opens a dedicated modal workflow; it never clears or repurposes
the selected provider's editor. The workflow is ordered as follows:

1. **Connection** collects Provider name, API format/provider preset,
   conditional Base URL, API-key requirement, and a transient API key.
   Presets provide the existing validated provider kind, registered provider
   ID, environment-variable name, and Wire API defaults. OpenAI, Anthropic,
   Gemini, and DeepSeek require no Advanced disclosure. Compatible/custom
   formats require an explicit Base URL; local-compatible defaults to no key.
2. **Model** collects Model ID and display name, with enabled on by default.
   Optional capabilities remain under a closed Advanced disclosure.
3. **Finish** saves/selects the model and returns to the new provider card with
   truthful credential, model, and current-selection state.

The Connection step uses the existing provider and credential commands in a
truthful two-stage sequence. Provider metadata is saved first because the
credential backend addresses a stable existing provider ID. If metadata fails,
no credential or model command runs. If metadata succeeds but credential save
fails, the UI states `Provider saved; API key not stored`, clears the key, stays
on Connection, and permits retry. It does not claim rollback or delete the
provider automatically. A blank required key is blocked with an explicit
warning and does not mutate provider state. Continuing without a key requires
explicitly turning off `API key required`, which is intended only for a
legitimately keyless provider such as a local service.

If Model save fails after the provider exists, the UI states that the provider
was saved but the model was not, preserves non-secret model input for retry,
and never resubmits or redisplays the credential. Cancelling before provider
save causes no mutation. Closing after provider save leaves the truthfully
listed provider for later completion. No step writes secrets to DOM attributes,
localStorage, session state, settings JSON, logs, diagnostics, or project data.

### Operation Feedback State Machine

Save API key, Save provider, Save model, Test connection, Use this model, and
the guided-flow transitions each project one of these local presentation
states through an `aria-live` status region:

```text
idle | working | success | warning | error
```

The working state names the operation and disables duplicate submission. A
success message is rendered only after the returned backend view is applied.
A warning identifies a durable partial result, such as a saved Provider with a
missing key or model. An error states what failed and the safe next action;
existing redaction remains mandatory. A new action clears obsolete feedback.
Closing the dialog, switching provider/project, and retrying clear stale local
feedback without changing durable state.

Connection testing states `Testing connection`, exposes the existing bounded
cancel action, and ends in ready, cancelled, or actionable error state. The UI
states that testing sends a small real provider request. Selecting a model
shows working feedback, applies the returned view, then updates both the current
model banner and composer before showing success. Failure never changes the
selected model or silently falls back.

The primary API-key save command runs only for a non-empty transient input.
An empty input never deletes or overwrites a stored key. Key deletion keeps its
existing confirmation and is presented separately from Save API key.

### Compatibility, Ownership, And Recovery

- No schema, provider/model type, Tauri command, settings path, credential
  service/account key, Agent R transport, or project scope changes.
- Existing stable provider/model IDs and global selection semantics remain
  authoritative. Historical Agent attribution is unchanged.
- Windows Credential Manager and macOS Keychain retain identical redaction,
  replacement, deletion, rollback, and Agent-only injection semantics.
- Browser/mock command behavior remains in lockstep with every command used by
  the new dialogs. Mock failure fixtures never contain a credential value.
- The UI may retain only non-secret draft fields during an operation. Every
  password input clears after success, failure, dialog/wizard close, provider
  change, project change, and application shutdown.
- Responsive layout uses provider rail plus detail at normal width and a single
  column at narrow width, without horizontal page scrolling or inaccessible
  Advanced/Danger disclosures.
- Model settings, Add provider, and Model editor are sibling modal roots.
  Opening a child suspends the main root with `display: none`, then makes the
  child the only visible element with `role=dialog` and `aria-modal=true`.
  Inactive siblings own no active role and are absent from rendering,
  interaction, and the accessibility tree. This top-level handoff is the
  required Safari/WKWebView compatibility path; `inert`, `aria-hidden`, or
  nested modal/document subtrees can expose an empty dialog. Tab focus remains
  contained in the visible child, close restores focus, and Escape closes only
  the active child. Closed workbench menus also use `display: none` so invisible
  menus do not mask the dialog in the accessibility tree.

### CRED-UX2 Verification And Acceptance

Focused automated evidence must prove:

- provider cards and provider-filtered model rows are the only default
  provider/model presentation;
- no global management form or global Advanced section remains;
- low-frequency provider fields are inside Provider Advanced;
- model fields are inside the dedicated Model editor, with capability Advanced;
- provider/model deletion is inside separate closed Danger zones;
- Add provider is a separate two-step dialog with the required Connection and
  Model fields and provider-preset defaults;
- all credential inputs are transient and cleared on every required boundary;
- mock success, validation rejection, provider-saved/key-failed,
  provider-saved/model-failed, connection failure/cancellation, selection
  failure, retry, and close/reopen paths render truthful operation states;
- empty, key-missing, stored, unavailable, disabled-model, selected-model,
  long-name, keyboard, normal-width, and narrow-width states are deterministic;
- no credential value reaches mock settings, browser storage, DOM attributes,
  diagnostics, or user-visible errors;
- existing backend credential, provider/model mutation, failure-injection,
  redaction, selection/no-fallback, and macOS Keychain tests remain green.

Representative manual acceptance must use a built candidate without entering a
real key in screenshots or evidence. It verifies the default card surface,
Provider Advanced, Add provider Connection -> Model flow with a disposable or
dummy key as appropriate, success/failure feedback, model selection, separated
Danger zones, close/reopen recovery, keyboard order, and normal plus narrow
viewports. Native-store replacement/deletion and a live provider request remain
separate credential-aware acceptance items and cannot be inferred from mock
evidence.

### Version And Release Impact

CRED-UX2 is user-visible desktop behavior. After implementation and the full
affected automated matrix pass, the next distributable development candidate
must advance from `0.4.0-dev.16` to `0.4.0-dev.17`, synchronize all application
version authorities, and update `NEWS.md`. No R package contract changes, so no
R package version bump is required. This authorization does not authorize a
tag, GitHub Release, Pages update, public distribution, or MAC5 release GO.

## CRED-UX3 Provider Model Discovery

### Problem, Authorization, And Primary UX

The delivered Add provider and Add model flows make a manually typed Model ID
the default even when the configured Provider exposes an authenticated model
list. On 2026-08-07 the project owner explicitly requested that Rho fetch that
list for the common API providers and use manual entry only as a fallback.

After a guided Connection step has durably saved provider metadata and any
required credential, its Model step immediately performs one discovery
request. Opening `Add model` for an existing provider does the same. The
default Model surface is a labelled `Available models` selector with loading,
ready, empty, unsupported, and error states plus an explicit `Refresh models`
action. A discovered choice fills the existing non-secret model draft but does
not save, enable, test, or select it until the user invokes the existing save
action.

`Enter a model ID manually` is a secondary, initially closed disclosure. Rho
opens it automatically when discovery is unsupported, empty, or fails, and the
user can open it at any time for a model omitted by the Provider. Editing an
existing model opens its current ID fields because the task is editing durable
metadata, not choosing a new Provider model. Discovery never removes or
overwrites an existing model and never silently substitutes another model.

The UI states that discovery uses the stored Provider key, sends no prompt, and
may contact the configured Provider. It does not describe the static
`aisdk::list_models()` metadata catalog as a live Provider result. That catalog
may still supply non-authoritative capability hints after an exact Provider and
model-ID match.

### Typed Command And Provider Strategies

Add one read-only typed command:

```text
agent_llm_discover_models(provider_id) -> {
  status: ready | unsupported | error,
  provider_id,
  models: [{ id, display_name, capabilities }],
  truncated,
  message,
  error_class?
}
```

The command resolves `provider_id` from the current global settings and rejects
an unknown provider before credential or network access. It reads the provider's
credential from the existing system store immediately before the request. A
key-required provider with a missing or unavailable credential returns a
redacted `credential` error. A key-optional local Provider sends no
authentication header.

Supported strategies are:

- OpenAI and OpenAI-compatible: authenticated `GET /models`, parsing bounded
  OpenAI-style `data[].id` entries;
- DeepSeek: authenticated `GET https://api.deepseek.com/models` with the same
  response shape;
- Anthropic: authenticated `GET https://api.anthropic.com/v1/models` using
  `x-api-key` plus the required `anthropic-version` header;
- Gemini: authenticated
  `GET https://generativelanguage.googleapis.com/v1beta/models` using the
  `x-goog-api-key` header and retaining only models that advertise
  `generateContent`;
- a custom literal Base URL: append `/models` without replacing its host,
  scheme, port, or existing path; use the configured OpenAI or Anthropic wire
  authentication style.

An unrecognized registered Provider and a custom Provider configured only by
`base_url_env` return `unsupported`; CRED-UX3 does not read an environment URL
or expand its possible secret/network authority. The manual path remains fully
functional. Provider responses are suggestions only and do not become a new
catalog, persistence source, capability authority, or compatibility promise.

### Bounds, Redaction, Failure, And Recovery

- Each invocation performs at most one HTTP request, has a 15-second total
  timeout, accepts at most 1 MiB of response bytes, exposes at most 100 unique
  valid models, and reads only the first Provider page. `truncated=true` reports
  an additional page or entries beyond the model limit.
- Redirects and automatic retries are disabled so an authentication header is
  never forwarded to another location. The request does not use an
  environment-derived Base URL. Fixed built-in endpoints use HTTPS; an explicit
  literal custom/local URL retains the user's already validated endpoint
  authority.
- Credentials never enter a URL, command argument, request/response object,
  frontend state, settings file, log, diagnostic, toast, or Provider error
  body. Error projection names only a bounded class: `credential`, `auth`,
  `rate_limit`, `network`, `timeout`, `unsupported`, or `response`.
- Non-success HTTP response bodies are discarded. Malformed, oversized, or
  structurally invalid success bodies fail closed. Empty, duplicate, blank, or
  over-limit model IDs are ignored; display names are bounded and fall back to
  the model ID.
- Discovery is read-only. Success, rejection, cancellation by closing the
  dialog, timeout, parsing failure, and retry leave provider/model metadata,
  credentials, and global selection unchanged. Late results are applied only
  when they still match the active dialog, scope, and Provider.
- Browser/mock mode implements the same command and deterministic loading,
  ready, empty, unsupported, auth-failure, malformed-response, retry, stale
  Provider, and manual-fallback projections without containing a real key.

### CRED-UX3 Verification And Acceptance

Focused automated evidence must prove:

- provider-specific URL, authentication-header, response-shape, Gemini
  generation-method filtering, deduplication, sorting, bounds, and truncation;
- unknown Provider and missing credential reject before network access;
- redirects are not followed and response/error serialization never contains
  the injected credential, response body, or a secret-bearing endpoint;
- timeout/network, 401/403, 404/unsupported, 429, malformed JSON, oversized
  response, empty list, and retry paths are truthful and preserve settings;
- wizard discovery starts only after the provider/key save sequence completes,
  while Add model discovers for the selected Provider and discards stale
  results after a Provider switch or dialog close;
- discovered selection fills a draft but does not mutate settings until Save;
  manual entry is initially secondary and becomes visible on every required
  fallback path;
- browser/mock command parity, keyboard/focus containment, narrow layout, JS
  syntax, Rust format/tests, complete affected frontend tests, and
  `git diff --check` pass.

Representative installed-app acceptance uses a disposable Provider credential
without recording it in screenshots or evidence. It verifies one successful
live list, one auth/failure fallback, manual entry, refresh, Provider switching,
close/reopen recovery, and that no model changes until Save. Live evidence is
separate from deterministic tests and remains `NOT RUN` until performed.

### CRED-UX3 Version And Release Impact

CRED-UX3 changes the default user-visible model setup workflow. After reviewed
implementation and the full affected automated matrix pass, the next local
development candidate advances from `0.4.0-dev.17` to `0.4.0-dev.18`, keeps all
application version authorities synchronized, and updates `NEWS.md`. No R
package API or contents change. This work package does not authorize a tag,
GitHub Release, Pages update, public distribution, or MAC5 release GO.

## CRED-UX4 Capability-Routed Model Architecture

### Status, Evidence, And Correction

The project owner requested this redesign on 2026-08-07 after observing that
`aisdk` model configuration is not a single global choice. Design work is
authorized and cross-reviewed. The owner explicitly activated CRED-UX4A on
2026-08-07. CRED-UX4B and CRED-UX4C are not active.

The exact `aisdk` commit pinned by `rho.agent`,
`1e2fa54358dda647a6d5cbf64c0625642c673e4c`, already provides:

- a default `ChatSession` language model;
- arbitrary normalized capability route names;
- session routes that override global routes;
- route model types `auto`, `language`, `embedding`, and `image`;
- `required_model_capabilities` validation;
- `set_capability_model()`, `get_capability_model()`,
  `list_capability_models()`, `clear_capability_model()`, and
  `resolve_model_for_capability()`.

The current Rho contract does not represent that model. It persists one
`selected_model_id`, imports only language models from `aisdk::list_models()`,
transports one runtime model profile, injects one selected Provider credential,
and creates `ChatSession` without capability routes. CRED-UX3 correctly solves
Provider model discovery but does not solve routing. A Provider model list is
also not capability evidence: most `/models` responses contain IDs but omit
reliable type and feature metadata.

### Goals And Non-goals

CRED-UX4 will make the model system three independent layers:

1. **Connections** own Provider endpoint metadata and one system credential.
2. **Model library** owns model identity, type, capability metadata, provenance,
   readiness, and test history.
3. **Capability routing** maps a typed Rho/`aisdk` task to one enabled model.

The redesign must let one model serve multiple routes and let different routes
use models from different Providers. It must make every effective route visible
and must never infer a route from natural-language prompt classification.

This design does not itself authorize image upload, image generation, image
editing, semantic search, a generic external-execution API, automatic model
routing, automatic fallback after Provider failure, background discovery,
OAuth, project-scoped credentials, or changes to the `aisdk` repository. Those
behaviors require the typed consumers and work packages below.

### User Model: Routes, Not One Current Model

The primary Model settings surface becomes **Model routing** rather than a
Provider rail. It presents these standard routes:

| Route | Type | Required capability | Consumer |
| --- | --- | --- | --- |
| `agent.chat` | language | none | ordinary Ask and Plan turns; required |
| `agent.act` | language | `function_call` | Act turns; optional explicit override |
| `vision.inspect` | language | `vision_input` | typed image/plot inspection worker |
| `image.generate` | image | `image_output` | typed image-generation worker |
| `image.edit` | image | `image_edit` | typed image-edit worker |
| `embedding.default` | embedding | none | typed embedding/retrieval worker |

`agent.chat` replaces the ambiguous Current model concept. If `agent.act` is
unset, the UI explicitly shows that Act uses `agent.chat` only when that model
advertises or declares `function_call=yes`; otherwise Act is unavailable. This
is a visible compatibility rule, not failure fallback. A Provider error never
causes another model to be selected silently.

The authorized PROBLEMS-AGENT-REPAIR-2 package adds one closed typed use of the
existing `agent.act` route. A `problem_repair` task resolves that route because
the existing reviewable file-proposal tool requires `function_call=yes`, but it
runs the Agent child in Ask mode with automatic approval disabled. This is a
read-only tool-capable consumer, not an Act turn, prompt classifier, custom
route, fallback, or new credential authority. The child receives exactly the
credential for the resolved effective `agent.act` model. Ordinary Ask/Plan/Act
resolution and persisted V2 routes remain unchanged; a non-tool-capable or
credential-unready effective route fails before creating a repair turn and the
UI links to the existing `agent.act` routing card.

Advanced users may add a custom route with a bounded canonical name, model
type, and required capability list. A custom route becomes executable only
when a registered typed consumer requests that exact route. Merely naming a
route does not create a tool or cause prompt classification.

Connections and Model library remain directly accessible secondary surfaces.
Add provider becomes `Connection -> Import models -> Assign uses`. Importing or
manually adding a model never assigns it automatically. When no `agent.chat`
route exists, setup requires one enabled language model before completion;
all other routes are optional.

Each route row shows model, Provider, model type, compatibility, credential
readiness, and consumer availability. Model pickers filter compatible models
first, then show unknown-capability models in a separate `Needs review` group.
Models with an explicitly incompatible type or capability are rejected, not
hidden. Unknown metadata may be chosen only with a visible warning and an
explicit user declaration; the declaration does not masquerade as Provider or
catalog evidence.

### Capability Metadata And Provenance

Model metadata uses tri-state `yes | no | unknown` attributes and a separate
model type `language | embedding | image | unknown`. The initial bounded
attribute vocabulary mirrors the pinned `aisdk` registry:

```text
function_call, reasoning, vision_input, image_output, image_edit,
audio_input, audio_output, structured_output, web_search
```

Every effective type and attribute records one provenance value:

```text
aisdk_catalog | provider_response | user_declared | unknown
```

Provider discovery proves only that an ID was returned by the configured
endpoint. Rho enriches an exact Provider/model-ID match with
`aisdk::list_models()` metadata, without treating the static catalog as live
availability. A user declaration overrides only the named attribute and keeps
its provenance. An unknown value is not silently converted to `no`; an
explicit `no` blocks a route requiring that capability, matching `aisdk`'s
fail-closed-on-known-incompatibility behavior.

Model testing is type-specific. A language model may use the existing bounded
`generate_text` probe. Settings must not generate an image or embedding merely
because a model was imported. Image and embedding live probes require a
separate explicit action, cost warning, bounded disposable input/output, and an
authorized implementation package. Until then their connection readiness and
capability provenance remain distinct from a successful language probe.

### Persistence Schema V2 And Migration

The authorized CRED-UX4A non-secret settings shape is:

```text
AgentLlmSettingsV2 {
  schema_version: 2,
  revision: u64,
  providers: [AgentProviderProfile],
  models: [AgentModelProfileV2 {
    id, provider_id, display_name, model_id, enabled,
    model_type: CapabilityValueWithSource,
    capabilities: map<capability, CapabilityValueWithSource>,
    last_test?
  }],
  capability_routes: [AgentCapabilityRoute {
    capability, model_id, model_type, required_model_capabilities
  }]
}
```

There is no second selected-model authority in V2. The required `agent.chat`
route is what the Agent composer displays and what a normal turn records.

Migration from V1 is deterministic:

- the exact V1 `selected_model_id` becomes the `agent.chat` route;
- existing Provider/model stable IDs and credential accounts are unchanged;
- existing tool-calling, reasoning, and vision fields retain their values and
  provenance;
- new capability fields and an unknown model type remain `unknown`; Rho does
  not guess from a model-name substring;
- no optional route is invented;
- before the first explicit V2 mutation, Rho atomically writes a same-directory
  non-secret V1 backup, then atomically writes V2; a backup failure prevents
  migration, and a V2 write failure leaves the V1 source recoverable;
- read-only opening may project V1 as V2 in memory but does not rewrite disk;
- repeated migration/reopen is idempotent, and unsupported/corrupt schemas
  fail closed without touching credentials.

The settings file is capped at 256 KiB; Providers and models retain their
existing bounds; routes are capped at 32; required capabilities at 16 per
route; route and capability tokens use bounded canonical ASCII names. The
presentation view includes a revision. Every route mutation supplies the
expected revision and rejects stale dialogs before writing.

Deleting or disabling one model directly remains rejected until its route is
reassigned or removed. Removing one route never removes its model or
credential. Removing a credential leaves routes configured but visibly not
ready. The explicit Provider-removal operation is the sole cascade exception:
after one impact confirmation, it removes that Provider's models and any
optional routes that reference them. It remains blocked while the required
`agent.chat` route references one of those models; the user must explicitly
assign Chat to a compatible model from another Provider first.

### Least-Privilege Runtime Architecture

Rho must not inject every routed Provider key into the long-lived scope of one
Agent turn. The runtime is split into two paths:

```text
Ask / Plan / Act
  -> broker resolves agent.chat or agent.act
  -> one short-lived Agent R process
  -> one Provider credential
  -> aisdk ChatSession default model

Typed capability operation
  -> broker resolves exact capability + settings revision
  -> one isolated short-lived capability worker
  -> one model profile + one Provider credential
  -> aisdk resolve_model_for_capability()
  -> bounded typed result / temporary artifact
```

The main Agent R receives only the credential for the effective
`agent.chat`/`agent.act` model. It may receive non-secret route summaries for
tool availability and attribution, but never optional-route credentials. A
capability tool sends only a typed request and opaque project/artifact identity
to Rust. Rust re-resolves the route against the current settings revision,
retrieves that one Provider key immediately before spawn, and injects it into
the isolated worker environment. Credentials never cross frontend state,
stdin JSON, broker frames, settings, arguments, events, logs, or artifacts.

Each worker has a fixed operation kind, bounded input/output, timeout,
cancellation, process-tree termination, and one-result contract. It cannot use
Workspace R directly. Scientific object or file access remains broker-owned;
the worker receives only an admitted bounded copy or artifact reference. Any
project file mutation continues through the existing file proposal/export
lanes. Generated media first lands in broker-owned temporary storage and is
registered/exported only through the existing Artifact contract.

The broker records route resolution and execution attribution without secrets:
capability, settings revision, model/profile ID, effective Provider/model ref,
operation ID, status, elapsed time, and artifact IDs. A missing credential,
stale revision, incompatible capability, unavailable consumer, timeout,
cancellation, Provider failure, or persistence failure remains on the selected
route and never falls back to `agent.chat` or another model.

### Typed Command And Worker Boundaries

The first implementation package may add only these settings commands:

```text
agent_llm_save_capability_route(expected_revision, route)
agent_llm_delete_capability_route(expected_revision, capability)
agent_llm_declare_model_capabilities(expected_revision, model_id, patch)
```

They return a fresh presentation view, perform one atomic settings mutation,
and never read a credential or contact a Provider. Provider discovery remains
the separately bounded CRED-UX3 read path.

Capability execution is a later typed broker command/tool family, not a string
shell, arbitrary R, generic HTTP proxy, or reuse of `approval_requests`. Each
consumer defines its own request/response shape, byte budgets, artifact rules,
and whether user confirmation is required. Media and embedding consumers may
not be enabled by merely landing the V2 settings schema.

### Work Packages And Mandatory Stops

#### CRED-UX4A — routing foundation

- V2 schema, deterministic V1 migration/backup/recovery, revision checks;
- complete model type/capability/provenance projection from the existing
  `aisdk` catalog plus user declarations;
- Model routing, Connections, and Model library UI with browser/mock parity;
- functional `agent.chat` and `agent.act` route resolution for existing turns;
- exactly one selected-route credential in the Agent child;
- no media/embedding worker and no optional-route credential use.

Mandatory stop: migration and rollback evidence, two-Provider routing tests,
stale/failure recovery, complete affected matrix, browser review, independent
credential review, and owner acceptance before CRED-UX4B.

#### CRED-UX4A-R1 — Provider-first recovery and catalog integration

Authorization: the project owner explicitly authorized the formal repair and
the bounded Provider-first enhancement on 2026-08-07. This package is active.
It is D3/R3 because it changes credential-adjacent Provider construction,
runtime dependency admission, Provider discovery endpoints, route mutation
entry points, and installed-app recovery. It retains schema V2 and every
credential, revision, project, and no-fallback boundary owned above.

The exact installed `0.4.0-dev.18` app reproduced this invariant violation:

1. a transient `agent_llm_settings` read failure was converted to an empty
   frontend settings projection;
2. the composer disabled its only model-settings trigger when the projection
   contained no models;
3. the trigger handler independently refused to open the menu without models;
4. the banner instructed the user to open Model settings, producing no
   reachable recovery action even though the durable V2 settings and Keychain
   account remained valid.

The protected recovery invariant is: unless an active turn or approval locks
model changes, Model settings remains reachable from the composer for loading,
empty, invalid, unavailable, and configured states. An initial read failure
must retain a bounded retry action, a retry must re-read durable state rather
than repair or overwrite it, and Rust must record a bounded credential-redacted
failure class in startup diagnostics. Opening Model settings after a failed
read performs one explicit retry; repeated failure remains visible and
retryable without touching providers, models, routes, or credentials.

The package imports `aisdk.providers` version `0.1.0` from exact commit
`5cf315e5eedad7d83b224c96595da346e1192a85`. It exposes only the reviewed named
adapters registered by that package: DeepSeek, Moonshot, Kimi, Stepfun,
Volcengine, AiHubMix, xAI, OpenRouter, Bailian, and NVIDIA. OpenAI, Anthropic,
and Gemini remain core `aisdk` Providers. Runtime construction uses an explicit
Rho-owned allowlist and one selected Provider profile; it never accepts a
package, function, expression, or constructor name from settings. A missing or
incompatible `aisdk.providers` installation produces a bounded actionable
runtime error for an affected Provider and never falls back to a different
Provider. The independently versioned `rho.agent` package advances because its
runtime adapter and declared dependency contract change.

Each reviewed preset defines a display name, stable registered Provider ID,
default API-key environment name, default endpoint, wire format, and model
discovery strategy. These defaults are presentation/runtime metadata, not
credentials and not durable model availability. Provider model discovery
retains one bounded request, no redirects/retries, exact authentication-header
rules, body/error redaction, and manual entry fallback. A literal Base URL is a
common visible optional override for every named/core Provider; blank means the
adapter's reviewed default. Custom/local compatible Providers still require a
literal Base URL because they have no default. Environment-derived Base URLs
remain Advanced and unavailable to discovery, preserving the existing network
authority boundary.

Model settings opens on **Connections**. The normal workflow is:

1. choose a Provider from an accessible card grid, optionally override its
   Base URL, store its key, and test the connection;
2. fetch/import a model from card-based Provider results, with manual Model ID
   entry as the existing fallback;
3. inspect the model's default type and capability values with evidence labels;
4. explicitly assign one or more compatible named uses in Model routing.

Provider choice, discovered-model choice, standard route assignment, and the
nine capability values use panel/card/switch presentation rather than default
HTML selects. Low-frequency wire format, custom route type, and destructive
controls may remain progressively disclosed. Capability controls preserve
tri-state truth: catalog/Provider values display as automatic evidence;
changing a value creates a user declaration; unknown is never displayed as a
known `no`. Context window and maximum output values are presentation-only
catalog facts in this package and are not accepted as execution limits unless
a later runtime contract adopts them.

Connections and Model routing are bidirectionally linked:

- each imported model card shows Provider, model type, positive/default
  capability badges, provenance, current route assignments, and an `Assign
  uses` action;
- `Assign uses` opens Model routing with that exact stable model ID in context;
  each standard route then presents an explicit compatible `Use for this
  route` action, a `Review capabilities` action for unknown evidence, or a
  disabled incompatibility explanation;
- each assigned route card links back to its exact Provider connection and
  model review surface;
- an empty route surface offers `Add a connection`, and adding/importing a
  model never assigns it automatically;
- route writes continue to use the current expected revision, and stale or
  failed writes keep the previous durable route visible after reloading.

Mock mode adds a one-shot `agent_llm_settings` failure followed by successful
retry and stays in command parity with the real backend. Automated evidence
must cover the recovery cause (not only the disabled-button symptom), keyboard
and pointer access with zero models, repeated retry failure, successful retry,
Provider-card selection, custom Base URL validation/default behavior, every
named preset mapping, exact catalog enrichment, card-based model selection,
compatible/unknown/incompatible routing, stale route writes, two-Provider
isolation, missing dependency, credential redaction, normal and narrow layouts,
and no accidental route mutation. Live Provider calls remain separate owner
acceptance and never run in deterministic tests.

`0.4.0-dev.18` was committed, handed to the owner as a DMG, installed under
`/Applications`, and rejected by the recovery reproduction above. Its source,
artifact, and hash become historical evidence and cannot be overwritten or
relabelled. Reviewed user-visible implementation therefore advances every
application version authority to the next unused identity,
`0.4.0-dev.19`, updates `NEWS.md`, and creates a new candidate checklist. The
authorization does not permit a tag, Release, hosted candidate workflow,
notarization, MAC5, Pages mutation, or public distribution.

#### CRED-UX4B — isolated capability workers

- broker-owned worker contract and lifecycle;
- `vision.inspect`, `image.generate`, `image.edit`, and `embedding.default`
  consumers added one at a time as vertical slices;
- one route, model, Provider credential, operation, and bounded result per
  worker;
- exact attribution, cancellation, crash recovery, artifacts, and negative
  tests for every consumer.

Each consumer has its own authorization and stop. One authorization does not
activate the next consumer or a custom generic executor.

#### CRED-UX4C — media interaction

Image attachments, generated-image review, editing controls, cost/confirmation
copy, and installed-app acceptance are a separate product package. It may use
the accepted workers but cannot broaden their credential, filesystem, or
network authority.

### Verification Contract

CRED-UX4A must prove:

- exact V1-to-V2 migration, backup-before-write ordering, idempotent reopen,
  corrupt/unsupported rejection, injected backup/write failure, and recovery;
- route normalization, uniqueness, bounds, required `agent.chat`, model/type
  compatibility, explicit-no rejection, unknown warning, and no guessed facts;
- success, invalid, stale revision, serialization failure, restart/reopen, and
  deletion/disable dependency behavior for every route mutation;
- Ask/Plan resolve `agent.chat`; Act resolves `agent.act` or the visibly
  compatible `agent.chat`; running turns retain their start-bound route/model;
- two Providers can own different routes without credential or settings
  crossover, while one Agent child receives exactly one key;
- model-list discovery remains read-only and transient; capability metadata
  sources remain distinguishable;
- empty, loading, compatible, unknown, incompatible, missing-key, stale,
  failure, retry, long-name, keyboard, and narrow-window UI states;
- R adapter session metadata matches the pinned `aisdk` route schema;
- complete Rust/R/frontend/release matrix and an independent security review.

CRED-UX4B additionally proves for each consumer:

- only the resolved worker receives its one credential and the main Agent,
  Workspace R, sibling workers, stdin, frames, logs, diagnostics, and artifacts
  do not;
- project/artifact identity, settings revision, model profile, and capability
  are bound before execution;
- malformed, oversized, foreign-project, stale, missing-input, timeout,
  cancellation, child crash, Provider error, output persistence failure, and
  restart recovery paths fail truthfully without fallback;
- concurrent workers cannot swap routes, credentials, results, or artifacts;
- generated output stays temporary until an existing reviewed artifact/export
  action admits it.

### Version And Release Impact

Design-only CRED-UX4 work does not change a package version or `NEWS.md`.
CRED-UX4A originally joined `0.4.0-dev.18` before its handoff. The owner later
installed and rejected that exact DMG under the CRED-UX4A-R1 reproduction
above, so its identity, artifact, hash, and earlier evidence are historical.
The authorized replacement implementation advances the application to
`0.4.0-dev.19`, reruns the complete affected matrix, and rebuilds a distinct
app/DMG. It must not overwrite or relabel `dev.18` evidence.

CRED-UX4 changes only desktop/Rho adapter contracts unless a worker requires a
change to exported `rho.agent` behavior. The implementation review decides the
R package version independently. No design or local build authorizes a tag,
Release, candidate workflow, MAC5, Pages mutation, or publication.

## Compatibility And Recovery

- Through CRED-UX3, the existing profile schema and stable IDs are unchanged.
  If CRED-UX4A is separately activated, its V2 migration contract above
  supersedes only the schema statement while preserving stable Provider/model
  identities and system credential accounts.
- Existing `.Renviron` API keys are no longer detected or used; users must save
  the key once in Windows Credential Manager.
- System credentials survive provider display-name and model changes because
  they are keyed by stable provider ID.
- Provider deletion first deletes the system credential. If credential
  deletion fails, provider metadata is retained and deletion reports failure.
- App uninstall behavior is an installed-app acceptance item; Rho does not
  promise that the operating system removes credentials automatically.
- A corrupt settings file remains fail-closed and is never repaired by a
  credential command.

## Verification

Automated evidence must include:

- credential backend unit tests for set/get/replace/delete, provider isolation,
  unknown provider, empty/oversize value, backend failure, and idempotent
  missing delete;
- proof that settings JSON and presentation views contain no key value;
- proof that the Agent child receives the override while the runtime-profile
  stdin, prompt, event metadata, diagnostics, and command arguments do not;
- connection-test success/failure/redaction using an injected test backend;
- frontend/mock tests for minimal required fields, conditional Base URL/API key,
  cleared password input, friendly status, Advanced disclosure, and no legacy
  credential actions in the primary flow;
- JavaScript syntax, Rust format/check/tests, all affected frontend tests,
  browser review, and `git diff --check`.

Manual installed-app evidence remains `NOT RUN` until a built candidate is used
to verify Windows Credential Manager persistence, replacement, deletion,
cancel/failure behavior, no console flash, display scaling, and rejection of a
legacy `.Renviron` API key. Automation does not make the candidate release
ready.

## Version And Documentation

This is user-visible behavior in the existing `0.4.0-dev.14` development
candidate. Keep synchronized application version metadata at `0.4.0-dev.14`,
update `NEWS.md`, amend the delivered LLM configuration design, update the
integrated manual acceptance project, and record exact automated and unrun
manual evidence here after it is true. No R package contract changes.

## CRED-UX1 Implementation Evidence

Implementation and automated/browser verification completed on 2026-08-05.

- Windows Credential Manager is implemented through a bounded credential-store
  abstraction using service `Rho Agent LLM` and stable provider profile IDs.
  Set, replace, delete, missing-delete, provider isolation, invalid input,
  backend failure, and metadata-write rollback/recovery are covered without
  touching a developer credential store.
- Agent turns and connection tests resolve a system credential immediately
  before launch and pass it only through the short-lived Agent R child
  environment. Tests prove the value is absent from settings JSON, runtime
  profiles, stdin, and process arguments.
- System credentials are the only Agent LLM API-key source. Presentation state
  exposes only system-store status; no credential value returns from Rust or
  mock commands, and Agent R is not launched with a user `.Renviron` path.
- Model settings now use the required-fields-first primary flow and one closed
  Advanced disclosure. The transient password input is conditional, is never
  repopulated, and clears after save completion, close, provider change, and
  project change. Base URL is visible only for compatible/local provider types.
- The Issue #4 follow-up keeps the primary flow focused on choosing a provider
  and model, showing the current selection/status, API-key state, connection
  test, and Use this model action. Provider/model editing and destructive
  management remain behind the closed Manage providers and models disclosure;
  Add provider and Add model open that management surface and focus the first
  required field. The chooser collapses to one column at narrow widths.
- The simplified follow-up removes the `.Renviron` credential fallback and
  credential-file action. The management surface now uses one Advanced section
  for low-frequency provider/model fields instead of separate Provider and
  Model advanced disclosures.
- Provider deletion retains metadata when credential deletion fails. If the
  credential deletion succeeds but metadata persistence fails, the previous
  credential is restored and the operation reports failure truthfully.

Verified commands and results:

```text
node --check desktop/dist/app.js
  PASS
all scripts/test-*.mjs
  PASS (28 scripts, including test-system-credential-llm-ui.mjs)
cargo +stable-x86_64-pc-windows-gnu test -p rho-desktop
  PASS (94 tests)
cargo +stable-x86_64-pc-windows-gnu test -p rho-server
  PASS (39 tests; doc tests also passed)
```

Browser/mock review passed at the normal preview viewport and at `560 x 760`:
the primary form did not overflow, Advanced was closed by default, compatible
and local conditional fields behaved as specified, and a mock credential input
cleared after save. This review did not use the real Windows credential store.

Version decision: application metadata remains synchronized at
`0.4.0-dev.0`; this work updates that existing undistributed development
candidate. No R package contract or version changed. `NEWS.md`, the delivered
LLM design, cross-review matrix, and integrated manual acceptance project were
updated.

Installed-app verification of real Credential Manager persistence,
replacement, deletion/cancel/failure behavior, legacy `.Renviron` rejection,
uninstall retention, no-console flash, and Windows display scale is `NOT RUN`.
The document remains active and no release-readiness claim is made.

## macOS Keychain Extension Evidence — 2026-08-05

MAC3 added keyring 4.1.6's Apple-native `v1` backend only for the macOS target.
The Windows production backend and unsupported-platform failure projection are
unchanged. The macOS adapter retains service `Rho Agent LLM`, stable provider
profile accounts, the 16 KiB bound, stored-over-environment precedence,
Agent-only child injection, presentation redaction, and metadata/credential
rollback.

Default automated coverage continues to use injected stores and passed the
complete set/get/replace/delete, missing-delete, provider-isolation,
validation, failure, rollback, fallback, precedence, injection, and redaction
matrix. A separately invoked ignored test used a unique MAC3 service/account
and dummy values to prove native Keychain set/get/replace/delete plus final
cleanup; it reported one passed test. The unsigned development app opened the
model-settings surface and projected credential source/status without exposing
or entering a secret. No provider-network request was made.

This evidence closes only the MAC3 macOS adapter gate. Real Windows Credential
Manager installed acceptance remains `NOT RUN`, and unsigned development-app
evidence does not make a release candidate ready.

## CRED-UX1 simplification follow-up evidence

Implementation and automated verification completed on 2026-08-06.

- Agent LLM credential presentation and resolution now query only the native
  system credential store: Windows Credential Manager on Windows and Keychain
  on macOS. Missing system credentials remain `not_detected`; no
  process-environment scan or `.Renviron` fallback remains.
- Agent connection probes and Agent R turns run without `R_ENVIRON_USER`; the
  system credential is still injected only as the configured API-key variable.
- Model settings now have one simple chooser plus one unified Advanced section;
  the prior Provider/Model advanced split and user-environment action were
  removed.
- `node --check desktop/dist/app.js`, `test-system-credential-llm-ui.mjs`,
  `test-human-facing-information-ui.mjs`, `cargo fmt --all -- --check`,
  `cargo test -p rho-desktop` (107 tests), and `cargo test -p rho-server`
  (46 tests) passed.

Installed-app verification remains `NOT RUN`.

## CRED-UX2 Implementation Evidence — 2026-08-07

The original Issue #4 Model settings completion is implemented in the
`0.4.0-dev.17` development identity.

- The default surface is a provider-card rail plus provider-scoped detail. It
  shows the current model separately, filters model rows by the selected
  provider, and keeps Provider Advanced and the Provider danger zone within
  that provider's detail.
- Add provider is a guided Connection -> Model flow. Provider presets fill
  safe defaults, the password field is transient, Back retains only nonsecret
  draft state, and a previously stored system credential does not require
  re-entry.
- Model creation and editing use a dedicated dialog with a closed capability
  disclosure and a separate Model danger zone. The main dialog and child
  dialogs are sibling modal roots so only the active root is exposed; focus is
  trapped, Escape closes one level, and focus returns to the invoking action.
- Working, success, warning, partial-success, failure, cancellation, and retry
  states are rendered from the operation that actually completed. Deterministic
  mock failure injection covers provider-saved/key-failed,
  provider-saved/model-failed, and provider-and-model-saved/selection-failed
  outcomes without persisting a credential value.
- Browser/mock review passed empty, missing-key, storage-unavailable,
  disabled-model, no-model, ready-to-test, ready, connection-error, long-name,
  wizard, model-editor, Advanced, keyboard, and `680 x 820` narrow-window
  states. The only entered value was an explicit non-secret dummy in mock mode;
  it was cleared at every boundary and was not written to settings, logs,
  screenshots, or artifacts.

Final affected verification passed from the reviewed worktree:

```text
node --check desktop/dist/app.js
  PASS
all scripts/test-*.mjs
  PASS (40 scripts, including test-issue-4-model-settings-ui.mjs)
node scripts/candidate-release.mjs --test true
node scripts/generate-update-site.mjs --test true
  PASS
cargo fmt --all -- --check
cargo test --workspace --no-fail-fast
  PASS (rho-desktop: 125 passed, 1 opt-in Keychain smoke ignored; all other
  workspace unit, integration, and doc tests passed)
Rscript -e "testthat::test_local('r/rho.bridge')"
  PASS (515)
Rscript -e "testthat::test_local('r/rho.agent')"
  PASS (53)
bash scripts/test-bootstrap-ark-macos.sh
  PASS
workflow YAML parse and git diff --check
  PASS
```

The CI-equivalent Tauri 2.11.4 local build produced an unsigned arm64
`Rho.app` and `Rho_0.4.0-dev.17_aarch64.dmg`. Both the app and packaged Ark are
arm64, both Info.plists report `0.4.0-dev.17`, `hdiutil verify` accepted the
DMG, and Workspace smoke passed from both the app bundle and a read-only mounted
DMG. The final local DMG is 21,079,685 bytes with SHA-256
`0f919f8366bade4d12554be87bf07f9117cbeac04397de9e7447935555516f76`.

Native local review confirmed the Issue #4 default provider-card surface and an
idle bundled R runtime. The final child-dialog accessibility-tree recheck is
not claimed: the Computer Use window service returned `cgWindowNotFound` even
for a unique-ID copy with one visible main process, while CoreGraphics showed
the window on screen. Deterministic browser accessibility/focus evidence
passed, but exact installed-candidate native accessibility, native-store
replacement/deletion, and a live provider request remain `NOT RUN` and must be
recorded separately before release handoff.

Version decision: Cargo, lockfile, Tauri, package, workflow defaults,
cache-busting metadata, `NEWS.md`, roadmap, and the active candidate checklist
are synchronized at `0.4.0-dev.17`. No R package contract or version changed.

## CRED-UX3 And CRED-UX4A Implementation Evidence — 2026-08-07

CRED-UX3 discovery and the authorized CRED-UX4A routing foundation were
implemented in the later installed-and-rejected `0.4.0-dev.18` development
identity.

- The non-secret settings authority is schema V2 with a monotonic revision,
  deterministic read-only V1 projection, byte-identical backup before the
  first V2 mutation, atomic persistence, strict bounds, and fail-closed corrupt
  or unsupported schema handling. Route mutation success, invalid/stale input,
  simultaneous writers, serialization/write failure, reopen, dependency
  rejection, and recovery have deterministic coverage.
- Connections, Model library, and Model routing are separate UI layers.
  Provider discovery remains read-only and never assigns a route. Exact
  Provider/model matches may add all nine pinned `aisdk` catalog attributes;
  Provider, catalog, user-declared, and unknown evidence remain distinct.
  Compatible, Needs review, and Incompatible models are presented separately.
- Ask and Plan resolve `agent.chat`; Act resolves explicit `agent.act` or the
  visible compatible Chat route. A per-turn model value cannot bypass the
  effective persisted route. A two-Provider fixture proves that each turn
  receives only its selected route and one matching credential.
- Agent R validates exactly one non-secret effective route and records it in
  ChatSession metadata using the pinned `aisdk` route schema. The exported
  `rho_create_aisdk_session()` contract therefore advances `rho.agent` from
  `0.1.2` to `0.1.3`; its package NEWS and generated documentation are updated.
- The deliberately separate post-test security/contract review found and
  resolved route-override bypass, incomplete catalog-evidence preservation,
  Act fallback compatibility, mock initialization order, stale/mock parity,
  and stale `.Renviron` design wording before this evidence was recorded. No
  unresolved blocking finding remains in the authorized package.

Final affected automated evidence from the reviewed worktree:

```text
cargo fmt --all -- --check
cargo test --workspace --all-targets
  PASS (rho-desktop: 144 passed, 1 opt-in Keychain smoke ignored;
  rho-server: 47; rho-store: 92; all remaining workspace targets passed)
Rscript -e "testthat::test_local('r/rho.bridge')"
  PASS (515)
Rscript -e "testthat::test_local('r/rho.agent')"
  PASS (60)
node --check desktop/dist/app.js
all scripts/test-*.mjs
  PASS (42 scripts)
node scripts/candidate-release.mjs --test true
node scripts/generate-update-site.mjs --test true
bash scripts/test-bootstrap-ark-macos.sh
workflow YAML parse and git diff --check
  PASS
```

Deterministic browser review passed all three settings layers, separate Chat
and Act assignment, compatible/Needs review/Incompatible grouping, full
nine-attribute catalog provenance, stale reload, missing-key presentation,
Advanced navigation, child-dialog focus restoration, keyboard operation,
long content, and `700 x 850` narrow-window containment. The normal review
viewport was `1715 x 891`. Only a disposable mock value was used and cleared;
no real Provider credential or network request was used.

Tauri CLI 2.11.4 built an unsigned arm64 application and the post-redesign
`Rho_0.4.0-dev.18_aarch64.dmg`. The first combined bundle attempt truthfully
failed because processes running from its read/write interstitial volume kept
that volume busy; those exact temporary processes exited, the volume detached,
and the documented split build/bundle recovery completed without signing. The
final DMG is 21,166,579 bytes with SHA-256
`75d6cdf20affb75ca94b5a81050c321eb41975b14c0a43bea2c40a9652da2723`.
`hdiutil verify` passed; the read-only mounted app and Ark are arm64; the app
reports `0.4.0-dev.18` and macOS 14.0; and its complete Workspace smoke passed,
including Plot, data view, stale rejection, two-project isolation, restart,
interrupt, crash recovery, and durable events.

Historical version decision: application authorities were synchronized at
`0.4.0-dev.18`, while `rho.agent` independently advanced to `0.1.3`. The
subsequent owner-installed recovery rejection supersedes local acceptance and
forces replacement identity `0.4.0-dev.19`. CRED-UX4B/C remain unauthorized.

## CRED-UX4A-R1 Implementation Evidence — 2026-08-07

The Provider-first recovery package is implemented at replacement identity
`0.4.0-dev.19`; `rho.agent` independently advances to `0.1.4` because its
runtime contract now imports and explicitly constructs the reviewed
`aisdk.providers` adapters.

- The composer model button remains reachable with zero models or a failed
  settings read. Opening Model settings performs one read-only retry and keeps
  a visible retry action; the real command logs bounded failures and mock mode
  reproduces a one-shot failure without mutating saved settings.
- Connections is first. Provider, discovered-model, capability, connection-
  model, and route-model choices use cards/switches for frequent decisions.
  The common connection section owns the optional literal Base URL, while
  environment indirection stays Advanced and is never expanded by discovery.
- The exact pinned `aisdk.providers` commit contributes ten explicit named
  constructors; unreviewed registered IDs cannot receive a Base URL override
  or arbitrary package/function dispatch.
- Default model type/capability evidence is visible on discovery, Connection,
  and routing cards. Model options opens its switches by default; overrides
  remain user-declared. Connection cards and route candidates link in both
  directions without automatic route assignment or silent fallback.
- Focused JavaScript, Rust, and R adapter checks pass. Deterministic browser
  review covers default, empty, Provider wizard, model options, Add model, and
  routing states at normal and narrow viewports with no page errors, horizontal
  overflow, or Provider/detail overlap.
- The complete affected matrix passes: 43 frontend contract scripts, complete
  Rust workspace/all-targets tests, complete `rho.bridge`/`rho.agent` suites,
  release/update fixtures, macOS Ark fixture, workflow parse, format, syntax,
  metadata, and diff checks. Independent final review found no unresolved
  credential, Provider-network, schema, persistence, routing, or sequencing
  conflict. That review found and repaired one pre-handoff boundary gap:
  provider constructors now receive an explicit reviewed default endpoint and
  explicit system-store key value, so an undeclared ambient API key, endpoint,
  backup endpoint, or Kimi/Moonshot option cannot silently override the Rho
  profile. Only the profile's explicit Advanced Base URL environment field is
  resolved.
- Tauri CLI 2.11.4 produced a local unsigned arm64 app and
  `Rho_0.4.0-dev.19_aarch64.dmg`. `hdiutil verify`, exact app/Ark arm64 checks,
  version `0.4.0-dev.19`, macOS 14.0 minimum, and read-only mounted-DMG
  Workspace smoke all pass. The DMG is 21,213,923 bytes with SHA-256
  `8fbe232b92b752216e907743cba45316acaaae1e0b20c5f9a12e77c6122906c1`.
  Its linker ad-hoc signature is development-only and intentionally does not
  satisfy Developer ID, notarization, staple, or Gatekeeper gates.

No real Provider request or credential was used. Authoritative candidate,
installed-app/live-Provider acceptance, MAC5, and publication remain `NOT RUN`
and unauthorized.

## Issue #6 Repair Route Consumer Amendment — 2026-08-08

PROBLEMS-AGENT-REPAIR-2 is an authorized consumer of the existing capability
route contract at application identity `0.4.0-dev.20`. It adds no Provider,
model, route, credential, or settings-schema state. The closed
`problem_repair` task resolves the same effective `agent.act` route used by Act
because a reviewable file proposal requires `function_call=yes`, but forces
Ask policy and `auto_approve=false`. Only the resolved route's system-store
credential is projected into the child; per-turn override, chat-only,
unknown-capability, disabled, and credential-missing cases fail before a turn
is created. Ordinary Ask/Plan/Act resolution remains unchanged.

Deterministic route, compatibility, one-credential, missing-credential,
override-rejection, and settings-deep-link tests pass without a real Provider
request. The historical `dev.19` settings artifact cannot validate this new
consumer. Live Provider/Keychain acceptance moves to the exact `dev.20`
owner-installed gate; CRED-UX4B/C remain unauthorized.

## CRED-UX4A-R2 Registered Runtime Identity Correction — 2026-08-08

Owner-installed `dev.20` evidence rejects the Issue #6 consumer before its
first Provider request. The persisted route correctly uses the canonical
registered Provider/model reference, but the supervised Agent R child registers
the reviewed one-credential Provider under a private alias and resolves that
alias as the session model. Exact route validation then fails.

The correction keeps one identity per registered runtime profile: in the
isolated one-profile child process, the explicitly constructed reviewed
Provider is registered at the profile's canonical registered Provider ID and
the session resolves the exact canonical route model. Generic/custom Providers
continue using their unique runtime IDs. This does not authorize global
Provider replacement, a second credential, ambient environment fallback,
silent model fallback, or changes to persisted settings schema. Mismatched
route/profile models still fail closed before network access.

Regression coverage must construct a reviewed registered Provider with a
disposable credential, resolve and normalize one `agent.act` route under Ask
policy, create the session without a request, and separately prove canonical
mismatch and custom-connection isolation. The exact installed `dev.20`
artifact is historical; the corrected runtime contract advances `rho.agent`
and is eligible only for replacement application identity `0.4.0-dev.21`.
CRED-UX4B/C remain unauthorized.

## CRED-UX4A-R3 One-Confirmation Provider Removal — 2026-08-10

### Reproduction And Invariant

The Provider-first surface presents a selected Provider, its imported models,
their route assignments, and credential state together. Despite already
holding that dependency graph, `Delete provider` currently opens a confirmation
that tells the user to remove every model manually, then the command rejects
with the same instruction. The screenshot reproduction used an unassigned
AiHubMix model: deleting the Provider failed even though no product decision
remained for the user to make.

The accepted invariant is:

> One destructive confirmation removes exactly one revision-bound Provider,
> all models owned by it, optional routes that reference those models, and its
> one system credential. If deletion would remove the required `agent.chat`
> route, Rho blocks before mutation and links to Model routing; it never guesses
> a replacement. Cancellation, stale state, credential failure, or settings
> persistence failure leaves the complete pre-operation state recoverable and
> never reports success.

### Typed Mutation And Ordering

The existing command becomes one typed request:

```text
DeleteProviderRequest {
  provider_id: String,
  expected_revision: u64
}

agent_llm_delete_provider(request) -> AgentLlmSettingsView
```

Under the existing process-wide settings mutation lock, Rust must:

1. load and validate current settings;
2. reject a stale `expected_revision` before credential access;
3. resolve the exact Provider, its model IDs, and every referencing route;
4. reject before credential access when `agent.chat` references a target model;
5. build and validate the candidate state after removing only the target
   Provider, its models, and referencing non-Chat routes, then increment the
   revision exactly once;
6. read and delete only the target Provider's system credential;
7. atomically persist the candidate settings;
8. if persistence fails, restore the previous credential and report failure;
   if restoration also fails, report that recovery failure truthfully while
   leaving settings metadata unchanged.

Credential read/delete failure occurs before metadata persistence and therefore
retains Provider, model, and route state. A duplicate or late request is stale,
not idempotent success. No key value enters the request, response, settings,
DOM, mock fixture, log, or diagnostics.

### User Experience

- The Danger zone explains that one confirmed action removes the Provider, its
  imported models, optional route assignments, and stored API key.
- The action label is `Delete provider and models`, not a command that implies
  models must already be gone.
- Before confirmation, the UI derives and presents the exact model count,
  optional route names/count, and whether a stored key is included. The
  confirmation button repeats the model count.
- If a target model owns `agent.chat`, the destructive confirmation is not
  shown. A decision dialog explains that Chat must remain assigned and offers
  `Open Model routing`; no Provider, model, route, or credential command runs.
- Cancel closes the dialog and restores focus to the invoking action without
  mutation. Working state disables duplicate submission.
- A stale backend rejection reloads the latest settings and asks the user to
  review the updated impact. Other failures keep the Provider selected and
  present a retryable, credential-redacted message.
- On success, Connections selects a remaining Provider and reports the exact
  deleted model and optional-route counts. Model routing, Model library, and
  the composer update from the returned authoritative view.
- Empty, long-name, narrow-window, keyboard, focus, and screen-reader semantics
  remain within the existing product-dialog and Model settings contracts.

### Compatibility, Tests, And Stop

This is a settings-schema-v2 mutation only. It adds no schema field, database,
project ownership, Provider-network request, credential source, route fallback,
or R package behavior. Direct single-model deletion remains non-cascading.

Required deterministic evidence is:

- success removes multiple target models, target optional routes, target
  Provider, and only its credential while preserving another Provider, its
  model, required Chat route, and credential across reopen;
- cancellation performs no command or state change;
- required-Chat ownership, unknown Provider, stale revision, credential read or
  delete failure, injected settings-write failure, and credential-restore
  failure reject truthfully with the strongest recoverable state;
- repeated/late submission and concurrent revision change cannot delete newly
  added dependencies;
- mock/Tauri command parity plus UI impact copy, Chat-route handoff, success,
  stale/reload, failure, long-name, keyboard/focus, and narrow layout;
- focused Rust and frontend regressions, complete affected Rust/frontend/R
  suites, syntax/format/diff checks, deterministic browser review, and an
  independent credential/destructive-state contract review.

This user-visible behavior requires the next unused application identity before
integration or packaging. `0.4.0-dev.27` and Draft `367934137` remain immutable;
the implementation is not distributable under that identity. The implementation
review decides whether to synchronize `0.4.0-dev.28` immediately or defer it to
a named integration candidate with packaging prohibited meanwhile. No R package
version change is expected. Candidate construction, publication, update-site
mutation, and MAC5 are outside this work package.

## CRED-UX4A-R3 Implementation Evidence — 2026-08-10

The authorized slice is implemented as one revision-bound command and one
dedicated impact-review dialog. The backend validates the complete candidate
before credential access, rejects required-Chat ownership without guessing a
replacement, removes only target-owned models and optional routes, deletes only
the target account in the system credential store, and restores the previous
credential if atomic settings persistence fails. Credential restoration failure
keeps metadata unchanged and is projected as an explicit instruction to save the
API key again rather than as a false all-or-nothing success.

The UI shows Provider, model count and names, optional route count and names,
and current credential-store status. Chat ownership replaces the destructive
action with `Open Model routing`; Cancel restores focus; working state prevents
duplicate submission; stale state reloads and requires another review; and a
failed reload preserves the reviewed state instead of falsely claiming another
window deleted it. The Tauri payload uses the nested request's serialized
`provider_id` and `expected_revision` names; browser/mock mode accepts the same
contract and applies the same cascade and Chat guard.

Focused regressions cover multiple target models, target route removal,
two-Provider/key isolation, empty Provider/no-key deletion, reopen, late replay,
simultaneous requests, malformed and unknown Provider IDs, required-Chat
rejection before credential access, credential read/delete failures, injected
metadata-write failure with successful restoration and retry, and restoration
failure with truthful partial-recovery state. The frontend contract covers
impact copy, cancellation/no-command behavior, typed request parity, stale
reload, failure projections, focus trapping, ARIA ownership, responsive layout,
mock ordering, and deterministic normal/empty/Chat-blocked preview states.

Final automated evidence from the reviewed worktree:

```text
cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo test --workspace --all-targets --no-fail-fast
  PASS (rho-desktop: 174 passed, 1 opt-in Keychain smoke ignored;
  rho-server: 58; rho-store: 108; all remaining workspace targets passed)
Rscript -e "testthat::test_local('r/rho.bridge', reporter='summary')"
Rscript -e "testthat::test_local('r/rho.agent', reporter='summary')"
  PASS
node --check desktop/dist/app.js
all 51 scripts/test-*.mjs
git diff --check
  PASS
```

Deterministic Chrome screenshots were reviewed at `1440 x 900` and `700 x 850`
for both an executable two-model/one-route deletion and required-Chat blocking.
The review showed the exact impact, long-name wrapping, visible default Cancel
focus, no destructive button in the blocked state, no overlap, and no clipping
outside the viewport. The configured in-app browser connection was unavailable
for a final scripted keyboard/DOM pass; final interactive and exact installed-app
acceptance are therefore still `NOT RUN` and remain release gates.

The independent post-test review found and resolved four boundary defects before
this evidence was recorded: nested Tauri fields initially used the wrong case;
stale reload failure could be mistaken for deletion in another window; a
credential restoration failure was projected too generically; and the Provider
ID input lacked an explicit request bound. No unresolved schema, route fallback,
cross-Provider deletion, credential disclosure, persistence, or command-parity
finding remains in the implemented source slice.

Version decision: this branch deliberately remains source-only. Application
metadata and `NEWS.md` stay at immutable `0.4.0-dev.27`; the change must advance
all application authorities and NEWS to the next unused identity (currently
expected to be `0.4.0-dev.28`) before integration, packaging, or distribution.
No R package contract or version changed.

## CRED-UX4A-R4 Issue #25 Provider Context And Model-Delete Modal Repair — 2026-08-10

### Reproduction And Invariants

Issue #25 reports three linked Model settings defects. The R3 Provider-removal
slice above already resolves the second: one guarded confirmation removes a
Provider and its owned models without requiring a manual model-by-model cleanup.
Two defects remain in the same Provider-first surface:

1. Connections renders the global `agent.chat` model inside every selected
   Provider detail. Selecting a new or unassigned Provider can therefore show a
   model and Provider name owned by another connection immediately above the
   selected Provider's connection test.
2. Model deletion calls the generic product confirmation at stacking level 32
   while the Model editor is a Model-settings child at stacking level 34. The
   confirmation is visually behind the editor, and both roots can retain modal
   semantics instead of exposing one active dialog.

The accepted invariants are:

> A selected Provider detail never presents another Provider's model as its
> Chat assignment. When the global Chat route belongs elsewhere, the detail
> says that this Provider is not assigned and reveals no unrelated model name.

> Model deletion is admitted only from one visible, topmost, Model-settings-
> owned confirmation dialog. Cancel, scrim close, or Escape issues no delete
> command and restores focus to the invoking Delete model action. While the
> confirmation is active, the Model editor is inert and is not exposed as a
> second modal dialog.

### Provider-Scoped Chat Presentation

The persisted route and selected model remain global. Connections derives a
presentation-only result from the selected Provider ID and the authoritative
Chat model:

- if the Chat model is owned by the selected Provider, show that model and its
  existing readiness status;
- if Chat is missing or is owned by another Provider, show `This Provider is
  not assigned to Chat.` with `Not assigned` status;
- never substitute the selected Provider's first model, mutate a route, or show
  the other Provider/model in this detail;
- Model routing and the composer remain the global places that expose the
  effective Chat assignment.

Provider switching, a newly saved Provider with no model, an unassigned
Provider with models, and a Provider that owns Chat must all re-render from the
same pure derivation. No schema, command, credential, or Provider-network path
changes.

### Model-Delete Dialog Contract

Model settings owns a dedicated sibling `Model deletion` modal above the Model
editor. Opening it captures the exact existing model ID and the invoking
element, presents the model display name plus the non-cascading consequence,
makes Cancel the initial focus, and performs no mutation. The confirmation
button calls the existing `agent_llm_delete_model` request for that exact model.

Cancel, close, scrim, and Escape clear the captured model ID, restore the Model
editor as the sole modal root, make it interactive again, and return focus to
the invoking action. Duplicate confirmation is disabled while the request is
in flight. Success applies the returned authoritative view, closes both delete
and edit dialogs, and reports the deleted model. Failure keeps the confirmation
open with a credential-free retryable error and does not claim deletion. Route
dependency rejection remains owned by the existing backend and does not
cascade or guess a replacement.

The main Model settings root stays suspended throughout the nested flow.
Closing Model settings forcibly closes the deletion dialog without restoring
focus into a hidden tree. Exactly one of the main settings root, Add Provider,
Model editor, Provider deletion, or Model deletion owns `role=dialog` and
`aria-modal=true` at a time.

### Acceptance Matrix And Stop

Required deterministic evidence is:

- a behavioral regression for selected Provider A owning Chat while selected
  Provider B has no route, plus the positive same-Provider case;
- model-delete dialog structure, topmost stacking, one-modal ownership, Model
  editor inertness, Cancel/scrim/Escape no-command behavior, focus restoration,
  duplicate-submit suppression, success, and failure/retry projection;
- unchanged direct-model backend rejection for a referenced route and unchanged
  Provider one-confirmation regressions;
- deterministic normal and narrow-window previews with the confirmation fully
  visible, reachable, and unclipped;
- frontend syntax plus all frontend contract scripts, followed by the complete
  affected Rust/R matrix because this branch also contains the R3 Provider
  transaction awaiting integration;
- a deliberately separate post-test review of route truthfulness, destructive
  admission, modal/accessibility ownership, mock/Tauri parity, and diff scope.

This is a source-only continuation of the not-yet-integrated R3 branch. The
immutable `0.4.0-dev.27` identity and Draft `367934137` remain unchanged. R3 and
R4 together require the next unused application identity and a `NEWS.md` entry
before integration, packaging, or distribution; no R package contract changes.
Installed-app acceptance and release actions remain outside this work package.

### Implementation And Verification Evidence

The implemented UI now derives the Connections Chat summary from the selected
Provider and the authoritative configured `agent.chat` route. A foreign Chat
model produces only `This Provider is not assigned to Chat.` and `Not
assigned`; the effective global route remains visible and editable in Model
routing and the composer. The existing R3 one-confirmation Provider-removal
flow continues to own Issue #25's Provider cleanup requirement.

Direct model deletion now uses a dedicated Model-settings sibling dialog above
the Model editor. It captures the exact model ID, makes the editor inert,
assigns modal semantics to only the active dialog, starts on Cancel, calls the
unchanged non-cascading `agent_llm_delete_model` command only after explicit
confirmation, and keeps a rejected request open for a truthful retry. Cancel,
close, scrim, and Escape perform no mutation and restore editor focus.

Failing-first evidence: `node scripts/test-issue-25-model-settings-ui.mjs`
initially failed because `agentProviderChatPresentation` did not exist. After
implementation, `node --check desktop/dist/app.js` and all 52
`scripts/test-*.mjs` frontend contract checks pass, including Provider
ownership projection, modal stacking/ownership, inertness, no-command
cancellation paths, and duplicate-submit suppression. The interactive
success/dependency-rejection evidence is recorded below.

The complete affected branch matrix also passes:

- `cargo fmt --all -- --check`, `cargo check --workspace --all-targets`, and
  `cargo test --workspace --all-targets --no-fail-fast` (including 174
  `rho-desktop`, 58 `rho-server`, and 108 `rho-store` tests; the opt-in
  Keychain smoke test remains ignored by design);
- `Rscript -e "testthat::test_local('r/rho.bridge', reporter='summary')"` and
  the equivalent `r/rho.agent` suite;
- candidate/update-site dry runs, the macOS Ark bootstrap contract, macOS
  entitlement/notary contract checks, workflow YAML parsing, and
  `git diff --check`.

Deterministic Chrome review covered the selected-unassigned Provider and the
model-delete confirmation at `1440 x 900`, `700 x 850`, and a blocked-delete
state at `900 x 820`. The selected Minimax Provider disclosed no DeepSeek Chat
model, and the confirmation remained topmost, fully visible, unclipped, and
focused on Cancel. A CDP interaction probe verified that Cancel preserved
revision/model count and restored Delete-model focus; success moved revision
`1 -> 2` and model count `3 -> 2`; a Chat-route dependency rejection kept the
dialog open with an enabled retry after the error. Every state exposed exactly
one active `aria-modal` dialog and produced no browser exception.

The deliberately separate post-test review covered route truthfulness,
destructive admission, modal/accessibility ownership, mock/Tauri command
parity, and diff scope. It found one bounded reentrancy issue: programmatic
duplicate-open or already-closed paths could needlessly relabel another active
dialog. Explicit open/close state guards were added, then the full 52-script
frontend matrix was rerun successfully. No unresolved route mutation,
cross-Provider disclosure, cascade deletion, credential, schema, persistence,
network, or backend-command finding remains.

Version decision at the source-review checkpoint: this was a source-only
continuation of the R3 branch. Application metadata and `NEWS.md` remained at
immutable `0.4.0-dev.27`; R3 and R4 therefore required the next unused
identity before integration, packaging, or distribution. No R package contract
or package version changed. Exact installed-app acceptance was `NOT RUN` and
remained the release gate.

## CRED-UX4A-R3/R4 Integration Handoff — 2026-08-10

The project owner's instruction to push, merge, and reply to Issue #25
authorizes the already reviewed R3/R4 source slice to enter upstream `main`.
It does not authorize candidate construction, installation, publication, or
reuse of the immutable `0.4.0-dev.27` Draft.

All application version authorities, release-workflow defaults, cache
identities, release-contract fixtures, and `NEWS.md` are synchronized to the
next unused identity, `0.4.0-dev.28`. The active `dev.28` checklist owns any
future exact-candidate evidence; no `dev.27` artifact, receipt, hash, or
installed result is composable with it. `rho.bridge 0.1.13`, `rho.agent
0.1.5`, and store schema 12 remain unchanged.

The integration branch carries the reviewed implementation commits
`751e71d` and `2b12d1f` plus this bounded identity/documentation
reconciliation. [PR #31](https://github.com/YuLab-SMU/Rho/pull/31) merged all
three commits into upstream `main` at
`e89ed7000e9b646e486843f501067687428da07e`. The final Issue evidence and
disposition remain; exact installed-app acceptance is a separate `dev.28`
release gate.

The pre-integration rerun passed `cargo fmt --all -- --check`, `cargo check
--workspace --all-targets`, and `cargo test --workspace --all-targets
--no-fail-fast` (desktop 174 passed with the opt-in Keychain smoke ignored,
server 58, store 108, and all other workspace targets passed). Both R package
suites and all 52 `scripts/test-*.mjs` contracts passed, together with
JavaScript syntax and `git diff --check`. The first frontend matrix run
truthfully rejected stale escaped `dev.27` cache-version fixtures; those
fixtures were synchronized to `dev.28`, and the complete 52-script matrix
then passed. No implementation behavior changed during that correction.

## CRED-UX3-R1 Deterministic Timeout Verification Repair — 2026-08-11

Candidate run `31552396659` against exact upstream source
`29faba2b4d08bbebb4d9e2e251e7e1d69d393d6f` failed only the macOS execution of
`agent_llm::tests::discovery_bounds_oversized_responses_and_timeouts`. The
fixture configured a 40 ms client timeout but also returned a fully valid
response after 150 ms. Under hosted parallel load, delayed timeout scheduling
allowed that valid response to become observable, producing no error class
where the assertion required `timeout`. The same exact test passed 20
consecutive local executions, confirming nondeterminism rather than a stable
product failure. Governance treats this flake as a release-blocking defect;
rerunning until green is not an acceptance path.

CRED-UX3 remains the sole owner of production Provider discovery. Its
15-second total request timeout, one-request limit, no redirect/retry policy,
literal-endpoint authority, response bounds, credential lookup/redaction,
read-only settings behavior, and bounded error classes do not change.
CRED-UX3-R1 owns only the test seam: the timeout server accepts and records the
request but never sends a valid HTTP response. The short-timeout client can
therefore complete only through its timeout or through a bounded watchdog
failure; a competing delayed success is impossible. The server watchdog must
remain longer than the client limit and prevent a broken client from hanging
CI. The regression continues to verify `timeout` classification and absence of
the injected credential from serialized output.

This package is D1/R1 because production code, protocol, network authority,
credentials, persistence, and user-visible behavior are unchanged. The
project owner reviewed the reproduction and explicitly authorized the repair
and push on 2026-08-11. The exact test, repeated focused execution, complete
locked Rust workspace, all deterministic frontend/release contracts, both R
package suites, format/check, and diff validation are required before handoff.
A separate post-test review must confirm no production discovery line changed.

The failed run produced an exact Windows installer artifact, consuming the
single-use `0.4.0-dev.32` identity. The replacement source advances only the
application/release identity to `0.4.0-dev.33`; `rho.bridge 0.1.14`,
`rho.agent 0.1.5`, settings schema V2, and store schema 12 remain unchanged.
No `dev.32` source result or artifact may satisfy a `dev.33` candidate,
installed, signing, MAC5, publication, or updater gate.

CRED-UX3-R1 is now implemented locally. The exact regression passed once with
visible output and 50 more independent Cargo-process repetitions. The locked
full Rust workspace, all 56 frontend/release contracts, both R package suites,
candidate/update-site dry runs, macOS Ark bootstrap fixtures, formatting, and
diff validation pass. An independent post-test comparison hashes every
production line before `#[cfg(test)]` identically to upstream `main`, confirming
the change is confined to test support. Push, exact-head hosted source CI,
integration, and every candidate or installed gate remain separate.
