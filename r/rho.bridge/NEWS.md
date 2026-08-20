# rho.bridge 0.1.15

- Workspace snapshots now identify active bindings without evaluating them,
  and fixed object inspection rejects active bindings instead of executing
  project-defined binding code.

# rho.bridge 0.1.14

- Data Viewer row cells and cell-state metadata now serialize as unnamed,
  positionally aligned JSON arrays, including for data frames with duplicate
  or non-syntactic column labels.

# rho.bridge 0.1.13

- Structured parse failures now distinguish their parse phase and expose a
  bounded one-character `r_parse_token` range only when R's anchored parser
  location identifies an actual Unicode scalar in the exact submitted code.
- Evaluation failures retain the existing exact top-level `r_expression`
  range; malformed, out-of-bounds, EOF, and nested parse messages remain
  unlocated instead of being inferred from ordinary error text.

# rho.bridge 0.1.12

- Structured execution errors now include the exact parsed top-level R
  expression range when evaluation fails. Ranges use bounded one-based
  character coordinates with an exclusive end and remain absent when the
  parser cannot establish a location.

# rho.bridge 0.1.11

- Added a fixed nullable Help target to structured execution results when the
  final value is one local R Help record. The Help object is no longer printed,
  preventing the Workspace from starting R's HTTP Help viewer.

# rho.bridge 0.1.10

- Added a bounded, project-relative R source formatting result using the
  explicitly selected optional `styler` provider. Missing providers, parse
  failures, unchanged text, warnings, and exact document metadata remain
  visible without formatter fallback or file mutation.

# rho.bridge 0.1.9

- Added bounded, version-bound lintr diagnostics with stable IDs, normalized
  ranges and severity, truthful partial/error states, and a fixed JSON-safe
  response.
- Added safe proposals for infix spacing, assignment, and trailing-whitespace
  findings; applying a proposal remains an editor-only action in the desktop.

# rho.bridge 0.1.8

- Added bounded installed Rd documentation, package version, argument,
  example, and vignette records for one explicitly qualified Help topic.
- Hidden Rd example branches are omitted, while malformed or truncated
  examples are marked non-executable before they reach the desktop.

# rho.bridge 0.1.7

- Added bounded, token-aware project reference discovery for R source and R
  chunks in R Markdown and Quarto documents.
- Added truthful partial-scan metadata for parse, containment, file-count, and
  byte-budget limits while returning project-relative locations only.

# rho.bridge 0.1.6

- Added bounded local Help, installed-package, library, and package-contained
  source-reference discovery without attaching or loading package namespaces.
- Preserved a fixed JSON-safe Help response for missing, ambiguous, and
  truncated lookups.

# rho.bridge 0.1.5

- Added previewed, project-root-explicit install, update, and remove operations
  for one validated package in the exact renv project library.
- Added fixed non-interactive renv argument forwarding, repository validation,
  execution-time package-state checks, and bounded diagnostics.

# rho.bridge 0.1.4

- Added evidence-bound direct, transitive, and unclassified dependency roles
  from the project DESCRIPTION and bounded lockfile requirements graph.
- Added credential-safe repository, remote, URL, and project-local package
  source metadata to lockfile and installed-library inventory rows.

# rho.bridge 0.1.3

- Added a bounded, project-root-explicit lockfile and installed-library union
  with matched, version-mismatch, not-installed, and not-locked states.
- Added truthful missing, malformed, unavailable, source-limit, and file-size
  states while selecting duplicate installed packages by `.libPaths()` order.

# rho.bridge 0.1.2

- Added additive column type/class/missing-count metadata and aligned cell
  states for ordinary, empty, missing, NaN, and infinite values.
- Preserved explicit `NaN`, `Inf`, and `-Inf` text while retaining null for R
  missing values and compatibility with existing delimited export.

# rho.bridge 0.1.1

- Added bounded, case-insensitive literal search across row names and all view
  cells before paging.
- Added stable Workspace-owned sorting by absolute column index, with missing
  values last and structured rejection for invalid or unsupported requests.
- Data Viewer pages now report source and matched row counts plus normalized
  query/sort state for exact visible-page export replay.
