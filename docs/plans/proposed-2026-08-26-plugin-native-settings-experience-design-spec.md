# Provider-First Settings Experience Redesign

Status: proposed design contract, revision 3; the owner rejected the initial
route-first single-screen direction and then required repeatably revealable
saved API keys on 2026-08-26. The owner's `开始施工` instruction activated
CRED-REVEAL-1A through
`active-2026-08-26-cred-reveal-1a-connection-test-redaction-spec.md`, and the
owner's `继续开发` instruction of 2026-08-27 activated CRED-REVEAL-1B through
`active-2026-08-27-cred-reveal-1b-native-secure-view-spec.md`. That package was
subsequently narrowed by the owner to the current local Darwin/macOS
implementation; other native presenter platforms remain deferred. The owner's
subsequent rapid-iteration correction activated the bounded Provider-first UI
slice SETTINGS-UX2A through
`active-2026-08-26-settings-ux2-provider-flow-spec.md`. This broader Settings
document remains proposed; MODEL-AUTO-1 and the remaining SETTINGS-UX packages
are not active. SETTINGS-UX2A may consume the outcome-only reveal command and
the existing credential-save command only within its focused Connection flow.

Date: 2026-08-26

Change class: D3 because the target experience changes how Provider policy,
model preference, current route settings, credentials, model readiness, and
Settings navigation would be presented and eventually resolved

Risk: R3 because later implementation would replace or migrate the current
explicit route-selection authority and can affect credential selection,
Provider/model execution, persistence, recovery, destructive guards, and a new
explicit native secure-reveal path from credential storage to an OS-owned view

Package owned directly by this broader proposal: SETTINGS-DESIGN-3 only —
revise the information architecture, automatic-selection semantics,
progressive-disclosure flow, repeatable native credential-view flow, prototype,
and cross-review.

Separately active focused handoff: CRED-REVEAL-1A only — repair the backend
connection-test diagnostic boundary through
`active-2026-08-26-cred-reveal-1a-connection-test-redaction-spec.md`. It does not
activate any Settings UI or credential redisplay behavior in this proposal.

Implementation gate: this document stays `proposed-`. Any Settings UI,
credential redisplay, MODEL-AUTO-1, SETTINGS-UX1, or SETTINGS-UX2 implementation
requires its own bounded authorization and the relevant active CRED-UX and
Settings Surface amendments. Backend-only CRED-REVEAL-1A is activated solely by
its focused handoff and changes no Surface/UI authority. A visual approval alone
does not authorize automatic model selection or credential redisplay.

## 1. Owner Correction And Problem

The first design revision was still organized around internal system concepts:

- `Models / Connections / Components` were equal top-level modules;
- six typed capability routes were the primary Models interface;
- users were asked to understand which model served which capability; and
- route summaries, a model library, capacity fields, Provider state, models,
  Advanced controls, and Danger controls were co-rendered in large pages.

That direction exposed implementation structure instead of supporting the
owner's intended mental model. Users should configure Providers; Rho should
choose a usable model automatically. A user may express a preferred model, but
that is an optional secondary control rather than the organizing principle of
Settings.

The owner also rejected the `Connections` label and the permanent
master-detail workbench. The intended interaction is a sequence of small,
focused screens and dialogs reached through explicit buttons and Back actions.
Only information required for the current task is visible.

The owner subsequently required an API key saved by Rho to remain explicitly
viewable on later visits, using a masked credential row and an explicit View
action as the entry point. That direction intentionally replaces the previous
design target that a stored key is never redisplayed. It does not authorize an
ambient secret projection, automatic read, persistent plaintext field, secret
return to the WebView, or product-code change.

## 2. Goals

- Make `Providers` the default and dominant Settings surface.
- Remove capability-, route-, and Component-to-model assignment from the
  ordinary user interface.
- Let one backend-owned deterministic policy choose an eligible model from
  configured Providers when a typed operation starts.
- Keep a user-controlled preferred-model interface as a secondary soft
  preference with truthful fallback copy.
- Show Provider list, Provider overview, connection editing, model inventory,
  model options, automatic-selection policy, and destructive work as separate
  focused screens or sibling dialogs.
- Make every screen answer one question and expose one primary next action.
- Keep automatic behavior explainable through Provider readiness, effective
  preference, and actual Provider/model attribution after resolution.
- Let users repeatedly view an app-managed saved API key from the focused
  Connection flow without replacing it, while keeping plaintext inside a
  separately authorized OS-native secure presenter.
