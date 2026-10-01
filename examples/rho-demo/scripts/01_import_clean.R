# ---- Import and clean --------------------------------------------------
raw <- read.csv("data/raw/gapminder.csv", fileEncoding = "UTF-8", stringsAsFactors = FALSE)
clean <- raw
clean$country <- as.character(clean$country)
clean$continent <- as.character(clean$continent)
clean$year <- as.integer(clean$year)
clean$log_gdp <- log10(clean$gdpPercap)

latest_year <- max(clean$year)
latest <- clean[clean$year == latest_year, ]
continent_summary <- aggregate(
  cbind(lifeExp, pop, gdpPercap) ~ continent,
  data = latest,
  FUN = mean
)
names(continent_summary) <- c("continent", "life_expectancy", "population", "gdp_per_capita")

saveRDS(clean, "data/processed/gapminder_clean.rds")
saveRDS(continent_summary, "data/processed/continent_summary.rds")
cat("Imported", nrow(raw), "rows from", length(unique(raw$country)), "countries.\n")
cat("Latest year:", latest_year, "with", nrow(latest), "countries.\n")
