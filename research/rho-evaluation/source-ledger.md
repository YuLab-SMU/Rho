# Source ledger

## Deep-read run

- Corpus root: `/Users/xiayh/Projects/yaoshunyu-phd`
- Inventory manifest: `corpus-manifest.csv`
- Deep-read run: `deep-read-28`
- Retrieved and reviewed: 2026-11-16
- Paper PDFs read: 28
- Per-paper notes: 28
- Notes and supporting PDFs: used for navigation and cross-checking
- Network expansion: deferred until the HCI/CSCW/provenance gap is queried explicitly

## Review method

Each paper was read from the PDF text extraction through its problem, environment, method, evaluation setup, results, ablations and limitations. The matrix records the primary paper as the evidence source and preserves section, page, table or figure locators. Relevant evaluation tables and figures were checked against the extracted pages. `reviewed_with_limitations` records that PDF extraction and task-level reading do not substitute for an independent replication of the paper's experiments.

## Source priority

Paper PDFs support methods, results, evaluation details and limitations. The supplied notes, slides and dissertation retain their documented roles. Rho episodes support bounded observed behavior. Search metadata remains a reading lead until the source is inspected.

## Main synthesis

The corpus contains strong patterns for executable benchmarks, trajectory/process measures, structured human or expert assessment, and offline/live comparison. It contains little direct evidence about shared work-state continuity between people and Agents. That is a candidate gap, pending a targeted review of HCI, CSCW, research-software, notebook and provenance systems.

## Provenance status

Every paper row has a SHA-256 source record in `corpus-manifest.csv`, a full note in `paper-notes/`, and locators in `paper-matrix.csv`. Claims in `claim-register.csv` point to exact paper IDs or Rho records. Unknown, not-reported and evaluator-limit states remain explicit.