- Keep View API key, Replace, and Test connection as separate user actions with
  truthful source, authorization, close, denial, and store-failure states.
- Preserve Rho's light monochrome Studio language, semantic status words,
  compact density, small radii, flat rows, and floating-layer-only elevation.
- Define loading, empty, no-match, testing, cancelled, ready, warning, error,
  stale, partial-result, and recovery states before implementation.

## 3. Non-Goals

SETTINGS-DESIGN-3 does not authorize:

- React/CSS, Tauri, Rust, R, generated binding, mock, schema, migration,
  persistence, credential, or runtime edits;
- using Surface view state, a selected Provider row, or a frontend draft as
  model-selection authority;
- silent retry to another Provider/model after a request has started;
- prompt-text classification, background health polling, OAuth, account sync,
  project-scoped credentials, or a second settings store;
- automatic credential reads during Settings render, revealing environment
  variables, returning secret material through Tauri IPC/WebView/React/DOM/mock
  state, indefinite plaintext display, automatic clipboard copy, secret
  persistence in UI/view/browser state, or reuse of a previous View result;
- capability switches, task-to-model matrices, Component-to-model mappings, or
  a user-facing typed-route editor in the primary Settings flow;
- copying competitor dark palettes, large radii, nested card chrome, or
  product-specific labels; or
- release, signing, publication, installer, application version, or `NEWS.md`
  work.

## 4. Authority And Required Amendments

| Owner | Current authority | Required treatment |
| --- | --- | --- |
| `design/accepted-2026-08-21-plugin-native-surface-runtime-design.md` | Surface/Command identity, lifecycle, focus, layout, accessibility, bounded view state | retain the existing trusted singleton Surface; child screens are presentation state and dialogs use the accepted sibling-modal handoff |
| `plans/implemented-2026-08-26-plugin-native-settings-surface-spec.md` | current `models`/`components` registry, Models fallback, revision-safe Chat/capacity controls | a successor package must add `providers`, make it the default/fallback, retain `models` only as the secondary preference destination, and test restoration compatibility |
| `plans/active-2026-08-05-system-credential-and-simple-llm-settings-spec.md` | explicit typed-route persistence, route/model mutations, deterministic route resolution, exactly one credential, presentation-safe views, no credential value returned to UI, no silent fallback, Provider/model CRUD and tests | must be amended before implementation because automatic Provider-driven selection replaces the current user-visible route-first authority and CRED-REVEAL-1 would add one bounded native secure-reveal command whose Settings-facing result contains outcome only |
| `plans/active-2026-08-26-llm-credential-sources-and-store-hardening-spec.md` | credential-source truth, store behavior, overwrite/delete, redaction, audit, exact-source/no-downgrade rules, and stored-value-never-redisplayed policy | CRED-REVEAL-1 must explicitly amend the no-redisplay, direct store-read, fail-closed reveal-audit, native plaintext lifetime, redaction, and source-eligibility rules before any View implementation; all other source/no-downgrade rules remain unchanged |
| `design/active-2026-08-22-studio-design-language-and-ux-overhaul-design.md` | typography, tokens, spacing, radius, borders, elevation, responsive behavior | remains normative for every Settings screen and dialog |

The current `capability_routes` state is the sole runtime model-selection
authority. The proposed Provider policy and preferred-model control cannot be
added beside it as a second authority. Before product work, a separately
accepted CRED-UX package must define one revision-checked durable authority,
its schema, migration, resolver, attribution, deletion behavior, and recovery.

Existing multi-Provider route data is never collapsed by guessing a preferred
Provider from `agent.chat`, the currently selected card, or the first ready
Provider. Migration must preserve it losslessly as an explicit legacy override
or present an owner-approved resolution flow.

The current credential contracts remain the sole authority and continue to
forbid redisplay. A prototype may use only an unmistakable fixed non-secret
preview value inside a simulated system secure-view surface. Product work
requires one separately accepted CRED-REVEAL-1 amendment; the Provider-first UI
cannot independently read a credential through the existing runtime resolver,
presentation-safe settings view, generated binding, mock, or WebView IPC.

## 5. Automatic Selection Semantics

The design uses `Automatic selection` to mean deterministic pre-execution
resolution, not invisible failure fallback.

