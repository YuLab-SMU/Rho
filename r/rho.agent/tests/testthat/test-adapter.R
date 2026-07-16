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
    c("get_workspace_snapshot", "inspect_r_object", "run_r")
  )
  expect_identical(tools[[1L]]$meta$rho_approval, "automatic")
  expect_identical(tools[[3L]]$meta$rho_approval, "required")
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
