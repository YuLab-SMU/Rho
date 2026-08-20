# Human-facing Information Projection

Status: active; authorized by the project owner on 2026-08-05

Change class: D2 cross-surface presentation workflow

Risk: R1 for display-only projections, rising to R2 where an approval or
scientific review surface must preserve an exact decision consequence.

Owning documents: this specification owns the shared frontend projection of
internal identifiers, statuses, errors, paths, and implementation terminology.
The UX1 interaction inventory remains the terminology source; existing Agent,
Environment, Evidence, Run, Artifact, Audit, approval, and startup contracts
retain their behavioral authority.

CRED-UX2, authorized on 2026-08-07 in the active system-credential and simple
LLM settings specification, owns the Model settings provider-card, guided-flow,
per-provider disclosure, management-separation, and operation-state layout. It
retains this document's friendly status/error, raw-detail exclusion, and
credential-redaction rules. The historical WP4 evidence below describes the
pre-CRED-UX2 layout and is not the current layout acceptance contract.

ART-2, authorized on 2026-08-18 in the active Agent result transport recovery
specification, may project a redacted bounded Provider failure into existing
Agent turn and Activity surfaces. This document retains presentation policy:
show the HTTP class/status and useful next action, while excluding Provider
URLs, response bodies, credentials, process/transport identifiers, and raw
payload JSON.

Mandatory stop: implement, test, review, document, and commit each work package
before starting the next package.

## Problem

Several later workflows added friendly local projections, but Rho still has no
single presentation boundary for internal information. Normal and failure
states can expose provider selectors, request or Run identifiers, runtime
process details, raw backend errors, stable reason codes, implementation terms,
and machine-specific runtime paths. These values remain useful for correlation
and support diagnostics, but they are not suitable as default product copy.

## Product Rule

Default UI answers four user questions: what happened, what it affects, what
the user can do next, and where the relevant user-owned source or output lives.
Opaque identities, raw protocol or schema fields, process identifiers, backend
command names, and implementation-only terms are excluded from ordinary UI.

User-owned scientific information remains visible when useful: R code, R
output, warnings, source locations, project-relative paths, package names and
versions, output filenames, and reviewable changes. Exact internal information
may remain in copied diagnostics or diagnostic log files, but not in ordinary
cards, status lines, tooltips, toasts, or accessibility names.

Unknown values fail closed to a truthful generic label. They do not fall back
to raw enum values, raw JSON, or `String(error)`.

## Work Packages

### WP1 Shared Projection Boundary

- Add shared frontend helpers for friendly errors, statuses, model names, and
  internal-detail rejection.
- Replace the highest-risk direct raw-error projection paths used by shared
  Run, project, approval, and operation workflows.
- Add a focused contract test with hostile opaque identifiers and backend
  command text.
- Commit checkpoint: the baseline remains syntax-valid and affected tests pass.

### WP2 Agent And Diagnostics Surfaces

- Agent Task and Activity show display names and user actions, not model
  selectors, request IDs, broker policy, or raw event bodies.
- Logs omit PID, opaque Run identity, and internal runtime branding while
  retaining useful operation outcomes, R output, messages, and warnings.
- Startup and About show recovery and product information; raw details remain
  available only through existing copy-diagnostics or log actions.
- Approval code never falls back to raw arguments JSON.

### WP3 Scientific And Review Surfaces

- Environment, Data Viewer, Help, References, Runs, Compare, Review, Project
  Skills, and Evidence use mapped status and limitation language.
- Machine-specific package-library paths and skill implementation paths are not
  default metadata.
- R errors and tracebacks remain reviewable where scientifically useful, with
  extended traceback detail progressively disclosed.
- Claim kinds and structural-review statuses use controlled human labels.

### WP4 Simple Settings And Enforcement

- Model/provider setup defaults to the fields needed to connect and select a
  model; protocol and capability metadata move under Advanced settings.
- Add deterministic browser/static checks across representative surfaces for
  forbidden internal identifiers, implementation terms, raw JSON fallback,
  and raw backend error projection.
- Update UX1 gap status, NEWS, manual acceptance, and this contract with exact
  automated and unrun installed-app evidence.

## Cross-review

- UX1 remains the terminology authority. This package implements its unfinished
  internal-ID and message-component requirements across later surfaces.
- Agent approval, file-edit, execution, and Act authority are unchanged. Only
  their displayed labels and diagnostic fallback change.
- Environment operations remain in their dedicated request lane. Exact package,
  project, repository, and consequence information stays reviewable.
- Runs, Artifacts, Plots, Evidence, and Audit retain their existing durable
  identities and provenance. The frontend continues to use those identifiers
  internally for selection and commands.
- Startup diagnostics and About diagnostics remain available for support via
  copy/log actions; this package does not weaken diagnostic capture.
- No schema, R package, public protocol, credential authority, project-file
  authority, or persistence changes are authorized. The separately active
  AGPL LIC-2 contract may add one no-input Rust command that resolves and
  reveals only the fixed bundled Rho license resource. Its UI must expose the
  friendly legal action and failure, never the internal command or raw path.

