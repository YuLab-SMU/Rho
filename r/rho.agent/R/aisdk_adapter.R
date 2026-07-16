#' Update the Workspace Identity Attached to Agent Tool Requests
#' @export
rho_agent_set_workspace_identity <- function(identity) {
  stopifnot(is.list(identity))
  .rho_agent_state$workspace_identity <- identity
  invisible(identity)
}

rho_broker_tool_request <- function(type, arguments = list()) {
  response <- rho_agent_request(
    type,
    list(
      arguments = arguments,
      expected_workspace = .rho_agent_state$workspace_identity
    )
  )
  if (is.list(response$workspace)) {
    rho_agent_set_workspace_identity(response$workspace)
  }
  response
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
          result_preview = rho_compact_event_value(result),
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