```text
typed operation starts
  -> read one revision-bound Provider policy snapshot
  -> consider enabled Providers in explicit preference order
  -> exclude unavailable credential/connection/model candidates
  -> evaluate compatibility from backend-owned model evidence
  -> apply the user's soft preferred model when it is eligible
  -> choose one Provider + model + exact credential source
  -> bind that choice for the operation
```

- Users configure which Providers may be used and their preference order.
- Users do not assign models to Chat, Act, vision, image, embedding, a
  Component, or any other internal consumer.
- `Automatic` is the default model preference.
- `Prefer a model` is a soft preference. The preferred model is used only when
  it is eligible for the current operation; otherwise Rho chooses another
  eligible model and records what it used.
- Once an operation begins, Rho does not silently retry another model,
  Provider, or credential source. Provider errors, timeouts, incompatibility,
  and missing credentials fail truthfully on the resolved choice.
- The actual Provider/model used remains visible in operation attribution and
  diagnostics. Settings does not need a permanent capability assignment table
  to make automatic behavior inspectable.
- Provider ordering and model preference do not live in layout/view state.
  They belong to the single future backend settings authority and every write
  is revision checked.

Any later cross-Provider retry or health-based failover requires its own D3/R3
policy, user-facing attribution, cooldown/stability rules, failure injection,
and explicit authorization.

## 6. Target Information Architecture

The visible primary navigation contains two concepts:

```text
Settings
├── Providers    default; services Rho may use automatically
└── Components   read-only trusted application/project catalog
```

`Model preferences` is a secondary screen reached from Providers. It is not a
peer primary module in the navigation rail.

The successor router recognizes these stable presentation destinations:

```text
providers   primary Provider overview and child screens
models      compatibility ID for the secondary Model preferences screen
components  existing read-only catalog
```

`providers` becomes the default/fallback only after the MODEL-AUTO-1 integration
and acceptance gate in Section 11 is satisfied. The existing `models` ID is
retained so restored instances and old entry points do not break, but it renders
the focused Model preferences child screen with a visible `Back to Providers`
action. No shipped `connections` ID exists, so the rejected name is not
introduced. Unknown/malformed state falls back to `providers` only after that
same acceptance gate.

Only the stable destination ID may be retained in Surface view state. Selected
Provider/model IDs, credentials, drafts, test results, navigation stacks, and
automatic-policy snapshots are not layout state. Reopening a Provider child
screen may safely return to the Providers overview.

## 7. Progressive-Disclosure Screen Flow

```text
Providers overview
├── Add provider -> Choose -> Connection -> Test/models -> Review
├── Automatic selection -> Provider enable/order
├── Model preferences -> Automatic | Prefer a model
└── Provider row -> Provider overview
    ├── Connection -> focused child screen
    │   ├── View saved key in native secure presenter
    │   └── Add API key | Replace API key -> focused child screen
    ├── Available models -> model list -> Model options dialog
    ├── Advanced -> focused child screen
    └── Remove provider -> separate confirmation dialog
```

Provider list and Provider detail are never permanently shown side by side.
Connection fields, model inventory, model options, Advanced controls, and
Danger controls are never expanded together.

### 7.1 Providers Overview

The default screen answers: **which services may Rho use?**

```text
Providers                                    Add provider
Connect services Rho may use. Models are chosen automatically.

Anthropic               Ready · 8 models · Automatic use on       >
Ollama Local            Ready · 3 models · Automatic use on       >
Archive API             Needs attention · key missing       Repair >

Automatic selection     2 ready Providers              Manage >
Model preference        Automatic                      Change >
```

- Each Provider row shows display name, kind, readiness word, model count, and
  whether it participates in automatic selection.
- A dot may reinforce a status but never replaces its word.
- `Add provider` is the only primary action.
- Provider rows precede the Automatic selection and Model preference controls,
  so configuring services remains the page's primary task.
- Automatic selection and Model preference are compact secondary navigation
  rows, not dashboards or model matrices.
- Provider search appears only when the list crosses the reviewed density
  threshold; it is not permanent chrome for a short list.
- The empty state contains one action: `Add provider`.

### 7.2 Provider Overview

The Provider screen answers: **is this Provider ready and where do I change one
part of it?**

```text
< Providers

Anthropic                                            Ready
Used automatically                                      On

Connection     System store · Custom endpoint          Open >
Models         8 available · selected automatically    View >
Advanced       Endpoint and request behavior            Open >
```

