.rho_agent_state <- new.env(parent = emptyenv())
.rho_agent_state$connection <- NULL
.rho_agent_state$protocol_version <- 1L
.rho_agent_state$max_frame_bytes <- 8L * 1024L * 1024L
.rho_agent_state$workspace_identity <- NULL

`%||%` <- function(x, y) if (is.null(x)) y else x

rho_protocol_jsonable <- function(value) {
  if (is.null(value)) {
    return(NULL)
  }
  if (is.environment(value) || inherits(value, "R6")) {
    return("<R object>")
  }
  if (inherits(value, "condition")) {
    return(list(message = conditionMessage(value), classes = class(value)))
  }
  if (is.list(value)) {
    fields <- unclass(value)
    output <- lapply(fields, rho_protocol_jsonable)
    if (!is.null(names(fields))) {
      names(output) <- names(fields)
    }
    return(output)
  }
  if (inherits(value, "POSIXt") || inherits(value, "Date")) {
    return(as.character(value))
  }
  if (is.atomic(value) && !is.null(class(value))) {
    return(unclass(value))
  }
  value
}
