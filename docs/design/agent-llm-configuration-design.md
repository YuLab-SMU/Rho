# Configurable Agent LLMs V1 Specification

Status: implementation handoff

Target release: `0.2.0-dev.10` or later

## 1. Goal

Allow the user to configure model providers and select the LLM used by the
Agent panel without placing API keys in Rho-owned storage.

The selected model is visible in the Agent composer. Provider and model
metadata are managed in a separate dialog. Credentials are read only by the
short-lived Agent R process from the user's R environment file.

V1 must support:

- multiple provider configurations;
- multiple models under one provider;
- selecting the model for the next Agent turn;
- built-in OpenAI, Anthropic and Gemini providers;
- OpenAI-compatible and local endpoints;
- preserving the current DeepSeek model as the initial configuration;
- user-level `~/.Renviron` credentials;
- credential detection without returning credential values;
- a bounded connection test;
- tool-capability gating for Act mode;
- complete model attribution in Agent history;
- cross-platform Windows, macOS and Linux behavior.

## 2. Product Decisions

### 2.1 Rho stores metadata, never credentials

Rho-owned configuration may contain:

- display names;
- provider type;
- model IDs;
- non-secret endpoint metadata;
- names of environment variables;
- declared or catalog-derived capabilities;
- the selected model ID;
- the last connection-test status and timestamp.

Rho must not store an API key or token in:

- frontend state beyond a boolean detection result;
- `localStorage`;
- project files or project session snapshots;
- `llm-profiles.json`;
- SQLite Agent turns or events;
- command-line arguments;
- model prompts;
- logs, errors or telemetry.

There is no API-key text input in V1.

### 2.2 Credentials use the user R environment file

V1 uses the effective user R environment file, normally `~/.Renviron`.
Examples:

```text
DEEPSEEK_API_KEY="..."
OPENAI_API_KEY="..."
ANTHROPIC_API_KEY="..."
GEMINI_API_KEY="..."
OPENROUTER_API_KEY="..."
```

Do not recommend a project-level `.Renviron` for model credentials. Rho must
set `R_ENVIRON_USER` explicitly for Agent R so opening another project cannot
change which credential file is loaded.

If Rho itself was launched with a non-empty `R_ENVIRON_USER`, preserve that
choice. The UI should identify it as a custom user environment file rather
than silently replacing it with `~/.Renviron`.

### 2.3 Workspace R uses explicit user startup files

The Ark-backed Workspace R receives explicit absolute paths for the user's
`~/.Rprofile` and `~/.Renviron`. This preserves user-level library paths,
proxies and R configuration without allowing an active project's startup files
to take precedence.

This means model credentials stored in the user `.Renviron` are visible to
code running in Workspace R. The UI and documentation must state this boundary.
Rho still must not copy credential values into its own settings, logs, SQLite
records, prompts or command-line arguments.

### 2.4 Model choice is explicit

Changing the selected model affects the next Agent turn only. It must not
alter an already running turn.

The backend must never silently switch to another model because a credential
is absent, a connection fails, or a provider rejects a request. The failed
turn remains attributed to the requested model and shows an actionable error.

### 2.5 Rho is still a human-first workbench

Model selection does not change the authority model:

- Workspace R remains the one persistent execution session;
- Act authorization still controls Workspace R execution;
- file edits still require the existing proposal and Accept workflow;
- selecting a more capable model grants no additional authority.

## 3. Current Architecture to Preserve

The implementation must extend the existing path rather than create a second
Agent runtime:

```text
Agent composer
  -> Tauri run_agent
  -> rho-server run_agent_turn
  -> short-lived Agent R
  -> aisdk ChatSession
  -> typed events and SQLite Agent history
```

Current useful behavior:

- `run_agent` already accepts a model string;
- `AgentTurnDraft.model` already persists the actual model used;
- `rho_create_aisdk_session()` already accepts the model;
- the full prompt is transported through stdin, not a Windows command line;
- Agent subprocess windows are hidden;
- Agent diagnostics already pass through credential redaction.

The frontend currently hardcodes `deepseek:deepseek-v4-flash`. Remove that
hardcoding only after backend model settings and migration are available.

