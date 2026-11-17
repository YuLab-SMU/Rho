# Corpus and source protocol

This reference governs how the Rho research corpus is read and extended.

## Local corpus order

For `/Users/xiayh/Projects/yaoshunyu-phd`, use this order:

1. `papers/00-INDEX.md` to establish the 28 paper IDs, titles and the slide mapping.
2. `notes/README.md` and `notes/INDEX.md` to understand the existing note layers.
3. `notes/00-meta/01-维护规范.md` and `notes/00-meta/02-材料与可信度.md` to preserve source roles.
4. Each paper PDF for methods, results, tables, figures and limitations.
5. The matching `notes/03-papers/` file, topic note or dissertation passage as a navigation and comparison aid.

The 28 PDFs are the first-pass deep-reading set. The dissertation and slides are supporting sources. The video transcript is useful for spoken positions only. It contains known transcription errors, so it cannot establish exact numbers or terminology without a paper or slide check.

## Source roles

Record one of these roles for every source claim:

- `primary_paper`: the supplied paper PDF or an official published version.
- `author_dissertation`: the supplied dissertation, used for broader framing or exact author-reported details.
- `author_slides`: the supplied slides, used for presentation structure and stated emphasis.
- `author_notes`: the supplied notes, used for navigation and synthesis.
- `author_episode`: a Rho episode or current repository record with a concrete observed run.
- `external_primary`: an externally retrieved primary paper, benchmark release or official documentation.
- `secondary_metadata`: a search result or index record that has not been inspected as full text.

Never use `secondary_metadata` as sole support for a methods, results, novelty or causal claim.

## Deep-reading record

Read the full relevant paper sections rather than relying on an abstract summary. For each paper, locate:

- the problem and intended user or agent;
- task, environment, data and unit of evaluation;
- intervention, baseline and comparison conditions;
- evaluator or ground truth and how it is obtained;
- primary and secondary metrics with denominators and aggregation;
- ablations, robustness checks, human evaluation or qualitative review;
- reported result and uncertainty;
- limitations, threats to validity and transfer conditions.

If a figure or table carries the evidence, inspect it and record the figure or table number. If PDF text extraction is incomplete, use the PDF reading workflow or a rendered page and record the page as an image-checked locator.

## Targeted network expansion

Search the network only after a local gap is named. Start from a question such as “which evaluation designs test long-running human-Agent work-state continuity?” and choose primary or authoritative sources. Record the query, URL or DOI, retrieval date, access level and the exact proposition supported.

Do not bulk-download or redistribute full text. Keep derived notes and bibliographic metadata in the package. When an external source is abstract-only, keep its evidence level at `metadata_only` and add it to the reading queue.

## Conflict and missing evidence

When sources disagree, preserve both values and their source locators. Explain the likely cause only when the sources establish it. Use `unknown`, `not_reported`, `conflict` and `access_limited` as explicit statuses. Do not resolve a conflict by averaging numbers or choosing the larger result.
