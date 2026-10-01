# Values carry their exceptional kind; JSON null is not used for every special value.
rho_preview_values <- function(values) {
  unname(lapply(seq_along(values), function(i) {
    value <- .subset2(values, i)
    if (is.double(value) && is.nan(value)) return(list(kind = "non_finite", label = "NaN", type = typeof(value)))
    if (is.na(value)) return(list(kind = "missing", label = "NA", type = typeof(value)))
    if (is.double(value) && is.infinite(value)) return(list(kind = "non_finite", label = if (value > 0) "Inf" else "-Inf", type = typeof(value)))
    value
  }))
}

rho_binding_summary <- function(name, inspect = FALSE, max_items = 20L) {
  result <- list(name = name, kind = "missing", object_type = NULL,
                 classes = list(), length = NULL, dimensions = list(),
                 preview = NULL, preview_kind = "metadata", truncated = FALSE, notice = NULL)
  binding <- rho_object_binding(name)
  metadata <- rho_object_metadata(binding$value, binding$kind)
  result$kind <- metadata$kind
  result$object_type <- metadata$object_type
  result$classes <- metadata$classes
  result$length <- metadata$length
  result$dimensions <- metadata$dimensions
  result$notice <- metadata$notice
  if (binding$kind != "value") return(result)
  value <- binding$value
  classes <- attr(value, "class", exact = TRUE)
  if (identical(classes, "data.frame") || identical(classes, c("tbl_df", "tbl", "data.frame"))) {
    result$preview_kind <- "table"
    column_names <- attr(value, "names", exact = TRUE)
    if (!is.null(column_names) && (!is.character(column_names) || is.object(column_names))) {
      result$preview_kind <- "metadata"
      result$notice <- "Nonstandard column names: metadata only; user methods were not called."
      return(result)
    }
    rows <- .row_names_info(value, 2L)
    columns <- length(column_names)
    result$dimensions <- list(rows, columns)
    if (!inspect) return(result)
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
        values <- rho_preview_values(values)
      }
      if (nchar(column_names[[index]], type = "chars") > 128L) truncated_cells <<- TRUE
      column_classes <- attr(column, "class", exact = TRUE)
      if (!is.character(column_classes) || is.object(column_classes)) column_classes <- character()
      list(index = index, name = substr(.subset2(column_names, index), 1L, 128L),
           type = typeof(column), classes = unname(as.list(substr(head(column_classes, 16L), 1L, 128L))), values = values)
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
    if (!inspect) return(result)
    count <- min(length(value), max_items, 20L)
    preview <- .subset(value, seq_len(count))
    if (is.character(preview)) {
      result$truncated <- any(nchar(preview, type = "chars") > 512L, na.rm = TRUE)
      preview <- substr(preview, 1L, 512L)
    }
    result$preview_kind <- "vector"
    result$preview <- rho_preview_values(preview)
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
  namespaces <- loadedNamespaces()
  namespace_paths <- unlist(lapply(head(namespaces, 512L), function(name) {
    # The built-in base namespace has no queryable package path; it is covered
    # by R's own library paths, not an incomplete user-library observation.
    if (identical(name, "base")) return(character())
    tryCatch({
      namespace <- base::.Internal(getRegisteredNamespace(name))
      if (base::is.null(namespace)) return(NA_character_)
      path <- base::getNamespaceInfo(namespace, "path")
      if (is.null(path)) character() else as.character(path)
    }, error = function(error) NA_character_)
  }), use.names = FALSE)
  libraries <- .libPaths()
  list(objects = unname(lapply(selected, rho_binding_summary)),
       total_bindings = length(names), truncated = length(selected) < length(names),
       working_directory = getwd(),
       r_version = paste(R.version$major, R.version$minor, sep = "."),
       library_paths = unname(as.list(head(libraries, 128L))),
       namespace_paths = unname(as.list(namespace_paths[!is.na(namespace_paths)])),
       library_usage_complete = length(namespaces) <= 512L && length(libraries) <= 128L && !anyNA(namespace_paths))
}

rho_inspect_object <- function(name, max_items) {
  stopifnot(is.character(name), length(name) == 1L, !is.na(name),
            nchar(name, type = "bytes") <= 4096L, nchar(name, type = "chars") <= 1024L,
            is.numeric(max_items), length(max_items) == 1L, max_items >= 1, max_items <= 100)
  rho_binding_summary(name, inspect = TRUE, max_items = as.integer(max_items))
}
