# Project notes

## When does the city need bikes?
<!-- rho:session c-91aa2e46b1ac1a6c -->

### Question

Compare the hourly demand profile on weekdays and weekends. Keep member and casual riders visible so a later question can use the same table.

### Data and method

- [data/rides/hourly_demand.csv](data/rides/hourly_demand.csv) contains twelve months of repeated weekday and weekend hourly observations.
- [analysis/hourly_demand.R](analysis/hourly_demand.R) aggregates the profile and writes `results/hourly_profile.csv` and `results/monthly_demand.csv`.

### Finding

Weekdays have morning and evening commute peaks. Weekend demand is lower overnight and broader through the middle of the day. See [results/hourly_demand.png](results/hourly_demand.png).

## Who rides at each time of day?
<!-- rho:session c-67f77cfebaba2cea -->

### Question

Summarize member and casual riders by day type and operating period. Identify where weather and season are likely to change the mix.

### Data and method

- The hourly table keeps temperature and rain beside the rider counts.
- [analysis/station_patterns.R](analysis/station_patterns.R) writes [results/rider_mix.csv](results/rider_mix.csv) and the stacked figure.

### Finding

Members dominate weekday commute periods. Casual riders make up more of the midday and weekend volume, which is where a simple temperature or rain sensitivity check would add the most value.

## Which stations need attention first?
<!-- rho:session c-fa24dfd80dfe4bcb -->

### Question

Use the station-by-hour table to find high-pressure stations, their peak hours and the first places to test a rebalancing rule.

### Data and method

- [data/stations/stations.csv](data/stations/stations.csv) holds the station context and capacity.
- [data/stations/station_hourly.csv](data/stations/station_hourly.csv) holds the hourly demand and utilization.
- [analysis/station_patterns.R](analysis/station_patterns.R) writes [results/station_demand.csv](results/station_demand.csv) and [results/station_heatmap.png](results/station_heatmap.png).

### Finding

Downtown and transit-hub stations have the largest commute peaks. Parks and the waterfront shift later into the day. Keep the station table beside the heatmap when deciding where a capacity change or rebalancing trial should start.

## Choices

- Used a compact, synthetic dataset so the example ships without a network download and every value can be inspected.
- Kept repeated observations across months and day types so the figures show seasonality and operating rhythm without pretending to be a city-wide census.
- Used rider type, station area and hour as the shared vocabulary across the tables, scripts and figures.

## To do

- [x] Build the hourly and station tables
- [x] Draw the three question figures
- [x] Put the conclusion in `results/summary.md`
- [ ] Add a real service-day feed and compare the fitted pattern with observed trips
