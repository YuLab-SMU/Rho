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
  value <- get(name, envir = .GlobalEnv, inherits = FALSE)
  result$object_type <- typeof(value)
  classes <- attr(value, "class", exact = TRUE)
  if (is.character(classes) && !is.object(classes)) result$classes <- as.list(substr(.subset(classes, seq_len(min(length(classes), 16L))), 1L, 128L))
  dimensions <- attr(value, "dim", exact = TRUE)
  if (!is.object(dimensions) && (is.integer(dimensions) || is.double(dimensions))) result$dimensions <- as.list(.subset(dimensions, seq_len(min(length(dimensions), 16L))))
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
      path <- getNamespaceInfo(name, "path")
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

# Observe DESCRIPTION text and existing namespaces only. No package is loaded,
# attached, installed, or probed, and no library path or startup file is changed.
rho_packages <- function(payload) {
  stopifnot(payload$mode %in% c("installed", "loaded", "attached"),
            length(payload$filter) == 1L, nchar(payload$filter) <= 128L,
            payload$limit >= 1L, payload$limit <= 200L,
            payload$offset >= 0L, payload$offset <= 10000L)
  libs <- .libPaths()
  complete <- length(libs) <= 128L
  libs <- head(libs, 128L)
  notices <- character()
  note <- function(text) { notices <<- unique(c(notices, text)); complete <<- FALSE }
  if (!complete) note("Library paths limited to 128.")
  namespaces <- sort(loadedNamespaces())
  if (length(namespaces) > 512L) note("Loaded namespaces limited to 512.")
  attached <- sub("^package:", "", grep("^package:", search(), value = TRUE))
  loaded <- setNames(lapply(head(namespaces, 512L), function(name) {
    tryCatch(list(version = as.character(getNamespaceVersion(name)),
                  path = if (identical(name, "base")) file.path(R.home("library"), "base") else getNamespaceInfo(name, "path")),
             error = function(e) { note("Some loaded namespace metadata could not be read."); list(version = NULL, path = NULL) })
  }), head(namespaces, 512L))
  rows <- list()
  scanned <- 0L
  seen <- character()
  add <- function(name, version, title, built, lib, index, first) {
    if (nzchar(payload$filter) && !grepl(tolower(payload$filter), tolower(paste(name, title)), fixed = TRUE)) return(invisible(NULL))
    native <- if (name %in% names(loaded)) loaded[[name]] else list(version = NULL, path = NULL)
    rows[[length(rows) + 1L]] <<- list(name = name, version = version, title = title, built = built,
      library_path = lib, library_index = index, first_in_library_path = first,
      loaded_version = native$version, loaded_path = native$path,
      loaded_from_library = !is.null(native$path) && !is.null(lib) &&
        identical(normalizePath(native$path, winslash = "/", mustWork = FALSE),
                  normalizePath(file.path(lib, name), winslash = "/", mustWork = FALSE)),
      attached = name %in% attached)
  }
  if (identical(payload$mode, "installed")) {
    fields <- c("Package", "Version", "Title", "Built")
    for (index in seq_along(libs)) {
      lib <- libs[[index]]
      if (!dir.exists(lib) || file.access(lib, 4L) != 0L) {
        note(paste("Library unavailable:", lib)); next
      }
      entries <- list.files(lib, pattern = "^[A-Za-z][A-Za-z0-9.]*$", full.names = TRUE)
      budget <- max(0L, 10000L - scanned)
      if (length(entries) > budget) note("Library scan limited to 10,000 entries. Narrowing a search does not scan beyond this bound.")
      for (entry in head(entries, budget)) {
        scanned <- scanned + 1L
        description <- file.path(entry, "DESCRIPTION")
        info <- file.info(description)
        if (is.na(info$size) || isTRUE(info$isdir)) next
        if (info$size > 262144L) { note("Oversized package DESCRIPTION metadata was skipped (256 KiB limit)."); next }
        metadata <- tryCatch(read.dcf(description, fields = fields), error = function(e) NULL)
        if (is.null(metadata) || nrow(metadata) != 1L || anyNA(metadata[1L, c("Package", "Version")])) {
          note("Unreadable or invalid package DESCRIPTION metadata was skipped."); next
        }
        name <- unname(metadata[1L, "Package"])
        if (!identical(name, basename(entry))) { note("Package directory and DESCRIPTION names disagree; entry skipped."); next }
        value <- function(field, limit) {
          text <- unname(metadata[1L, field])
          if (is.na(text)) return(NULL)
          if (nchar(text) > limit) note("Long package metadata fields were shortened.")
          substr(text, 1L, limit)
        }
        first <- !name %in% seen
        seen <- c(seen, name)
        add(name, value("Version", 128L), value("Title", 512L), value("Built", 256L), lib, index, first)
      }
      if (scanned >= 10000L) {
        if (index < length(libs)) note("Later libraries were not scanned after the 10,000-entry limit.")
        break
      }
    }
  } else {
    for (name in names(loaded)) {
      if (identical(payload$mode, "attached") && !name %in% attached) next
      scanned <- scanned + 1L
      native <- loaded[[name]]
      lib <- if (is.null(native$path)) NULL else dirname(native$path)
      index <- match(lib, libs)
      if (!length(index) || is.na(index)) index <- NULL
      add(name, if (is.null(native$version)) "Unknown" else native$version, NULL, NULL, lib, index, FALSE)
    }
  }
  if (length(rows)) rows <- rows[order(vapply(rows, function(x) tolower(x$name), ""))]
  total <- length(rows)
  start <- payload$offset + 1L
  end <- min(total, payload$offset + payload$limit)
  page <- if (start <= end) rows[seq.int(start, end)] else list()
  list(r_version = paste(R.version$major, R.version$minor, sep = "."),
       r_home = R.home(), platform = R.version$platform,
       library_paths = unname(as.list(libs)), mode = payload$mode, filter = payload$filter,
       offset = payload$offset, next_offset = if (end < total) end else NULL,
       packages = unname(page), total_matches = total, scanned = scanned,
       scan_complete = complete, notices = unname(as.list(head(notices, 20L))))
}
