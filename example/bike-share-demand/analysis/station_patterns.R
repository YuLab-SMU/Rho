# Station pressure points and rider mix in the city bike-share example
#
# Reads the station and hourly ride tables and writes compact summaries plus
# the heatmap and rider-mix figures.
#
# Run from the project root: Rscript analysis/station_patterns.R

suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(scales)
  library(tidyr)
})

dir.create("results", showWarnings = FALSE)
stations <- read.csv("data/stations/stations.csv", stringsAsFactors = FALSE)
station_hourly <- read.csv("data/stations/station_hourly.csv", stringsAsFactors = FALSE)
hourly <- read.csv("data/rides/hourly_demand.csv", stringsAsFactors = FALSE)

station_summary <- station_hourly %>%
  group_by(station_id, station, area, capacity) %>%
  summarise(
    total_rides = sum(rides),
    peak_hour = hour[which.max(rides)],
    peak_rides = max(rides),
    mean_utilization = mean(utilization),
    peak_utilization = max(utilization),
    .groups = "drop"
  ) %>%
  mutate(
    rebalancing_priority = case_when(
      peak_utilization >= 0.65 ~ "priority",
      peak_utilization >= 0.45 ~ "plan",
      TRUE ~ "watch"
    )
  ) %>%
  arrange(desc(peak_rides))

write.csv(station_summary, "results/station_demand.csv", row.names = FALSE)

periods <- function(hour) {
  case_when(
    hour %in% 7:9 ~ "Morning commute",
    hour %in% 16:18 ~ "Evening commute",
    hour %in% 10:15 ~ "Midday",
    TRUE ~ "Overnight"
  )
}

rider_mix <- hourly %>%
  mutate(period = periods(hour)) %>%
  group_by(day_type, period) %>%
  summarise(
    member_rides = sum(member_rides),
    casual_rides = sum(casual_rides),
    total_rides = sum(total_rides),
    .groups = "drop"
  ) %>%
  mutate(
    period = factor(period, levels = c("Morning commute", "Midday", "Evening commute", "Overnight")),
    casual_share = casual_rides / total_rides
  ) %>%
  arrange(day_type, period)

write.csv(rider_mix, "results/rider_mix.csv", row.names = FALSE)

top <- station_summary %>% slice_head(n = 10)
heat <- station_hourly %>%
  filter(station %in% top$station) %>%
  mutate(station = factor(station, levels = rev(top$station)))

heat_plot <- ggplot(heat, aes(hour, station, fill = rides)) +
  geom_tile(colour = "white", linewidth = 0.25) +
  scale_fill_viridis_c(option = "C", labels = comma) +
  scale_x_continuous(breaks = seq(0, 23, by = 3)) +
  labs(title = "Where the network needs attention", x = "Hour of day", y = NULL, fill = "Rides") +
  theme_minimal(base_size = 10) +
  theme(panel.grid = element_blank(), plot.title = element_text(face = "bold"))

ggsave("results/station_heatmap.png", heat_plot, width = 12, height = 7, dpi = 150, bg = "white")

mix_long <- rider_mix %>%
  select(day_type, period, member_rides, casual_rides) %>%
  pivot_longer(c(member_rides, casual_rides), names_to = "rider_type", values_to = "rides") %>%
  mutate(rider_type = recode(rider_type, member_rides = "Members", casual_rides = "Casual"),
         label = paste(day_type, period, sep = "\n"))

mix_plot <- ggplot(mix_long, aes(label, rides, fill = rider_type)) +
  geom_col() +
  scale_fill_manual(values = c(Members = "#3b82c4", Casual = "#e58a3a")) +
  scale_y_continuous(labels = comma) +
  labs(title = "Who rides, and when", x = NULL, y = "Rides in sample", fill = NULL) +
  theme_minimal(base_size = 10) +
  theme(axis.text.x = element_text(angle = 35, hjust = 1), legend.position = "bottom",
        panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"))

ggsave("results/rider_mix.png", mix_plot, width = 10, height = 6, dpi = 150, bg = "white")
