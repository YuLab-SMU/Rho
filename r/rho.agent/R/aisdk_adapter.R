#' Update the Workspace Identity Attached to Agent Tool Requests
#' @export
rho_agent_set_workspace_identity <- function(identity) {
  stopifnot(is.list(identity))
  .rho_agent_state$workspace_identity <- identity
  invisible(identity)
}

rho_broker_tool_request <- function(type, arguments = list()) {
  payload <- list(
    arguments = arguments,
    expected_workspace = .rho_agent_state$workspace_identity
  )
  if (identical(type, "workspace.execute")) {
    approval <- .rho_agent_state$pending_approval
    .rho_agent_state$pending_approval <- NULL
    if (!is.null(approval$request_id)) {
      payload$approval_request_id <- approval$request_id
    }
  }
  response <- rho_agent_request(
    type,
    payload
  )
  if (is.list(response$workspace)) {
    rho_agent_set_workspace_identity(response$workspace)
  }
  response
}

rho_file_edit_proposal <- function(args) {
  stopifnot(is.list(args) || is.environment(args))
  value <- function(name) {
    item <- args[[name]]
    if (!is.character(item) || length(item) != 1L || is.na(item)) {
      stop(sprintf("File edit argument `%s` must be one string.", name))
    }
    item
  }
  list(
    kind = "rho.file_edit_proposal",
    path = value("path"),
    operation = value("operation"),
    content = value("content")
  )
}

#' Create aisdk Tools Backed by the Rho Broker
#' @export
rho_create_workspace_tools <- function() {
  list(
    aisdk::tool(
      name = "get_workspace_snapshot",
      description = "Return a bounded summary of the authoritative Ark workspace.",
      parameters = aisdk::z_empty_object(),
      execute = function(args) rho_broker_tool_request("workspace.snapshot", args),
      meta = list(validate_arguments = TRUE, rho_approval = "automatic")
    ),
    aisdk::tool(
      name = "inspect_r_object",
      description = paste(
        "Inspect one object in the authoritative Ark workspace.",
        "The object remains in Workspace R; only bounded metadata is returned."
      ),
      parameters = aisdk::z_object(
        name = aisdk::z_string("Object name"),
        detail = aisdk::z_enum(
          c("summary", "structured", "full"),
          description = "Inspection detail level",
          default = "summary"
        ),
        .required = "name"
      ),
      execute = function(args) rho_broker_tool_request("workspace.inspect_object", args),
      meta = list(validate_arguments = TRUE, rho_approval = "automatic")
    ),
    aisdk::tool(
      name = "run_r",
      description = paste(
        "Execute R code in the authoritative persistent Ark workspace.",
        "The broker serializes execution and rejects stale workspace revisions."
      ),
      parameters = aisdk::z_object(
        code = aisdk::z_string("R code to execute", min_length = 1L),
        .required = "code"
      ),
      execute = function(args) rho_broker_tool_request("workspace.execute", args),
      meta = list(validate_arguments = TRUE, rho_approval = "required")
    ),
    aisdk::tool(
      name = "propose_file_edit",
      description = paste(
        "Propose one project file edit for user review.",
        "This tool never writes the file; the desktop shows a diff and requires explicit acceptance."
      ),
      parameters = aisdk::z_object(
        path = aisdk::z_string("Project-relative file path"),
        operation = aisdk::z_enum(
          c("replace_selection", "insert_at_cursor", "append", "create"),
          description = "How the proposed content should be placed"
        ),
        content = aisdk::z_string("Exact text to insert, replace with, append, or place in the new file"),
        .required = c("path", "operation", "content")
      ),
      execute = rho_file_edit_proposal,
      meta = list(validate_arguments = TRUE, rho_approval = "automatic")
    )
  )
}

rho_compact_event_value <- function(value, max_chars = 4000L) {
  text <- tryCatch(
    jsonlite::toJSON(value, auto_unbox = TRUE, null = "null"),
    error = function(error) as.character(value)[[1L]]
  )
  if (nchar(text) > max_chars) {
    text <- paste0(substr(text, 1L, max_chars), "... [truncated]")
  }
  text
}

