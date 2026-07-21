# WP5 Project-Scoped Scientific Environment Basics Design

Date: 2026-07-16
Status: Implemented in `0.2.0-dev.2`
Scope: `docs/plans/implemented-0.2x-agent-handoff.md` WP5

## Goal

WP5 establishes a project-scoped scientific environment contract so local work
is inspectable and reproducible before and after execution. The workbench must
surface enough environment state, bounded object summaries, plot provenance,
and structured render failures to let a second user reproduce a selected result
without relying on chat text alone.

The design must preserve these constraints:

- Workspace R remains the only authority for scientific execution and live
  objects.
- Rust broker remains the only authority for revisions, provenance, run
  history, and durable projections.
- Large scientific objects remain inside Workspace R and are never serialized
  wholesale into the frontend or Agent R.
- `rho-store` remains the only durable event store.
- Quarto and R Markdown rendering are optional capabilities, not startup
  dependencies.

## Non-Goals

WP5 does not add:

- remote compute or cloud execution;
- cloud artifact storage;
- project-wide semantic adapters beyond bounded summaries;
- automatic `renv` restore or package installation during startup;
- Quarto as a required runtime prerequisite;
- unrestricted environment mutation workflows.

## High-Level Architecture

WP5 extends the current prototype from "persistent execution with audit" to
"persistent execution with reproducible local environment context". The
authoritative flow becomes:

1. the frontend requests a project-scoped environment snapshot;
2. Rust broker invokes bounded Workspace R probes through `rho.bridge`;
3. Workspace R returns schema-stable summaries for environment state, objects,
   plots, and render diagnostics;
4. broker records provenance-bearing responses alongside existing run and
   revision semantics;
5. the frontend renders environment drift, bounded object previews, plot
   lineage, and structured render failures from broker-owned projections.

WP5 does not create a second environment model in the frontend. The Environment
panel remains a projection surface. `rho.bridge` returns bounded summaries.
Rust broker normalizes and preserves the contract. The frontend renders only
what the broker says is true.

This keeps the architecture aligned with the longer implementation plan:

- `rho.bridge` continues to own R-aware semantic probes;
- broker continues to own provenance and revision correlation;
- frontend remains read-only for environment truth;
- optional render tools are discovered on demand rather than assumed at boot.

## Component Breakdown

### `EnvironmentSnapshot`

This extends `rho.bridge` with read-only environment probes for:

- `renv` presence and lockfile visibility;
- whether project `renv` appears active or degraded;
- `R.version.string`;
- normalized `.libPaths()`;
- Bioconductor version when detectable;
- loaded package and attached search path summary;
- current working directory and revision metadata.

The first iteration is status-first. It does not run `renv::restore()`,
`renv::snapshot()`, or package install commands.

### `ObjectSummaryProvider`

This provides bounded, schema-stable previews for objects that matter in local
analysis work:

- data frames and tibbles;
- matrices and arrays;
- compact summaries for common table-like structures;
- fallback summaries for unsupported or opaque classes.

The provider returns shape, class, size, column/type previews, and a bounded
row sample. It never serializes the full object.

### `PlotManifest`

This adds durable plot history with provenance fields such as:

- plot id;
- originating run id;
- source file path;
- execution mode;
- document version;
- workspace and revision snapshot;
- generation timestamp;
- exportable artifact path or broker-managed payload reference.

Plots must no longer behave like untraceable transient images.

### `RenderProbe`

This handles Quarto and R Markdown rendering as optional broker-mediated jobs.
Its responsibilities are:

- detect whether Quarto or `rmarkdown` tooling is available;
- execute render requests as durable runs;
- capture render phase, stderr summary, and output path;
- project failures into structured Problems instead of console-only text.

Quarto absence is reported as capability degradation, not as startup failure.

### `EnvironmentPanelViewModel`

This upgrades the current Environment surface into a combined view of:

- project-scoped environment summary;
- object list and bounded object preview;
- plot history with provenance labels;
- render capability and recent render failures.

The panel remains a projection from broker responses, not an inferred client
model.

## Data Flow

### Environment Snapshot Flow

When the desktop starts, the project changes, or the user refreshes the
Environment panel, the frontend requests a broker-owned environment snapshot.
Broker calls `rho.bridge` probes and returns:

