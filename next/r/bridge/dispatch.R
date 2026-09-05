# Loaded into a private environment by the Ark adapter. No Operation or Store policy here.
rho_dispatch <- function(request) {
  stopifnot(identical(request$protocol_version, 1L),
            identical(request$action, "execute"),
            is.character(request$request_id), length(request$request_id) == 1L,
            is.character(request$payload$code), length(request$payload$code) == 1L)
  conditions <- list()
  truncated <- FALSE
  add_condition <- function(kind, condition) {
    if (length(conditions) >= 100L) {
      truncated <<- TRUE
      return(invisible(NULL))
    }
    text <- conditionMessage(condition)
    if (nchar(text, type = "bytes") > 4096L) {
      text <- substr(text, 1L, 1000L)
      truncated <<- TRUE
    }
    conditions[[length(conditions) + 1L]] <<- list(kind = kind, message = text)
  }
  outcome <- "succeeded"
  error <- NULL
  value <- tryCatch(
    withCallingHandlers({
      expressions <- parse(text = request$payload$code, keep.source = TRUE)
      result <- NULL
      for (expression in expressions) result <- withVisible(eval(expression, envir = .GlobalEnv))
      if (is.null(result) || !result$visible) NULL else result$value
    }, warning = function(condition) {
      add_condition("warning", condition)
      invokeRestart("muffleWarning")
    }, message = function(condition) {
      add_condition("message", condition)
      invokeRestart("muffleMessage")
    }),
    interrupt = function(condition) {
      outcome <<- "cancelled"
      error <<- "R execution interrupted"
      NULL
    },
    error = function(condition) {
      outcome <<- "failed"
      error <<- substr(conditionMessage(condition), 1L, 1000L)
      add_condition("error", condition)
      NULL
    })
  # Never serialize an entire scientific object for a console return value.
  if (!is.null(value) && !(is.atomic(value) && !is.object(value) &&
                          is.null(dim(value)) && length(value) <= 100L &&
                          as.numeric(utils::object.size(value)) <= 16384)) {
    value <- list(typeof = typeof(value), classes = as.list(class(value)),
                  dimensions = as.list(dim(value)), length = length(value),
                  preview = "Inspect this object to retrieve a bounded view.")
  }
  list(protocol_version = 1L, request_id = request$request_id,
       outcome = outcome, error = error, value = value,
       conditions = conditions, conditions_truncated = truncated)
}
