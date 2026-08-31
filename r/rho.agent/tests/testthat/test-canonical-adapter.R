test_that("snapshot is provider neutral and capability accurate", {
  snapshot <- rho_agent_provider_snapshot()
  expect_true(snapshot$supports_resume)
  expect_true(snapshot$supports_cancel)
  expect_setequal(
    snapshot$capability_ids,
    c("workspace.inspect", "workspace.run_r", "project.apply_patch", "network.fetch", "artifact.commit")
  )
})

test_that("visible, plan, tool, and terminal events translate canonically", {
  expect_identical(
    rho_translate_aisdk_event(list(type = "text_delta", cursor = 1L, text = "visible"))$kind,
    "message_delta"
  )
  expect_identical(
    rho_translate_aisdk_event(list(type = "mission_plan", mission_id = "p1", steps = "inspect"))$kind,
    "plan_replaced"
  )
  tool <- rho_translate_aisdk_event(list(
    type = "tool_request", tool = "run_r", call_id = "c1", arguments = list(code = "x <- 1")
  ))
  expect_identical(tool$capability_id, "workspace.run_r")
  expect_identical(tool$operation_id, "operation_aisdk_c1")
  expect_identical(rho_translate_aisdk_event(list(type = "complete"))$outcome, "completed")
})

test_that("private reasoning is discarded", {
  expect_null(rho_translate_aisdk_event(list(
    type = "private_thinking", text = "CANARY_PRIVATE_REASONING"
  )))
})

test_that("child environment is exact allowlist", {
  child <- rho_agent_child_environment(c(AISDK_PROVIDER_TOKEN = "CANARY_SECRET"))
  expect_identical(names(child), "AISDK_PROVIDER_TOKEN")
  expect_error(
    rho_agent_child_environment(c(DATABASE_URL = "CANARY_DATABASE")),
    "not allowlisted"
  )
})

test_that("event and plan bounds fail closed", {
  expect_error(
    rho_translate_aisdk_event(list(type = "text_delta", cursor = 0L, text = strrep("x", 130L * 1024L))),
    "byte bound"
  )
  expect_error(
    rho_translate_aisdk_event(list(type = "mission_plan", mission_id = "large", steps = as.character(seq_len(65L)))),
    "step bound"
  )
})
