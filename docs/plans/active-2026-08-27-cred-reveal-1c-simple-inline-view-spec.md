# CRED-REVEAL-1C Simple Inline Credential View

Status: active implementation contract, activated on 2026-08-27 by the owner's
explicit instruction "不要什么Touch ID 了，简洁就行" after the owner-run macOS
trial of the CRED-REVEAL-1B flow failed: the LocalAuthentication dialog itself
tripped 1B's focused-window revalidation, so every View resolved `stale`
(forensic evidence: `credential_reveal_refused outcome:"stale"` rows in
`agent-credential-audit.jsonl` after successful OS verification, settings file
revision stable throughout). 1B's own open acceptance gate (section 7: real
installed-app Touch ID trial) therefore closed as rejected by the owner.

This package supersedes
`plans/active-2026-08-27-cred-reveal-1b-native-secure-view-spec.md` (1B). Where
1C and 1B disagree, 1C wins; 1B remains as historical evidence only.

Date: 2026-08-27

Change class: D3 — it deliberately returns a stored Provider credential across
Tauri IPC into the Settings WebView for inline display, reversing the
never-crosses-IPC boundary that 1B established.

Risk: R3 — a stored credential becomes WebView-renderable plaintext; a defect
or injected script could expose a Provider API key. The controls below bound
that exposure.

## 1. What Is Revoked From 1B

- Invariant 1 (no credential material crosses IPC/bindings): reversed. The
  reveal command's response now carries the plaintext value for display.
- Invariant 2 (fresh OS user-presence verification per view): revoked. There
  is no LocalAuthentication / biometric / OS password gate. The owner judged
  the Rho-owned encrypted vault (CRED-VAULT-1) plus an explicit click per view
  sufficient for the local single-user desktop threat model.
- Invariant 4 (focused-window admission and repeated focus revalidation):
  revoked. Window focus plays no role in the flow. This also removes the
  defect class that made 1B unusable.
- Invariant 7 (native in-process AppKit presenter owns the only plaintext):
  revoked. Display is inline in the Settings WebView (mask row toggles to
  plaintext), matching mainstream AI tools' eye-toggle convention.
- Invariant 8 (command pending until presenter close; outcome-only response):
  revoked. The command resolves once per call with outcome plus, on success,
  the value.
- Invariant 6 (blocking fail-closed reveal audit): revoked. Reveal audit
  returns to ordinary CRED-SEC4 best-effort semantics; an audit failure never
  blocks or leaks a view.
- The `agent_llm_reveal_platform` module tree, the `RevealSupport` seam, the
  presenter, and the `expected_revision` reveal-request field are removed.
  Revision/credential-generation revalidation is not part of this flow.

## 2. The 1C Flow

```text
mask row -> explicit View click per display ->
  agent_llm_view_credential(provider_id) ->
    provider exists? api_key_required? supported eligible source?
    -> fresh exact-source read (rho_vault file read+decrypt, or live
       session_only entry) every call, no cache, no preload
    -> best-effort credential_reveal audit row (bounded, no value)
  -> resolve { outcome: "revealed", credential }
           | { outcome: "credential_missing" | "store_unavailable"
                     | "source_ineligible", credential: null }
-> Settings renders the value inline in the API-key row and offers Hide
```

Invariants kept from 1B, restated for 1C:

1. Every view is independent and explicit: one click, one fresh read, one
   response. No ambient projection, auto-read on surface open, retained grant,
   preload, or background read. The runtime read-through cache stays untouched.
2. Source eligibility is exact with no fallback: `rho_vault` and `session_only`
   eligible; `environment` is rejected before its variable is read;
   out-of-vocabulary persisted sources fail closed as ineligible.
3. The response contains only `outcome` and `credential`; failures carry no
   store-layer detail. The best-effort audit row records provider ID, source,
   outcome, and time only — never the value, length, prefix, or suffix.
4. Rho adds no clipboard/copy affordance. The value renders as a React text
   node (never HTML), and the frontend clears it from state on Hide, window
   blur, navigation, provider switch, credential mutation, and unmount.
   User-initiated OS copy of displayed text is inherent to inline display and
   is accepted by the owner.
5. XSS honesty: inline display makes WebView script injection the residual
   exfiltration path. The existing CSP (no `eval`, no remote content) and the
   absence of any dynamic-HTML rendering of the value are the controls; no new
   markup, attribute, or log line may carry the value.
6. Settings bytes never change because a View happened; a failed first attempt
   leaves stored values unchanged.

## 3. Authorized Implementation

May change only:

- `desktop/src-tauri/src/agent_llm.rs`: replace the 1B reveal orchestration
  with the 1C flow, shrink the outcome vocabulary to
  `revealed | credential_missing | store_unavailable | source_ineligible`,
  drop `expected_revision` from the request, switch reveal audit to the
  best-effort helper, remove the `RevealSupport`/presenter/guard/focus
  machinery, and keep credential-generation tracking where mutation paths
  already advance it (harmless; no longer consulted by reveal);
- delete `desktop/src-tauri/src/agent_llm_reveal_platform/` and its
  registration in `main.rs`; narrow `desktop/src-tauri/Cargo.toml` if the
  LocalAuthentication/objc2 features are now unused;
- `desktop/src-tauri/src/commands/agent_llm.rs`: the command keeps the name
  `agent_llm_view_credential`, loses window/focus plumbing;
- generated `agent-settings` bindings and generator inputs, command
  inventory/digest metadata, contract fixtures;
- frontend `SettingsSurfaceView.tsx` (+ tests): the API-key row gains an
  inline View/Hide toggle; failure outcomes map to truthful messages;
- `transport/mock.ts`: browser-mock parity, returning a labelled mock value
  (never a real secret shape);
- the spec amendments listed below, and this handoff.

Explicitly out of scope: schema/migration edits, store format, resolver and
runtime read paths, any clipboard affordance, auto-reveal, application version
and `NEWS.md` (the View UX ships later with its own candidate decision),
docs/README.md (owned by the startup-progress lane; index update is recorded
as a follow-up), Windows/Linux-specific behavior.

## 4. Spec Amendments Made Concurrently

- `plans/active-2026-08-26-llm-credential-sources-and-store-hardening-spec.md`
  gains the CRED-REVEAL-1C amendment section revoking its 1B amendment rules.
- `plans/active-2026-08-05-system-credential-and-simple-llm-settings-spec.md`
  gains a pointer note: the Settings-facing reveal command's result now
  carries the value on success (1C), superseding its 1B outcome-only rule.
- `plans/active-2026-08-27-cred-reveal-1b-native-secure-view-spec.md` status
  records supersession by 1C.

## 5. Deterministic Verification

1. Rust: eligible-source happy path returns the exact sentinel once (fresh
   read per call, cache untouched); `environment` and unknown sources resolve
   `source_ineligible` before any read; missing entry resolves
   `credential_missing`; injected store error resolves `store_unavailable`;
   the audit row contains no sentinel and at most the allowed fields; no
   response/binding/log surface carries the sentinel except the single
   `credential` field on `revealed`.
2. UI: View toggles to inline plaintext and Hide restores the fixed mask;
   value clears on window blur, navigation, provider switch, and replace/add;
   failure outcomes map to truthful banners; mock parity holds.
3. Focused suites green, then `cargo test -p rho-desktop`,
   `cargo fmt --all -- --check`, binding freshness, command inventory/digest,
   and the RSR UI matrix (typecheck, lint, contract, vitest, build, browser
   smoke).
4. Owner acceptance: rebuilt debug app, View shows the saved key inline with
   no OS prompt; audit log gains a `credential_reveal` row.