- The page is a summary plus navigation. It is not an editing form.
- Network testing lives inside the focused Connection child screen, alongside
  its truthful working, Cancel, ready, and actionable failure states.
- Automatic-use enablement is Provider policy; it is not inferred from card
  selection or connection readiness.
- Remove Provider is reachable only through Advanced/Danger and remains
  separated from Test, credential Save, model editing, and preference changes.

### 7.3 Connection And Credential Screens

Repeatable View makes connection review, credential viewing/replacement, and
network testing distinct tasks. `Connection` therefore becomes a focused child
screen rather than a growing edit dialog:

```text
< Anthropic
Connection

Endpoint
https://api.anthropic.com                              Edit >

Credential
API key · Stored in System Store
••••••••••••••••
View API key    Replace
Each view requires system verification.

Connection status
Ready · Checked 2 minutes ago
Test connection
```

- The mask has a fixed length and never encodes the value's real length, prefix,
  suffix, or format.
- `View API key` and `Replace` are visible text actions; an eye icon may
  reinforce but never replace the View label.
- `Test connection` remains a separate real Provider request and never reveals,
  replaces, or saves a credential.
- Endpoint editing remains a separate focused task. View does not turn the
  Connection summary into a general editing form.
- No second WebView/Rho modal opens over Connection. User verification and the
  plaintext presenter are operating-system owned; Settings stays masked.
- A required but missing app-managed credential uses the same Connection
  structure with status `Missing`, no mask or View action, and one visible
  `Add API key` action. Saved state shows the fixed mask plus View and Replace;
  the UI never uses Replace copy for a first save.

#### 7.3.1 Repeatable Native Secure View

The Settings-facing state machine is:

```text
stored_hidden
  -> View API key -> authorizing -> native_presenter_open
                                 \-> cancelled | denied | source_ineligible
                                  \-> auth_unavailable | credential_missing
                                   \-> store_unavailable | stale
                                    \-> audit_unavailable | presenter_unavailable

native_presenter_open
  -> Close | Escape | focus loss | app quit
  -> clear Rho-owned plaintext -> closed_after_display -> stored_hidden
```

- Every View is a new explicit user action, fresh OS user-presence check, and
  fresh exact-source read. Rho does not preload the key when Settings opens,
  retain a reveal grant, or reuse a previous read.
- While authorizing, the Settings mask remains visible, the action reads
  `Verifying...`, duplicate requests are disabled, and no secret is announced.
- Admission order is fixed: focused main window plus Provider/source/revision/
  credential-generation check, OS-owned user verification, repeated focus and
  authority validation, exact current-source read, fail-closed reveal audit,
  final focus/authority validation, then native display.
- The native presenter owns Close, Escape, focus-loss, and app-quit clearing.
  Plaintext never enters a Settings view, Tauri response, generated binding,
  React state, DOM/ARIA tree, mock payload, browser storage, or view state.
- The command remains pending while the native presenter is open and completes
  only after presenter close plus Rho-owned-buffer clearing. Settings receives
  only one terminal non-secret result: `closed_after_display`, `cancelled`,
  `denied`, `source_ineligible`, `auth_unavailable`, `credential_missing`,
  `store_unavailable`, `stale`, `audit_unavailable`, or
  `presenter_unavailable`. Explicit Close/Escape may restore View focus when Rho
  is still active; app focus loss, navigation, and close never steal focus back.
  Status copy remains bounded and contains no backend details, fragments, or
  source fallback.
- The first package has no Copy action, no persistent authorization grant, and
  no `confirmed: true` shortcut from frontend code. OS verification unavailable
  means no store read and no display.
- `credential_reveal_authorized` is a secret-egress audit event and must be
  written successfully before native display. Unlike ordinary non-blocking
  credential-access audit, audit failure here zeroizes the Rho-owned read buffer and fails
  closed. The event contains Provider ID, source, outcome, and time only. The
  future amendment must define a blocking append plus flush/durability boundary,
  serialized rotation, partial-write/truncation recovery, and fail-closed disk-
  full, permission, append, rotation, flush, and sync failures; ordinary
  best-effort CRED-SEC4 audit semantics do not satisfy this gate.

Source eligibility is exact:

| Credential source | View behavior |
| --- | --- |
| `system_store` | conditionally eligible after approved OS-owned user verification; use a fresh direct keyring read, never the runtime read-through cache |
| `session_only` | conditionally eligible only while the current zeroizing in-memory entry exists; never survives restart and still requires fresh verification |
| `file_fallback` | excluded from the first package; its path identity, no-follow, ownership, permission, size, redaction, and platform-auth rules require a later gate |
| `environment` | never revealable because Rho does not own or persist the value; reject before reading it and show only the variable name/detected state |

