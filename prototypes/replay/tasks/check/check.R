# Checks for stats.R. Leave this file as it is: fix stats.R until every check passes.
# The run's output directory is the first argument; results.csv records every check.
out <- commandArgs(trailingOnly = TRUE)[1]
source("stats.R")

checks <- list(
  list(name = "weighted_mean", expected = 6.5, actual = function() weighted_mean(c(2, 4, 6, 8), c(1, 1, 1, 5))),
  list(name = "trimmed_mean", expected = 2.5, actual = function() trimmed_mean(c(1, 2, 3, 100), 0.25)),
  list(name = "zscore", expected = 1, actual = function() zscore(c(2, 4, 6))[3])
)
results <- do.call(rbind, lapply(checks, function(k) {
  got <- tryCatch(k$actual(), error = function(e) NA_real_)
  data.frame(check = k$name, expected = k$expected, actual = got,
             passed = isTRUE(abs(got - k$expected) < 1e-9))
}))

if (!is.na(out)) {
  path <- file.path(out, "results.csv")
  write.csv(results, path, row.names = FALSE)
  manifest <- list(schemaVersion = 1L, complete = TRUE, artifacts = list(list(
    path = "results.csv", bytes = unname(file.size(path)),
    sha256 = digest::digest(path, algo = "sha256", file = TRUE))))
  writeLines(jsonlite::toJSON(manifest, auto_unbox = TRUE), file.path(dirname(out), "inventory.json"))
}

print(results, row.names = FALSE)
failed <- results$check[!results$passed]
if (length(failed)) stop("checks failed: ", paste(failed, collapse = ", "))
cat("all checks passed\n")
