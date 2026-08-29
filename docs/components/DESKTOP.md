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
  credential projection;
- `agent_config` for the canonical `<Rho home>/config.yaml` model registry,
  atomic mutation, and permission checks. `RHO_HOME` overrides discovery;
  otherwise an existing `~/.rho` wins over the XDG variant, and new installs
  default to `~/.rho`. Credentials resolve session → environment → config
  literal without a second vault authority;
- `commands/toolchain.rs` for the read-only project Toolchain Doctor projected
  in Environment → Toolchains. External sync/lock authority remains in
  `rho-toolchain`, separate from ordinary run admission.

## Frontend

`desktop/ui/src/main.tsx` mounts `App`. The startup controller must reach a
ready state before `WorkbenchApp` is mounted. Views consume typed transport
facets under `transport/`; generated files in `transport/generated/` mirror
Rust commands. `transport/mock.ts` supports deterministic browser development.

Controllers under `app/controllers/` serialize project, Surface, Console, and
Studio mutations. A completed Agent turn may emit one bounded Studio
presentation request. The Agent Surface preserves the current Scene, creates a
separate result Scene, and opens only validated project files, a Console pinned
to the exact Agent execution, Plots, and Environment views through the same
revision-checked mutation paths
used by human actions. This handoff never writes Vibe content; Vibe remains the
narrative flow workspace. CSS is composed from the tokenized files under
`ui/src/styles/`; `foundation.css` only orders those layers.

`desktop/dist/` is generated output. Change `desktop/ui/`, rebuild it, and do
not document generated bundles as source.
