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
    c(
      "get_workspace_snapshot",
      "inspect_r_object",
      "run_r",
      "initialize_project_environment",
      "restore_project_environment",
      "snapshot_project_environment",
      "install_project_package",
      "update_project_package",
      "remove_project_package",
      "propose_file_edit"
    )
  )
  approvals <- stats::setNames(
    vapply(tools, function(tool) tool$meta$rho_approval, character(1L)),
    vapply(tools, function(tool) tool$name, character(1L))
  )
  expect_identical(approvals[["get_workspace_snapshot"]], "automatic")
  expect_identical(approvals[["propose_file_edit"]], "automatic")
  expect_true(all(approvals[c(
    "run_r", "initialize_project_environment", "restore_project_environment",
    "snapshot_project_environment", "install_project_package",
    "update_project_package", "remove_project_package"
  )] == "required"))
})

test_that("Manifest V2 plugin tools use bounded aisdk schemas and labelled origin", {
  skip_if_not_installed("aisdk")
  definition <- list(
    name = "plugin_csv_metadata_a1b2c3d4",
    contribution_id = "tool.csv.metadata",
    label = "CSV metadata",
    purpose = "Summarize the granted CSV",
    input_schema = list(
      type = "object",
      properties = list(
        path = list(type = "string", minLength = 1L, maxLength = 128L),
        limit = list(type = "integer", minimum = 1L, maximum = 100L)
      ),
      required = list("path")
    ),
    plugin_id = "org.example.csv",
    package_digest = paste(rep("a", 64L), collapse = "")
  )

  tools <- rho_create_workspace_tools(list(definition))
  plugin <- tools[[length(tools)]]
  expect_identical(plugin$name, definition$name)
  expect_identical(plugin$meta$rho_approval, "automatic")
  expect_identical(plugin$meta$rho_plugin_origin$contribution_id, "tool.csv.metadata")
  expect_match(plugin$description, "untrusted project plugin", fixed = TRUE)
  expect_match(plugin$description, "org.example.csv", fixed = TRUE)
  expect_s3_class(plugin$parameters, "z_schema")
  expect_identical(plugin$parameters$type, "object")
  expect_false(plugin$parameters$additionalProperties)
  expect_named(plugin$parameters$properties, c("path", "limit"))
  expect_identical(plugin$parameters$required, list("path"))
  expect_identical(plugin$parameters$properties$path$maxLength, 128L)
  expect_identical(plugin$parameters$properties$limit$maximum, 100L)

  captured <- NULL
  local_mocked_bindings(
    rho_agent_request = function(type, payload, ...) {
      captured <<- list(type = type, payload = payload)
      list(ok = TRUE)
    },
    .package = "rho.agent"
  )
  rho_agent_set_workspace_identity(list(
    kernel_instance_id = "kernel_1",
    state_revision = 1L,
    project_revision = 1L
  ))
  plugin$run(list(path = "data/input.csv", limit = 10L))
  expect_identical(captured$type, "plugin.contribution.invoke")
  expect_identical(
    captured$payload$arguments$contribution_id,
    "tool.csv.metadata"
  )
  expect_identical(
    captured$payload$arguments$input,
    list(path = "data/input.csv", limit = 10L)
  )
})

