# Differential expression of PA14 quorum-sensing mutants vs wild type
#
# Reads data/rnaseq/counts.csv, samples.csv and annotation.csv and writes
#   results/rnaseq_differential_expression.csv  only the calls passing
#                                               FDR < 0.05 and |log2FC| >= 1,
#                                               one row per gene and contrast
#   results/rnaseq_de_summary.csv               genes changed per contrast
#   results/rnaseq_mutant_overlap.csv           overlap of the two single mutants,
#                                               double-mutant sharing and additivity
#   results/rnaseq_sensitivity.csv              per-medium fits and default Cook's filter
#   results/rnaseq_top_genes.csv                strongest genes per contrast
#   results/rnaseq_differential_expression.png  four-panel figure
#
# Run from the project root:  Rscript analysis/rnaseq_differential_expression.R
#
# Design: one DESeq2 model on all 36 samples with the twelve medium x strain
# groups (a saturated model equivalent to medium * strain). Each mutant is then
# compared with wild type within each medium by a group contrast. Dispersion is
# estimated across all groups, which is more stable than three separate 12-sample
# fits; the per-medium sensitivity fit is written to rnaseq_sensitivity.csv.
#
# The annotation file has unquoted commas inside some product names, so it is
# parsed by splitting each line on its first two commas rather than with read.csv.
#
# A gene is called changed when padj < 0.05 and |log2FoldChange| >= 1 (two-fold).
# Cook's distance outliers are flagged but not removed: with three replicates the
# default filter removes five genes from every contrast, including rhlI and lasB.
# Turning it off changes each contrast's changed-gene count by at most four genes.

suppressPackageStartupMessages({
  library(DESeq2)
  library(dplyr)
  library(tidyr)
  library(ggplot2)
  library(patchwork)
  library(scales)
})

dir.create("results", showWarnings = FALSE)

mutant_labels <- c("1" = "Wild type", "97" = "ΔrhlI", "98" = "ΔlasI",
                   "99" = "ΔlasIΔrhlI")
mutant_short <- c("97" = "ΔrhlI\n(97)", "98" = "ΔlasI\n(98)",
                  "99" = "ΔlasIΔrhlI\n(99)")
media_short <- c("MMGluFeMinus" = "MMGlu Fe−",
                 "MMGluFePlus"  = "MMGlu Fe+",
                 "Succinate"    = "Succinate")

## ---- data ----------------------------------------------------------------

counts <- read.csv("data/rnaseq/counts.csv", row.names = 1, check.names = FALSE)
samples <- read.csv("data/rnaseq/samples.csv", stringsAsFactors = FALSE)

if (!setequal(colnames(counts), samples$AzentaName)) {
  stop("Count columns and sample sheet names do not match")
}
counts <- counts[, samples$AzentaName]

parse_annotation <- function(path) {
  lines <- readLines(path, warn = FALSE)
  parts <- strsplit(lines[-1], ",", fixed = TRUE)
  data.frame(
    locus_tag = vapply(parts, `[`, "", 1),
    gene      = vapply(parts, function(x) if (length(x) >= 2) x[2] else "", ""),
    product   = vapply(parts, function(x) if (length(x) >= 3) {
      paste(x[-(1:2)], collapse = ",")
    } else "", ""),
    stringsAsFactors = FALSE
  )
}

annot <- parse_annotation("data/rnaseq/annotation.csv")
annot <- annot[!duplicated(annot$locus_tag), ]
rownames(annot) <- annot$locus_tag

if (any(!rownames(counts) %in% annot$locus_tag)) {
  stop("Some count rows have no annotation")
}

meta <- samples
rownames(meta) <- meta$AzentaName
meta$Strain <- factor(meta$Strain, levels = c(1, 97, 98, 99))
meta$Media <- factor(meta$Media,
                     levels = c("MMGluFeMinus", "MMGluFePlus", "Succinate"))
group_levels <- as.vector(t(outer(levels(meta$Media), levels(meta$Strain),
                                  paste, sep = "_")))
meta$Group <- factor(paste(meta$Media, meta$Strain, sep = "_"),
                     levels = group_levels)

