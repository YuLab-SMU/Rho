# CRED-REVEAL-1B Native Secure Credential View

> Status: superseded on 2026-08-27 by
> `plans/active-2026-08-27-cred-reveal-1c-simple-inline-view-spec.md` (owner
> instruction "不要什么Touch ID 了，简洁就行") after the owner-run macOS trial
> recorded below failed: the LocalAuthentication dialog tripped this flow's own
> focused-window revalidation and every View resolved `stale`. This document
> remains as historical evidence; 1C governs the reveal flow.
>
> CRED-VAULT-1 changes the eligible app-managed exact source from
> `system_store` to an already-unlocked `rho_vault`. Native macOS user
> verification remains a reveal gate, but reveal performs no Keychain call.

Status: active implementation handoff activated on 2026-08-27 through the
owner's explicit `继续开发` instruction following the completed CRED-REVEAL-1A
checkpoint (`active-2026-08-26-cred-reveal-1a-connection-test-redaction-spec.md`)
that separately required this activation. This package stops after its own
implementation, automated verification, and independent review; owner-run
installed-app platform acceptance remains separate and is not claimed here.
The owner narrowed this active package on 2026-08-27 to the current local
development platform only (`Darwin`/macOS): implement and verify the macOS
LocalAuthentication/AppKit path here; Windows and Linux native reveal
presenters are explicitly deferred and must not expand this work package.

Date: 2026-08-27

Change class: D3 because it adds one IPC command, one bounded exception to the
stored-value-never-redisplayed rule, a new durable audit authority, and
OS-owned user verification plus a native plaintext presenter — a new security
boundary around Provider credentials

Risk: R3 because it deliberately egresses a stored credential from its store
into Rho process memory for display and defines the controls that must make
that egress safe; a defect could expose a Provider API key while appearing
safe

Parent direction:
`proposed-2026-08-26-plugin-native-settings-experience-design-spec.md`
(sections 7.3.1 and 11, package CRED-REVEAL-1B)

Required amendments made concurrently with this activation:

- `plans/active-2026-08-05-system-credential-and-simple-llm-settings-spec.md`
  (CRED-REVEAL-1B amendment, 2026-08-27) authorizes the single bounded
  Settings-facing reveal command whose result contains outcome only.
- `plans/active-2026-08-26-llm-credential-sources-and-store-hardening-spec.md`
  (CRED-REVEAL-1B amendment, 2026-08-27) amends no-redisplay, direct store
  read, blocking fail-closed reveal audit, and native plaintext lifetime rules.

## 1. Scope

One repeatable, explicitly user-triggered secure-view flow for app-managed
Provider credentials, backend-complete in this package:

```text
stored_hidden
  -> agent_llm_view_credential ->
     admission checks -> OS user verification -> repeated admission checks
     -> fresh exact-source read -> blocking fail-closed reveal audit
     -> final admission checks -> native in-process presenter owns plaintext
  -> presenter close clears Rho-owned plaintext -> command completes
  -> Settings receives exactly one terminal non-secret outcome
```

No Settings UI consumes the command in this package; exposing View actions,
masks, Replace/Add flows, and connection screens belongs to SETTINGS-UX2. The
frontend receives only generated bindings and a browser-mock parity stub with
the same no-secret shape.

## 2. Invariants

1. The credential value never crosses Tauri IPC in any form. Every request and
   response field of the new command is non-secret; there is no string,
   fragment, length, prefix, suffix, encoding, hash, environment value, raw
   diagnostic, or presenter detail that encodes credential material.
2. Every View is independent: a fresh OS user-presence verification, a fresh
   exact-source store read taken directly from the underlying store, and a
   fresh reveal-audit write precede every display. Rho never preloads a key
   when Settings opens, retains a grant between Views, consults the Agent
   runtime read-through cache, or reuses a previous read for a later one.
3. Source eligibility is exact and has no fallback:
   - `system_store` is eligible after approved OS verification, using a fresh
     direct keyring read;
   - `session_only` is eligible only while its current zeroized in-memory
     entry exists, still requiring fresh verification;
   - `environment` is rejected before its variable is read (presence probes do
     not occur and the value is never materialized);
   - `file_fallback` is ineligible everywhere in this first package;
   - an out-of-vocabulary persisted source fails closed as ineligible.
4. One admission order is fixed: focused main window and stable
   Provider/source/revision/generation checks, OS-owned user verification,
   repeated focus/authority validation, exact current-source read, blocking
   fail-closed reveal audit, final focus/authority validation, native display.
5. A settings-revision change or a credential-generation advance for the
   Provider (from set, replace, delete, source change, provider update, or
   provider deletion) at any revalidation boundary clears any staged snapshot,
   suppresses display of already-read plaintext, and resolves `stale`.
