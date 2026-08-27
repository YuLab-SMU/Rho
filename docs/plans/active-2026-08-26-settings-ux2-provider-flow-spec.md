# Provider-First Settings UI — SETTINGS-UX2A

Status: active implementation contract

Date: 2026-08-26

Authorization: after reviewing the rebuilt application and finding no visible
frontend change, the owner explicitly requested: “重新快速开发迭代，注意不要又跑偏了”.
This activates only the bounded visible Settings slice below.

Change class: D3 because the Settings information architecture changes from a
route/model-first page to Provider-first progressive disclosure.

Risk: R3 because the focused Connection screen accepts credential drafts and
invokes the separately authorized native secure reveal command.

## 2026-08-26 Provider Feedback Loop Amendment

The owner rejected the sparse, display-only Provider page and the extra API-key
child screen. This amendment supersedes the child-screen and static-inventory
requirements below.

- Add and Replace edit the API key inline on the Provider page; save and cancel
  never navigate away.
- Saving a key immediately performs bounded Provider model discovery and then
  connection-tests the configured enabled language models. The page reports
  whether the credential was accepted, the latest latency, and check time.
- Opening a Provider with a detected credential automatically refreshes the
  remote model list. A visible Refresh action allows an explicit retry.
- The model list merges configured and remotely discovered models. Configured
  rows expose last-test availability, latency, checked time, and an explicit
  Test action; remote-only rows are labelled as available from the Provider.
- The backend presentation projects the effective Base URL and whether it came
  from an explicit value, an environment variable, or the reviewed Provider
  default. Provider default must never be rendered as an unexplained blank.
- The layout uses token-backed grouped surfaces, varied spacing, compact health
  facts, and readable line lengths. It must not become one undifferentiated
  divided list or a grid of decorative equal-weight cards.

### Defect corrections

- Automatic discovery runs once per Provider-page entry. Model test persistence
  must not retrigger discovery or cascade through every untested model.
- At most one configured model is automatically tested per page entry. Manual
  Test remains explicit per model.
- View reloads presentation-safe settings immediately before invoking the
  revision-bound reveal command, preventing background validation from making
  the action stale.
- Every configured model row has inline progressive Details containing model
  identity, type, enabled/selected state, context/output limits, capabilities,
  and complete latest-test presentation. Details do not navigate away.

### 2026-08-26 Model-metadata truthfulness correction

The owner rejected presentation of internal safety fallbacks as though they
were model specifications: “什么保守默认，你少保守默认。不要默认假信息。” This
authorizes a bounded D1/R1 presentation correction.

- `conservative_default` context and output values remain internal runtime
  safety limits. Model Details must not render their numeric values as model
  capacity. It states that the Provider did not report capacity instead.
- Capability values are model facts only when their provenance is Provider
  response evidence or the reviewed Rho/aisdk catalog. `user_declared` values
  are labelled unverified local metadata and are presented as Unknown, not as
  Provider facts.
- The capabilities block is titled as evidence, not `Provider metadata`, and
  source labels use user-facing evidence language rather than raw persistence
  enums.
- Connection status, measured latency and check time remain test evidence and
  are unaffected. This correction does not rewrite persisted profiles or alter
  the runtime resolver in this work package.

CRED-VAULT-1 supersedes the app-managed `system_store` presentation in this
slice with `rho_vault` plus create/unlock states. This UI may collect only the
transient vault-password inputs authorized there.

## 1. Outcome

The trusted Settings Surface opens on `Providers`, with `Components` as the
only other primary module. Provider rows lead to one focused Provider screen.
That screen keeps the Provider's endpoint, credential controls, and model
inventory together because they describe one service and are commonly reviewed
as one task. It never renders a stored credential value.

Saved app-managed credentials show a fixed-length mask plus explicit
`View API key` and `Replace` actions. Missing app-managed credentials show only
`Add API key`. View invokes CRED-REVEAL-1B and receives only its terminal
outcome. Add/Replace uses an empty local password draft, clears it on Back,
Cancel, blur, unmount, success, and failure, and reloads authoritative settings
after uncertain failures. The old key remains active until replacement
succeeds.