rho_workspace_snapshot_preview <- function(value) {
  snapshot <- value$execution %||% value
  r <- snapshot$r %||% list()
  environment <- snapshot$environment %||% list()
  objects <- snapshot$objects %||% list()
  object_names <- vapply(objects, function(item) item$name %||% "?", character(1L))

  package_items <- environment$attached_packages$values %||% list()
  packages <- vapply(package_items, function(item) {
    name <- item$name %||% "?"
    version <- item$version %||% NULL
    if (is.null(version) || !nzchar(version)) name else paste(name, version)
  }, character(1L))
  if (!length(packages)) {
    packages <- sub("^package:", "", r$attached %||% character())
  }

  render <- environment$render %||% list()
  render_status <- c(
    sprintf("R Markdown %s", if (isTRUE(render$can_render_rmd)) "ready" else "unavailable"),
    sprintf("Quarto %s", if (isTRUE(render$can_render_qmd)) "ready" else "unavailable")
  )
  renv_status <- environment$renv$status %||% "unknown"
  bioc_version <- environment$bioconductor$version %||% "unknown"

  paste(
    c(
      "Workspace R ready",
      sprintf("R: %s (%s)", r$version %||% "unknown", r$platform %||% "unknown"),
      sprintf("Project: %s", environment$project_dir %||% r$cwd %||% "unknown"),
      sprintf(
        "Objects (%d): %s",
        length(objects),
        if (length(object_names)) paste(head(object_names, 12L), collapse = ", ") else "none"
      ),
      sprintf(
        "Attached packages: %s",
        if (length(packages)) paste(head(packages, 12L), collapse = ", ") else "base only"
      ),
      sprintf("Environment: renv %s; Bioconductor %s", renv_status, bioc_version),
      sprintf("Render: %s", paste(render_status, collapse = "; "))
    ),
    collapse = "\n"
  )
}

rho_parse_tool_result <- function(value) {
  if (!is.character(value) || length(value) != 1L || !nzchar(value)) {
    return(value)
  }
  tryCatch(
    jsonlite::fromJSON(value, simplifyVector = FALSE),
    error = function(error) value
  )
}

rho_run_r_preview <- function(value) {
  parsed <- rho_parse_tool_result(value)
  if (!is.list(parsed)) {
    return(rho_compact_event_value(parsed))
  }
  execution <- if (is.list(parsed$execution)) parsed$execution else parsed

  text_value <- function(value) {
    if (is.null(value) || !length(value)) return("")
    if (is.character(value)) return(paste(value, collapse = "\n"))
    rho_compact_event_value(value)
  }
  error <- execution$error %||% NULL
  if (!is.null(error) || identical(execution$ok, FALSE)) {
    message <- if (is.list(error)) error$message %||% error$error %||% error else error
    message <- text_value(message)
    return(sprintf("Error\n%s", if (nzchar(message)) message else "R execution failed."))
  }

  sections <- character()
  add_section <- function(label, content) {
    content <- text_value(content)
    if (nzchar(content)) sections <<- c(sections, sprintf("%s\n%s", label, content))
  }
  add_section("Output", execution$stdout %||% "")
  add_section("Result", execution$value %||% execution$value_text %||% "")
  add_section("Messages", execution$messages %||% character())
  add_section("Warnings", execution$warnings %||% character())
  if (!length(sections)) {
    return("R completed successfully with no printed output.")
  }
  paste(sections, collapse = "\n\n")
}

rho_tool_result_preview <- function(tool, value) {
  parsed <- rho_parse_tool_result(value)
  if (identical(tool, "propose_file_edit") && is.list(parsed)) {
    return(rho_compact_event_value(parsed, max_chars = 100000L))
  }
  if (identical(tool, "get_workspace_snapshot") && is.list(parsed)) {
    return(rho_workspace_snapshot_preview(parsed))
  }
  if (identical(tool, "run_r")) {
    return(rho_run_r_preview(parsed))
  }
  rho_compact_event_value(parsed)
}

