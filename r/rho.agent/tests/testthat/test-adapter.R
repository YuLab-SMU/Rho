test_that("framed messages round trip without stdout parsing", {
  connection <- rawConnection(raw(), open = "w+b")
  on.exit(close(connection), add = TRUE)
  message <- list(
    protocol_version = 1L,
    id = "evt_test",
    kind = "event",
    timestamp = "2026-07-15T00:00:00Z",
    payload = list(type = "test", ok = TRUE)
  )

  rho_write_frame(connection, message)
  seek(connection, where = 0L, origin = "start")
  decoded <- rho_read_frame(connection)

  expect_identical(decoded$id, "evt_test")
  expect_true(decoded$payload$ok)
})

test_that("aisdk workspace tools target the broker boundary", {
  skip_if_not_installed("aisdk")
  tools <- rho_create_workspace_tools()

  expect_identical(
    vapply(tools, function(tool) tool$name, character(1L)),
    c("get_workspace_snapshot", "inspect_r_object", "run_r", "propose_file_edit")
  )
  expect_identical(tools[[1L]]$meta$rho_approval, "automatic")
  expect_identical(tools[[3L]]$meta$rho_approval, "required")
  expect_identical(tools[[4L]]$meta$rho_approval, "automatic")
})

test_that("workspace snapshot preview is concise and readable", {
  value <- list(execution = list(
    r = list(version = "R version 4.6.0", platform = "x86_64-w64-mingw32", cwd = "D:/project"),
    environment = list(
      project_dir = "D:/project",
      attached_packages = list(values = list(list(name = "ggplot2", version = "4.0.3"))),
      renv = list(status = "absent"),
      bioconductor = list(version = "3.22"),
      render = list(can_render_rmd = TRUE, can_render_qmd = FALSE)
    ),
    objects = list(list(name = "iris"), list(name = "fit"))
  ))

  preview <- rho.agent:::rho_tool_result_preview("get_workspace_snapshot", value)
  expect_match(preview, "Workspace R ready", fixed = TRUE)
  expect_match(preview, "Objects (2): iris, fit", fixed = TRUE)
  expect_match(preview, "ggplot2 4.0.3", fixed = TRUE)
  expect_false(grepl("execution_id", preview, fixed = TRUE))

  serialized <- jsonlite::toJSON(value, auto_unbox = TRUE)
  serialized_preview <- rho.agent:::rho_tool_result_preview(
    "get_workspace_snapshot",
    serialized
  )
  expect_identical(serialized_preview, preview)
  expect_false(grepl("\\\"execution_id\\\"", serialized_preview, fixed = TRUE))
})

test_that("file edit proposals remain structured for desktop review", {
  proposal <- list(
    kind = "rho.file_edit_proposal",
    path = "R/plot.R",
    operation = "insert_at_cursor",
    content = "plot(x)\n"
  )
  preview <- rho.agent:::rho_tool_result_preview("propose_file_edit", proposal)
  parsed <- jsonlite::fromJSON(preview, simplifyVector = FALSE)
  expect_identical(parsed, proposal)
})

test_that("large file edit proposals are not truncated to the default preview limit", {
  proposal <- list(
    kind = "rho.file_edit_proposal",
    path = "R/plot.R",
    operation = "append",
    content = paste(rep("plot(x, y)\n", 500L), collapse = "")
  )
  preview <- rho.agent:::rho_tool_result_preview("propose_file_edit", proposal)
  expect_false(grepl("\\[truncated\\]", preview, fixed = TRUE))
  parsed <- jsonlite::fromJSON(preview, simplifyVector = FALSE)
  expect_identical(parsed, proposal)
})

test_that("broker tool results refresh the workspace identity", {
  requests <- list()
  local_mocked_bindings(
    rho_agent_request = function(type, payload, ...) {
      requests[[length(requests) + 1L]] <<- payload
      if (length(requests) == 1L) {
        return(list(workspace = list(
          kernel_instance_id = "kernel_1",
          state_revision = 2L,
          project_revision = 0L
        )))
      }
      list(ok = TRUE)
    },
    .package = "rho.agent"
  )
  rho_agent_set_workspace_identity(list(
    kernel_instance_id = "kernel_1",
    state_revision = 1L,
    project_revision = 0L
  ))

  rho.agent:::rho_broker_tool_request("workspace.execute", list(code = "x <- 1"))
  rho.agent:::rho_broker_tool_request("workspace.snapshot")

  expect_identical(requests[[1L]]$expected_workspace$state_revision, 1L)
  expect_identical(requests[[2L]]$expected_workspace$state_revision, 2L)
})

