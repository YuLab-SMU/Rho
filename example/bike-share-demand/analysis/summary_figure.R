# One-page summary figure for the city bike-share example.
#
# The script reads the compact result tables produced by the two analysis
# scripts and draws one panel for each project question.
#
# Run from the project root: Rscript analysis/summary_figure.R

suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(patchwork)
  library(scales)
})

dir.create("results", showWarnings = FALSE)
hourly <- read.csv("data/rides/hourly_demand.csv", stringsAsFactors = FALSE)
profile <- read.csv("results/hourly_profile.csv", stringsAsFactors = FALSE)
monthly <- read.csv("results/monthly_demand.csv", stringsAsFactors = FALSE)
station <- read.csv("data/stations/station_hourly.csv", stringsAsFactors = FALSE)
station_summary <- read.csv("results/station_demand.csv", stringsAsFactors = FALSE)

p1 <- ggplot(profile, aes(hour, total_rides, colour = day_type)) +
  geom_line(linewidth = 1.1) +
  scale_colour_manual(values = c(Weekday = "#16233b", Weekend = "#e58a3a")) +
  scale_x_continuous(breaks = seq(0, 23, by = 3)) +
  labs(title = "When demand peaks", x = "Hour", y = "Average rides", colour = NULL) +
  theme_minimal(base_size = 9.5) + theme(legend.position = "bottom", panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"))

monthly_total <- monthly %>%
  group_by(month, month_name) %>%
  summarise(member_rides = sum(member_rides), casual_rides = sum(casual_rides), .groups = "drop") %>%
  tidyr::pivot_longer(c(member_rides, casual_rides), names_to = "rider_type", values_to = "rides") %>%
  mutate(rider_type = recode(rider_type, member_rides = "Members", casual_rides = "Casual"))
p2 <- ggplot(monthly_total, aes(factor(month, levels = 1:12), rides, fill = rider_type)) +
  geom_col() + scale_fill_manual(values = c(Members = "#3b82c4", Casual = "#e58a3a")) +
  scale_y_continuous(labels = comma) + labs(title = "Rides follow the seasons", x = "Month", y = "Rides in sample", fill = NULL) +
  theme_minimal(base_size = 9.5) + theme(legend.position = "bottom", panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"))

daily <- hourly %>% group_by(date, day_type) %>% summarise(total_rides = sum(total_rides), temperature_c = mean(temperature_c), .groups = "drop")
p3 <- ggplot(daily, aes(temperature_c, total_rides, colour = day_type)) +
  geom_point(alpha = 0.75, size = 1.8) + geom_smooth(method = "lm", se = FALSE, linewidth = 0.7) +
  scale_colour_manual(values = c(Weekday = "#3b82c4", Weekend = "#e58a3a")) +
  scale_y_continuous(labels = comma) + labs(title = "Weather shapes casual demand", x = "Daily mean temperature (°C)", y = "Rides per day", colour = NULL) +
  theme_minimal(base_size = 9.5) + theme(legend.position = "bottom", panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"))

top <- head(station_summary$station, 10)
heat <- station %>% filter(station %in% top) %>% mutate(station = factor(station, levels = rev(top)))
p4 <- ggplot(heat, aes(hour, station, fill = rides)) +
  geom_tile(colour = "white", linewidth = 0.2) + scale_fill_viridis_c(option = "C") + scale_x_continuous(breaks = seq(0, 23, by = 3)) +
  labs(title = "Station pressure points", x = "Hour", y = NULL, fill = "Rides") +
  theme_minimal(base_size = 8.5) + theme(panel.grid = element_blank(), plot.title = element_text(face = "bold"))

figure <- (p1 | p2) / (p3 | p4) + plot_annotation(
  title = "City bike-share demand overview",
  theme = theme(plot.title = element_text(size = 16, face = "bold", colour = "#16233b"))
)
ggsave("results/summary.png", figure, width = 14, height = 10, dpi = 150, bg = "white")
