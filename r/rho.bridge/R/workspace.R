#' List Workspace Objects Without Serializing Their Values
#' @export
rho_list_objects <- function(envir = .GlobalEnv, limit = 200L) {
  names <- ls(envir = envir, all.names = TRUE)
  names <- head(names, as.integer(limit))
  lapply(names, function(name) {
    value <- get(name, envir = envir, inherits = FALSE)
    dimensions <- tryCatch(dim(value), error = function(e) NULL)
    list(
      name = name,
      classes = class(value),
      dimensions = if (is.null(dimensions)) NULL else as.integer(dimensions),
      size_bytes = as.numeric(object.size(value)),
      typeof = typeof(value),
      preview_kind = rho_preview_kind(value)
    )
  })
}

normalize_paths <- function(paths) {
  unique(normalizePath(paths, winslash = "/", mustWork = FALSE))
}

safe_package_version <- function(package) {
  tryCatch(
    as.character(utils::packageVersion(package)),
    error = function(e) NULL
  )
}

bounded_vector <- function(values, limit = 8L) {
  values <- as.character(values)
  list(
    values = head(values, as.integer(limit)),
    truncated = length(values) > as.integer(limit)
  )
}

rho_preview_kind <- function(value) {
  if (is.data.frame(value)) {
    return("tabular")
  }
  if (is.matrix(value) || is.array(value)) {
    return("array")
  }
  if (is.atomic(value) && is.null(dim(value))) {
    return("vector")
  }
  if (is.list(value)) {
    return("list")
  }
  "opaque"
}

rho_function_source <- function(value, name, max_chars = 12000L) {
  if (!is.function(value)) {
    return(NULL)
  }

  source_lines <- deparse(value, width.cutoff = 500L)
  source_lines[[1L]] <- sprintf("%s <- %s", name, source_lines[[1L]])
  srcref <- attr(value, "srcref", exact = TRUE)
  srcfile <- if (is.null(srcref)) NULL else attr(srcref, "srcfile", exact = TRUE)
  source_path <- tryCatch({
    if (is.environment(srcfile) && exists("filename", envir = srcfile, inherits = FALSE)) {
      get("filename", envir = srcfile, inherits = FALSE)
    } else if (is.list(srcfile)) {
      srcfile$filename
    } else {
      NULL
    }
  }, error = function(e) NULL)
  if (is.character(source_path) && length(source_path) == 1L && nzchar(source_path)) {
    source_path <- normalizePath(source_path, winslash = "/", mustWork = FALSE)
  } else {
    source_path <- NULL
  }

  list(
    definition = compact_text(source_lines, max_chars = max_chars),
    path = source_path,
    line = if (length(srcref) >= 1L) as.integer(srcref[[1L]]) else NULL,
    column = if (length(srcref) >= 5L) as.integer(srcref[[5L]]) else NULL
  )
}

rho_detect_renv_state <- function(project_dir = getwd()) {
  lockfile <- file.path(project_dir, "renv.lock")
  renv_library <- normalizePath(
    file.path(project_dir, "renv"),
    winslash = "/",
    mustWork = FALSE
  )
  lib_paths <- normalize_paths(.libPaths())
  has_lockfile <- file.exists(lockfile)
  renv_available <- requireNamespace("renv", quietly = TRUE)
  active <- any(startsWith(lib_paths, renv_library))
  status <- if (!has_lockfile) {
    "absent"
  } else if (!renv_available) {
    "degraded"
  } else if (active) {
    "active"
  } else {
    "present"
  }
  list(
    status = status,
    has_lockfile = has_lockfile,
    lockfile_path = if (has_lockfile) normalizePath(lockfile, winslash = "/", mustWork = FALSE) else NULL,
    package_available = renv_available,
    project_library = renv_library,
    active = active
  )
}

rho_detect_bioc_state <- function() {
  if (!requireNamespace("BiocManager", quietly = TRUE)) {
    return(list(
      status = "unknown",
      version = NULL,
      package_available = FALSE
    ))
  }
  version <- tryCatch(
    as.character(BiocManager::version()),
    error = function(e) NULL
  )
  list(
    status = if (is.null(version)) "unknown" else "available",
    version = version,
    package_available = TRUE
  )
}

