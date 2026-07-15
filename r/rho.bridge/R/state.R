.rho_bridge_state <- new.env(parent = emptyenv())
.rho_bridge_state$last_execution <- NULL

compact_text <- function(x, max_chars = 4000L) {
  value <- paste(x, collapse = "\n")
  if (nchar(value, type = "chars") <= max_chars) {
    return(value)
  }
  paste0(substr(value, 1L, max_chars), "\n... [truncated]")
}

safe_call_text <- function(call) {
  tryCatch(
    paste(deparse(call, width.cutoff = 200L), collapse = " "),
    error = function(e) "<unavailable>"
  )
}

#' Return the Last Structured Workspace Execution
#' @export
rho_get_last_execution <- function() {
  .rho_bridge_state$last_execution
}