## ---- model ---------------------------------------------------------------

keep <- rowSums(counts >= 10) >= 3
counts_keep <- counts[keep, ]
cat("Genes with >= 10 counts in >= 3 samples:", nrow(counts_keep), "of",
    nrow(counts), "\n")

dds <- DESeqDataSetFromMatrix(countData = counts_keep, colData = meta,
                              design = ~ Group)
dds <- DESeq(dds, fitType = "local", quiet = TRUE)

# Same Cook's distance rule DESeq2 applies inside results(); used only to flag.
p_model <- ncol(model.matrix(design(dds), colData(dds)))
n_samples <- ncol(dds)
cooks_cutoff <- qf(0.99, p_model, n_samples - p_model)
cooks <- assays(dds)[["cooks"]]
cooks_outlier <- apply(cooks, 1, function(x) any(x > cooks_cutoff, na.rm = TRUE))
cat("Cook's outlier cutoff:", round(cooks_cutoff, 2), "- flagged genes:",
    sum(cooks_outlier), "\n")

extract_contrast <- function(medium, mut) {
  con <- c("Group", paste(medium, mut, sep = "_"), paste(medium, "1", sep = "_"))
  r <- results(dds, contrast = con, alpha = 0.05, cooksCutoff = FALSE)
  rs <- suppressMessages(lfcShrink(dds, contrast = con, type = "normal"))
  d <- data.frame(
    comparison   = paste(medium, mut, sep = "_"),
    media        = medium,
    strain       = mut,
    mutant       = unname(mutant_labels[mut]),
    locus_tag    = rownames(r),
    gene         = annot[rownames(r), "gene"],
    product      = annot[rownames(r), "product"],
    baseMean     = r$baseMean,
    log2FC       = r$log2FoldChange,
    lfcSE        = r$lfcSE,
    stat         = r$stat,
    pvalue       = r$pvalue,
    padj         = r$padj,
    log2FC_shrunk = rs$log2FoldChange,
    lfcSE_shrunk  = rs$lfcSE,
    cooks_outlier = unname(cooks_outlier[rownames(r)]),
    stringsAsFactors = FALSE
  )
  d$significant_FDR05 <- !is.na(d$padj) & d$padj < 0.05
  d$significant_2fold <- d$significant_FDR05 & abs(d$log2FC) >= 1
  d$direction <- ifelse(!d$significant_2fold, "not changed",
                        ifelse(d$log2FC > 0, "up", "down"))
  d
}

res_list <- list()
for (medium in levels(meta$Media)) {
  for (mut in levels(meta$Strain)[-1]) {
    key <- paste(medium, mut, sep = "_")
    res_list[[key]] <- extract_contrast(medium, mut)
  }
}

de <- do.call(rbind, res_list)
rownames(de) <- NULL

# The written table is compact: only the calls passing FDR < 0.05 and
# |log2FC| >= 1, with the columns used for interpretation.
de_out <- de[de$significant_2fold,
             c("comparison", "media", "strain", "mutant", "locus_tag", "gene",
               "product", "baseMean", "log2FC", "lfcSE", "pvalue", "padj",
               "log2FC_shrunk", "direction", "cooks_outlier")]
num_cols <- c("baseMean", "log2FC", "lfcSE", "pvalue", "padj", "log2FC_shrunk")
de_out[num_cols] <- lapply(de_out[num_cols], function(x) signif(x, 6))
write.csv(de_out, "results/rnaseq_differential_expression.csv",
          row.names = FALSE, fileEncoding = "UTF-8")

## ---- per-contrast summary -------------------------------------------------

de_summary <- de %>%
  group_by(comparison, media, strain, mutant) %>%
  summarise(
    genes_tested    = sum(!is.na(padj)),
    DE_FDR05        = sum(significant_FDR05),
    DE_FDR05_2fold  = sum(significant_2fold),
    up              = sum(direction == "up"),
    down            = sum(direction == "down"),
    cooks_outlier_genes = sum(cooks_outlier),
    .groups = "drop"
  ) %>%
  arrange(match(media, levels(meta$Media)), match(strain, levels(meta$Strain)))

