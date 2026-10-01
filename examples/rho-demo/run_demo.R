# Run this file from the project root to populate the Rho workspace.
source("scripts/01_import_clean.R")
source("scripts/02_transform_model.R")
source("scripts/03_figures_viewer.R")
source("scripts/04_report.R")

palette <- c(Africa = "#d95f02", Americas = "#1b9e77", Asia = "#7570b3", Europe = "#e7298a", Oceania = "#66a61e")
labels <- list(
  project = "Rho Gapminder Demo",
  observations = nrow(clean),
  countries = length(unique(clean$country)),
  latest_year = latest_year
)
cat("Rho demo complete:", labels$observations, "observations and", labels$countries, "countries.\n")