## 2. Authorized UI And Transport Slice

- Replace the visible Models-first Settings module with Providers-first
  progressive screens in `desktop/ui/src/app/SettingsSurfaceView.tsx`.
- Keep `providers` and `components` as the only primary module IDs; legacy
  `models` view state restores safely to `providers`.
- Hide Chat assignment, capability routes, and context-capacity editing from
  the primary Settings experience. This slice does not change their existing
  backend authority or claim automatic-selection backend work.
- Provider overview is a flat divided list. A Provider detail is one coherent
  page containing compact Connection, Credential, and Models sections. Add or
  Replace API key remains a focused child screen because it owns a transient
  secret draft; ordinary review never requires another navigation step.
- Add the already-existing revision-safe `agent_llm_set_credential` command to
  the generated Agent Settings transport. Its input may contain the transient
  draft; no output/binding/mock field may contain a credential value.
- Use only existing design tokens in `desktop/ui/src/styles/surfaces.css`.
- Amend focused tests, binding guards, mock parity, the broader proposed design
  record, cross-review, and documentation index.

No Provider/model schema, migration, runtime resolver, model-selection policy,
credential store semantics, native presenter, application version, `NEWS.md`,
installer, or other platform implementation is authorized in this iteration.

## 3. Interaction Contract

```text
Providers
  -> Provider
       -> View API key -> Verifying… -> bounded outcome
       -> Add API key | Replace -> focused draft screen -> Save | Cancel
```

- Navigation changes from the Provider list to one complete Provider page and
  always offers a named Back action. Endpoint, credential, and model inventory
  for that Provider are not fragmented into extra child pages.
- The mask is the fixed literal `••••••••••••••••`; it never reflects key
  length, prefix, suffix, or format.
- `system_store` and `session_only` may expose View/Add/Replace according to
  projected status. `environment`, `file_fallback`, unknown, and not-required
  sources never expose a saved-value View.
- While View is pending the mask stays visible, the button reads
  `Verifying…`, and duplicates are disabled.
- Terminal reveal outcomes map to bounded user copy; no backend error detail or
  secret fragment enters the DOM, ARIA, view state, mock, log, or screenshot.
- Credential Save success is accepted only from the returned authoritative
  settings view. Rejection/stale/failure clears the draft and reloads durable
  truth before offering Retry.
- Provider A local navigation/draft/reveal state never changes Provider B.

## 4. Acceptance And Rapid Iteration Gate

Focused tests cover default/fallback Providers navigation, one complete
Provider page, fixed mask, reveal pending/outcome/duplicate behavior,
missing Add state, Add and Replace success, validation/stale failure reload,
draft clearing, environment exclusion, two-Provider isolation, Components
project isolation, and absence of capability-route/credential plaintext UI.

For the owner's rapid review, run generated binding freshness, TypeScript,
Settings focused tests through `rsr:quick`, production frontend build, and
launch the exact current debug binary. Do not claim full completion. After the
owner accepts the visual/interaction direction, freeze the slice, run the full
Rust/RSR matrix, complete installed-app credential interaction acceptance,
perform the independent R3 review, and then decide version/`NEWS.md` impact.

## 2026-08-27 SETTINGS-UX2B Model Add/Edit Amendment

The owner reviewed the master-detail Providers UI and instructed: “新的模型没法
添加，有的信息需要能编辑”, with reference screenshots of capability/context-
window editing dialogs. This amendment authorizes one bounded model add/edit
slice. Change class D2 (durable model-metadata mutations through mostly
existing backend authorities plus one new capability-declaration command).
Risk R3 (settings state mutations); every mutation below gets success,
rejection/stale, failure, and recovery test coverage.

### Add model