- `renv` status;
- R version and library paths;
- Bioconductor version if available;
- loaded package summary;
- current workspace and project revisions.

This makes environment drift visible before the next scientific run.

### Object Preview Flow

When a user selects an object in the Environment panel, the frontend asks for a
bounded summary. Broker routes the request to Workspace R and returns only:

- dimensions and type;
- size and classes;
- bounded structure summary;
- bounded table preview when supported;
- truncation flags when limits are hit.

Large objects remain inside Workspace R.

### Plot Provenance Flow

When execution produces a plot, broker records the plot in a durable manifest
linked to:

- the originating run;
- the source file and execution mode;
- the document version and revisions at creation time.

The frontend renders plot history from this manifest. A user can therefore move
from a plot back to the run and source context that created it.

### Render Flow

When a user requests render for `.qmd` or `.Rmd`, broker first checks
capability. If the toolchain is available, broker creates a new durable run and
executes render. If not, it returns a structured degraded-capability response.

Render success records output provenance. Render failure records structured
diagnostics and enters Problems with run/source linkage.

## Error Handling And Failure Behavior

### Environment Detection Failure

If `renv`, lockfile, Bioconductor version, or package state cannot be resolved,
the environment snapshot returns a degraded or unknown status instead of
pretending the environment is healthy. Partial data still renders when
available.

### Bounded Object Limits

If an object exceeds preview limits or is an unsupported opaque class, the
result must return a bounded fallback such as `truncated` or
`unsupported_preview`. This is not treated as a transport failure.

### Provenance Incomplete

If a plot exists but run/source/revision provenance is missing, the plot must
be explicitly marked as provenance-incomplete. It must not be rendered as a
fully trustworthy reproducible artifact.

### Optional Render Capability

If Quarto or R Markdown render tooling is absent, render requests fail in a
structured way with capability metadata. The desktop still starts normally and
ordinary Workspace R execution still works.

### Structured Render Failure

Render failures must surface through durable run records and Problems. Error
payloads should include:

- source path;
- render target;
- render phase if known;
- stderr summary;
- linked run id.

Console text alone is not the system of record.

## Testing Strategy

### Bridge Tests

Add `rho.bridge` tests for:

- `renv` present vs absent status detection;
- library path and R version summary;
- Bioconductor version detection success and degradation;
- bounded object preview for data frames and large objects;
- truncation or unsupported-preview behavior without full serialization.

### Broker Integration Tests

Add integration coverage for:

- environment snapshot preserving revision metadata;
- plot manifest linking plot to run/source/document version;
- render failure producing structured Problems;
- optional render capability degradation when tooling is unavailable.

### Frontend Checks

Add targeted frontend verification for:

- environment drift visibility;
- bounded object preview rendering;
- plot provenance labels and back-links;
- render failures appearing in Problems rather than only Console text.

### Manual Acceptance

Manual acceptance must prove the handoff scenarios:

1. environment drift is visible before a run;
2. large objects are summarized without full serialization;
3. a plot links back to source file, execution id, and revision;
4. a second user can infer the required environment to reproduce a selected
   result.

## Implementation Notes

Recommended implementation order:

1. extend `rho.bridge` with environment and bounded object probes;
2. expose broker APIs for environment summary and object preview;
3. add plot manifest provenance projection on top of existing run history;
4. add optional render probe and structured render failure projection;
5. upgrade the frontend Environment surface to render the new contract;
6. add focused tests and acceptance notes.

Preferred implementation touchpoints:

- `r/rho.bridge/R/workspace.R`
- `r/rho.bridge/R/execute.R`
- `crates/rho-server/src/coordinator.rs`
- `crates/rho-store/src/lib.rs`
- `desktop/src-tauri/src/main.rs`
- `desktop/dist/app.js`
- `desktop/dist/index.html`
- `desktop/dist/styles.css`

## Done Criteria For WP5

WP5 is complete when the prototype can:

1. show project-scoped environment summary before a run;
2. display `renv`, R, library path, and Bioconductor diagnostics as bounded
   status rather than implicit assumptions;
3. preview large objects through bounded summaries without full serialization;
4. show plot history with run/source/revision provenance;
5. report Quarto or R Markdown render failures as structured Problems;
6. give a second user enough environment and provenance context to reproduce a
   selected local result.