rho_validate_runtime_model_profile <- function(profile) {
  stopifnot(is.list(profile))
  required <- c(
    "profile_id",
    "provider_kind",
    "runtime_provider_id",
    "model_id",
    "api_key_required",
    "tool_calling"
  )
  missing <- required[!nzchar(vapply(profile[required], function(value) {
    if (is.null(value)) "" else as.character(value[[1L]])
  }, character(1L)))]
  if (length(missing)) {
    stop(sprintf("Runtime model profile is missing required fields: %s", paste(missing, collapse = ", ")))
  }
  if (!(profile$provider_kind %in% c(
    "registered",
    "openai",
    "anthropic",
    "gemini",
    "openai_compatible",
    "local_openai_compatible"
  ))) {
    stop(sprintf("Unsupported runtime provider kind: %s", profile$provider_kind))
  }
  if (!(profile$tool_calling %in% c("yes", "no", "unknown"))) {
    stop(sprintf("Unsupported tool calling capability: %s", profile$tool_calling))
  }
  invisible(profile)
}

rho_redact_known_values <- function(text, values = character()) {
  output <- text %||% ""
  for (value in unique(Filter(nzchar, as.character(values)))) {
    output <- gsub(value, "[REDACTED]", output, fixed = TRUE)
  }
  output
}

rho_runtime_profile_sensitive_values <- function(profile) {
  env_names <- c(profile$api_key_env %||% "", profile$base_url_env %||% "")
  env_values <- vapply(env_names[nzchar(env_names)], Sys.getenv, character(1L), unset = "")
  unique(Filter(nzchar, c(env_values, profile$base_url %||% "")))
}

rho_runtime_profile_capabilities <- function(profile, info = NULL) {
  if (is.list(info) && is.list(info$capabilities)) {
    capabilities <- info$capabilities
    return(list(
      tool_calling = if (isTRUE(capabilities$function_call)) "yes" else "no",
      reasoning = if (isTRUE(capabilities$reasoning)) "yes" else "no",
      vision_input = if (isTRUE(capabilities$vision_input)) "yes" else "no",
      source = "catalog"
    ))
  }
  list(
    tool_calling = profile$tool_calling %||% "unknown",
    reasoning = "unknown",
    vision_input = "unknown",
    source = "probe"
  )
}

rho_runtime_profile_credential_status <- function(profile) {
  if (!isTRUE(profile$api_key_required)) {
    return("not_required")
  }
  env_name <- profile$api_key_env %||% ""
  value <- if (nzchar(env_name)) Sys.getenv(env_name, unset = "") else ""
  if (nzchar(value)) "detected" else "not_detected"
}

rho_runtime_profile_api_key <- function(profile) {
  env_name <- profile$api_key_env %||% ""
  value <- if (nzchar(env_name)) Sys.getenv(env_name, unset = "") else ""
  if (isTRUE(profile$api_key_required) && !nzchar(value)) {
    stop("Credential was not detected in the effective user environment file.")
  }
  value
}

rho_runtime_profile_base_url <- function(profile) {
  if (nzchar(profile$base_url %||% "")) {
    return(profile$base_url)
  }
  env_name <- profile$base_url_env %||% ""
  if (!nzchar(env_name)) {
    return(NULL)
  }
  value <- Sys.getenv(env_name, unset = "")
  if (!nzchar(value)) {
    stop(sprintf("Base URL environment %s was not set.", env_name))
  }
  value
}

rho_classify_model_error <- function(message) {
  lowered <- tolower(message %||% "")
  if (grepl("credential|api key|not detected|unauthorized|401|403", lowered, fixed = FALSE)) {
    return("credential")
  }
  if (grepl("timeout|timed out", lowered, fixed = FALSE)) {
    return("timeout")
  }
  if (grepl("base url|endpoint|404|model", lowered, fixed = FALSE)) {
    return("endpoint")
  }
  if (grepl("network|connection|dns|socket", lowered, fixed = FALSE)) {
    return("network")
  }
  "provider"
}