`not_required` is an effective key-requirement/status outcome, not a persisted
credential source. When a Provider does not require a key, View and Replace are
absent. When an eligible app-managed source is configured but its value is
missing, Connection shows `Missing` plus `Add API key`; it never labels the
state `Not required`. Unknown source/status values fail closed as a bounded
configuration error.

There is no fallback between sources. A failed system-store View never probes
the session cache, environment, or file fallback. A source change invalidates an
in-flight View; the command never searches orphaned credentials from an older
source. The source-change contract must separately define whether an old
app-managed value is retained or deleted, how that choice is confirmed, and how
failure recovers; the UI never implies that changing metadata moved the secret.

One per-Provider credential-operation guard spans initial admission through
presenter close and clearing. Every Rho-owned set, replace, delete, source
change, and Provider removal advances a credential-generation token and cannot
interleave with that guard. View revalidates focused-window identity, Provider,
source, settings revision, and credential generation after authentication,
after read, after audit, and immediately before display. Any mismatch clears
the snapshot and returns `stale`; injected race tests cover focus loss, replace,
delete, source switch, and Provider removal at every boundary.

The first native presenter is in-process and does not pass the secret through a
helper process, argv, environment, stdin, clipboard, drag service, title,
window metadata, diagnostic, or crash context. It disables selection, keyboard
copy, context menus, and drag/services. The native value may be exposed to the
OS accessibility API only while open and only when the authenticated user
focuses it; it is never an automatic announcement. Platform contracts must
verify these controls rather than assuming common widget defaults.

The authenticated user can still photograph or screen-capture the display, and
the native GUI/OS or assistive technology may create transient memory copies;
CRED-REVEAL-1 records these as residual risks and claims deterministic clearing
only for Rho-owned buffers. OS-owned copies receive platform-specific
best-effort close behavior, not a false zeroization guarantee.

#### 7.3.2 Add Or Replace API Key

`Add API key` and `Replace` open the same mode-aware child-screen structure,
not a nested modal. Missing state uses the heading `Add API key`, an empty
`New API key` field, and the primary action `Save API key`. Saved state uses
`Replace API key` for both heading and primary action; the existing key remains
active until the replacement is stored successfully.

- Entering Add or Replace first closes any native presenter and clears its
  plaintext.
- The new-key field starts empty, uses `autocomplete=new-password`, and may
  locally show/hide only the unsaved draft.
- Cancel, Back, Provider change, window/app blur, and Settings close clear the
  draft. The draft never becomes view state or durable metadata.
- A first save succeeds only after the authoritative returned view reports the
  credential stored. It clears the draft and returns to Connection with
  `Saved`, the fixed mask, View and Replace actions, and connection state
  `Not tested`. It does not test the connection, enable automatic use, or claim
  readiness.
- Successful replacement clears the draft and returns to Connection with the
  fixed mask and `API key replaced`; it likewise leaves the connection in its
  truthful untested or previously tested state rather than testing implicitly.
- Validation rejection, store failure, and uncertain outcome never claim Add
  or Replace success. In every failure path the password input clears and the
  UI reloads the authoritative presentation-safe view. A failed first save
  remains `Missing` with `Add API key`; a failed replacement preserves the
  prior saved mask, View, and Replace state. A bounded redacted error and Retry
  path remain visible, and retry requires re-entry of the key.
- Replacement preserves the active overwrite-confirmation contract and never
  echoes either old or new values. The existing key remains unchanged unless
  the authoritative store write completed, preserving the current
  transactional overwrite contract.

### 7.4 Available Models

The model inventory is a separate child screen:

```text
< Anthropic
Available models                                  Refresh

Research Large                 Available                   >
Research Small                 Available                   >
Vision Review                  Unavailable                 >

Add model manually
```

- Rows show identity and readiness, not which capability or Component uses the
  model.
- Clicking a row opens a focused Model options dialog for reviewed identity,
  context/output metadata, enablement, and diagnostic provenance.
- Capability evidence may be used internally by the resolver but is not a set
  of user assignment switches.
- Importing, enabling, or editing a model does not create a visible task map.

### 7.5 Model Preferences

The secondary preference screen contains one choice:

```text
< Providers
Model preference

(*) Automatic
    Let Rho choose an eligible model from enabled Providers.

( ) Prefer a model
    Use this model when appropriate. Rho may choose another eligible model.
    [Model selector appears only after selection]
```

- The default is `Automatic`.
- The selector discloses only after `Prefer a model` is chosen.
- The choice is global soft preference, not a per-task, per-capability, or
  per-Component mapping.
- Unavailable/ineligible preferences remain visible with an explanation and a
  deterministic automatic result; the UI never pretends they were used.

### 7.6 Automatic Selection

This secondary screen manages Providers rather than model routes:

```text
< Providers
Automatic selection

1  Anthropic      Ready              Enabled
2  Ollama Local   Ready              Enabled
3  Archive API    Needs attention    Disabled
```

- Users enable/exclude Providers and set a stable preference order.
- Reordering is keyboard accessible and uses labeled `Move up`/`Move down`
  actions in addition to any drag gesture.
- The screen does not show a capability matrix or model assignments.
- A disabled/unready Provider links to its focused repair screen.

### 7.7 Add Provider

The guided flow uses four small steps:

```text
Choose Provider -> Connection -> Test and discover -> Review and enable
```

- Each step shows only the fields and result needed to continue.
- Failure stays on the responsible step with a safe retry.
- The final review shows Provider identity, credential status, discovered model
  count, and automatic-use state. It does not require choosing a default model.
- Durable partial results use warning copy and the existing recovery contract;
  they are never reported as full success.

### 7.8 Components

Components remains a quiet read-only catalog grouped by Rho application and
active project. It shows label, purpose, scope, instance policy, Surface ID,
and origin. It never shows a Provider/model assignment and offers no component
enable/install/lifecycle control.

## 8. Visual And Interaction System

- Light paper/panel/canvas surfaces and ink hierarchy remain normative.
- Controls use 3px radius; screens/dialogs use at most 6px.
- Docked content has no shadow; only a real dialog/menu uses the one floating
  shadow.
- Spacing uses the Studio 2/4/8/12/16/24/32px scale.
- Repeated Providers/models/components are flat rows with dividers, not cards.
- Ordinary content is 12–13px and titles 15–17px.
- One high-emphasis action exists per screen or dialog action group.
- Back, Cancel, Save, Test, Retry, Repair, View, Edit, and Open use stable
  task-specific labels.
- Navigation changes one focused screen at a time. It does not create nested
  scrolling master-detail columns.
- At narrow width the primary rail becomes a horizontal Providers/Components
  tab row; child screens retain Back. There is no horizontal page scroll.

## 9. State, Feedback, And Accessibility

Every operation projects one local state:

```text
idle | working | success | warning | error
```

- Working states name the operation and prevent duplicate submission.
- Success appears only after the returned authoritative view is rendered.
- Stale/failure reloads durable truth; reload failure keeps a bounded error and
  Retry visible.
- Deterministic fixtures cover no Providers, no models, no search match,
  unavailable preference, missing credential, testing/cancelled/failed,
  discovery partial result, View authorizing/native-open/closed-after-display/
  cancelled/denied/source-ineligible/auth-unavailable/credential-missing/store-
  unavailable/audit-unavailable/presenter-unavailable/stale states, first-save
  success to `Saved` plus `Not tested`, first-save validation/store/uncertain
  recovery back to `Missing`, replacement success/rejection/store/uncertain
  recovery with the prior saved key preserved, stale write, reload failure,
  and project switch.
- The Settings root remains an ordinary trusted Surface, not a modal.
- Model options, Add Provider, and confirmation use sibling modal roots. Exactly
  one is rendered with `role=dialog`/`aria-modal=true`. Connection and Replace
  API key are ordinary child screens and never open a nested Rho modal.
- Dialog open moves focus to its heading/first invalid field; close restores
  the exact trigger; Escape closes only the active dialog.
- Child-screen Back restores the originating row/button when it still exists.
- Status never depends on color alone. Ordinary text reaches 4.5:1 contrast.
- Keyboard order follows visual task order. Provider reordering has labeled
  keyboard controls. At 200% zoom no action, status, Back path, or error clips.

## 10. Content And Security Fixtures

Use realistic long Provider/model names, long model IDs/Base URLs, mixed
CJK/ASCII text, ready/missing/unavailable/disabled states, multiple similarly
named models, and bounded redacted failures.