rho_attached_packages <- function(limit = 12L) {
  attached <- search()
  packages <- sub("^package:", "", attached[grepl("^package:", attached)])
  list(
    values = lapply(head(packages, as.integer(limit)), function(name) {
      list(name = name, version = safe_package_version(name))
    }),
    truncated = length(packages) > as.integer(limit)
  )
}

rho_render_capabilities <- function() {
  quarto_binary <- Sys.which("quarto")
  quarto_available <- nzchar(quarto_binary)
  rmarkdown_available <- requireNamespace("rmarkdown", quietly = TRUE)
  knitr_available <- requireNamespace("knitr", quietly = TRUE)
  list(
    quarto = list(
      available = quarto_available,
      binary = if (quarto_available) normalizePath(quarto_binary, winslash = "/", mustWork = FALSE) else NULL
    ),
    rmarkdown = list(
      available = rmarkdown_available,
      version = if (rmarkdown_available) safe_package_version("rmarkdown") else NULL
    ),
    knitr = list(
      available = knitr_available,
      version = if (knitr_available) safe_package_version("knitr") else NULL
    ),
    can_render_qmd = quarto_available,
    can_render_rmd = rmarkdown_available && knitr_available
  )
}

rho_environment_snapshot <- function() {
  list(
    project_dir = normalizePath(getwd(), winslash = "/", mustWork = FALSE),
    renv = rho_detect_renv_state(),
    bioconductor = rho_detect_bioc_state(),
    attached_packages = rho_attached_packages(),
    render = rho_render_capabilities()
  )
}

bounded_text <- function(value, max_chars = 256L) {
  value <- as.character(value %||% "")
  if (nchar(value, type = "bytes") <= as.integer(max_chars)) {
    return(value)
  }
  paste0(substr(value, 1L, as.integer(max_chars)), "... [truncated]")
}

bounded_scalar <- function(value, max_chars = 256L) {
  if (is.null(value) || !length(value)) {
    return(NULL)
  }
  if (is.factor(value) || inherits(value, c("Date", "POSIXt"))) {
    return(bounded_text(value[[1L]], max_chars = max_chars))
  }
  if (is.atomic(value) && length(value) == 1L) {
    if (is.character(value)) {
      return(bounded_text(value, max_chars = max_chars))
    }
    if (is.raw(value)) {
      return(bounded_text(paste(format(value), collapse = ""), max_chars = max_chars))
    }
    return(unclass(value)[[1L]])
  }
  sprintf("<%s length=%d>", paste(class(value), collapse = "/"), length(value))
}

bounded_columns <- function(names, limit = 8L, max_chars = 128L) {
  names <- as.character(names %||% character())
  list(
    values = vapply(
      head(names, as.integer(limit)),
      bounded_text,
      character(1),
      max_chars = max_chars
    ),
    truncated = length(names) > as.integer(limit)
  )
}

`%||%` <- function(x, y) {
  if (is.null(x)) y else x
}

preview_data_frame <- function(value,
                               max_rows = 8L,
                               max_cols = 8L,
                               max_cell_chars = 256L) {
  column_limit <- min(ncol(value), as.integer(max_cols))
  preview <- utils::head(
    value[, seq_len(column_limit), drop = FALSE],
    as.integer(max_rows)
  )
  rows <- lapply(seq_len(nrow(preview)), function(index) {
    row <- lapply(preview, function(column) {
      bounded_scalar(column[[index]], max_chars = max_cell_chars)
    })
    names(row) <- colnames(preview)
    row
  })
  list(
    kind = "tabular",
    columns = bounded_columns(colnames(value), max_cols),
    column_types = vapply(
      preview,
      function(column) bounded_text(paste(class(column), collapse = "/"), 128L),
      character(1)
    ),
    rows = rows,
    truncated_rows = nrow(value) > as.integer(max_rows),
    truncated_columns = ncol(value) > as.integer(max_cols)
  )
}

