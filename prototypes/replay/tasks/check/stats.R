# Summary statistics that check.R relies on.
weighted_mean <- function(x, w) sum(x * w) / length(x)

trimmed_mean <- function(x, trim) {
  x <- sort(x)
  n <- length(x)
  k <- floor(n * trim)
  mean(x[k:(n - k)])
}

zscore <- function(x) (x - mean(x)) / sqrt(mean((x - mean(x))^2))