## 4. Scope and Non-goals

### 4.1 Included in V1

- a compact model selector in the Agent composer;
- a `Manage LLMs...` dialog;
- global provider and model configuration;
- user `.Renviron` discovery and opening;
- credential presence status;
- connection testing;
- model capability display and Act gating;
- safe migration from the current DeepSeek default;
- mock-mode support for UI verification.

### 4.2 Deferred

Do not include these in V1:

- entering or saving API keys in Rho;
- operating-system credential vault integration;
- organization account login or OAuth;
- per-turn temperature, token or reasoning controls;
- automatic model routing or fallback;
- model aliases that change their target silently;
- per-project credentials;
- project-controlled provider configuration;
- image attachment or vision workflows;
- cost accounting or budget enforcement;
- downloading or managing local model servers;
- syncing settings between machines.

## 5. User Experience

### 5.1 Composer model selector

Replace the static `#agentRuntimeLabel` text with a compact button in the
composer footer. It should show the selected model display name, for example:

```text
DeepSeek V4 Flash  v
```

The popover lists configured and enabled models. Each row shows:

- model display name;
- provider display name;
- a small status indicator: `Ready`, `Key missing`, `Untested`, or `Error`;
- a check mark for the selected model.

The last item is `Manage LLMs...`.

The control must remain usable at the minimum right-panel width. Long names
are ellipsized and exposed in a tooltip. The `+` context button and Send
button keep stable dimensions.

Selecting a model:

1. updates the global selected model setting;
2. updates the composer label immediately;
3. affects only the next turn;
4. does not rewrite old Agent history;
5. does not send a network request.

If a turn is running, the selector may remain readable but should be disabled
until the turn finishes. This avoids suggesting that the running turn changed
models.

### 5.2 Manage LLMs dialog

Open a modal or dedicated unframed settings surface. Do not put nested cards
inside the existing Agent panel.

Use two columns when space permits and one column on narrow windows:

```text
Providers                     Models
DeepSeek                      DeepSeek V4 Flash
OpenAI                        GPT model
Local                         Local coder
```

Provider actions:

- `Add provider`;
- edit metadata;
- refresh credential status;
- open the effective user environment file;
- copy a setup-line template;
- delete an unused provider.

Model actions:

- `Add model`;
- edit model ID and display name;
- enable or disable it;
- select it as default;
- test connection;
- delete it.

Deleting a provider is blocked while models still reference it. Deleting the
selected model requires selecting another enabled model in the same action.

### 5.3 Provider fields

Required fields:

```text
Display name
Provider type
API key environment variable
```

Provider type options:

```text
Registered aisdk provider
OpenAI
Anthropic
Gemini
OpenAI-compatible
Local OpenAI-compatible
```

Conditional fields:

```text
Provider ID              registered aisdk provider only
Base URL                 compatible providers
Base URL environment     optional alternative to Base URL
Wire API                 chat_completions | responses | anthropic_messages
API key required         false by default for local endpoints, true otherwise
Stream options           compatible-provider advanced option
```

`Base URL` and `Base URL environment` are mutually exclusive. Reject URLs
that contain user information or obvious secret query parameters. A signed or
credential-bearing endpoint must be placed in an environment variable instead.

Environment variable names must match:

```text
[A-Za-z_][A-Za-z0-9_]*
```

Preset defaults:

| Type | Key environment | Base behavior |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | aisdk default |
| Anthropic | `ANTHROPIC_API_KEY` | aisdk default |
| Gemini | `GEMINI_API_KEY` | aisdk default |
| OpenAI-compatible | user supplied | explicit URL or URL environment |
| Local OpenAI-compatible | optional | explicit local URL |

The existing DeepSeek configuration is represented initially as a registered
aisdk provider with model reference `deepseek:deepseek-v4-flash`. This
preserves current behavior without guessing the user's endpoint. A new direct
DeepSeek-compatible provider may be added later through the compatible form.

### 5.4 Model fields

Required fields:

```text
Display name
Provider
Model ID
```

The effective model reference is derived by the backend. The frontend must
not construct or submit an arbitrary provider/model reference.

Capabilities:

```text
Tool calling: yes | no | unknown
Reasoning: yes | no | unknown
Vision input: yes | no | unknown
```

Use `aisdk::get_model_info()` or `aisdk::list_models()` when catalog metadata
exists. For a custom model, allow the user to declare tool-calling support.
Label custom declarations as `Declared`, not `Verified`.

Vision and reasoning are informational in V1. Tool calling controls behavior.

### 5.5 Tool-capability behavior

For `tool_calling == yes`:

- Ask, Plan and Act are enabled;
- Workspace inspection tools and `propose_file_edit` are available;
- Act authorization behavior remains unchanged.

For `tool_calling == no`:

- Ask and Plan are allowed as chat-only turns;
- create the ChatSession with no Workspace or file-proposal tools;
- show a compact notice that this model cannot inspect or modify the workspace;
- disable Act mode while this model is selected.

For `tool_calling == unknown`:

- Ask and Plan are allowed as chat-only turns;
- Act is disabled;
- show `Test or declare tool support to use Act`.

Do not send tools to a provider that is known not to support tool calling.

### 5.6 Credential setup controls

The provider editor shows only:

```text
Credential: Detected
Credential: Not detected
Credential: Not required
```

It never shows the key, key length, prefix or suffix.

`Copy setup line` copies a template with an empty value, for example:

```text
OPENAI_API_KEY=""
```

It must not copy any detected value.

`Open user environment file` opens the exact effective file. If the file does
not exist, create an empty file without overwriting another file. Use a native
opener such as the Tauri opener plugin or platform file-opening API. Do not
launch `cmd.exe`, PowerShell, Terminal or another visible console window.

`Reload environment` means re-run credential detection and refresh the UI.
Agent turns already use new R processes, so no long-lived Agent session needs
to be restarted. The label should avoid implying that Workspace R was reloaded.

### 5.7 Connection test

`Test connection` starts a temporary hidden Agent R process and performs a
small real model request. It does not connect to Workspace R and exposes no
Workspace tools.

The result contains only:

```json
{
  "status": "ready",
  "credential_status": "detected",
  "model_resolved": true,
  "latency_ms": 842,
  "capabilities": {
    "tool_calling": "yes",
    "reasoning": "unknown",
    "vision_input": "no"
  },
  "message": "Connection succeeded."
}
```

The probe may derive capabilities from the aisdk catalog. A successful text
request does not by itself prove tool calling, so custom declarations remain
labelled `Declared` unless a deterministic tool probe is added.

Requirements:

- show that the test makes a real provider request and may incur a small cost;
- use a bounded prompt and output;
- timeout after 30 seconds;
- allow cancellation when practical;
- do not persist model response text;
- redact provider errors before returning or storing them;
- classify common failures as credential, model, endpoint, network or timeout;
- never change the selected model automatically after a failure.

## 6. Configuration Model

Store global settings at:

```text
<app_local_data_dir>/llm-profiles.json
```

Use atomic writes. This file is application-global, not project-scoped.

Recommended schema:

```json
{
  "schema_version": 1,
  "selected_model_id": "model-deepseek-v4-flash",
  "providers": [
    {
      "id": "provider-deepseek-existing",
      "display_name": "DeepSeek",
      "kind": "registered",
      "registered_provider_id": "deepseek",
      "api_key_env": "DEEPSEEK_API_KEY",
      "api_key_required": true,
      "base_url": null,
      "base_url_env": null,
      "wire_api": null,
      "disable_stream_options": null
    }
  ],
  "models": [
    {
      "id": "model-deepseek-v4-flash",
      "provider_id": "provider-deepseek-existing",
      "display_name": "DeepSeek V4 Flash",
      "model_id": "deepseek-v4-flash",
      "enabled": true,
      "capabilities": {
        "tool_calling": "yes",
        "reasoning": "yes",
        "vision_input": "no",
        "source": "catalog"
      },
      "last_test": null
    }
  ]
}
```

Use opaque stable IDs. Display names are not identifiers.

Allowed provider `kind` values:

```text
registered
openai
anthropic
gemini
openai_compatible
local_openai_compatible
```

Allowed capability values:

```text
yes
no
unknown
```

Allowed capability sources:

```text
catalog
declared
probe
unknown
```

`last_test` may contain status, timestamp, latency and a redacted error class
and message. It must never contain request headers, response bodies or secrets.

### 6.1 Validation

The backend validates every write:

- schema version is supported;
- IDs are unique and bounded in length;
- each model references an existing provider;
- selected model exists and is enabled;
- display names and model IDs are non-empty and bounded;
- environment names match the required pattern;
- compatible providers have exactly one base URL source;
- URLs use `http` or `https`;
- non-local providers require a key environment name;
- local endpoints default to no key requirement;
- capability values and sources are recognized;
- no unknown field resembles `key`, `token`, `secret`, `password` or
  `authorization` with a non-empty value.

Do not silently repair a corrupt file. Return an actionable settings error,
leave the file untouched, and disable Agent Send until the configuration is
valid.

### 6.2 Initial migration

When no settings file exists, expose an in-memory default equivalent to:

```text
Provider: registered aisdk provider `deepseek`
Model: deepseek-v4-flash
Display: DeepSeek V4 Flash
Credential env: DEEPSEEK_API_KEY
Selected: yes
```

Persist it on the first settings mutation. Existing Agent history requires no
migration because each turn already stores its model string.

Do not overwrite an existing settings file during an application upgrade.

## 7. Effective User Environment File

Resolve the Agent credential file once during runtime preparation and expose
its path through a safe settings view.

Resolution order:

1. If inherited `R_ENVIRON_USER` is non-empty, preserve it.
2. Otherwise ask the configured `Rscript` for `path.expand("~/.Renviron")`
   using a hidden `--vanilla` probe.
3. Normalize the resulting absolute path without requiring the file to exist.
4. Return a clear error if no user path can be resolved.

Use R's own home expansion rather than assuming `%USERPROFILE%`, `$HOME` or a
platform-specific Documents folder.

Every Agent and connection-test child process must receive:

```text
R_ENVIRON_USER=<resolved path>
```

Do not add `--no-environ` to Agent R. The Ark kernelspec uses the same explicit
user `R_ENVIRON_USER` path and an explicit user `R_PROFILE_USER` path.

Because `R_ENVIRON_USER` is explicit, a `.Renviron` inside the active project
must not take precedence.

## 8. Backend Contracts

### 8.1 Rust domain types

Introduce typed structures rather than transporting unvalidated `Value` data:

```rust
struct AgentLlmSettings
struct AgentProviderProfile
struct AgentModelProfile
struct AgentModelCapabilities
struct AgentModelTestResult
struct AgentCredentialStatus
```

Keep the settings store in a focused module such as:

```text
desktop/src-tauri/src/agent_llm.rs
```

Do not expand `project.rs`; these settings are global and unrelated to the
project boundary.

### 8.2 Tauri commands

Recommended commands:

```text
agent_llm_settings
agent_llm_save_provider
agent_llm_delete_provider
agent_llm_save_model
agent_llm_delete_model
agent_llm_select_model
agent_llm_refresh_credentials
agent_llm_open_user_environ
agent_llm_test_model
agent_llm_cancel_test
agent_llm_catalog
```

`agent_llm_settings` returns a presentation-safe view. Provider rows contain
credential status but never credential values.

`agent_llm_catalog` runs in Agent R and returns bounded language-model metadata
from `aisdk::list_models()`. Filter out embedding and image-only models. A
catalog failure must not prevent manual model-ID entry.

`run_agent` changes from accepting a raw model reference to accepting the
stable Rho `model_id`:

```text
run_agent(prompt, mode, model_id, auto_approve, editor_context)
```

The backend then:

1. loads and validates settings;
2. resolves the selected model when `model_id` is omitted;
3. rejects an unknown, disabled or unusable model;
4. resolves the provider profile;
5. applies tool-capability policy;
6. creates the Agent turn with the effective model reference;
7. launches Agent R with non-secret provider metadata.

Frontend input must never override provider URLs, environment names or
capabilities during `run_agent`.

### 8.3 Agent R profile transport

Extend the stdin payload without placing provider metadata in the prompt:

```text
line 1: broker authentication token
line 2: compact JSON model runtime profile
remaining bytes: complete model prompt
```

The runtime profile contains no credentials. Example:

```json
{
  "profile_id": "model-local-coder",
  "provider_kind": "local_openai_compatible",
  "runtime_provider_id": "rho_profile_provider_local",
  "registered_provider_id": null,
  "model_id": "coder-model",
  "api_key_env": "LOCAL_LLM_API_KEY",
  "api_key_required": false,
  "base_url": "http://127.0.0.1:11434/v1",
  "base_url_env": null,
  "wire_api": "chat_completions",
  "disable_stream_options": true,
  "tool_calling": "yes"
}
```

Keep the 40 KB prompt regression test and add an assertion that profile JSON
is not part of the model prompt or command arguments.

### 8.4 Provider construction in Agent R

Add a focused resolver in `r/rho.agent`, for example:

```text
rho_resolve_model_profile(profile)
```

Behavior:

- `registered`: use `<registered_provider_id>:<model_id>` with the aisdk
  default registry;
- `openai`: register a turn-local provider created by
  `aisdk::create_openai()`;
- `anthropic`: register a turn-local provider created by
  `aisdk::create_anthropic()`;
- `gemini`: register a turn-local provider created by
  `aisdk::create_gemini()`;
- compatible kinds: register a turn-local provider created by
  `aisdk::create_custom_provider()`.

For non-registered providers:

1. read the API key with `Sys.getenv(profile$api_key_env, unset = "")`;
2. read a configured base URL environment variable when present;
3. validate required values;
4. construct the provider in Agent R memory;
5. register it under the generated runtime provider ID;
6. return `<runtime_provider_id>:<model_id>`.

The credential value remains inside the Agent R process. It must not be added
to hooks, metadata, events, errors or return values.

The Agent R system prompt and tool list are then built from the resolved
capabilities. The selected model does not control its own capability flags.

### 8.5 History attribution

Persist the actual effective model reference in the existing
`agent_turns.model` column.

Also add non-secret attribution to the `agent.user_prompt` event details:

```json
{
  "model_profile_id": "model-deepseek-v4-flash",
  "model_display_name": "DeepSeek V4 Flash",
  "provider_display_name": "DeepSeek"
}
```

The timeline or turn detail should show the model used. Old turns continue to
render from their stored `model` string if display metadata is absent.

Deleting or renaming a profile must not change historical attribution.

## 9. Credential Detection and Redaction

Credential detection must happen in a hidden temporary R process using the
same effective `R_ENVIRON_USER` as Agent turns.

The process receives only environment-variable names and returns only one of:

```text
detected
not_detected
not_required
```

Do not parse `.Renviron` in JavaScript. Prefer R's `Sys.getenv()` after normal
R startup so quoting and platform behavior match the actual Agent process.

Strengthen redaction in two layers:

1. Agent R catches provider errors and replaces any known credential value
   with `[REDACTED]` before emitting a message.
2. Rust applies `redact_sensitive_text()` before persistence or UI return.

Expand Rust tests for:

- query parameters;
- JSON fields;
- Bearer headers;
- `KEY=value` and `API_KEY=value` text;
- a bare known credential passed to the redactor by the Agent R wrapper.

Never include an entire environment dump in diagnostics.

## 10. Frontend State and Behavior

Recommended additions to `state` in `desktop/dist/app.js`:

```js
agentLlm: {
  settings: null,
  selectedModelId: null,
  selectorOpen: false,
  settingsOpen: false,
  testAbortId: null,
}
```

Do not persist this object to `localStorage`; the Tauri settings file is the
authority. Mock mode may keep an in-memory equivalent.

On startup:

1. load project and Workspace state as today;
2. load Agent LLM settings independently;
3. render the selected model and credential state;
4. disable Agent Send with a clear reason only if no valid enabled model is
   available.

Before sending:

- capture the selected stable model ID;
- pass that ID to `run_agent`;
- let the backend resolve it again;
- keep the captured label on the optimistic/running UI;
- refresh settings after a credential or connection test.

The model selector, `@` completion, `+` context menu, mode control and Send
button must not overlap at minimum panel width or minimum composer height.