6. The blocking `credential_reveal_authorized` audit row must be durably
   appended and flushed before the native presenter opens; any write, rotate,
   flush, or durability failure zeroes the read buffer, never displays, and
   resolves `audit_unavailable`. The row contains provider ID, credential
   source, outcome, and time only. Ordinary CRED-SEC4 best-effort rows may add
   bounded attempt records for refused flows and remain non-blocking there.
7. The native presenter is in-process. The secret passes to it as a zeroized
   owner and never through a helper process, argv, environment, stdin,
   clipboard, drag/service bridge, title, window metadata, log, crash report,
   screenshot artifact, or diagnostic. It offers no selection, keyboard copy,
   context menu, drag, or services export of the value, closes on Close,
   Escape, main-window/app focus loss, or app quit, and clears the Rho-owned
   plaintext before its close is reported. Accessibility exposure of the open
   value follows platform defaults without proactive announcement.
8. The command stays pending while the presenter is open and completes only
   after presenter close plus Rho-owned-buffer clearing, resolving exactly one
   terminal outcome: `closed_after_display | cancelled | denied |
   source_ineligible | credential_missing | auth_unavailable |
   store_unavailable | stale | audit_unavailable | presenter_unavailable`.
   Concurrent duplicate requests resolve immediately as `cancelled` without
   touching the store, OS verification, audit, or presenter. Outcomes beyond
   ordinary close are distinct and truthful, including no OS verification
   capability.
9. A per-Provider credential-operation guard spans a reveal's full lifetime;
   Rho-owned credential mutations on the same Provider serialize behind it and
   advance the credential-generation token only after they succeed. Other
   Providers are unaffected; a second in-flight presenter is refused globally.
10. Terminal outcomes never claim false success or leak the responsible store
    layer, platform component, error chain, or credential state beyond the
    bounded vocabulary; failed first attempts leave stored values unchanged
    except that OS store reads are inherently side-effect free, and no
    Settings/settings-file bytes change because a View happened.
11. Existing authorities stay untouched: automatic route resolution, the
    runtime resolver and its read-through cache, presentation-safe settings
    views, observation projections, schema/migrations, model selection,
    connection-test redaction (CRED-REVEAL-1A), browser mock fixtures, and all
    other commands behave unchanged. Clearing an entry by another flow may
    legitimately make a subsequent View resolve `credential_missing`.

## 3. Authorized Implementation

The package may change only:

- `desktop/src-tauri/src/agent_llm.rs`: add the reveal orchestration, typed
  outcome/request/result types, per-Provider credential-generation tracking
  advanced by the existing mutations above, the blocking reveal-audit append
  beside the existing audit helpers, the window/focus abstraction seam, and
  their tests; the file's existing functions gain only generation-token calls
  at mutation success points and otherwise stay byte-compatible;
- one new sibling module tree under
  `desktop/src-tauri/src/agent_llm_reveal_platform/` implementing, behind two
  narrow traits owned by `agent_llm.rs`, the macOS LocalAuthentication
  presence check plus AppKit presenter; non-macOS targets fail closed as
  unavailable and gain no presenter in this package;
- `desktop/src-tauri/src/commands/agent_llm.rs`, command registration in
  `main.rs`, the generated `agent-settings` bindings file and its generator
  inputs, `mock.ts` browser-parity stub, transport facade exposure, the
  binding-leak-guard scripts, command inventory/digest metadata, and
  `desktop/src-tauri/Cargo.toml` limited to enabling the already-resolved
  objc2/foundation features plus the LocalAuthentication framework link;
- docs listed in the amendments above, cross-review, `docs/README.md`, and
  this handoff.

Nothing else changes: schemas, migrations, stores, keyring service names,
resolvers, routes, Installer/R packages, other domains' bindings or mocks.

## 4. Explicitly Forbidden In 1B

- Any Settings UI, mask row, View/Replace buttons, dialog, or controller wiring
  consuming the new command;
- clipboard/copy affordances, persistent authorization grants, `confirmed:`
  frontend shortcuts, auto-reveal, background reads, or reveal on render;
- revealing `environment` or `file_fallback` values, a second settings store,
  schema or migration edits, source fallbacks, or probing any other source
  after an eligible-source failure;
- ambient secret projection into views, bindings, mocks, logs, diagnostics, or
  screenshots, or widening any existing command's result shape;
- MODEL-AUTO-1, SETTINGS-UX1, SETTINGS-UX2 route/default-fallback work, and
  application version, `NEWS.md`, candidate, installer, signing, publication,
  or release claims.

## 5. Deterministic Verification

Focused Rust regression evidence (fake gate/presenter/store injection; real
macOS platform code compiled locally):

1. sentinel happy path: single fresh direct store read, gate, blocking audit
   row present before presenter open, presenter received exactly the sentinel,
   close resolves `closed_after_display`, runtime read-through cache empty
   throughout, and repeat cycles re-read/re-verify/re-audit;