write.csv(de_summary, "results/rnaseq_de_summary.csv",
          row.names = FALSE, fileEncoding = "UTF-8")

## ---- overlap of the single mutants and double-mutant sharing --------------

sig_loci <- function(key) {
  d <- res_list[[key]]
  d$locus_tag[d$significant_2fold]
}

universe <- sum(!is.na(res_list[[1]]$padj))

overlap_rows <- lapply(levels(meta$Media), function(m) {
  d97 <- res_list[[paste(m, "97", sep = "_")]]
  d98 <- res_list[[paste(m, "98", sep = "_")]]
  d99 <- res_list[[paste(m, "99", sep = "_")]]
  a <- sig_loci(paste(m, "97", sep = "_"))
  b <- sig_loci(paste(m, "98", sep = "_"))
  d <- sig_loci(paste(m, "99", sep = "_"))
  both <- intersect(a, b)
  union_ab <- union(a, b)

  same_direction <- sum(
    sign(d97$log2FC[match(both, d97$locus_tag)]) ==
      sign(d98$log2FC[match(both, d98$locus_tag)])
  )

  pred <- d97$log2FC + d98$log2FC
  ok <- !is.na(pred) & !is.na(d99$log2FC) & !is.na(d99$padj) & d99$padj < 0.05
  fit <- lm(d99$log2FC[ok] ~ pred[ok])

  data.frame(
    media               = m,
    n97                 = length(a),
    n98                 = length(b),
    both                = length(both),
    only97              = length(setdiff(a, b)),
    only98              = length(setdiff(b, a)),
    jaccard             = length(both) / length(union_ab),
    same_direction      = same_direction,
    p_overlap           = phyper(length(both) - 1, length(a),
                                 universe - length(a), length(b),
                                 lower.tail = FALSE),
    lfc_cor_all         = cor(d97$log2FC, d98$log2FC, use = "complete.obs"),
    lfc_cor_union       = cor(d97$log2FC[match(union_ab, d97$locus_tag)],
                              d98$log2FC[match(union_ab, d98$locus_tag)]),
    n99                 = length(d),
    n99_in_both         = sum(d %in% both),
    n99_in_one          = sum(d %in% union_ab & !d %in% both),
    n99_new             = sum(!d %in% union_ab),
    additivity_n        = sum(ok),
    additivity_slope    = unname(coef(fit)[2]),
    additivity_r2       = summary(fit)$r.squared,
    additivity_cor      = cor(pred[ok], d99$log2FC[ok]),
    stringsAsFactors = FALSE
  )
})
overlap <- do.call(rbind, overlap_rows)
write.csv(overlap, "results/rnaseq_mutant_overlap.csv",
          row.names = FALSE, fileEncoding = "UTF-8")

## ---- sensitivity of the per-contrast calls --------------------------------
# Alternative 1: fit each medium separately (12 samples, design ~ Strain).
# Alternative 2: keep the combined model but use DESeq2's default Cook's filter.

