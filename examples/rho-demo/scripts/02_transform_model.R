# ---- Transform and model -----------------------------------------------
model <- lm(lifeExp ~ log_gdp + continent, data = clean)
model_summary <- summary(model)
model_coefficients <- coef(model)
model_results <- list(
  formula = formula(model),
  coefficients = model_coefficients,
  r_squared = unname(model_summary$r.squared),
  observations = nrow(clean)
)

saveRDS(model_results, "data/processed/model_results.rds")
cat("Model R-squared:", format(round(model_results$r_squared, 3)), "\n")
print(model_coefficients)
