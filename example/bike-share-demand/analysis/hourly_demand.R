# Hourly and seasonal demand in the city bike-share example
#
# Reads data/rides/hourly_demand.csv and writes
#   results/hourly_profile.csv   mean rides by day type and hour
#   results/monthly_demand.csv   monthly totals by rider type and day type
#   results/hourly_demand.png    the two-panel demand figure
#
# Run from the project root: Rscript analysis/hourly_demand.R

suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(patchwork)
  library(scales)
})

dir.create("results", showWarnings = FALSE)
hourly <- read.csv("data/rides/hourly_demand.csv", stringsAsFactors = FALSE)

profile <- hourly %>%
  group_by(day_type, hour) %>%
  summarise(
    member_rides = mean(member_rides),
    casual_rides = mean(casual_rides),
    total_rides = mean(total_rides),
    .groups = "drop"
  ) %>%
  mutate(day_type = factor(day_type, levels = c("Weekday", "Weekend"))) %>%
  arrange(day_type, hour)

monthly <- hourly %>%
  group_by(month, month_name, day_type) %>%
  summarise(
    member_rides = sum(member_rides),
    casual_rides = sum(casual_rides),
    total_rides = sum(total_rides),
    .groups = "drop"
  ) %>%
  arrange(month, day_type)

write.csv(profile, "results/hourly_profile.csv", row.names = FALSE)
write.csv(monthly, "results/monthly_demand.csv", row.names = FALSE)

profile_plot <- ggplot(profile, aes(hour, total_rides, colour = day_type, fill = day_type)) +
  geom_ribbon(aes(ymin = 0, ymax = total_rides), alpha = 0.08, colour = NA) +
  geom_line(linewidth = 1.1) +
  scale_colour_manual(values = c(Weekday = "#16233b", Weekend = "#e58a3a")) +
  scale_fill_manual(values = c(Weekday = "#16233b", Weekend = "#e58a3a")) +
  scale_x_continuous(breaks = seq(0, 23, by = 3)) +
  scale_y_continuous(labels = comma) +
  labs(title = "Hourly demand profile", x = "Hour", y = "Average rides", colour = NULL, fill = NULL) +
  theme_minimal(base_size = 10) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"))

monthly_plot <- monthly %>%
  group_by(month, month_name) %>%
  summarise(
    member_rides = sum(member_rides),
    casual_rides = sum(casual_rides),
    .groups = "drop"
  ) %>%
  tidyr::pivot_longer(c(member_rides, casual_rides), names_to = "rider_type", values_to = "rides") %>%
  mutate(rider_type = recode(rider_type, member_rides = "Members", casual_rides = "Casual"))

season_plot <- ggplot(monthly_plot, aes(factor(month, levels = 1:12), rides, fill = rider_type)) +
  geom_col() +
  scale_fill_manual(values = c(Members = "#3b82c4", Casual = "#e58a3a")) +
  scale_y_continuous(labels = comma) +
  labs(title = "Seasonal total", x = "Month", y = "Rides in sample", fill = NULL) +
  theme_minimal(base_size = 10) +
  theme(legend.position = "bottom", panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"))

ggsave("results/hourly_demand.png", profile_plot + season_plot,
       width = 13, height = 5, dpi = 150, bg = "white")