sens_rows <- lapply(names(res_list), function(key) {
  d_primary <- res_list[[key]]
  m <- d_primary$media[1]
  mut <- d_primary$strain[1]
  idx <- meta$Media == m
  ms <- droplevels(meta[idx, ])
  d_alt <- DESeqDataSetFromMatrix(countData = counts_keep[, idx],
                                  colData = ms, design = ~ Strain)
  d_alt <- DESeq(d_alt, fitType = "local", quiet = TRUE)
  r_alt <- results(d_alt, contrast = c("Strain", mut, "1"),
                   alpha = 0.05, cooksCutoff = FALSE)
  sig_alt <- !is.na(r_alt$padj) & r_alt$padj < 0.05 & abs(r_alt$log2FoldChange) >= 1

  con <- c("Group", paste(m, mut, sep = "_"), paste(m, "1", sep = "_"))
  r_def <- results(dds, contrast = con, alpha = 0.05)
  sig_def <- !is.na(r_def$padj) & r_def$padj < 0.05 & abs(r_def$log2FoldChange) >= 1

  sig_primary <- d_primary$significant_2fold
  p_locus <- d_primary$locus_tag

  data.frame(
    comparison            = key,
    primary_DE            = sum(sig_primary),
    per_medium_DE         = sum(sig_alt),
    per_medium_shared     = sum(sig_primary & sig_alt),
    per_medium_jaccard    = sum(sig_primary & sig_alt) / sum(sig_primary | sig_alt),
    per_medium_lfc_cor    = cor(d_primary$log2FC,
                                r_alt$log2FoldChange[match(p_locus, rownames(r_alt))],
                                use = "complete.obs"),
    cooks_default_DE      = sum(sig_def),
    cooks_default_shared  = sum(sig_primary & sig_def),
    cooks_default_jaccard = sum(sig_primary & sig_def) / sum(sig_primary | sig_def),
    cooks_default_lfc_cor = cor(d_primary$log2FC,
                                r_def$log2FoldChange[match(p_locus, rownames(r_def))],
                                use = "complete.obs"),
    stringsAsFactors = FALSE
  )
})
sensitivity <- do.call(rbind, sens_rows)
write.csv(sensitivity, "results/rnaseq_sensitivity.csv",
          row.names = FALSE, fileEncoding = "UTF-8")

## ---- strongest genes per contrast ----------------------------------------

top_rows <- list()
for (key in names(res_list)) {
  d <- res_list[[key]]
  sig <- d[d$significant_2fold, ]
  by_padj <- head(sig[order(sig$padj), ], 10)
  by_fold <- sig[sig$baseMean >= 100, ]
  by_fold <- head(by_fold[order(-abs(by_fold$log2FC)), ], 10)

  add_rank <- function(x, how) {
    if (nrow(x) == 0) return(NULL)
    data.frame(
      rank_by   = how,
      rank      = seq_len(nrow(x)),
      comparison = key,
      media     = x$media,
      strain    = x$strain,
      mutant    = x$mutant,
      locus_tag = x$locus_tag,
      gene      = x$gene,
      product   = x$product,
      baseMean  = x$baseMean,
      log2FC    = x$log2FC,
      padj      = x$padj,
      stringsAsFactors = FALSE
    )
  }
  top_rows[[paste(key, "padj", sep = "_")]] <- add_rank(by_padj, "padj")
  top_rows[[paste(key, "fold", sep = "_")]] <- add_rank(by_fold, "abs_log2FC")
}
top_genes <- do.call(rbind, top_rows)
rownames(top_genes) <- NULL
top_genes$baseMean <- signif(top_genes$baseMean, 6)
top_genes$log2FC <- signif(top_genes$log2FC, 6)
top_genes$padj <- signif(top_genes$padj, 6)
write.csv(top_genes, "results/rnaseq_top_genes.csv",
          row.names = FALSE, fileEncoding = "UTF-8")

## ---- figure ---------------------------------------------------------------

# A. genes changed per contrast, split by direction
bar_df <- de_summary %>%
  select(comparison, media, strain, mutant, up, down) %>%
  tidyr::pivot_longer(c(up, down), names_to = "direction", values_to = "n")
bar_df$direction <- factor(bar_df$direction, levels = c("up", "down"),
                           labels = c("Up", "Down"))
bar_df$mutant_f <- factor(mutant_short[bar_df$strain],
                          levels = mutant_short[c("97", "98", "99")])
bar_df$media_f <- factor(media_short[bar_df$media],
                         levels = media_short[levels(meta$Media)])
de_summary$mutant_f <- factor(mutant_short[de_summary$strain],
                              levels = mutant_short[c("97", "98", "99")])
de_summary$media_f <- factor(media_short[de_summary$media],
                             levels = media_short[levels(meta$Media)])