rho_make_runtime_provider <- function(profile) {
  api_key <- rho_runtime_profile_api_key(profile)
  provider <- switch(
    profile$provider_kind,
    registered = NULL,
    openai = aisdk::create_openai(
      api_key = if (nzchar(api_key)) api_key else NULL,
      name = profile$runtime_provider_id
    ),
    anthropic = aisdk::create_anthropic(
      api_key = if (nzchar(api_key)) api_key else NULL,
      name = profile$runtime_provider_id
    ),
    gemini = aisdk::create_gemini(
      api_key = if (nzchar(api_key)) api_key else NULL,
      name = profile$runtime_provider_id
    ),
    openai_compatible = aisdk::create_custom_provider(
      provider_name = profile$runtime_provider_id,
      base_url = rho_runtime_profile_base_url(profile),
      api_key = if (nzchar(api_key)) api_key else NULL,
      api_format = profile$wire_api %||% "chat_completions",
      disable_stream_options = isTRUE(profile$disable_stream_options),
      supports_native_tools = identical(profile$tool_calling, "yes")
    ),
    local_openai_compatible = aisdk::create_custom_provider(
      provider_name = profile$runtime_provider_id,
      base_url = rho_runtime_profile_base_url(profile),
      api_key = if (nzchar(api_key)) api_key else NULL,
      api_format = profile$wire_api %||% "chat_completions",
      disable_stream_options = isTRUE(profile$disable_stream_options),
      supports_native_tools = identical(profile$tool_calling, "yes")
    ),
    stop(sprintf("Unsupported runtime provider kind: %s", profile$provider_kind))
  )
  if (is.null(provider)) {
    return(NULL)
  }
  aisdk::register_provider(profile$runtime_provider_id, function() provider)
  provider
}

rho_resolve_model_profile <- function(profile) {
  rho_validate_runtime_model_profile(profile)
  if (identical(profile$provider_kind, "registered")) {
    provider_id <- profile$registered_provider_id %||% ""
    if (!nzchar(provider_id)) {
      stop("Registered runtime profiles require registered_provider_id.")
    }
    return(sprintf("%s:%s", provider_id, profile$model_id))
  }
  rho_make_runtime_provider(profile)
  sprintf("%s:%s", profile$runtime_provider_id, profile$model_id)
}

rho_test_model_profile <- function(profile) {
  rho_validate_runtime_model_profile(profile)
  credential_status <- rho_runtime_profile_credential_status(profile)
  known_values <- character()
  if (!identical(credential_status, "not_required")) {
    env_name <- profile$api_key_env %||% ""
    if (nzchar(env_name)) {
      known_values <- c(known_values, Sys.getenv(env_name, unset = ""))
    }
  }
  started <- Sys.time()
  result <- tryCatch(
    {
      model <- rho_resolve_model_profile(profile)
      info <- tryCatch(
        {
          provider_id <- if (identical(profile$provider_kind, "registered")) {
            profile$registered_provider_id
          } else {
            profile$runtime_provider_id
          }
          aisdk::get_model_info(provider_id, profile$model_id)
        },
        error = function(error) NULL
      )
      aisdk::generate_text(
        model = model,
        prompt = "Reply with OK only.",
        system = "Return OK only.",
        tools = list(),
        max_steps = 1L,
        max_tokens = 16L
      )
      list(
        status = "ready",
        credential_status = credential_status,
        model_resolved = TRUE,
        latency_ms = as.integer(round(as.numeric(difftime(Sys.time(), started, units = "secs")) * 1000)),
        capabilities = rho_runtime_profile_capabilities(profile, info),
        message = "Connection succeeded.",
        error_class = NULL
      )
    },
    error = function(error) {
      message <- rho_redact_known_values(conditionMessage(error), known_values)
      list(
        status = "error",
        credential_status = credential_status,
        model_resolved = FALSE,
        latency_ms = as.integer(round(as.numeric(difftime(Sys.time(), started, units = "secs")) * 1000)),
        capabilities = rho_runtime_profile_capabilities(profile, NULL),
        message = message,
        error_class = rho_classify_model_error(message)
      )
    }
  )
  result
}

