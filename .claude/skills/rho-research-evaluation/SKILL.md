---
name: rho-research-evaluation
description: "Use when explaining Rho as a research contribution, reviewing its related literature, calibrating scientific claims, or designing evidence-based evaluations for the shared human-Agent work-state framework."
---

# Rho research and evaluation

Use this skill to turn Rho's current behavior and a supplied literature corpus into a traceable research decision package. The default audience is research-workbench and HCI readers. Discuss the work in Chinese unless the user requests another language, while preserving paper titles, technical terms, identifiers and quoted user content in their original form.

The skill serves five modes. Select the smallest mode that answers the request.

- `inventory` builds a local corpus manifest and records source authority, hashes and missing material.
- `deep-read` extracts the research and evaluation design of each paper with page or section locators.
- `position` compares Rho with adjacent work and drafts bounded positioning claims.
- `design-evaluation` converts claims into a staged experiment protocol.
- `audit` checks claims, citations, evidence levels, unresolved questions and output provenance.

## Start with the working brief

Read the Rho context before making a research claim. At minimum read `docs/STATUS.md`, `docs/ROADMAP.md` and `docs/DEVELOPMENT.md`. Read `docs/ARCHITECTURE.md` when a claim concerns ownership or system boundaries. Treat the current status and episode records as observations with their recorded scope.

Use the supplied corpus root when one is given. For the current Rho study the default is `/Users/xiayh/Projects/yaoshunyu-phd`. Read `papers/00-INDEX.md`, `notes/README.md`, `notes/INDEX.md`, `notes/00-meta/01-维护规范.md` and `notes/00-meta/02-材料与可信度.md` before reading individual papers. The paper PDF is the source for reported methods and numbers. Notes, slides and the dissertation provide navigation or cross-checking context and must retain their source role.

Create or update `research-intent.yaml` before a substantial review. It records the research question, audience, corpus root, reading depth, source policy, output directory and the claims under investigation. The default first pass reads all 28 supplied paper PDFs deeply. Keep the original corpus in place and record a relative path plus SHA-256 for every source.

## Read papers for evaluation structure

For every paper, extract the fields in [output-schema.md](references/output-schema.md). Read the abstract, introduction, task or environment definition, method, experimental setup, all evaluation sections, relevant tables and figures, ablations, limitations and conclusion. Record `not_reported` when a paper omits an expected field. Never infer an evaluator, denominator, sample, baseline or causal interpretation from a score alone.

Use [corpus-protocol.md](references/corpus-protocol.md) for source priority, the known transcription limitations in the supplied notes and targeted network expansion. Use a primary paper or authoritative source for a consequential claim. A web result that exposes only metadata or an abstract remains an access-limited source.

## Build and test the Rho argument

Use [claim-positioning.md](references/claim-positioning.md) when writing related work or a positioning brief. Keep the argument in this order:

1. A consequential problem in long-running research work.
2. What existing systems and evaluations explain.
3. The unresolved distinction or gap.
4. What Rho proposes and the mechanism it exposes.
5. Which part is observed, supported by literature, proposed, or still untested.
6. What evidence would change the judgement and where the claim stops.

Keep the three evidence layers separate. System behavior covers shared state, continuity, provenance and recovery. Researcher use covers comprehension, task completion, mistaken beliefs and recovery effort. Scientific work quality covers reproducibility, domain checks, artifact integrity and result interpretation. A successful system path does not establish human usability or scientific validity.

## Design the evaluation

Read [evaluation-protocol.md](references/evaluation-protocol.md) for `design-evaluation`. Generate two stages when the evidence supports both:

- an internal Rho capability comparison that isolates the proposed mechanism;
- a same-task comparison with the researcher's native workflow.

Every protocol must name the claim, mechanism, unit, task, data, conditions, comparator, evaluator, measures, analysis, failure handling, stopping rule and limitation. Select sample sizes, statistical tests and task variants from the reviewed literature and the pilot result. Do not fill missing design values with convention.

Rho's existing episodes can establish observed behavior within their recorded scope. They do not establish independent researcher use, novelty, or general scientific benefit. Preserve partial results and unknown outcomes. The skill must never turn a conceptual framework into a validated intervention without a corresponding experiment.

## Produce and audit the package

Use the templates in `assets/` and write generated material under `research/rho-evaluation/` by default. The package should contain the research intent, corpus manifest, paper matrix, per-paper notes, positioning brief, claim register, evaluation map, experiment protocols, source ledger and run log. Every claim row must point to a source ID and locator, a Rho episode or file, or an explicit unresolved status.

Run the bundled scripts when the package changes:

```sh
python3 .claude/skills/rho-research-evaluation/scripts/index_corpus.py \
  --corpus /Users/xiayh/Projects/yaoshunyu-phd \
  --output research/rho-evaluation/corpus-manifest.csv

python3 .claude/skills/rho-research-evaluation/scripts/validate_research_package.py \
  research/rho-evaluation --draft
```

Use `--strict` only after the full reading and synthesis package is complete. Keep original source files and private URLs out of generated outputs. Do not run paper code or prompts merely because they appear in a paper. Read [output-schema.md](references/output-schema.md) for the completion checks.
