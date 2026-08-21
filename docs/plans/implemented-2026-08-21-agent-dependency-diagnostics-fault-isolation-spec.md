# Agent Dependency Diagnostics And Fault Isolation

Status: ADI-1 implemented and locally accepted on 2026-08-21 against the exact
checkout `target/debug/rho-desktop`; the owner-authorized dependency-diagnostics
slice of Issue #100 is complete, while CI, multi-platform, provisioning,
runtime-supervisor, keyboard-navigation, and Console-completion work remain
outside this local iteration

Date: 2026-08-21
Issues: [#100](https://github.com/YuLab-SMU/Rho/issues/100),
[#94](https://github.com/YuLab-SMU/Rho/issues/94), and
[#93](https://github.com/YuLab-SMU/Rho/issues/93)

Change class: D3 because startup health crosses R discovery, Agent R package
admission, Tauri serialization, and frontend fault domains. Risk: R3 because
startup truth must not disable a healthy Workspace R or misdirect dependency,
Provider, credential, and network recovery.

## Authorization And Scope

Only ADI-1 is active:

- replace the Agent-runtime boolean/error projection with structured package
  health for `aisdk` and `aisdk.providers`;
- classify missing, incompatible version, namespace/load failure, incompatible
  API, ready, and process-level probe failure;
- report selected Rscript, R version, installed/required package version, and
  resolved package path;
- give source-aware remediation that never claims CRAN can satisfy
  `aisdk >= 1.5.0`;
- render bounded, copyable diagnostics inside the Agent surface;
- preserve a ready editor, Console, Workspace R, Environment, and project when
  Agent dependencies fail;
- keep Provider credential/network health separate from package health;
- keep real and browser/mock projections aligned;
- validate locally with deterministic fixtures and the exact debug app where
  available.

ADI-1 does not authorize keyboard shortcuts or Console completion from the
broader Issue #100. They remain independent work packages.

## Authority And Cross-review

- the implemented Windows startup-diagnostics design owns required R discovery,
  base-R bootstrap, shell survival, stable startup issues, and optional Agent
  probing;
- Issue #94 owns canonical Agent dependency manifests, application-private
  libraries, artifact/source verification, provisioning, repair, network
  authorization, atomic activation, and last-known-good selection;
- Issue #93 owns Workspace R/Ark supervision, recovery states, restart policy,
  and execution interruption truth;
- Provider settings and model connection tests own credentials, endpoint,
  network, quota, and Provider API failure;
- project `renv` remains scientific Workspace R authority and cannot be used as
  the Agent dependency environment;
- this document owns only precise observation and UI fault isolation against
  the currently resolved selected-R libraries.

Stop and amend the contract if implementation would install/update a package,
change `.libPaths()`, mutate user/project libraries, restart Ark because of an
Agent dependency, treat a Provider failure as a package failure, or add a
second package/source authority.

## Current Failure

`AgentRuntimeStatus` currently exposes only:

```text
available
aisdk_version
error
```

The R probe calls `loadNamespace("aisdk")`, checks one minimum version and two
exports, then collapses every non-zero result into one bounded stderr string.
It does not observe `aisdk.providers`. The UI presents this as an Assistant
connection failure and offers only Retry, even though Workspace R may be fully
healthy.

On a selected valid R with missing or old Agent packages, this leaves users
unable to distinguish R, namespace, API, Provider-adapter, credential, and
network failures. A generic startup/project-session error can then make a
healthy editor and Console appear broken.

## Structured Contract

The backend returns:

```text
AgentRuntimeStatus {
  available
  status
  rscript
  r_version
  aisdk_version                  // compatibility projection
  provider_adapters_available
  provider_health                // not_checked | dependency_ready | dependency_unavailable
  dependencies[]
  error
}

AgentDependencyStatus {
  package
  status                         // checking | ready | missing |
                                 // incompatible_version |
                                 // namespace_load_failed |
                                 // incompatible_api | probe_failed
  installed_version
  required_version
  resolved_path
  detail
  remediation
}
```

Rules:

- `available` means the core `aisdk` dependency is ready for ordinary Agent
  orchestration;
- missing/broken `aisdk.providers` makes status `degraded` and
  `provider_adapters_available=false`, but does not falsify core `aisdk`
  readiness or Workspace R health;
- adapter degradation disables submission only when the selected model uses a
  `registered` Provider backed by `aisdk.providers`; compatible built-in or
  custom Provider lanes remain admissible;
- Provider credentials/network are never probed here. `provider_health` says
  `not_checked` or only whether adapter dependencies are ready;
- process spawn, timeout, non-zero exit before structured markers, or malformed
  markers produce `probe_failed`, not a guessed package state;
- dependency details and remediation are single-line, control-free, and
  bounded; no credential, startup-file contents, or unbounded probe output is
  returned.

## Probe Contract

The short-lived R process uses the selected R and existing reviewed startup
policy. It emits one machine-readable bounded marker per package and does not
abort merely because a package is unhealthy.

For each package:

1. inspect package metadata/version and resolved library path without loading
   the namespace;
2. classify missing metadata as `missing`;
3. compare versions before namespace load;
4. classify an old version as `incompatible_version` with installed and
   required values;
5. load the namespace under `tryCatch` and classify an error as
   `namespace_load_failed`;
6. compare required exports and classify gaps as `incompatible_api`;
7. otherwise report `ready`.

Required contracts for ADI-1:

- `aisdk >= 1.5.0`, exports `normalize_capability_model_routes` and
  `set_run_trace_sink`;
- `aisdk.providers >= 0.1.0`, reviewed constructors used by `rho.agent` for
  DeepSeek, Moonshot, Kimi Code, Stepfun, Volcengine, AiHubMix, xAI,
  OpenRouter, Bailian, and NVIDIA.

Context7 contains no documentation for the YuLab R packages and its similarly
named AISDK result is a different Rust library. Therefore repository
`DESCRIPTION`, pinned `Remotes`, adapter calls, and runtime constants remain the
only authority in this slice.

## Remediation Contract

Remediation must be source-aware:

- missing/old/incompatible `aisdk` says the selected R library needs the
  reviewed Rho build and explicitly states that a CRAN-only install may remain
  below `>= 1.5.0`;
- it may show the current reviewed GitHub revision from this repository as a
  manual development instruction, but does not run it;
- `aisdk.providers` remediation names its separately pinned GitHub revision;
- namespace failures say to repair the reviewed package and its dependencies,
  preserving the resolved path in diagnostics;
- API failures say to replace the package with the reviewed Rho revision;
- Provider credential/network errors continue to direct users to Model
  settings and are never presented as package installation advice.

No “Install from CRAN” action is emitted by ADI-1.

## UI Contract

When Agent dependencies need attention:

- the workbench remains open and Workspace R health remains idle/ready;
- only Agent sending is disabled when core `aisdk` is unavailable;
- the Agent timeline says `Agent dependencies need attention`, not Assistant
  connection or R session failure;
- a compact diagnostic card lists selected R, each package state,
  installed/required versions, resolved path, detail, and remediation;
- `Copy diagnostics` produces a bounded plain-text report;
- `Retry Agent check` reruns only the dependency probe;
- provider adapter degradation is a warning while core Agent remains usable;
- Provider connection status is explicitly labelled as checked separately in
  Model settings.

Startup/project restore handling must preserve the current fire-and-forget
Agent probe: a failed dependency result cannot reject `workspace_start`, project
restore, file hydration, Console, Environment, or Run loading.

## Local Verification Matrix

Backend fixtures cover:

- deferred/checking state;
- core package missing;
- `aisdk 1.4.12` vs required `1.5.0`;
- core namespace/load failure with installed version/path;
- core missing required export;
- core ready;
- `aisdk.providers` missing, old, namespace-broken, API-broken, and ready;
- process spawn failure, timeout, non-zero exit, and malformed/no markers;
- control/newline/oversized detail bounding;
- selected Rscript/R version/path projection;
- serialization compatibility and no credential fields.

Frontend/mock checks cover:

- missing, incompatible, namespace, API, and provider-adapter states;
- exact version/path/remediation rendering;
- copyable diagnostics with no credential/network conflation;
- core dependency failure disables only Agent sending;
- adapter-only degradation preserves core Agent readiness, disables an affected
  selected registered Provider with a specific reason, and leaves compatible
  Provider lanes selectable;
- workspace startup continues independently from background probe failure;
- retry wording names dependency check rather than connection retry.

Required local commands:

```text
cargo test -p rho-desktop <focused Agent dependency tests>
node --check desktop/dist/app.js
node scripts/test-agent-dependency-diagnostics.mjs --test
node scripts/test-agent-dependency-diagnostics.mjs
git diff --check
```

No CI, remote check, multi-platform, installed Windows, provisioning, package
installation, network, credential, full supervisor, or release gate belongs to
this local stop point. Those checks are unrun, not passed.

## Version, NEWS, And Lifecycle

ADI-1 is user-visible startup/Agent behavior. Application version and NEWS must
advance in the next named integration candidate before distribution. This local
branch does not allocate or reuse a candidate version and must not be
distributed.

ADI-1 is implemented because its structured fixtures, frontend/mock parity,
fault-isolation regression checks, exact-debug local observation, and final
contract review pass are complete. Issue #94 provisioning and Issue #93
supervision remain open regardless of ADI-1 completion.

## ADI-1 Local Checkpoint — 2026-08-21

Implemented:

- replaced the collapsed Agent runtime result with selected-R identity and
  structured `aisdk`/`aisdk.providers` package observations;
- added bounded classifications for missing package, old version, namespace
  load failure, incompatible API, ready, and process-level probe failure;
- preserved a fire-and-forget Agent probe after Workspace startup, so a failed
  check cannot reject project restore or disable editor, Console, Environment,
  Runs, or Workspace R;
- added package/version/path/remediation cards and bounded copy diagnostics in
  the Agent surface, including the CRAN minimum-version warning and reviewed
  repository revisions;
- kept credential, endpoint, and network health in Model settings rather than
  inferring them from package state;
- made `aisdk.providers` failure a degraded core state: submission is blocked
  only when the selected model uses an affected `registered` Provider;
  compatible Provider lanes remain selectable;
- added browser/mock fixtures for checking, missing, old, namespace, API,
  Provider-adapter, and process-failure states.

Local automated evidence:

- `cargo fmt --all --check` passes;
- `cargo test -p rho-desktop` passes 274 tests with one documented opt-in
  Keychain smoke ignored and zero failures;
- the opt-in live probe passes and emits `aisdk 1.5.0` and
  `aisdk.providers 0.1.0` from their actual local library paths;
- `node --check desktop/dist/app.js` passes;
- `node scripts/test-agent-dependency-diagnostics.mjs --test` and the same
  script against repository sources pass;
- `node scripts/test-human-facing-information-ui.mjs` passes;
- `git diff --check` passes.

Local manual evidence:

- the exact checkout executable `target/debug/rho-desktop` opens the workbench with
  Workspace `R idle`, Agent `Ready`, and an enabled composer when both reviewed
  packages are healthy;
- deterministic browser previews show missing and `1.4.12` core states with
  exact installed/required/path/remediation detail and an Agent-only disabled
  composer;
- the Provider-adapter preview shows core `Ready · adapters need attention`, a
  separate `aisdk.providers` diagnostic, and a specific disabled reason for the
  selected registered DeepSeek route while Workspace R remains idle;
- the copy-diagnostics action is visibly available in each actionable card.

Final contract review:

- a separate post-verification diff review found no package mutation,
  `.libPaths()` change, Workspace restart, credential/network probe, second
  dependency authority, public protocol, persistence, or provisioning path;
- the one review refinement was to bind Provider-adapter admission to the
  selected Provider kind instead of either disabling every Agent route or
  allowing a known affected registered route; the structured core readiness
  contract remains unchanged;
- browser/mock and Tauri result shapes remain aligned, fields are bounded and
  rendered as text, and process failures preserve truthful `probe_failed`
  state rather than guessing package health.

Version and release decision:

- this is user-visible application behavior, so application version metadata
  and `NEWS.md` are required before the next named distributable integration
  candidate;
- version allocation is deliberately deferred because this local branch is not
  a distributable candidate; no R package contract changed;
- CI, remote checks, Windows installed-app acceptance, non-local platforms,
  provisioning, credentials/network, supervisor recovery, installer, signing,
  publication, and release gates are unrun and are not claimed passing.
