# PA14 quorum sensing and swarming

*Pseudomonas aeruginosa* PA14 coordinates collective behaviour through two quorum-sensing
systems, las and rhl. This project asks what each system contributes to swarming motility,
whether the two single mutants can rescue each other when grown together, and what the
mutants change in gene expression.

Everything here runs on this machine with R. Scripts go in `analysis/`, what they write goes
in `results/`.

## Data

| File | What it holds |
| --- | --- |
| [data/swarming/single_cultures.csv](data/swarming/single_cultures.csv) | Swarming of wild type and the four single mutants, one dish per row: the colony `area` and `circularity` the imaging software reports, three replicates each. |
| [data/swarming/cocultures.csv](data/swarming/cocultures.csv) | Swarming of wild type, ΔlasI and ΔrhlI grown alone, and of ΔrhlI:ΔlasI mixes at eleven ratios from 1:3 to 1000:1, three replicates each. `ratio_rhlI_to_lasI` reads ΔrhlI first, so 10:1 is ten ΔrhlI cells per ΔlasI cell. |
| [data/rnaseq/counts.csv](data/rnaseq/counts.csv) | Raw RNA-seq counts, one row per gene and one column per sample. |
| [data/rnaseq/samples.csv](data/rnaseq/samples.csv) | What each sample column is: `Media` (MMGluFeMinus, MMGluFePlus, Succinate) × `Strain` (1 wild type, 97 ΔrhlI, 98 ΔlasI, 99 ΔlasIΔrhlI) × `Replicate` (A, B, C). |
| [data/rnaseq/annotation.csv](data/rnaseq/annotation.csv) | Each locus tag's gene name and product. |

The data come with the study
([microPublication Biology, 10.17912/micropub.biology.001326](https://doi.org/10.17912/micropub.biology.001326));
the counts and sample sheet are as distributed with it, and the annotation keeps the three
columns this project reads.

## Notes

`area` is in the units the imaging software reports, so it is compared within the assay and
never across assays. The swarming assay has three replicates per condition.
