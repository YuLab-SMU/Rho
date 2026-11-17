# Research package schema

The output package is a set of linked, reviewable files. Keep generated notes and source records separate from the original corpus.

## `research-intent.yaml`

Required keys:

```yaml
research_question: ""
audience: research-workbench-hci
rho_root: ""
corpus_root: ""
reading_depth: full
source_policy: local-first-targeted-web
output_dir: research/rho-evaluation
evidence_layers:
  - system_behavior
  - researcher_use
  - scientific_work_quality
comparison_stages:
  - internal_capability
  - native_workflow
```

Add `claims`, `open_questions`, `created_at`, `updated_at` and `run_id` when known. Keep paths portable by storing paths relative to the declared root where possible.

## `corpus-manifest.csv`

One row per source with these columns:

`source_id,kind,title,relative_path,sha256,bytes,pages,role,status,index_locator`

`kind` includes `paper_pdf`, `note_markdown`, `support_pdf` and `index`. `status` includes `available`, `missing`, `access_limited` and `unreadable`.

## `paper-matrix.csv`

One row per paper with these columns:

`paper_id,title,year,venue,problem,actor,task,environment,intervention,comparator,evaluator,unit,metrics,results,ablations,limitations,rho_relevance,evidence_level,locators,review_status`

Use semicolon-separated values inside a cell only when a list cannot be represented by a separate note. Keep the detailed reasoning and quotations in `paper-notes/<paper-id>.md`.

## `claim-register.csv`

One row per claim with these columns:

`claim_id,claim_text,claim_type,claim_status,supporting_sources,contradicting_sources,rho_observations,warrant,limitation,required_test,owner,updated_at`

`supporting_sources`, `contradicting_sources` and `rho_observations` contain IDs that resolve to the manifest or a Rho episode. A proposed claim may have no supporting source, but it must name the required test.

## Per-paper notes

Each note starts with YAML frontmatter:

```yaml
paper_id: 01-CALM
source_id: 01-CALM-2010.02903.pdf
review_status: draft
source_sha256: ""
```

Use headings for `Question`, `Setting and task`, `Method`, `Evaluation design`, `Results`, `Ablations and robustness`, `Limitations`, `Rho relevance` and `Locators`. Mark omissions explicitly.

## Experiment protocol

Use the required fields in [evaluation-protocol.md](evaluation-protocol.md). Each protocol receives a stable ID and links every measure to a claim ID. Keep pilot observations and deviations in `run-log.jsonl`.

## Completion checks

A strict package has one manifest row for every source, one matrix row for each of the 28 papers, a note for each paper, at least one source locator for each reported result, a claim register with no unresolved placeholder, a positioning brief, an evaluation map, both staged protocols and a run log. `unknown`, `not_reported` and `access_limited` are valid evidence states when explained.
