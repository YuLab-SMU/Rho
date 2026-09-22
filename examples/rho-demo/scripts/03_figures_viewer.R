# ---- Figures and Viewer ------------------------------------------------
source("R/demo_helpers.R")

latest_plot <- function() {
  plot(
    latest$gdpPercap,
    latest$lifeExp,
    log = "x",
    pch = 19,
    col = as.integer(factor(latest$continent)),
    xlab = "GDP per capita (log scale)",
    ylab = "Life expectancy",
    main = paste("Income and life expectancy", latest_year)
  )
  legend("bottomright", legend = levels(factor(latest$continent)), pch = 19, col = seq_along(levels(factor(latest$continent))), bty = "n")
}

trend_plot <- function() {
  means <- aggregate(lifeExp ~ year + continent, data = clean, FUN = mean)
  plot(
    range(means$year),
    range(means$lifeExp),
    type = "n",
    xlab = "Year",
    ylab = "Mean life expectancy",
    main = "Life expectancy over time"
  )
  for (continent in unique(means$continent)) {
    part <- means[means$continent == continent, ]
    lines(part$year, part$lifeExp, type = "o", pch = 19, col = which(unique(means$continent) == continent))
  }
  legend("topleft", legend = unique(means$continent), lty = 1, pch = 19, col = seq_along(unique(means$continent)), bty = "n")
}

save_demo_plot("output/figures/income-life-expectancy.png", latest_plot)
save_demo_plot("output/figures/life-expectancy-trend.png", trend_plot)

# These two calls are intentionally not hidden in png(); Rho retains them in Plots.
latest_plot()
trend_plot()

report_path <- file.path("output", "rho_demo_report.html")
report_summary <- list(
  life_expectancy = setNames(continent_summary$life_expectancy, continent_summary$continent),
  population = setNames(continent_summary$population, continent_summary$continent)
)
write_demo_report(report_path, report_summary, model)
viewer <- getOption("viewer")
if (is.function(viewer)) viewer(normalizePath(report_path), title = "Rho demo report")
cat("Created two plots and an HTML report. Open Viewer to inspect the report.\n")