test_that("plugin schema conversion rejects unsupported R bounds", {
  skip_if_not_installed("aisdk")
  expect_error(
    rho.agent:::rho_plugin_schema_to_aisdk(list(
      type = "string",
      maxLength = .Machine$integer.max + 1
    )),
    "outside the supported R bound"
  )
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

test_that("file edit proposals discard aisdk execution environments", {
  args <- list(
    path = "analysis.R",
    operation = "replace_selection",
    content = "geom_point(size = 5)",
    .envir = new.env(parent = emptyenv())
  )

  proposal <- rho.agent:::rho_file_edit_proposal(args)
  expect_named(proposal, c("kind", "path", "operation", "content"))
  expect_identical(proposal$kind, "rho.file_edit_proposal")
  expect_identical(proposal$path, "analysis.R")
  expect_identical(proposal$operation, "replace_selection")
  expect_identical(proposal$content, "geom_point(size = 5)")
  expect_silent(jsonlite::toJSON(proposal, auto_unbox = TRUE, null = "null"))
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

test_that("run_r previews omit broker internals and decode nested JSON", {
  result <- list(
    execution_id = "exec_internal",
    execution = list(
      ok = TRUE,
      code = "readLines('analysis.R')",
      stdout = "",
      value = "[1] \"geom_point()\"",
      warnings = "package was built under R 4.6.0",
      messages = character(),
      error = NULL,
      traceback = list()
    ),
    events = list(list(type = "busy")),
    workspace = list(state_revision = 4L)
  )
  encoded <- jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")
  preview <- rho.agent:::rho_tool_result_preview("run_r", encoded)

  expect_match(preview, "Result\n[1] \"geom_point()\"", fixed = TRUE)
  expect_match(preview, "Warnings\npackage was built", fixed = TRUE)
  expect_false(grepl("execution_id|state_revision|traceback|events", preview))
})

test_that("run_r previews report concise empty and error states", {
  empty <- rho.agent:::rho_tool_result_preview(
    "run_r",
    list(execution = list(ok = TRUE, stdout = "", value = NULL))
  )
  failed <- rho.agent:::rho_tool_result_preview(
    "run_r",
    list(execution = list(ok = FALSE, error = list(message = "object 'x' not found")))
  )

  expect_identical(empty, "R completed successfully with no printed output.")
  expect_identical(failed, "Error\nobject 'x' not found")
})

test_that("run_r previews report successful response truncation truthfully", {
  preview <- rho.agent:::rho_tool_result_preview(
    "run_r",
    list(
      execution = list(ok = TRUE),
      response_truncated = TRUE,
      response_truncation_reason = "agent_frame_budget"
    )
  )

  expect_identical(
    preview,
    "R completed successfully. Detailed output was omitted because it exceeded the Agent response limit."
  )
})

test_that("correlated responses and identity events refresh transport identity", {
  written <- list()
  frames <- list(
    list(
      kind = "event",
      payload = list(
        type = "workspace.identity",
        identity = list(state_revision = 2L, project_revision = 0L)
      )
    ),
    list(
      kind = "response",
      payload = list(
        request_id = NULL,
        ok = TRUE,
        workspace = list(state_revision = 3L, project_revision = 0L),
        result = list(ok = TRUE)
      )
    )
  )
  local_mocked_bindings(
    rho_write_frame = function(connection, message) {
      written[[length(written) + 1L]] <<- message
      frames[[2L]]$payload$request_id <<- message$id
    },
    rho_read_frame = function(connection) {
      frame <- frames[[1L]]
      frames <<- frames[-1L]
      frame
    },
    .package = "rho.agent"
  )
  .rho_agent_state$workspace_identity <- list(state_revision = 1L, project_revision = 0L)

  result <- rho_agent_request("workspace.snapshot", connection = "mock")

  expect_true(result$ok)
  expect_length(written, 1L)
  expect_identical(.rho_agent_state$workspace_identity$state_revision, 3L)
})

test_that("error responses refresh transport identity before raising", {
  request_id <- NULL
  local_mocked_bindings(
    rho_write_frame = function(connection, message) request_id <<- message$id,
    rho_read_frame = function(connection) list(
      kind = "response",
      payload = list(
        request_id = request_id,
        ok = FALSE,
        error = "workspace state changed",
        workspace = list(state_revision = 4L, project_revision = 1L)
      )
    ),
    .package = "rho.agent"
  )
  .rho_agent_state$workspace_identity <- list(state_revision = 3L, project_revision = 0L)

  expect_error(
    rho_agent_request("workspace.snapshot", connection = "mock"),
    "workspace state changed",
    fixed = TRUE
  )
  expect_identical(.rho_agent_state$workspace_identity$state_revision, 4L)
  expect_identical(.rho_agent_state$workspace_identity$project_revision, 1L)
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

test_that("approved environment request injects canonical broker arguments", {
  captured <- NULL
  local_mocked_bindings(
    rho_agent_request = function(type, payload, ...) {
      captured <<- list(type = type, payload = payload)
      list(ok = TRUE)
    },
    .package = "rho.agent"
  )
  .rho_agent_state$pending_approval <- list(
    request_id = "env_req_1",
    request_type = "environment.snapshot",
    arguments = list(
      operation = "snapshot",
      project_root = "D:/Rho",
      repositories = NULL,
      bioconductor = NULL
    )
  )

  rho.agent:::rho_broker_tool_request("environment.snapshot", list())

  expect_identical(captured$type, "environment.snapshot")
  expect_identical(captured$payload$approval_request_id, "env_req_1")
  expect_identical(captured$payload$arguments$project_root, "D:/Rho")
  expect_null(.rho_agent_state$pending_approval)
})

test_that("aisdk session is marked as a Rho desktop session", {
  skip_if_not_installed("aisdk")
  session <- rho_create_aisdk_session(model = NULL)

  expect_s3_class(session, "ChatSession")
  expect_true(session$get_metadata("rho_desktop"))
})

test_that("desktop aisdk sessions preserve typed capability routes", {
  skip_if_not_installed("aisdk")
  routes <- list(
    agent.chat = list(
      model = "deepseek:deepseek-v4-flash",
      type = "language",
      required_model_capabilities = character()
    )
  )
  session <- rho_create_aisdk_session(
    model = NULL,
    tools = list(),
    capability_models = routes
  )

  effective <- session$get_metadata("capability_models")
  expect_identical(names(effective), "agent.chat")
  expect_identical(effective[[1L]]$model, "deepseek:deepseek-v4-flash")
  expect_identical(effective[[1L]]$type, "language")
})

test_that("runtime profile admits exactly one matching non-secret route", {
  skip_if_not_installed("aisdk")
  profile <- list(
    settings_revision = 9L,
    route_capability = "agent.act",
    profile_id = "model-act",
    provider_kind = "registered",
    runtime_provider_id = "rho_profile_provider_act",
    registered_provider_id = "deepseek",
    model_id = "deepseek-v4-flash",
    api_key_env = "DEEPSEEK_API_KEY",
    api_key_required = TRUE,
    base_url = NULL,
    base_url_env = NULL,
    wire_api = NULL,
    disable_stream_options = FALSE,
    tool_calling = "yes",
    capability_routes = list(list(
      capability = "agent.act",
      model = "deepseek:deepseek-v4-flash",
      model_type = "language",
      required_model_capabilities = list("function_call")
    ))
  )

  routes <- rho.agent:::rho_runtime_profile_capability_models(
    profile,
    "deepseek:deepseek-v4-flash"
  )
  expect_identical(names(routes), "agent.act")
  expect_identical(routes[[1L]]$required_model_capabilities, "function_call")

  profile$capability_routes[[1L]]$capability <- "image.generate"
  expect_error(
    rho.agent:::rho_runtime_profile_capability_models(profile),
    "does not match"
  )
  profile$capability_routes <- c(profile$capability_routes, profile$capability_routes)
  expect_error(
    rho.agent:::rho_runtime_profile_capability_models(profile),
    "exactly one"
  )
})

test_that("registered runtime startup preserves the canonical routed model", {
  skip_if_not_installed("aisdk")
  skip_if_not_installed("aisdk.providers")
  credential_name <- "RHO_TEST_REGISTERED_PROVIDER_KEY"
  previous <- Sys.getenv(credential_name, unset = NA_character_)
  on.exit({
    if (is.na(previous)) {
      Sys.unsetenv(credential_name)
    } else {
      do.call(Sys.setenv, stats::setNames(list(previous), credential_name))
    }
  }, add = TRUE)
  do.call(Sys.setenv, stats::setNames(list("disposable-no-network-key"), credential_name))

  profile <- list(
    settings_revision = 10L,
    route_capability = "agent.act",
    profile_id = "model-act",
    provider_kind = "registered",
    runtime_provider_id = "rho_profile_provider_act",
    registered_provider_id = "deepseek",
    model_id = "deepseek-v4-flash",
    api_key_env = credential_name,
    api_key_required = TRUE,
    base_url = "https://api.deepseek.com",
    base_url_env = NULL,
    wire_api = "chat_completions",
    disable_stream_options = FALSE,
    tool_calling = "yes",
    capability_routes = list(list(
      capability = "agent.act",
      model = "deepseek:deepseek-v4-flash",
      model_type = "language",
      required_model_capabilities = list("function_call")
    ))
  )

  resolved_model <- suppressWarnings(rho.agent:::rho_resolve_model_profile(profile))
  expect_identical(resolved_model, "deepseek:deepseek-v4-flash")
  routes <- rho.agent:::rho_runtime_profile_capability_models(profile, resolved_model)
  expect_identical(routes[["agent.act"]]$model, resolved_model)

  model <- getFromNamespace("resolve_model", "aisdk")(resolved_model)
  expect_s3_class(model, "DeepSeekLanguageModel")
  expect_identical(model$provider, "deepseek")
  expect_identical(model$get_config()$api_key, "disposable-no-network-key")

  session <- rho_create_aisdk_session(
    model = resolved_model,
    tools = list(),
    capability_models = routes
  )
  expect_s3_class(session, "ChatSession")
  expect_identical(
    session$get_metadata("capability_models")[["agent.act"]]$model,
    resolved_model
  )

  profile$capability_routes[[1L]]$model <- "rho_profile_provider_act:deepseek-v4-flash"
  expect_error(
    rho.agent:::rho_runtime_profile_capability_models(profile, resolved_model),
    "does not match the effective model"
  )
})

test_that("custom runtime profiles retain their isolated provider identity", {
  skip_if_not_installed("aisdk")
  profile <- list(
    settings_revision = 10L,
    route_capability = "agent.chat",
    profile_id = "model-custom",
    provider_kind = "openai_compatible",
    runtime_provider_id = "rho_profile_provider_custom_connection",
    registered_provider_id = NULL,
    model_id = "custom-language-model",
    api_key_env = NULL,
    api_key_required = FALSE,
    base_url = "https://custom.example.test/v1",
    base_url_env = NULL,
    wire_api = "chat_completions",
    disable_stream_options = FALSE,
    tool_calling = "yes",
    capability_routes = list(list(
      capability = "agent.chat",
      model = "rho_profile_provider_custom_connection:custom-language-model",
      model_type = "language",
      required_model_capabilities = list()
    ))
  )

  resolved_model <- rho.agent:::rho_resolve_model_profile(profile)
  expect_identical(
    resolved_model,
    "rho_profile_provider_custom_connection:custom-language-model"
  )
  routes <- rho.agent:::rho_runtime_profile_capability_models(profile, resolved_model)
  expect_identical(routes[["agent.chat"]]$model, resolved_model)
  model <- getFromNamespace("resolve_model", "aisdk")(resolved_model)
  expect_identical(model$provider, "rho_profile_provider_custom_connection")
})

test_that("reviewed aisdk.providers adapters are explicit and bounded", {
  expect_identical(
    rho.agent:::rho_registered_provider_ids(),
    c(
      "deepseek", "moonshot", "kimi", "stepfun", "volcengine",
      "aihubmix", "xai", "openrouter", "bailian", "nvidia"
    )
  )
  skip_if_not_installed("aisdk.providers")

  provider_classes <- c(
    deepseek = "DeepSeekProvider",
    moonshot = "MoonshotProvider",
    kimi = "KimiCodeAnthropicProvider",
    stepfun = "StepfunProvider",
    volcengine = "VolcengineProvider",
    aihubmix = "AiHubMixProvider",
    xai = "XAIProvider",
    openrouter = "OpenRouterProvider",
    bailian = "BailianProvider",
    nvidia = "NvidiaProvider"
  )
  default_base_urls <- c(
    deepseek = "https://api.deepseek.com",
    moonshot = "https://api.moonshot.cn/v1",
    kimi = "https://api.kimi.com/coding/v1",
    stepfun = "https://api.stepfun.com/v1",
    volcengine = "https://ark.cn-beijing.volces.com/api/v3",
    aihubmix = "https://aihubmix.com/v1",
    xai = "https://api.x.ai/v1",
    openrouter = "https://openrouter.ai/api/v1",
    bailian = "https://dashscope.aliyuncs.com/compatible-mode/v1",
    nvidia = "https://integrate.api.nvidia.com/v1"
  )
  ambient_names <- c(
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_BASE_URLS",
    "MOONSHOT_API_KEY", "MOONSHOT_BASE_URL", "MOONSHOT_BASE_URLS",
    "KIMI_API_KEY", "KIMI_CODE_API_KEY", "KIMI_BASE_URL",
    "KIMI_CODE_BASE_URL", "KIMI_ANTHROPIC_BASE_URL", "KIMI_BASE_URLS",
    "KIMI_CODE_BASE_URLS", "KIMI_PROMPT_CACHE_KEY",
    "KIMI_CODE_PROMPT_CACHE_KEY", "STEPFUN_API_KEY", "STEPFUN_BASE_URL",
    "STEPFUN_BASE_URLS", "ARK_API_KEY", "ARK_BASE_URL", "ARK_BASE_URLS",
    "AIHUBMIX_API_KEY", "AIHUBMIX_BASE_URL", "AIHUBMIX_BASE_URLS",
    "XAI_API_KEY", "XAI_BASE_URL", "XAI_BASE_URLS", "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL", "OPENROUTER_BASE_URLS", "DASHSCOPE_API_KEY",
    "DASHSCOPE_BASE_URL", "DASHSCOPE_BASE_URLS", "NVIDIA_API_KEY",
    "NVIDIA_BASE_URL", "NVIDIA_BASE_URLS"
  )
  previous <- Sys.getenv(ambient_names, unset = NA_character_)
  on.exit({
    for (index in seq_along(ambient_names)) {
      name <- ambient_names[[index]]
      value <- previous[[index]]
      if (is.na(value)) {
        Sys.unsetenv(name)
      } else {
        do.call(Sys.setenv, stats::setNames(list(value), name))
      }
    }
  }, add = TRUE)
  for (name in ambient_names) {
    value <- if (grepl("KEY", name, fixed = TRUE)) {
      "ambient-secret-must-not-be-used"
    } else {
      "https://ambient.example.test/v1"
    }
    do.call(Sys.setenv, stats::setNames(list(value), name))
  }
  for (provider_id in names(provider_classes)) {
    profile <- list(
      registered_provider_id = provider_id,
      wire_api = if (identical(provider_id, "kimi")) "anthropic_messages" else "chat_completions"
    )
    provider <- suppressWarnings(rho.agent:::rho_make_registered_runtime_provider(
      profile,
      "dummy-key",
      NULL
    ))
    expect_s3_class(provider, provider_classes[[provider_id]])
    config <- provider$language_model(
      if (identical(provider_id, "kimi")) "kimi-for-coding" else "test-model"
    )$get_config()
    expect_identical(config$base_url, unname(default_base_urls[[provider_id]]))
    expect_identical(config$base_urls, unname(default_base_urls[[provider_id]]))
    expect_identical(config$api_key, "dummy-key")
  }

  profile <- list(
    registered_provider_id = "deepseek",
    runtime_provider_id = "rho_profile_provider_test",
    wire_api = "chat_completions"
  )
  provider <- suppressWarnings(rho.agent:::rho_make_registered_runtime_provider(
    profile,
    "dummy-key",
    "https://gateway.example.test/deepseek/v1"
  ))
  model <- provider$language_model("deepseek-chat")
  expect_s3_class(model, "DeepSeekLanguageModel")
  expect_identical(model$get_config()$base_url, "https://gateway.example.test/deepseek/v1")

  profile$registered_provider_id <- "unlisted"
  expect_null(rho.agent:::rho_make_registered_runtime_provider(profile, "", NULL))
  expect_error(
    rho.agent:::rho_make_registered_runtime_provider(
      profile,
      "dummy-key",
      "https://gateway.example.test/v1"
    ),
    "does not support a Rho Base URL override"
  )
})

test_that("runtime provider defaults ignore undeclared ambient credentials and endpoints", {
  old_key <- Sys.getenv("OPENAI_API_KEY", unset = NA_character_)
  old_url <- Sys.getenv("OPENAI_BASE_URL", unset = NA_character_)
  old_urls <- Sys.getenv("OPENAI_BASE_URLS", unset = NA_character_)
  on.exit({
    values <- c(OPENAI_API_KEY = old_key, OPENAI_BASE_URL = old_url, OPENAI_BASE_URLS = old_urls)
    for (name in names(values)) {
      if (is.na(values[[name]])) {
        Sys.unsetenv(name)
      } else {
        do.call(Sys.setenv, stats::setNames(list(values[[name]]), name))
      }
    }
  }, add = TRUE)
  Sys.setenv(
    OPENAI_API_KEY = "ambient-secret-must-not-be-used",
    OPENAI_BASE_URL = "https://ambient.example.test/v1",
    OPENAI_BASE_URLS = "https://ambient-backup.example.test/v1"
  )
  profile <- list(
    provider_kind = "openai",
    runtime_provider_id = "rho_profile_provider_ambient_test",
    api_key_env = "OPENAI_API_KEY",
    api_key_required = FALSE,
    base_url = NULL,
    base_url_env = NULL,
    wire_api = "chat_completions",
    disable_stream_options = FALSE,
    tool_calling = "yes"
  )
  provider <- suppressWarnings(rho.agent:::rho_make_runtime_provider(profile))
  config <- provider$language_model("test-model")$get_config()
  expect_identical(config$api_key, "")
  expect_identical(config$base_url, "https://api.openai.com/v1")
  expect_identical(config$base_urls, "https://api.openai.com/v1")

  profile$api_key_required <- TRUE
  profile$api_key_env <- "RHO_MISSING_SYSTEM_CREDENTIAL"
  Sys.unsetenv("RHO_MISSING_SYSTEM_CREDENTIAL")
  expect_error(
    rho.agent:::rho_make_runtime_provider(profile),
    "system credential store"
  )
})

test_that("desktop aisdk sessions allow long multi-step analyses", {
  expect_identical(eval(formals(rho_create_aisdk_session)$max_steps), 512L)
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
