library(dplyr)
library(tibble)
library(ggplot2)
raw <- read.csv("data/raw/gapminder.csv", fileEncoding = "UTF-8")
clean <- as_tibble(raw) |>
  mutate(continent = as.character(continent), log_gdp = log10(gdpPercap))
summary_by_year <- clean |>
  group_by(continent, year) |>
  summarise(life_expectancy = mean(lifeExp), .groups = "drop")
model <- lm(lifeExp ~ log_gdp + continent, data = clean)
saveRDS(clean, "data/processed/clean.rds")
scatter <- ggplot(filter(clean, year == 2007), aes(gdpPercap, lifeExp, colour = continent)) +
  geom_point(size = 2, alpha = 0.8) + scale_x_log10() + theme_minimal(base_size = 13) +
  labs(title = "Income and life expectancy, 2007", x = "GDP per capita (log scale)", y = "Life expectancy")
scatter
facet <- scatter + facet_wrap(~continent)
facet
trend <- ggplot(summary_by_year, aes(year, life_expectancy, colour = continent)) +
  geom_line(linewidth = 1) + theme_minimal(base_size = 13) +
  labs(title = "Life expectancy over time", y = "Mean life expectancy")
trend
ggsave("output/figures/trend.png", trend, width = 8, height = 5, dpi = 150)
cat("Analysis complete:", nrow(clean), "rows\n")