#' Create aisdk Hooks that Delegate Policy and Emit Structured Events
#' @export
rho_create_aisdk_hooks <- function(connection = .rho_agent_state$connection) {
  aisdk::create_hooks(
    on_generation_start = function(model, prompt, tools) {
      rho_agent_emit(
        "agent.run_started",
        list(tool_names = vapply(tools, function(tool) tool$name, character(1L))),
        connection = connection
      )
      NULL
    },
    on_generation_end = function(result) {
      state <- result$task_state %||% result$run_state %||% list(status = "completed")
      rho_agent_emit(
        "agent.run_state_changed",
        list(run_state = unclass(state), usage = result$usage %||% NULL),
        connection = connection
      )
      NULL
    },
    on_tool_approval = function(tool, args) {
      policy <- tool$meta$rho_approval %||% "required"
      if (identical(policy, "automatic")) {
        return(TRUE)
      }
      response <- rho_agent_request(
        "tool.approval_required",
        list(
          tool = tool$name,
          arguments = args,
          policy = policy,
          expected_workspace = .rho_agent_state$workspace_identity
        ),
        connection = connection
      )
      if (isTRUE(response$approved)) {
        .rho_agent_state$pending_approval <- list(
          request_id = response$approval_request_id %||% response$request_id,
          tool = tool$name,
          arguments = args
        )
      } else {
        .rho_agent_state$pending_approval <- NULL
      }
      isTRUE(response$approved)
    },
    on_tool_start = function(tool, args) {
      rho_agent_emit(
        "tool.call_started",
        list(tool = tool$name, arguments = args),
        connection = connection
      )
    },
    on_tool_end = function(tool, result, success, error, args) {
      rho_agent_emit(
        if (isTRUE(success)) "tool.call_completed" else "tool.call_failed",
        list(
          tool = tool$name,
          arguments = args,
          success = isTRUE(success),
          result_preview = rho_tool_result_preview(tool$name, result),
          error = error
        ),
        connection = connection
      )
    }
  )
}

#' Create the Agent R ChatSession Used by Rho
#' @export
rho_create_aisdk_session <- function(model,
                                     system_prompt = NULL,
                                     tools = rho_create_workspace_tools(),
                                     max_steps = 10L,
                                     connection = .rho_agent_state$connection) {
  aisdk::create_chat_session(
    model = model,
    system_prompt = system_prompt,
    tools = tools,
    hooks = rho_create_aisdk_hooks(connection),
    max_steps = as.integer(max_steps),
    metadata = list(rho_desktop = TRUE)
  )
}

#' Run One Streaming aisdk Turn and Forward Events to the Broker
#' @export
rho_run_aisdk_turn <- function(session,
                               prompt,
                               connection = .rho_agent_state$connection) {
  stopifnot(inherits(session, "ChatSession"))
  previous_sink <- aisdk::set_run_trace_sink(function(event, run_id) {
    rho_agent_emit(
      "agent.trace",
      list(run_id = run_id, event = event),
      connection = connection
    )
  })
  on.exit(aisdk::set_run_trace_sink(previous_sink), add = TRUE)

  result <- session$send_stream(
    prompt,
    callback = function(text, done) NULL,
    on_event = function(event) {
      mapped_type <- switch(
        event$type %||% "",
        text_delta = "chat.text_delta",
        thinking_text = "chat.thinking_delta",
        final_text = "chat.message_completed",
        done = "agent.stream_completed",
        "agent.stream_event"
      )
      rho_agent_emit(mapped_type, list(event = event), connection = connection)
    }
  )
  invisible(result)
}
