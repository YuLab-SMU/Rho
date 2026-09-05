rho_binding_summary <- function(name, inspect = FALSE, max_items = 20L) {
  result <- list(name = name, kind = "missing", object_type = NULL,
                 classes = list(), length = NULL, dimensions = list(),
                 preview = NULL, truncated = FALSE, notice = NULL)
  if (!exists(name, envir = .GlobalEnv, inherits = FALSE)) return(result)
  if (bindingIsActive(name, .GlobalEnv)) {
    result$kind <- "active_binding"
    result$notice <- "Active binding was not invoked."
    return(result)
  }
  if (!isTRUE(can_inspect_bindings)) {
    result$kind <- "uninspected_binding"
    result$notice <- "rlang is unavailable; value was not read because it may be a promise."
    return(result)
  }
  if (isTRUE(rlang::env_binding_are_lazy(.GlobalEnv, name)[[1L]])) {
    result$kind <- "promise"
    result$notice <- "Unevaluated promise was not forced."
    return(result)
  }
  result$kind <- "value"
  if (!inspect) return(result)
  value <- get(name, envir = .GlobalEnv, inherits = FALSE)
  result$object_type <- typeof(value)
  classes <- attr(value, "class", exact = TRUE)
  if (is.character(classes)) result$classes <- as.list(substr(head(classes, 16L), 1L, 128L))
  dimensions <- attr(value, "dim", exact = TRUE)
  if (is.integer(dimensions) || is.double(dimensions)) result$dimensions <- as.list(head(dimensions, 16L))
  if (identical(classes, "data.frame")) {
    column_names <- attr(value, "names", exact = TRUE)
    rows <- .row_names_info(value, 2L)
    columns <- length(column_names)
    result$dimensions <- list(rows, columns)
    selected_columns <- seq_len(min(columns, 10L))
    selected_rows <- seq_len(min(rows, max_items, 20L))
    truncated_cells <- FALSE
    result$preview <- unname(lapply(selected_columns, function(index) {
      column <- .subset2(value, index)
      values <- NULL
      if (!is.object(column) && typeof(column) %in% c("integer", "double", "logical", "character")) {
        values <- .subset(column, selected_rows)
        if (is.character(values)) {
          truncated_cells <<- truncated_cells || any(nchar(values, type = "chars") > 512L, na.rm = TRUE)
          values <- substr(values, 1L, 512L)
        }
        values <- unname(as.list(values))
      }
      if (nchar(column_names[[index]], type = "chars") > 128L) truncated_cells <<- TRUE
      list(index = index, name = substr(column_names[[index]], 1L, 128L), values = values)
    }))
    result$truncated <- truncated_cells || columns > length(selected_columns) || rows > length(selected_rows)
    result$notice <- "Data-frame preview is limited to 10 columns and 20 rows; classed columns are not evaluated."
    return(result)
  }
  # Never call a user's print/format/length/subset methods while answering a Query.
  if (is.object(value) || isS4(value)) {
    result$notice <- "Classed object: metadata only; user-defined methods were not called."
    return(result)
  }
  if (typeof(value) %in% c("integer", "double", "logical", "character")) {
    result$length <- length(value)
    count <- min(length(value), max_items)
    preview <- .subset(value, seq_len(count))
    if (is.character(preview)) {
      result$truncated <- any(nchar(preview, type = "chars") > 512L, na.rm = TRUE)
      preview <- substr(preview, 1L, 512L)
    }
    result$preview <- unname(as.list(preview))
    result$truncated <- result$truncated || length(value) > count
  } else {
    result$notice <- "Opaque object: value was not serialized."
  }
  result
}

rho_workspace_snapshot <- function(limit) {
  stopifnot(is.numeric(limit), length(limit) == 1L, limit >= 1, limit <= 200)
  names <- ls(envir = .GlobalEnv, all.names = TRUE)
  bounded <- names[nchar(names, type = "bytes") <= 4096L & nchar(names, type = "chars") <= 1024L]
  selected <- head(bounded, as.integer(limit))
  list(objects = unname(lapply(selected, rho_binding_summary)),
       total_bindings = length(names), truncated = length(selected) < length(names),
       working_directory = getwd(),
       r_version = paste(R.version$major, R.version$minor, sep = "."))
}

rho_inspect_object <- function(name, max_items) {
  stopifnot(is.character(name), length(name) == 1L, !is.na(name),
            nchar(name, type = "bytes") <= 4096L, nchar(name, type = "chars") <= 1024L,
            is.numeric(max_items), length(max_items) == 1L, max_items >= 1, max_items <= 100)
  rho_binding_summary(name, inspect = TRUE, max_items = as.integer(max_items))
}