No mock, screenshot, DOM attribute, browser storage, diagnostic, log, audit
event, or visual review evidence contains a real credential, credential
fragment, or secret-bearing endpoint. The prototype's simulated native secure
presenter uses the fixed literal `DEMO VALUE - NOT A SECRET`, never a
token-shaped string; this DOM-only design fixture is not the product transport
contract. Review screenshots are captured only while Settings remains masked
and the simulated presenter is closed. Password drafts and native plaintext
buffers clear on every owner-defined boundary.

## 11. Proposed Work Packages

### SETTINGS-DESIGN-3 — current authorized package

Revise this contract, the interactive design, and cross-review. Mandatory
stop: owner reviews Providers-first navigation, automatic-selection semantics,
secondary model preference, progressive disclosure, repeatable native secure
View, source eligibility, and Rho visual character.

No product code, version, `NEWS.md`, candidate, or release decision.

### CRED-REVEAL-1 — required future credential-security package

Amend CRED-UX/CRED-SEC to add one explicit, user-triggered native secure-reveal
flow and no ambient secret projection. Its Settings-facing command validates a
stable Provider ID, exact source, expected settings revision, credential
generation, focused main window, one per-Provider credential-operation guard,
and one in-flight presenter; performs OS-owned user verification and a fresh
direct read; writes the durable reveal audit; then invokes the native presenter.
The command remains pending until native close and Rho-buffer clearing, then
returns only the terminal non-secret outcomes defined in 7.3.1. It never returns
a secret/settings view, calls the automatic runtime resolver, accepts a
frontend confirmation flag, changes a credential source, or silently falls
back.

CRED-REVEAL-1 is implemented only through two separately reviewed checkpoints:

1. `CRED-REVEAL-1A` repairs connection-test error redaction. Today a credential-
   injected R subprocess may return raw stderr to the frontend; a bounded
   redactor plus sentinel regression is mandatory. This checkpoint exposes no
   View action and stops for contract review and acceptance. It is active only
   through `active-2026-08-26-cred-reveal-1a-connection-test-redaction-spec.md`.
2. `CRED-REVEAL-1B` may expose View only after 1A is accepted, and owns native
   verification, direct read, locking/generation, durable pre-display audit,
   presenter, typed outcomes, clearing, and platform acceptance.

The reveal contract must define per-platform user-presence behavior, main/
focused-window admission and revalidation, reauthentication for every View,
settings-revision/credential-generation checks at every boundary, native
presenter lifetime and Rho-owned-buffer clearing, cancellation, concurrent
duplicate rejection, exact-source store errors, source transitions, and the
durable fail-closed `credential_reveal_authorized` audit written before display.
System-store View uses a fresh direct keyring read rather than the Agent runtime
cache. Session-only reads only its current zeroizing entry. Environment rejects
before read; file fallback is ineligible in the first package. `not_required`
remains a key-requirement/status outcome and never joins the source enum.

Mandatory evidence includes allow/deny/cancel/auth-unavailable/store-unavailable
cases and exact typed results; inactive/wrong window, stale revision/generation,
concurrent duplicate, and focus loss/replace/delete/source switch/Provider
removal injected before auth, after auth, after read, after audit, and before
display; exact-source get counts and no fallback; fresh system-store replacement
versus stale cache; session delete/source-switch/restart behavior; environment
rejection before read; fail-closed blocking append/rotation/flush/sync audit
failures plus exact-once attempt/outcome events; two-Provider isolation; repeated
fresh-auth View cycles; native presenter creation failure and Close/Escape/
focus-loss/app-quit clearing; disabled selection/copy/context-menu/drag/service
channels; no helper-process secret transport; no secret field in commands,
generated bindings, settings JSON, mock history, WebView/DOM/ARIA/browser state,
logs/errors/toasts/diagnostics/crash/startup logs/R output/screenshots; connection
test sentinel redaction; replacement success/failure/uncertain recovery; and
exact-platform installed-app acceptance with disposable credentials.

### MODEL-AUTO-1 — required future CRED-UX policy package

Define the single durable Provider-policy/model-preference authority, schema,
lossless legacy-route migration, deterministic resolver, exact credential
selection, attribution, deletion behavior, stale handling, persistence, and
recovery. This is D3/R3 and requires separate owner activation plus amendment
of CRED-UX before any automatic behavior ships.