- Remote-only discovered rows gain an explicit `Add` action. Add persists a
  configured model whose internal id derives from the provider-side model id,
  whose type/capability evidence is exactly the discovered (catalog-enriched)
  evidence with its provenance preserved, `enabled`, internal conservative
  capacity (never rendered as model capacity, per the truthfulness
  correction), and no route assignment. Importing never assigns uses.
- `Enter a model ID manually` is a collapsed disclosure inside the Models
  section, opened automatically when discovery is unsupported, empty, or
  failed. Manual add persists honest unknown evidence (type and every
  capability `unknown`, source `unknown`); no value is fabricated.
- The already-registered `agent_llm_save_model` command gains specta export,
  generated bindings, transport facade, and mock parity.

### Edit configured model

A modal `Model options` dialog opened from the configured model's detail page
(owner direction 2026-08-27: match the mainstream Model Options dialog —
capability toggles with auto/declared markers, side-by-side capacity inputs,
one batched Save, Cancel discards):

- Display name and model ID through `agent_llm_save_model`; model type and
  capability evidence stay immutable through that command, matching its
  existing guard.
- Enabled toggle through the same command; the backend route-guard message is
  surfaced verbatim and the previous durable state is reloaded on rejection.
- Context window and maximum output through the existing revision-safe
  `agent_llm_set_context_capacity` (provenance `user_declared`). Catalog
  capacity values remain presentation-only and are never persisted by this UI;
  only explicit user declarations become execution inputs.
- Capability declarations through one new bounded command
  `agent_llm_declare_model_capability { model_id, expected_revision,
  capability, value }`: capability is one of the nine pinned attributes or
  `model_type`; value is `yes|no|unknown` for attributes and
  `language|embedding|image|unknown` for type. The declaration sets exactly
  the named attribute with provenance `user_declared` and nothing else.
  Stale revision, unknown model, and out-of-vocabulary inputs reject with
  truthful messages; the UI reloads durable truth after stale/failure.
- Declared-evidence presentation refines the 2026-08-26 truthfulness
  correction: a `user_declared` value renders as the declared value labelled
  `Unverified local metadata` — honest about both the claim and its
  unverified provenance, never masquerading as Provider or catalog evidence.
  Routing authority is unchanged.

### Delete model

`agent_llm_delete_model` gains specta export, facade, and mock parity. The
model detail page exposes an explicit confirmed destructive Delete; the
route-guard rejection is surfaced and durable truth reloaded.

Remote (not yet added) models stay read-only except `Add`.

### Out of scope

Provider options/JSON passthrough, reset-to-catalog-evidence, route
assignment UI, Provider add/edit/delete UI, persisting catalog capacity,
`agent_llm_save_model`'s existing revision-free upsert semantics, application
version/`NEWS.md`, and the lane-owned documentation index/cross-review
(recorded as integration follow-ups).

### Verification

Rust: declaration add/replace/stale/vocabulary/unknown-model coverage;
save-model add and guard coverage; delete guard coverage. UI: Add from
discovered row and from manual disclosure (including auto-open on failed
discovery), edit name/ID/enabled/capacity with stale-reload honesty, per-
capability declaration, confirmed delete, two-Provider isolation, mock
parity. Then the full matrix and owner acceptance on the rebuilt debug app.

### 2026-08-27 Catalog capacity presentation note

The owner hit the pair-required capacity editor on a model whose limits the
pinned `aisdk` catalog already carries ("设置上下文窗口，第二个是必填项？").
This note authorizes the presentation-only wiring the 08-05 contract already
sanctions ("Context window and maximum output values are presentation-only
catalog facts"): the settings view projects `aisdk::list_models()`
`context_window`/`max_output` onto any model still at durable
`conservative_default` when an exact Provider/model-ID catalog match has both
values, labelled with provenance `catalog`. The durable profile is never
rewritten by this projection, the runtime execution budget keeps reading
durable values, and the catalog is loaded through a process-wide cache. The
Model options dialog prefills from the projected values; only
catalog-unknown models still require the honest pair declaration.