test_that("approved mutation request id is consumed by the next run_r call", {
  captured <- NULL
  local_mocked_bindings(
    rho_agent_request = function(type, payload, ...) {
      captured <<- payload
      list(ok = TRUE)
    },
    .package = "rho.agent"
  )
  .rho_agent_state$pending_approval <- list(request_id = "req_approved")

  rho.agent:::rho_broker_tool_request("workspace.execute", list(code = "x <- 1"))

  expect_identical(captured$approval_request_id, "req_approved")
  expect_null(.rho_agent_state$pending_approval)
})

test_that("aisdk session is marked as a Rho desktop session", {
  skip_if_not_installed("aisdk")
  session <- rho_create_aisdk_session(model = NULL)

  expect_s3_class(session, "ChatSession")
  expect_true(session$get_metadata("rho_desktop"))
})

test_that("public aisdk typed events are forwarded as broker frames", {
  skip_if_not_installed("aisdk")
  skip_if_not_installed("R6")
  mock_model <- R6::R6Class(
    "RhoMockModel",
    inherit = aisdk::LanguageModelV1,
    public = list(
      initialize = function() super$initialize("mock", "rho-mock"),
      do_generate = function(params) {
        list(text = "hello", tool_calls = NULL, finish_reason = "stop")
      },
      do_stream = function(params, callback) {
        callback("hello", TRUE)
        list(
          text = "hello",
          tool_calls = NULL,
          finish_reason = "stop",
          usage = list(total_tokens = 2L)
        )
      },
      format_tool_result = function(tool_call_id, tool_name, result_content) {
        list(role = "tool", content = result_content)
      }
    )
  )$new()
  connection <- rawConnection(raw(), open = "w+b")
  on.exit(close(connection), add = TRUE)
  session <- rho_create_aisdk_session(
    model = mock_model,
    tools = list(),
    connection = connection
  )

  rho_run_aisdk_turn(session, "hi", connection = connection)
  total_bytes <- length(rawConnectionValue(connection))
  seek(connection, where = 0L, origin = "start")
  events <- list()
  while (seek(connection) < total_bytes) {
    events[[length(events) + 1L]] <- rho_read_frame(connection)
  }
  types <- vapply(events, function(event) event$payload$type, character(1L))

  expect_true("agent.run_started" %in% types)
  expect_true("chat.text_delta" %in% types)
  expect_true("chat.message_completed" %in% types)
  expect_true("agent.stream_completed" %in% types)
  expect_true("agent.run_state_changed" %in% types)
  expect_true("agent.trace" %in% types)
})

test_that("runtime profile sensitive values are redacted", {
  old_key <- Sys.getenv("RHO_TEST_MODEL_KEY", unset = NA_character_)
  old_url <- Sys.getenv("RHO_TEST_MODEL_URL", unset = NA_character_)
  on.exit({
    if (is.na(old_key)) Sys.unsetenv("RHO_TEST_MODEL_KEY") else Sys.setenv(RHO_TEST_MODEL_KEY = old_key)
    if (is.na(old_url)) Sys.unsetenv("RHO_TEST_MODEL_URL") else Sys.setenv(RHO_TEST_MODEL_URL = old_url)
  }, add = TRUE)
  Sys.setenv(
    RHO_TEST_MODEL_KEY = "rho-secret-key",
    RHO_TEST_MODEL_URL = "https://example.test/v1?signed=rho-secret-url"
  )
  profile <- list(
    api_key_env = "RHO_TEST_MODEL_KEY",
    base_url_env = "RHO_TEST_MODEL_URL",
    base_url = NULL
  )
  values <- rho.agent:::rho_runtime_profile_sensitive_values(profile)
  redacted <- rho.agent:::rho_redact_known_values(
    "key=rho-secret-key url=https://example.test/v1?signed=rho-secret-url",
    values
  )
  expect_false(grepl("rho-secret-key", redacted, fixed = TRUE))
  expect_false(grepl("rho-secret-url", redacted, fixed = TRUE))
  expect_match(redacted, "[REDACTED]", fixed = TRUE)
})
