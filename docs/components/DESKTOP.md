# Desktop application

The desktop is a Tauri application with a React RSR frontend.

## Backend

`desktop/src-tauri/src/main.rs` constructs `AppState`, registers commands, and
coordinates startup and shutdown. Commands are grouped under
`desktop/src-tauri/src/commands/`; durable or long-lived behavior is delegated
to stores, registries, project transition code, or the server coordinator.

Important runtime owners include:

- `application_*`, `startup_runtime`, and `workspace_lifecycle` for process
  admission and recovery;
- `project`, `project_transition`, and `resource_registry` for project and file
  identity;
- `runtime_registry`, `studio_runtime`, `surface_runtime`, and `ui_profile` for
  desktop workbench state;
- `agent_llm` and Agent commands for model settings, selection, tests, and
  credential projection. Provider setup asks for service and API key (plus a
  Base URL only for compatible services), validates the session credential,
  discovers models, and atomically creates config with the first usable
  language model and Chat route. Failed discovery leaves no half-configured
  Provider. Existing Providers expose an in-app endpoint/name editor while
  credential and model controls remain separate;
- `agent_config` for the canonical `<Rho home>/config.yaml` model registry,
  atomic mutation, and permission checks. `RHO_HOME` overrides discovery;
  otherwise an existing `~/.rho` wins over the XDG variant, and new installs
  default to `~/.rho`. Credentials resolve session → environment → config
  literal without a second vault authority;
- `commands/toolchain.rs` for the read-only project Toolchain Doctor projected
  in Environment → Toolchains and the managed-project Target Admission cache.
  Workspace startup admits the exact local/native R realization before Ark
  launch; Runtime Run and auxiliary Live entry points revalidate the cached
  config/registry binding and recent resource-governance observation before
  persistence or process dispatch. Environment → Connections asks for four
  essential login fields, then automates host-key pinning, Slurm discovery,
  dedicated-key bootstrap, exact remote Helper deployment, target persistence,
  and optional project selection without requiring a terminal. Configured SSH
  targets can be edited and reverified with their existing key. Helper build
  identities are checked and stale Helpers are upgraded with bounded retries.
  Environment → Resources refreshes bounded local/SSH device telemetry across
  native, Docker, and Conda target identities every 15 seconds while that view
  is open. Remote host telemetry measures the configured filesystem directly;
  it does not require a synchronized remote `rho.toml`. The workbench taskbar reuses the
  same typed Environment read surface as a three-metric CPU/RAM/disk panel,
  refreshes every 10 seconds, and expands to device, runtime, operation, and
  admission detail with direct Environment Resources and Diagnostics actions.
  External sync/lock authority remains in `rho-toolchain`.

## Frontend

`desktop/ui/src/main.tsx` mounts `App`. The startup controller must reach a
ready state before `WorkbenchApp` is mounted. Views consume typed transport
facets under `transport/`; generated files in `transport/generated/` mirror
Rust commands. `transport/mock.ts` supports deterministic browser development.

Controllers under `app/controllers/` serialize project, Surface, Console, and
Studio mutations. The compact left rail keeps Studio/Vibe/Compose captions
hidden until hover or keyboard focus, exposes one tools button for every placed
component, and folds the former top Rho menu into the bottom-pinned rail menu
alongside a deliberately small toolbar customization surface: only Command
Search and Compose remain optional; redundant project, scene, action, and
runtime projections are removed.
Component tools provide focus, mode, runtime, duplicate, and close actions.
Exact Plot links from Console or History open the durable Plot identity, while
the general Plots view includes both current-session and historical project
plots. A completed Agent turn may emit one bounded Studio presentation request.
The Agent Surface preserves the current Scene, creates a
separate result Scene, and opens only validated project files, a Console pinned
to the exact Agent execution, Plots, and Environment views through the same
revision-checked mutation paths
used by human actions. This handoff never writes Vibe content; Vibe remains the
narrative flow workspace. CSS is composed from the tokenized files under
`ui/src/styles/`; `foundation.css` only orders those layers.

`desktop/dist/` is generated output. Change `desktop/ui/`, rebuild it, and do
not document generated bundles as source.
