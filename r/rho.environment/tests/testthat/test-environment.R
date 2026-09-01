test_that("dispatcher rejects arbitrary actions", {
  expect_error(
    rho_environment_dispatch(list(action = "eval", code = "system('true')")),
    "unsupported rho.environment action"
  )
})

test_that("observation is read-only and identifies every library installation", {
  project <- tempfile("rho-environment-project-")
  dir.create(project)
  before <- list.files(project, all.files = TRUE, recursive = TRUE)
  observation <- rho_environment_observe(project)
  after <- list.files(project, all.files = TRUE, recursive = TRUE)
  expect_identical(after, before)
  expect_identical(observation$schema, 1L)
  expect_true(length(observation$library_paths) >= 1L)
  expect_true(is.list(observation$installations))
})