## 11. Expected File Changes

### New file

```text
desktop/src-tauri/src/agent_llm.rs
```

Responsibilities:

- typed settings and validation;
- atomic persistence;
- migration/default settings;
- user environment path resolution;
- credential and catalog probes;
- connection-test lifecycle;
- presentation-safe views.

### `desktop/src-tauri/src/main.rs`

- add Agent LLM state to `AppState` or `RuntimeConfig`;
- register Tauri commands;
- resolve stable model IDs in `run_agent`;
- remove the hardcoded backend fallback after migration exists;
- add model attribution to prompt event details;
- bind Workspace R to explicit user startup paths without allowing project
  startup-file precedence.

### `crates/rho-server/src/coordinator.rs`

- accept a typed non-secret runtime model profile;
- extend stdin framing with the compact profile JSON line;
- set the resolved `R_ENVIRON_USER` on Agent R child processes;
- pass the resolved tool policy to Agent R;
- preserve hidden-window and prompt-stdin behavior;
- strengthen credential redaction tests.

### `r/rho.agent/R/aisdk_adapter.R`

- validate runtime profile shape;
- resolve credentials by environment-variable name;
- construct/register providers in Agent R;
- create a no-tools session for chat-only models;
- add a safe model connection probe;
- redact known credential values before returning errors.

Consider a separate `R/model_profiles.R` if this would keep the adapter
focused. If added, remember that desktop runtime source extraction currently
copies an explicit file list and must be updated.

### `r/rho.agent/tests/testthat/test-adapter.R`

- provider-profile validation tests;
- missing credential tests;
- registered-provider model reference tests;
- compatible-provider construction tests without real network calls;
- chat-only tool-list tests;
- error redaction tests.

### `desktop/dist/index.html`

- replace static model label with selector button and popover;
- add the Manage LLMs dialog;
- add provider and model forms;
- add credential, catalog and test states.

### `desktop/dist/styles.css`

- compact selector and status styles;
- responsive settings layout;
- stable narrow-panel dimensions;
- loading, empty, disabled and error states;
- no nested-card layout.

### `desktop/dist/app.js`

- load and render settings;
- selector behavior and keyboard navigation;
- provider/model CRUD forms;
- credential refresh, file opening and setup-line copy;
- connection-test behavior;
- stable model-ID submission;
- Act capability gating;
- mock-mode fixtures and interactions.

### Documentation

Update:

- `NEWS.md`;
- `docs/implementation/windows-prototype.md`;
- `docs/implementation/windows-build-environment.md`;
- release checklist and smoke-test instructions.

Document `.Renviron` setup without including a real key in examples or test
fixtures.

## 12. Tests

### 12.1 Rust unit tests

Required cases:

- default migration preserves `deepseek:deepseek-v4-flash`;
- settings round-trip and atomic write;
- corrupt settings are not overwritten;
- duplicate IDs and dangling provider references are rejected;
- selected model must exist and be enabled;
- environment-variable validation;
- secret-like configuration fields are rejected;
- base URL validation rejects credentials and secret query parameters;
- inherited `R_ENVIRON_USER` is preserved;
- fallback user environment path comes from R, including paths with spaces and
  non-ASCII characters;
- project `.Renviron` cannot override the explicit Agent path;
- frontend model ID resolves to the expected runtime profile;
- unknown/disabled models fail without fallback;
- a model change does not affect an already captured running turn;
- credential probe returns status only;
- connection-test errors are redacted;
- Agent subprocesses keep the hidden-window flag;
- Workspace kernelspec binds the resolved user `.Rprofile` and `.Renviron` and
  does not load project startup files;
- long prompts remain on stdin and outside command arguments.

### 12.2 R tests

Required cases:

- registered provider resolves the expected model reference;
- OpenAI, Anthropic, Gemini and compatible profiles choose the correct factory;
- required missing key fails before a network request;
- local key-optional profile resolves without a key;
- base URL environment resolution;
- compatible wire API and tool-support flags are propagated;
- known credential values are removed from error text;
- chat-only models receive no tools;
- tool-capable models retain all existing Rho tools;
- connection probe result excludes response content and credentials.

