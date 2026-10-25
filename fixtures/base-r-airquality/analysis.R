# Monthly ozone in the built-in airquality data (New York, May–September 1973).
# Initial method: keep observations complete across every recorded variable.
args <- commandArgs(trailingOnly = TRUE)
out <- args[1]
# A bounded window for the browser-disconnection acceptance; ordinary use does not wait.
if ("recovery-window" %in% args[-1]) Sys.sleep(6)
observations <- datasets::airquality
included <- observations[complete.cases(observations), ]
months <- sort(unique(observations$Month))
result <- do.call(rbind, lapply(months, function(month) {
  ozone <- included$Ozone[included$Month == month]
  data.frame(id = sprintf("month-%02d", month), month = month,
             n = length(ozone), mean_ozone = mean(ozone))
}))
write.csv(result, file.path(out, "monthly-ozone.csv"), row.names = FALSE)
png(file.path(out, "monthly-ozone.png"), width = 900, height = 600, res = 120)
plot(result$month, result$mean_ozone, type = "b", pch = 19, xaxt = "n",
     xlab = "Month (1973)", ylab = "Mean ozone (ppb)",
     main = "Monthly ozone in New York")
axis(1, at = months, labels = month.abb[months])
invisible(dev.off())
# Completion is separate from execution exit and from scientific review.
files <- c("monthly-ozone.csv", "monthly-ozone.png")
entries <- vapply(files, function(file) {
  p <- file.path(out, file)
  sprintf('{"path":"%s","bytes":%d,"sha256":"%s"}',
          file, as.integer(file.size(p)), unname(tools::sha256sum(p)))
}, "")
writeLines(sprintf('{"schemaVersion":1,"complete":true,"artifacts":[%s]}',
                   paste(entries, collapse = ",")),
           file.path(dirname(out), "inventory.json"))
