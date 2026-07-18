#' Execute R Code with Structured Conditions and Bounded Output
#' @export
rho_execute <- function(code,
                        envir = .GlobalEnv,
                        max_output_chars = 16000L) {
  stopifnot(is.character(code), length(code) == 1L, nzchar(code))
  # Source files may carry a BOM or editor-only zero-width marker at byte 0.
  # Remove only these leading markers; ordinary Unicode inside R strings stays intact.
  leading_markers <- paste0(
    "^[",
    intToUtf8(c(0xFEFF, 0x200B, 0x200C, 0x200D, 0x2060)),
    "]+"
  )
  code <- sub(leading_markers, "", code, perl = TRUE)
  code <- gsub("\r\n?", "\n", code, perl = TRUE)

  warnings <- character()
  messages <- character()
  error_info <- NULL
  call_stack <- character()
  value <- NULL

  output <- capture.output({
    value <- withCallingHandlers(
      tryCatch(
        {
          expressions <- parse(text = code, keep.source = TRUE)
          result <- NULL
          for (expression in expressions) {
            result <- eval(expression, envir = envir)
          }
          result
        },
        error = function(error) {
          call_stack <<- vapply(sys.calls(), safe_call_text, character(1))
          error_info <<- list(
            message = conditionMessage(error),
            classes = class(error),
            call = if (is.null(conditionCall(error))) NULL else safe_call_text(conditionCall(error))
          )
          NULL
        }
      ),
      warning = function(warning) {
        warnings <<- c(warnings, conditionMessage(warning))
        invokeRestart("muffleWarning")
      },
      message = function(message) {
        messages <<- c(messages, conditionMessage(message))
        invokeRestart("muffleMessage")
      }
    )
  }, type = "output")

  visible_value <- if (is.null(error_info) && !is.null(value)) {
    compact_text(capture.output(print(value)), max_chars = max_output_chars)
  } else {
    NULL
  }

  result <- list(
    ok = is.null(error_info),
    code = code,
    stdout = compact_text(output, max_chars = max_output_chars),
    value = visible_value,
    warnings = warnings,
    messages = messages,
    error = error_info,
    traceback = call_stack,
    calls = call_stack,
    timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3%z")
  )
  .rho_bridge_state$last_execution <- result
  result
}
