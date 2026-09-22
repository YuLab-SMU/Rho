# ---- Rebuild the report ------------------------------------------------
source("R/demo_helpers.R")
processed <- readRDS("data/processed/continent_summary.rds")
model_results <- readRDS("data/processed/model_results.rds")
report_summary <- list(
  life_expectancy = setNames(processed$life_expectancy, processed$continent),
  population = setNames(processed$population, processed$continent)
)
report_model <- structure(list(coefficients = model_results$coefficients), class = "lm")
write_demo_report("output/rho_demo_report.html", report_summary, report_model)
cat("Report rebuilt from processed RDS files.\n")
