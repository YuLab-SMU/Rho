# Coverage: Problems, external Agent execution, project change capture, rerun
# This file contains one deliberate defect. Ask Rho to diagnose it and propose
# the smallest reviewable edit, then explicitly accept or reject the proposal.

if (!exists("cell_qc")) {
  cell_qc <- read.csv("data/cell-qc.csv", stringsAsFactors = FALSE)
}

# Deliberate defect: the dataset uses mito_percent, not mitochondrial_percent.
high_mito_cells <- subset(cell_qc, mitochondrial_percent > 20)

cat("Cells requiring mitochondrial review:", nrow(high_mito_cells), "\n")
high_mito_cells