Mandatory evidence includes mixed two-Provider legacy routes, no guessed
migration, preferred-model eligible/ineligible/unavailable cases, exactly one
credential injection, no prompt inference, no post-start silent retry, stale
revision, persistence/reopen, Provider/model deletion, redaction, and failure
injection.

### SETTINGS-UX1 — required future Settings successor package

Add the `providers` destination, make Providers the reviewed default/fallback,
retain `models` as the secondary preference destination, implement focused
child-screen navigation, and preserve Components isolation. This package may
not switch the default/fallback or hide the still-authoritative route editor
until MODEL-AUTO-1 is implemented, fully verified, integrated, contract-reviewed,
and accepted. If both packages land through one integration package, the old
route UI remains reachable until the new resolver, lossless migration, and
persistence pass acceptance together at the same checked-in integration
boundary; only then may Providers become the default/fallback.

Mandatory evidence includes old `models` restoration, new `providers`
restoration/fallback, Back/focus behavior, normal/narrow/200%-zoom views, all
empty/error states, missing-key Add mode, saved-key Replace mode, singleton
focus/restore, browser/mock parity, real debug-app acceptance, Workspace/Agent
health, version/NEWS decision, and complete affected validation.

### SETTINGS-UX2 — Provider management integration

Integrate already-owned Provider/model/credential/test/discovery/destructive
workflows into the focused Provider child screens. It requires a two-way
CRED-UX/CRED-SEC amendment; Connection may expose View API key only after
CRED-REVEAL-1 is implemented and accepted. It retains every transient
credential, network, cancellation, partial-result, redaction, restart, and
recovery gate.

## 12. Design Verification

SETTINGS-DESIGN-3 requires:

- interactive inspection of Providers overview, Provider detail, Connection,
  models, preferences, automatic selection, Add Provider, and Components;
- 1024px, 736px, and 360px layout review with no horizontal overflow;
- keyboard navigation, Back/focus, dialog focus, progressive disclosure,
  validation, working/cancel/error, and no-match checks;
- repeated View, authorizing, native-presenter Close/Escape/focus clearing,
  pending-authorization app-hidden cancellation, source-ineligible,
  denial/store-failure, replacement, exact focus restoration, and fixed-mask
  checks using only the literal non-secret preview;
- missing-key Add mode with `Save API key`, authoritative success returning to
  `Saved` plus `Not tested`, and validation/store/uncertain recovery remaining
  `Missing`; saved-key Replace success/failure/uncertain recovery must preserve
  the prior-key truth and never reuse Add copy;
- explicit inspection that no capability/task/Component-to-model map remains;
- cross-review against Surface Runtime, SETTINGS-PLUG-1, CRED-UX, CRED-SEC, and
  Studio design language;
- local path/link validation, lane validation, and `git diff --check`; and
- no product-code, version, NEWS, test-pass, candidate, or release claim.

## 13. Version, Documentation, And Release Impact

This design revision changes only proposed documentation and an external
review design. It has no application/R-package version impact and no
`NEWS.md`, candidate, installer, signing, publication, or release decision.

The first reviewed user-visible implementation entering a distributable
development candidate requires synchronized application version metadata and
`NEWS.md`. R package versions remain independent.

## 14. Owner Review Decisions

The revised package asks the owner to confirm:

1. `Providers` is the default primary surface and `Connections` is retired;
2. capability/Component-to-model assignment is absent from the user interface;
3. automatic selection resolves once before each operation and does not silently
   retry another Provider/model after start;
4. Model preference is a secondary global soft preference;
5. Provider list, Provider overview, connection, model inventory/options,
   automatic selection, Advanced/Danger, and Add Provider are separate focused
   screens/dialogs; and
6. route-UI replacement and the Providers default/fallback remain blocked until
   MODEL-AUTO-1 is implemented, integrated, contract-reviewed, and accepted, or
   until a same-boundary integration proves the resolver, lossless migration,
   persistence, and Settings successor together while the old route UI remains
   reachable through that acceptance boundary;
7. Rho-managed saved API keys are repeatedly viewable only through explicit
   `View API key`, fresh OS verification, exact-source reads, fail-closed audit,
   an OS-native presenter with Rho-owned-buffer clearing, no WebView/IPC secret
   return, no source
   fallback, and no clipboard action in the initial package;
8. environment-sourced values remain non-revealable, and product code remains
   blocked until CRED-REVEAL-1 amends and satisfies the active credential
   security, redaction, audit, platform, and recovery gates.