preview_matrix <- function(value,
                           max_rows = 8L,
                           max_cols = 8L,
                           max_cell_chars = 256L) {
  row_limit <- min(nrow(value), as.integer(max_rows))
  col_limit <- min(ncol(value), as.integer(max_cols))
  preview <- value[seq_len(row_limit), seq_len(col_limit), drop = FALSE]
  rows <- lapply(seq_len(row_limit), function(row_index) {
    lapply(seq_len(col_limit), function(column_index) {
      bounded_scalar(preview[row_index, column_index], max_chars = max_cell_chars)
    })
  })
  list(
    kind = "array",
    columns = bounded_columns(colnames(value), max_cols),
    mode = mode(value),
    rows = rows,
    truncated_rows = nrow(value) > as.integer(max_rows),
    truncated_columns = ncol(value) > as.integer(max_cols)
  )
}

preview_vector <- function(value, limit = 12L, max_item_chars = 256L) {
  raw_values <- utils::head(value, as.integer(limit))
  list(
    kind = "vector",
    values = lapply(raw_values, bounded_scalar, max_chars = max_item_chars),
    truncated = length(value) > as.integer(limit)
  )
}

preview_list <- function(value, limit = 12L, max_item_chars = 128L) {
  names <- names(value)
  item_names <- if (is.null(names)) paste0("[[", seq_along(value), "]]") else names
  item_names <- vapply(
    head(item_names, as.integer(limit)),
    bounded_text,
    character(1),
    max_chars = max_item_chars
  )
  list(
    kind = "list",
    items = item_names,
    truncated = length(value) > as.integer(limit)
  )
}

rho_bounded_preview <- function(value,
                                max_rows = 8L,
                                max_cols = 8L,
                                max_items = 12L) {
  if (is.data.frame(value)) {
    return(preview_data_frame(value, max_rows = max_rows, max_cols = max_cols))
  }
  if (is.matrix(value) || is.array(value)) {
    return(preview_matrix(value, max_rows = max_rows, max_cols = max_cols))
  }
  if (is.atomic(value) && is.null(dim(value))) {
    return(preview_vector(value, limit = max_items))
  }
  if (is.list(value)) {
    return(preview_list(value, limit = max_items))
  }
  list(
    kind = "opaque",
    unsupported_preview = TRUE
  )
}

#' Return a Bounded Workspace Snapshot
#' @export
rho_workspace_snapshot <- function(envir = .GlobalEnv, object_limit = 200L) {
  list(
    ok = TRUE,
    r = list(
      version = R.version.string,
      platform = R.version$platform,
      cwd = normalizePath(getwd(), winslash = "/", mustWork = FALSE),
      lib_paths = normalize_paths(.libPaths()),
      attached = search(),
      loaded_namespaces = loadedNamespaces()
    ),
    environment = rho_environment_snapshot(),
    objects = rho_list_objects(envir = envir, limit = object_limit),
    last_execution = rho_get_last_execution()
  )
}

#' Inspect One Workspace Object with Bounded Output
#' @export
rho_inspect_object <- function(name,
                               envir = .GlobalEnv,
                               max_chars = 4000L,
                               max_level = 2L,
                               max_rows = 8L,
                               max_cols = 8L,
                               max_items = 12L) {
  stopifnot(is.character(name), length(name) == 1L, nzchar(name))
  if (!exists(name, envir = envir, inherits = FALSE)) {
    stop(sprintf("Object `%s` does not exist in the workspace.", name), call. = FALSE)
  }
  value <- get(name, envir = envir, inherits = FALSE)
  structure_text <- capture.output(
    str(value, max.level = as.integer(max_level), give.attr = FALSE)
  )
  dimensions <- tryCatch(dim(value), error = function(e) NULL)
  list(
    ok = TRUE,
    name = name,
    classes = class(value),
    dimensions = if (is.null(dimensions)) NULL else as.integer(dimensions),
    size_bytes = as.numeric(object.size(value)),
    typeof = typeof(value),
    preview_kind = rho_preview_kind(value),
    function_source = rho_function_source(value, name),
    preview = rho_bounded_preview(
      value,
      max_rows = max_rows,
      max_cols = max_cols,
      max_items = max_items
    ),
    structure = compact_text(structure_text, max_chars = max_chars)
  )
}

