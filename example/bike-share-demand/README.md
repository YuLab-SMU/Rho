# City bike-share demand

This finished example asks a familiar operational question: **when and where do people need shared bikes?** It uses a small, curated example dataset so the project is readable on a laptop and easy to continue with an Agent. The values are synthetic but shaped to preserve the patterns a city operator would look for.

## Questions

1. When does demand peak on weekdays and weekends?
2. How does the mix of members and casual riders change through the day and across the year?
3. Which stations have the strongest pressure points for rebalancing?

## Start here

- [results/summary.md](results/summary.md) — the three answers in one place.
- [results/summary.png](results/summary.png) — the overview figure.
- [project-notes.md](project-notes.md) — the working record, decisions and file map.

## Run the analyses

From this project folder, run:

```sh
Rscript analysis/hourly_demand.R
Rscript analysis/station_patterns.R
Rscript analysis/summary_figure.R
```

The scripts read the CSV files under `data/`, write compact tables to `results/` and redraw the figures. They use `ggplot2`, `dplyr`, `tidyr`, `patchwork` and `scales`.

## Questions to ask next

- Compare the morning and evening peaks by station and identify where the direction of rebalancing is likely to change.
- Add a service-day field and test whether rain changes casual demand more than member demand.
- Pick one station, inspect its hourly rows in the table, and propose a simple capacity rule for the next operating season.
