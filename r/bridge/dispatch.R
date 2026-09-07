# Loaded into a private environment by the Ark adapter. No Operation or Store policy here.
rho_dispatch <- function(request) {
  stopifnot(identical(request$protocol_version, 1L),
            request$action %in% c("execute", "snapshot", "inspect_object", "help", "lint", "format"),
            is.character(request$request_id), length(request$request_id) == 1L)
  if (request$action %in% c("snapshot", "inspect_object")) {
    value <- switch(request$action,
                    snapshot = rho_workspace_snapshot(request$payload$limit),
                    inspect_object = rho_inspect_object(request$payload$name, request$payload$max_items))
    return(list(protocol_version = 1L, request_id = request$request_id,
                outcome = "succeeded", error = NULL, value = value,
                conditions = list(), conditions_truncated = FALSE))
  }
  if (!identical(request$action, "help")) {
    stopifnot(is.character(request$payload$code), length(request$payload$code) == 1L)
  }
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
      if (identical(request$action, "execute")) {
        expressions <- parse(text = sub("^\ufeff", "", request$payload$code, perl = TRUE), keep.source = TRUE)
        result <- NULL
        for (expression in expressions) result <- withVisible(eval(expression, envir = .GlobalEnv))
        if (is.null(result) || !result$visible) NULL else result$value
      } else {
        switch(request$action, help = rho_help(request$payload),
               lint = rho_lint(request$payload), format = rho_format(request$payload))
      }
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
  if (identical(request$action, "execute") && !is.null(value) &&
      !(is.atomic(value) && !is.object(value) &&
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