#' Render a Project Document Through Optional Tooling
#' @export
rho_render_document <- function(path,
                                format = NULL,
                                envir = .GlobalEnv,
                                quiet = TRUE) {
  stopifnot(is.character(path), length(path) == 1L, nzchar(path))
  full_path <- normalizePath(path, winslash = "/", mustWork = FALSE)
  if (!file.exists(full_path)) {
    return(list(
      ok = FALSE,
      kind = "render",
      error = list(
        message = sprintf("Document does not exist: %s", path),
        phase = "resolve_path",
        tool = NULL
      )
    ))
  }
  extension <- tolower(tools::file_ext(full_path))
  capabilities <- rho_render_capabilities()
  if (identical(extension, "qmd")) {
    if (!isTRUE(capabilities$can_render_qmd)) {
      return(list(
        ok = FALSE,
        kind = "render",
        capability = capabilities,
        error = list(
          message = "Quarto is not available in the current environment.",
          phase = "capability",
          tool = "quarto"
        )
      ))
    }
    args <- c("render", full_path)
    if (is.character(format) && nzchar(format)) {
      args <- c(args, "--to", format)
    }
    result <- tryCatch(
      system2(
        command = capabilities$quarto$binary,
        args = args,
        stdout = TRUE,
        stderr = TRUE
      ),
      error = function(error) {
        structure(character(), status = 1L, error_message = conditionMessage(error))
      }
    )
    status <- attr(result, "status")
    if (is.null(status)) {
      output_file <- sub("\\.qmd$", ".html", full_path, ignore.case = TRUE)
      return(list(
        ok = TRUE,
        kind = "render",
        tool = "quarto",
        capability = capabilities,
        source_path = full_path,
        output_path = normalizePath(output_file, winslash = "/", mustWork = FALSE),
        stdout = compact_text(result, max_chars = 16000L),
        messages = character(),
        warnings = character(),
        error = NULL
      ))
    }
    return(list(
      ok = FALSE,
      kind = "render",
      tool = "quarto",
      source_path = full_path,
      capability = capabilities,
      stdout = compact_text(result, max_chars = 16000L),
      error = list(
        message = attr(result, "error_message") %||% compact_text(result, max_chars = 16000L),
        phase = "render",
        tool = "quarto"
      )
    ))
  }
  if (identical(extension, "rmd")) {
    if (!isTRUE(capabilities$can_render_rmd)) {
      return(list(
        ok = FALSE,
        kind = "render",
        capability = capabilities,
        error = list(
          message = "rmarkdown/knitr is not available in the current environment.",
          phase = "capability",
          tool = "rmarkdown"
        )
      ))
    }
    output <- character()
    warnings <- character()
    result <- tryCatch(
      withCallingHandlers(
        {
          output_path <- rmarkdown::render(
            input = full_path,
            output_format = if (is.character(format) && nzchar(format)) format else NULL,
            quiet = quiet,
            envir = envir
          )
          list(ok = TRUE, output_path = normalizePath(output_path, winslash = "/", mustWork = FALSE))
        },
        warning = function(warning) {
          warnings <<- c(warnings, conditionMessage(warning))
          invokeRestart("muffleWarning")
        },
        message = function(message) {
          output <<- c(output, conditionMessage(message))
          invokeRestart("muffleMessage")
        }
      ),
      error = function(error) {
        list(
          ok = FALSE,
          error = list(
            message = conditionMessage(error),
            phase = "render",
            tool = "rmarkdown"
          )
        )
      }
    )
    return(c(
      list(
        kind = "render",
        tool = "rmarkdown",
        source_path = full_path,
        capability = capabilities,
        stdout = compact_text(output, max_chars = 16000L),
        messages = output,
        warnings = warnings
      ),
      result
    ))
  }
  list(
    ok = FALSE,
    kind = "render",
    capability = capabilities,
    error = list(
      message = sprintf("Unsupported render document type: .%s", extension),
      phase = "capability",
      tool = NULL
    )
  )
}