pA <- ggplot(bar_df, aes(mutant_f, n, fill = direction)) +
  geom_col(width = 0.72) +
  geom_text(data = de_summary,
            aes(x = mutant_f, y = DE_FDR05_2fold, label = DE_FDR05_2fold),
            inherit.aes = FALSE, vjust = -0.35, size = 3) +
  facet_wrap(~ media_f, nrow = 1) +
  scale_fill_manual(values = c(Up = "#c0392b", Down = "#2c6fbb"),
                    name = NULL) +
  scale_y_continuous(expand = expansion(mult = c(0, 0.12))) +
  labs(x = NULL,
       y = "Genes changed (FDR < 0.05, |log2FC| ≥ 1)") +
  theme_bw(base_size = 10) +
  theme(legend.position = "bottom",
        strip.background = element_rect(fill = "grey94", colour = NA),
        panel.grid.minor = element_blank())

# B. overlap of the two single mutants
ov_long <- overlap %>%
  select(media, both, only97, only98) %>%
  tidyr::pivot_longer(c(both, only97, only98),
                      names_to = "category", values_to = "n")
ov_long$category <- factor(ov_long$category,
                           levels = c("both", "only97", "only98"),
                           labels = c("Both mutants", "ΔrhlI only", "ΔlasI only"))
ov_long$media_f <- factor(media_short[ov_long$media],
                          levels = media_short[levels(meta$Media)])

pB <- ggplot(ov_long, aes(media_f, n, fill = category)) +
  geom_col(width = 0.7) +
  scale_fill_manual(values = c("Both mutants" = "#6a3d9a",
                               "ΔrhlI only" = "#e08214",
                               "ΔlasI only" = "#3288bd"),
                    name = NULL) +
  scale_y_continuous(expand = expansion(mult = c(0, 0.08))) +
  labs(x = NULL, y = "Genes changed in 97 and/or 98") +
  theme_bw(base_size = 10) +
  theme(legend.position = "bottom",
        axis.text.x = element_text(angle = 20, hjust = 1),
        panel.grid.minor = element_blank())

# C. log2 fold-change agreement between the single mutants
scatter_rows <- lapply(levels(meta$Media), function(m) {
  d97 <- res_list[[paste(m, "97", sep = "_")]]
  d98 <- res_list[[paste(m, "98", sep = "_")]]
  cat <- ifelse(d97$significant_2fold & d98$significant_2fold, "Both mutants",
                ifelse(d97$significant_2fold, "ΔrhlI only",
                       ifelse(d98$significant_2fold, "ΔlasI only", "Not changed")))
  data.frame(media = m, lfc97 = d97$log2FC, lfc98 = d98$log2FC,
             category = cat, stringsAsFactors = FALSE)
})
scatter <- do.call(rbind, scatter_rows)
scatter$category <- factor(scatter$category,
                           levels = c("Both mutants", "ΔrhlI only",
                                      "ΔlasI only", "Not changed"))
scatter$media_f <- factor(media_short[scatter$media],
                          levels = media_short[levels(meta$Media)])

cor_labels <- overlap %>%
  mutate(media_f = factor(media_short[media],
                          levels = media_short[levels(meta$Media)]),
         label = paste0("r = ", round(lfc_cor_all, 2)))

pC <- ggplot(scatter, aes(lfc97, lfc98)) +
  geom_point(data = subset(scatter, category == "Not changed"),
             colour = "grey75", size = 0.55, alpha = 0.35) +
  geom_point(data = subset(scatter, category != "Not changed"),
             aes(colour = category), size = 0.9, alpha = 0.75) +
  geom_abline(slope = 1, intercept = 0, linetype = "dashed",
              colour = "grey35") +
  geom_hline(yintercept = 0, colour = "grey85") +
  geom_vline(xintercept = 0, colour = "grey85") +
  geom_text(data = cor_labels, aes(x = -9.3, y = 9, label = label),
            hjust = 0, size = 3, inherit.aes = FALSE) +
  facet_wrap(~ media_f, nrow = 1) +
  coord_fixed(xlim = c(-10, 10), ylim = c(-10, 10)) +
  scale_colour_manual(values = c("Both mutants" = "#6a3d9a",
                                 "ΔrhlI only" = "#e08214",
                                 "ΔlasI only" = "#3288bd",
                                 "Not changed" = "grey75"),
                      name = NULL) +
  labs(x = "log2 fold change, ΔrhlI (97) vs wild type",
       y = "log2 fold change, ΔlasI (98) vs wild type") +
  theme_bw(base_size = 10) +
  theme(legend.position = "bottom",
        panel.grid.minor = element_blank())