2. denial, dismissal, and unavailability of OS verification resolve `denied`,
   `cancelled`, `auth_unavailable` with zero store reads, zero audit writes,
   and no presenter construction;
3. environment/file_fallback/unknown sources resolve `source_ineligible`
   before any read (sentinel env var untouched, filesystem untouched);
4. missing entries (`system_store` absent; evicted `session_only`) resolve
   `credential_missing`; store read errors resolve `store_unavailable`;
5. audit write/rotation/flush/sync injected failure resolves
   `audit_unavailable`, zeroizes the buffer, proves no display call, and a
   retry after removing the fault succeeds; the audit row bytes contain no
   sentinel and no detail beyond the allowed fields;
6. stale resolution injected independently after authentication, after read,
   after audit, and before display via generation bumps and revision bumps;
   post-admission focus loss; every stale path leaves the store and audit
   truthful and permits immediate clean retry;
7. concurrent duplicates resolve immediately for both same- and cross-Provider
   requests with one presenter slot enforced; the guard serializes a
   simultaneous credential replace/delete, releases fully on every path, and
   an A/B Provider pair shows per-Provider isolation in both directions;
8. presenter creation failure resolves `presenter_unavailable`;
   user-close, Escape-simulated close, focus-loss close, and app-hide close
   all resolve `closed_after_display` with the buffer observed cleared;
9. serialization regression proving every response/binding surface of the new
   command contains only the outcome field, the sentinel appears nowhere, and
   existing settings JSON/views/mock history are sentinel-free;
10. adjacent regressions green: existing credential set/delete/replace/
    overwrite-confirm, session-cache, observation projection, redaction, and
    connection-test suites unchanged; generation tokens advance only on
    successful Rho-owned mutations listed in invariant 5.

After focused tests pass: full `cargo test -p rho-desktop`,
`cargo fmt --all -- --check`, generated-binding freshness/staleness checks,
command inventory/digest, and the complete RSR matrix
(`rsr:check:resume:stable`). An independent reviewer
must confirm no secret crosses IPC/bindings/mock/log and no SETTINGS-UX2 code.

Platform authenticity notes are recorded honestly as residuals: interactive
Touch ID/system-password presenter acceptance requires an owner-run macOS
installed-app trial with a disposable credential and remains an open gate for
SETTINGS-UX2/release decisions. Windows/Linux reveal behavior is not
implemented or claimed by this package.

## 6. Version, Documentation, And Stop

Backend-complete, no user-visible surface ships, so: no application version
bump and no `NEWS.md`. The future Settings-UI candidate exposes View and owns
its synchronized version/changelog decision.

When verification and review pass, record exact evidence in section 7 and
stop. UI integration requires activating SETTINGS-UX2 with its own bounded
authorization; installed-app acceptance of the OS verification/presenter stack
occurs before any release-impacting claim about this feature.

## 7. Implementation And Verification Evidence

Implementation evidence recorded on 2026-08-26:

- reveal admission, credential-generation checks, eligible-source exact reads,
  durable reveal audit, operation/presenter guards, typed outcomes, and focused
  regressions live in `desktop/src-tauri/src/agent_llm.rs`;
- the local development platform implementation lives in
  `desktop/src-tauri/src/agent_llm_reveal_platform/macos.rs` and uses
  LocalAuthentication plus an in-process AppKit presenter; non-macOS dispatch
  fails closed as unsupported and is outside this package's acceptance claim;
- `agent_llm_view_credential` is registered through the Tauri command and
  generated transport contract. Its serialized response contains only
  `outcome`; the browser mock resolves `auth_unavailable` and cannot fabricate
  a secret. No Settings UI or SETTINGS-UX2 controller was added;
- focused `credential_reveal` Rust regressions passed: 9 passed, 0 failed;
- full `cargo test -p rho-desktop` passed: 421 passed, 0 failed, 23 ignored;
- the complete resumable RSR matrix passed: command inventory 197 commands
  across 84 Rust files, generated-binding and contract checks, 51 UI test
  files with 329 tests, build/browser/interaction/dev-lane/visual-acceptance
  harness checks, and `git diff --check`;
- regression work found and fixed two bounded defects before the green matrix:
  persisted `file_fallback` now remains truthfully `source_ineligible` on
  macOS, and reveal-audit rotation preserves valid row boundaries when an old
  oversized file has malformed/no-newline content;
- application version metadata and `NEWS.md` are unchanged because this package
  adds no user-visible Settings surface.

Open acceptance/review evidence, deliberately not claimed as complete:

- a real installed-app Touch ID/system-password and presenter-close trial with
  a disposable credential has not been run;
- the independent R3 reviewer gate has not been run. Until that review and the
  owner-run macOS trial are recorded, this document remains `active` and makes
  no release-readiness or installed-app acceptance claim.