Use mocked provider factories and HTTP behavior for the normal suite. Real
provider checks remain explicit opt-in smoke tests.

### 12.3 Frontend and mock-mode checks

Required cases:

- selector opens, closes and supports keyboard selection;
- selection persists through the backend mock;
- changing models updates only the next mock turn;
- historical mock turns retain their original model label;
- missing-key and failed-test states render clearly;
- Act disables for no/unknown tool support;
- Ask and Plan remain available in chat-only mode;
- provider deletion is blocked while referenced;
- selected model cannot be deleted without replacement;
- setup-line copy contains an empty value;
- no credential value enters DOM state or localStorage;
- Manage LLMs remains usable at minimum desktop size;
- selector does not overlap `+`, context badge or Send.

### 12.4 Validation commands

Run the existing project checks plus new focused tests:

```powershell
Rscript -e "testthat::test_local('r/rho.agent')"
cargo test --workspace
node --check desktop\dist\app.js
cargo fmt --all -- --check
git diff --check
```

Run a real-provider smoke test only when the corresponding user environment
credential is intentionally available. The smoke test must report the model
reference and success/failure without printing the key.

## 13. Manual Verification

1. Start Rho without a key and confirm the selected model shows `Key missing`.
2. Open the effective user environment file from Manage LLMs.
3. Add a test credential manually, save, and select `Reload environment`.
4. Confirm only `Detected` is shown, never any part of the value.
5. Test the connection and confirm the result is bounded and readable.
6. Add two models under one provider and switch between them.
7. Send one turn with each model and confirm history shows the actual model.
8. Change the selected model while idle and confirm the next turn uses it.
9. Confirm there is no silent fallback after an invalid model or network error.
10. Select a chat-only model and confirm Act is disabled.
11. Confirm Ask/Plan chat-only turns do not expose Workspace tools.
12. Confirm an existing Act-capable model still uses the current Workspace R
    authorization and file-proposal workflows.
13. Open another project and confirm provider settings and credentials remain
    global while Agent history remains project-scoped.
14. Confirm Workspace R cannot see the model key through `Sys.getenv()`.
15. Confirm opening the environment file and running probes never flashes a
    Windows terminal window.
16. Verify the dialog and composer at 1024x680 and the normal 1440x900 size.

## 14. Acceptance Criteria

The feature is ready only when all statements are true:

- the Agent composer visibly identifies the selected model;
- the user can configure multiple providers and models;
- the frontend submits a stable model ID, not arbitrary runtime metadata;
- the backend resolves and validates the effective model;
- the requested model is recorded on every Agent turn;
- old turns retain their original model attribution;
- API keys are loaded only inside Agent R from the effective user environment
  file;
- Rho-owned files, SQLite, frontend state, prompts, args and logs contain no
  API keys;
- an inherited `R_ENVIRON_USER` is respected;
- project `.Renviron` files cannot unexpectedly replace the credential source;
- Workspace R remains isolated from model credentials;
- missing credentials and provider failures are actionable;
- connection tests are bounded, hidden and redacted;
- Act is unavailable for models without confirmed or declared tool support;
- model failure never triggers a silent fallback;
- the current DeepSeek configuration continues to work after migration;
- no Windows terminal window flashes during settings or Agent operations;
- R, Rust, frontend, formatting and manual responsive checks pass.

## 15. Implementation Order

Implement in this order to keep the hardcoded model available until the new
path is complete:

1. Add typed settings, validation, atomic persistence and default migration.
2. Add effective user environment resolution and credential-status probes.
3. Add Agent R provider resolution and tests.
4. Change coordinator transport to carry the non-secret runtime profile.
5. Change `run_agent` to resolve stable model IDs and persist attribution.
6. Add catalog and connection-test commands.
7. Add the composer selector and Manage LLMs UI.
8. Add capability gating and chat-only tool behavior.
9. Remove frontend and backend hardcoded model fallbacks.
10. Update docs, run full validation and perform manual responsive checks.

Do not bump the application version or build an installer until this feature
passes the acceptance criteria and the existing Agent file-editing tests remain
green.