# D. heatmap of the strongest genes across all samples
top_n <- 6
top_loci <- unique(unlist(lapply(res_list, function(d) {
  s <- d[d$significant_2fold, ]
  head(s$locus_tag[order(s$padj)], top_n)
})))

vsd <- vst(dds, blind = TRUE, fitType = "local")
z <- t(scale(t(assay(vsd)[top_loci, ])))
z[is.na(z)] <- 0

sample_order <- order(meta$Media, meta$Strain, meta$Replicate)
sample_ids <- rownames(meta)[sample_order]
z <- z[, sample_ids]

zdf <- data.frame(
  gene   = rep(rownames(z), times = ncol(z)),
  sample = rep(colnames(z), each = nrow(z)),
  z      = as.vector(z),
  stringsAsFactors = FALSE
)
zdf <- merge(zdf, meta[, c("AzentaName", "Media", "Strain", "Replicate")],
             by.x = "sample", by.y = "AzentaName")
zdf$sample_label <- paste(zdf$Strain, zdf$Replicate, sep = " ")
zdf$sample_label <- factor(zdf$sample_label,
                           levels = unique(zdf$sample_label[order(
                             zdf$Media, zdf$Strain, zdf$Replicate)]))
zdf$media_f <- factor(media_short[zdf$Media],
                      levels = media_short[levels(meta$Media)])

gene_order <- rownames(z)[hclust(dist(z), method = "ward.D2")$order]
zdf$gene <- factor(zdf$gene, levels = gene_order)

gene_label <- ifelse(annot[gene_order, "gene"] == "", gene_order,
                     annot[gene_order, "gene"])
dup <- duplicated(gene_label) | duplicated(gene_label, fromLast = TRUE)
gene_label[dup] <- paste0(gene_label[dup], " (", gene_order[dup], ")")
names(gene_label) <- gene_order

pD <- ggplot(zdf, aes(sample_label, gene, fill = z)) +
  geom_tile() +
  facet_grid(~ media_f, scales = "free_x", space = "free_x") +
  scale_fill_gradient2(low = "#2166ac", mid = "white", high = "#b2182b",
                       limits = c(-2.5, 2.5), oob = squish,
                       name = "z-score") +
  scale_y_discrete(labels = gene_label) +
  labs(x = NULL, y = NULL) +
  theme_bw(base_size = 9) +
  theme(axis.text.x = element_text(angle = 90, hjust = 1, vjust = 0.5,
                                   size = 7),
        axis.text.y = element_text(size = 7),
        panel.grid = element_blank(),
        strip.background = element_rect(fill = "grey94", colour = NA),
        legend.position = "right",
        legend.key.height = unit(0.9, "cm"))

fig <- (pA | pB) / pC / pD +
  plot_layout(widths = c(3, 2), heights = c(1.1, 1, 1.75)) +
  plot_annotation(
    tag_levels = "A",
    caption = paste(
      "A: genes with FDR < 0.05 and |log2FC| ≥ 1 against wild type in the same medium.",
      "B: overlap of the genes changed in ΔrhlI (97) and ΔlasI (98).",
      "C: all genes; dashed line is y = x, r is the Pearson correlation across all genes.",
      "D: top six genes by adjusted p-value per contrast, VST z-scores."
    ),
    theme = theme(plot.tag = element_text(face = "bold", size = 11),
                  plot.caption = element_text(size = 7.5, colour = "grey35",
                                              hjust = 0))
  )

ggsave("results/rnaseq_differential_expression.png", fig,
       width = 14, height = 15, dpi = 300, bg = "white")

cat("\nWrote results/rnaseq_differential_expression.csv\n")
cat("Wrote results/rnaseq_de_summary.csv\n")
cat("Wrote results/rnaseq_mutant_overlap.csv\n")
cat("Wrote results/rnaseq_sensitivity.csv\n")
cat("Wrote results/rnaseq_top_genes.csv\n")
cat("Wrote results/rnaseq_differential_expression.png\n")