## Verification

- JavaScript syntax and focused human-facing projection contract;
- complete affected frontend/mock tests for Agent, Runs, Problems, Logs,
  Environment, Data Viewer, Help, References, Evidence, Git, Plots, Audit,
  startup/About, and interface hierarchy;
- browser preview checks for Agent default/activity/approval, Human Logs,
  Environment, Evidence, and settings at normal and narrow layouts;
- `git diff --check` and post-test contract review;
- installed-app and display-scale acceptance remain manual and must be recorded
  as `NOT RUN` until performed on a built candidate.

## Version And Release

The work joins the existing `0.4.0-dev.0` development candidate, so application
metadata remains synchronized at that version and NEWS is amended once. There
are no R package version changes. Passing frontend tests does not establish
installed-app acceptance or release readiness.

## Implementation Evidence

### WP1 Shared Projection Boundary

Implemented 2026-08-05. The frontend now has one friendly error/status boundary
and uses it for shared Run history, project guidance, Agent history, Agent
approval, Run cancellation/comparison, and Environment operation failures. Raw
details are written only to the developer console by this layer. JavaScript
syntax, the focused projection contract, Agent-first, Environment package, and
Project Check UI contracts passed. Installed-app acceptance remains `NOT RUN`.

### WP2 Agent And Diagnostics Surfaces

Implemented 2026-08-05. Agent Task and Activity map historical model selectors
to display names, omit request IDs, and whitelist friendly event titles and
bodies. Approval never falls back to arguments JSON. Logs use product labels
and omit opaque Run/PID/runtime details. Startup offers recovery and diagnostic
actions without rendering raw details or machine log paths. About keeps only
product, platform, R-session, and assistant availability information while Copy
Diagnostics retains support detail. Agent posture hides editor-only status-bar
metadata. Focused, Console/Logs, Agent-first, scientific-surface, interface, and
Agent output-review contracts passed; browser preview confirmed no visible
model selector, request ID, broker/runtime term, or editor position in the
default Agent and expanded Activity views. Installed-app acceptance remains
`NOT RUN`.

### WP3 Scientific And Review Surfaces

Implemented 2026-08-05. Project guidance now shows titles, descriptions, and a
project-provided trust reminder without skill IDs or implementation paths.
Help, References, package inventories, Environment summaries and operation
reviews map incomplete, unavailable, synchronization, and failure states to
outcomes and next actions; machine-specific package-library paths are omitted.
Data Viewer uses preview and partial-data language instead of transport terms.
Run comparison admits only known fields and maps status, origin, action, and
environment availability values. Agent Run Review keeps R errors visible and
places traceback detail in a collapsed disclosure. Evidence claim kinds are a
controlled Result/Method/Interpretation choice, while claim and structural
review statuses use friendly labels and unknown limitations fail closed.

JavaScript syntax; focused human-facing projection; Evidence claim;
Environment package and lockfile; Local Help, Installed Help, Agent Help, and
Project References; Data Viewer type/query; and Agent output-review contracts
passed. Browser/mock review covered a missing lockfile/package inventory, the
Evidence claim form and review labels, and a failed Agent Run with useful R
error/source evidence and no default traceback. Installed-app acceptance
remains `NOT RUN`.

### WP4 Simple Settings And Enforcement

Implemented 2026-08-05. Model settings now lead with display name, provider,
connection URL, credential requirement, catalog selection, enabled state, and
connection actions. Provider IDs, environment-variable names, Wire API, stream
options, Model ID, and capability metadata retain their existing serialized
values under two collapsed Advanced settings disclosures. Provider/model rows,
validation, connection tests, and credential actions use friendly projections
without showing the credential-file path or raw backend errors.

The focused projection contract now extracts representative renderers and
rejects direct visible opaque-ID assignment, arguments JSON projection, raw
error string projection, unknown Compare fields, and normal settings enum/path
fallbacks. Its repository-wide error checks also reject direct error-object
toasts and verify the Git review, package inventory, Agent Run Review, and
Agent runtime retry boundaries. JavaScript syntax and all 27 repository `scripts/test-*.mjs`
frontend contracts passed. Browser/mock review confirmed both
Advanced settings disclosures are closed by default, the technical controls
are not visible until expansion, and expansion restores them. UX1 gap status,
NEWS, cross-review status, and the integrated manual acceptance project were
updated. Application and R package versions remain unchanged because this work
joins the existing `0.4.0-dev.0` candidate and changes no R package contract.
Installed-app and display-scale acceptance remain `NOT RUN`; no release
readiness decision is made.

### LIC-2 About Legal Notice Extension

Implemented and locally reviewed 2026-08-12 under the active AGPL transition
contract. About now projects the static `GNU AGPL v3.0 only` identity and
corresponding-source statement, keeps Source Repository and Show License File
as accessible buttons, and exposes no resource path. The real command returns
fixed friendly failures and browser/mock mode performs no filesystem access.
Computer Use confirmed the notice and exact bundled-license reveal action in a
local macOS `.app`. Exact candidate and installed-app acceptance remain
`NOT RUN`.
