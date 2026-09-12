# Loaded into a private environment by the Ark adapter. No Operation or Store policy here.
rho_dispatch <- function(request) {
  stopifnot(identical(request$protocol_version, 1L),
            request$action %in% c("execute", "checkpoint_capture", "checkpoint_restore", "snapshot", "packages", "inspect_object", "list_objects", "observe_object", "read_object", "package_index", "read_help", "help", "lint", "format"),
            is.character(request$request_id), length(request$request_id) == 1L)
  if (request$action %in% c("snapshot", "packages", "inspect_object", "list_objects", "observe_object", "read_object", "package_index", "read_help")) {
    failure <- NULL
    value <- tryCatch(switch(request$action,
                    list_objects = rho_list_objects(request$payload),
                    observe_object = rho_observe_object(request$payload),
                    read_object = rho_read_object(request$payload),
                    package_index = rho_package_index(request$payload),
                    read_help = rho_read_help(request$payload),
                    snapshot = rho_workspace_snapshot(request$payload$limit),
                    packages = rho_packages(request$payload),
                    inspect_object = rho_inspect_object(request$payload$name, request$payload$max_items)),
                    error = function(error) { failure <<- list(code = if (inherits(error, "rho_query_error")) error$code else "unavailable", message = conditionMessage(error)); NULL })
    return(list(protocol_version = 1L, request_id = request$request_id,
                outcome = if (is.null(failure)) "succeeded" else "failed", error = if (is.null(failure)) NULL else failure$message, value = if (is.null(failure)) value else list(query_error = failure),
                conditions = list(), conditions_truncated = FALSE))
  }
  # Invalidate before parsing, loading tools or executing; failures and cancellation never restore old handles.
  rho_invalidate_objects()
  if (!request$action %in% c("help", "checkpoint_capture", "checkpoint_restore")) {
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
        console <- identical(request$payload$output_mode, "console")
        for (expression in expressions) {
          result <- withVisible(eval(expression, envir = .GlobalEnv))
          if (console && result$visible) base::print(result$value)
        }
        if (console || is.null(result) || !result$visible) NULL else result$value
      } else {
        switch(request$action, checkpoint_capture = rho_checkpoint_capture(request$payload),
               checkpoint_restore = rho_checkpoint_restore(request$payload), help = rho_help(request$payload),
               lint = rho_lint(request$payload), format = rho_format(request$payload))
      }
    }, warning = function(condition) {
      if (identical(request$payload$output_mode, "console")) cat("Warning: ", conditionMessage(condition), "\n", sep = "", file = stderr())
      add_condition("warning", condition)
      invokeRestart("muffleWarning")
    }, message = function(condition) {
      if (identical(request$payload$output_mode, "console")) cat(conditionMessage(condition), file = stderr())
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
