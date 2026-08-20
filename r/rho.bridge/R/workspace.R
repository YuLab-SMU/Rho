#' List Workspace Objects Without Serializing Their Values
#' @export
rho_list_objects <- function(envir = .GlobalEnv, limit = 200L) {
  names <- ls(envir = envir, all.names = TRUE)
  names <- head(names, as.integer(limit))
  lapply(names, function(name) {
    if (bindingIsActive(name, envir)) {
      return(list(
        name = name,
        classes = "active_binding",
        dimensions = NULL,
        size_bytes = NA_real_,
        typeof = "active_binding",
        preview_kind = "opaque",
        active_binding = TRUE
      ))
    }
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

rho_read_lockfile <- function(project_dir) {
  lockfile <- file.path(project_dir, "renv.lock")
  if (!file.exists(lockfile)) {
    return(list(
      exists = FALSE,
      valid = FALSE,
      packages = list(),
      parse_error = NULL
    ))
  }

  parsed <- tryCatch(
    jsonlite::fromJSON(lockfile, simplifyVector = FALSE),
    error = function(e) e
  )
  if (inherits(parsed, "error")) {
    return(list(
      exists = TRUE,
      valid = FALSE,
      packages = list(),
      parse_error = conditionMessage(parsed)
    ))
  }

  package_entries <- parsed$Packages %||% list()
  values <- lapply(names(package_entries), function(name) {
    item <- package_entries[[name]] %||% list()
    list(
      name = name,
      version = if (is.null(item$Version)) NULL else as.character(item$Version),
      source = if (is.null(item$Source)) NULL else as.character(item$Source)
    )
  })
  values <- values[order(vapply(values, function(item) item$name, character(1)))]

  list(
    exists = TRUE,
    valid = is.list(parsed$Packages),
    packages = values,
    parse_error = NULL
  )
}

rho_compare_lockfile_library <- function(lockfile_packages, installed_packages, limit = 50L) {
  installed_versions <- stats::setNames(
    vapply(installed_packages, function(item) item$version %||% NA_character_, character(1)),
    vapply(installed_packages, function(item) item$name, character(1))
  )
  installed_names <- names(installed_versions)
  lockfile_names <- vapply(lockfile_packages, function(item) item$name, character(1))
  diff <- list()

  for (package in lockfile_packages) {
    library_version <- if (package$name %in% installed_names) {
      unname(installed_versions[[package$name]])
    } else {
      NA_character_
    }
    if (is.na(library_version)) {
      diff[[length(diff) + 1L]] <- list(
        name = package$name,
        lockfile_version = package$version %||% NULL,
        library_version = NULL,
        direction = "missing_in_library"
      )
      next
    }
    if (!identical(package$version %||% NA_character_, library_version)) {
      diff[[length(diff) + 1L]] <- list(
        name = package$name,
        lockfile_version = package$version %||% NULL,
        library_version = library_version,
        direction = "version_mismatch"
      )
    }
  }

  missing_in_lockfile <- sort(setdiff(installed_names, lockfile_names))
  for (name in missing_in_lockfile) {
    diff[[length(diff) + 1L]] <- list(
      name = name,
      lockfile_version = NULL,
      library_version = unname(installed_versions[[name]] %||% NA_character_),
      direction = "missing_in_lockfile"
    )
  }

  list(
    values = head(diff, as.integer(limit)),
    truncated = length(diff) > as.integer(limit)
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
  installed <- rho_project_installed_packages(project_dir, limit = 10000L)
  lockfile_state <- rho_read_lockfile(project_dir)
  synchronization <- if (!has_lockfile) {
    "no_lockfile"
  } else if (!lockfile_state$valid) {
    "invalid_lockfile"
  } else if (!renv_available) {
    "renv_unavailable"
  } else if (length(rho_compare_lockfile_library(lockfile_state$packages, installed$values, limit = 1L)$values)) {
    "drifted"
  } else {
    "synchronized"
  }
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
    active = active,
    synchronization = synchronization,
    lockfile_valid = lockfile_state$valid,
    lockfile_parse_error = lockfile_state$parse_error %||% NULL
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

rho_runtime_state <- function() {
  list(
    version = paste(R.version$major, R.version$minor, sep = "."),
    platform = R.version$platform
  )
}

# renv can temporarily expose a project library before it has been created or
# restored. Keep inventory useful by including valid site/base libraries and
# explicit R library variables. Rho transports the effective user-profile
# paths through R_LIBS, but some R startup combinations do not merge R_LIBS
# into .libPaths() automatically.
rho_environment_variable_library_paths <- function() {
  values <- unlist(lapply(
    c("R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"),
    function(name) Sys.getenv(name, unset = "")
  ), use.names = FALSE)
  values <- values[nzchar(values)]
  if (!length(values)) return(character())
  values <- unlist(strsplit(values, split = .Platform$path.sep, fixed = TRUE), use.names = FALSE)
  values <- path.expand(values)
  values <- values[nzchar(values) & dir.exists(values)]
  normalizePath(unique(values), winslash = "/", mustWork = FALSE)
}

rho_effective_library_paths <- function() {
  paths <- unique(c(
    .libPaths(),
    rho_environment_variable_library_paths(),
    .Library.site,
    .Library
  ))
  paths <- paths[nzchar(paths) & dir.exists(paths)]
  normalizePath(paths, winslash = "/", mustWork = FALSE)
}

rho_installed_packages <- function(limit = 10000L) {
  rows <- tryCatch(
    utils::installed.packages(
      lib.loc = rho_effective_library_paths(),
      fields = c("Package", "Version", "LibPath")
    ),
    error = function(e) e
  )

  if (inherits(rows, "error")) {
    return(list(
      values = list(),
      truncated = FALSE,
      incomplete_reason = conditionMessage(rows)
    ))
  }

  packages <- lapply(seq_len(nrow(rows)), function(index) {
    list(
      name = as.character(rows[index, "Package"]),
      version = as.character(rows[index, "Version"]),
      library = normalizePath(
        as.character(rows[index, "LibPath"]),
        winslash = "/",
        mustWork = FALSE
      )
    )
  })

  packages <- packages[order(
    vapply(packages, function(item) item$name, character(1)),
    vapply(packages, function(item) item$library, character(1))
  )]

  list(
    values = head(packages, as.integer(limit)),
    total_count = length(packages),
    truncated = length(packages) > as.integer(limit),
    incomplete_reason = NULL
  )
}

rho_project_installed_packages <- function(project_dir, limit = 10000L) {
  if (!requireNamespace("renv", quietly = TRUE)) {
    return(list(values = list(), total_count = 0L, truncated = FALSE, incomplete_reason = "renv unavailable"))
  }
  project_library <- tryCatch(
    rho_environment_project_library(project_dir),
    error = function(e) NULL
  )
  if (is.null(project_library) || !dir.exists(project_library)) {
    return(list(values = list(), total_count = 0L, truncated = FALSE, incomplete_reason = NULL))
  }
  rows <- tryCatch(
    utils::installed.packages(lib.loc = project_library, fields = c("Package", "Version", "LibPath")),
    error = function(e) e
  )
  if (inherits(rows, "error")) {
    return(list(values = list(), total_count = 0L, truncated = FALSE, incomplete_reason = conditionMessage(rows)))
  }
  packages <- lapply(seq_len(nrow(rows)), function(index) {
    list(
      name = as.character(rows[index, "Package"]),
      version = as.character(rows[index, "Version"]),
      library = normalizePath(as.character(rows[index, "LibPath"]), winslash = "/", mustWork = FALSE)
    )
  })
  packages <- packages[order(vapply(packages, function(item) item$name, character(1)))]
  list(values = head(packages, as.integer(limit)), total_count = length(packages), truncated = length(packages) > as.integer(limit), incomplete_reason = NULL)
}

#' Return a browsable installed-package list for the Environment panel.
#' Includes priority ("base" / "recommended") and build version.
rho_list_installed_packages <- function(limit = 500L) {
  rows <- tryCatch(
    utils::installed.packages(
      lib.loc = rho_effective_library_paths(),
      fields = c("Package", "Version", "LibPath", "Priority", "Built")
    ),
    error = function(e) e
  )

  if (inherits(rows, "error")) {
    return(list(
      packages = list(),
      total_count = 0L,
      truncated = FALSE,
      error = conditionMessage(rows)
    ))
  }

  all <- lapply(seq_len(nrow(rows)), function(index) {
    list(
      name = as.character(rows[index, "Package"]),
      version = as.character(rows[index, "Version"]),
      library = normalizePath(
        as.character(rows[index, "LibPath"]),
        winslash = "/",
        mustWork = FALSE
      ),
      priority = if (!is.na(rows[index, "Priority"]))
        as.character(rows[index, "Priority"]) else NULL,
      built = if (!is.na(rows[index, "Built"]))
        as.character(rows[index, "Built"]) else NULL
    )
  })

  all <- all[order(
    vapply(all, function(item) item$name, character(1)),
    vapply(all, function(item) item$library, character(1))
  )]

  list(
    packages = head(all, as.integer(limit)),
    total_count = length(all),
    truncated = length(all) > as.integer(limit)
  )
}

rho_lockfile_inventory_limit <- function(limit) {
  value <- if (!length(limit)) 500L else suppressWarnings(as.integer(limit[[1L]]))
  if (is.na(value)) value <- 500L
  max(1L, min(value, 500L))
}

rho_lockfile_inventory_text <- function(value, max_bytes = 512L) {
  if (is.null(value) || !length(value) || is.na(value[[1L]])) return(NULL)
  value <- enc2utf8(as.character(value[[1L]]))
  if (nchar(value, type = "bytes") <= max_bytes) return(value)
  while (nchar(value, type = "bytes") > max_bytes && nchar(value) > 0L) {
    value <- substr(value, 1L, nchar(value) - 1L)
  }
  value
}

rho_lockfile_inventory_installed_rows <- function() {
  utils::installed.packages(
    lib.loc = rho_effective_library_paths(),
    fields = c(
      "Package", "Version", "LibPath", "Repository", "RemoteType",
      "RemoteUrl", "RemoteUsername", "RemoteRepo", "RemoteRef"
    )
  )
}

rho_lockfile_inventory_library_paths <- function() .libPaths()

rho_lockfile_inventory_matrix_value <- function(rows, index, name) {
  if (!(name %in% colnames(rows))) return(NULL)
  value <- rows[index, name]
  if (!length(value) || is.na(value[[1L]])) return(NULL)
  rho_lockfile_inventory_text(value, 1000L)
}

rho_lockfile_dependency_names <- function(value) {
  if (is.null(value) || !length(value)) return(character())
  values <- unlist(value, use.names = FALSE)
  tokens <- trimws(unlist(strsplit(values, ",", fixed = TRUE), use.names = FALSE))
  tokens <- trimws(sub("\\s*\\(.*$", "", tokens))
  unique(tokens[grepl("^[A-Za-z][A-Za-z0-9.]*$", tokens) & tokens != "R"])
}

rho_lockfile_description_roles <- function(project_dir) {
  description <- file.path(project_dir, "DESCRIPTION")
  result <- list(
    state = "no_description",
    path = NULL,
    fields = list(),
    direct = character(),
    error = NULL
  )
  if (!file.exists(description)) return(result)
  info <- file.info(description)
  normalized <- tryCatch(
    normalizePath(description, winslash = "/", mustWork = TRUE),
    error = function(e) e
  )
  root_prefix <- paste0(tolower(project_dir), "/")
  if (inherits(normalized, "error") || isTRUE(info$isdir) || nzchar(Sys.readlink(description)) ||
      !startsWith(tolower(normalized), root_prefix)) {
    result$state <- "invalid_description"
    result$error <- "DESCRIPTION must be a regular file inside the project root"
    return(result)
  }
  if (is.na(info$size) || info$size > 256L * 1024L) {
    result$state <- "description_size_limit"
    result$error <- "DESCRIPTION exceeds the 256 KiB inventory budget"
    return(result)
  }
  fields <- c("Depends", "Imports", "LinkingTo", "Suggests")
  parsed <- tryCatch(read.dcf(normalized, fields = fields), error = function(e) e)
  if (inherits(parsed, "error") || nrow(parsed) != 1L) {
    result$state <- "invalid_description"
    result$error <- rho_lockfile_inventory_text(
      if (inherits(parsed, "error")) conditionMessage(parsed) else "DESCRIPTION must contain one DCF record",
      1000L
    )
    return(result)
  }
  declared <- lapply(fields, function(field) {
    value <- parsed[1L, field]
    if (is.na(value)) character() else rho_lockfile_dependency_names(value)
  })
  names(declared) <- fields
  result$state <- "available"
  result$path <- normalized
  result$fields <- lapply(declared, as.list)
  result$direct <- sort(unique(unlist(declared, use.names = FALSE)))
  result
}

rho_lockfile_dependency_closure <- function(direct,
                                            requirements,
                                            requirement_limit = 512L,
                                            node_limit = 10000L,
                                            edge_limit = 10000L,
                                            graph_complete = TRUE) {
  if (!length(direct)) {
    return(list(transitive = character(), incomplete = FALSE, reasons = list()))
  }
  if (!isTRUE(graph_complete)) {
    return(list(
      transitive = character(),
      incomplete = TRUE,
      reasons = list("lockfile_packages_source_limit")
    ))
  }
  queue <- direct
  seen <- character()
  edges <- 0L
  reasons <- list()
  while (length(queue)) {
    name <- queue[[1L]]
    queue <- queue[-1L]
    if (name %in% seen) next
    seen <- c(seen, name)
    if (length(seen) > node_limit) {
      reasons <- list("dependency_node_limit")
      break
    }
    children <- requirements[[name]] %||% character()
    if (length(children) > requirement_limit) {
      reasons <- list("dependency_requirement_limit")
      break
    }
    edges <- edges + length(children)
    if (edges > edge_limit) {
      reasons <- list("dependency_edge_limit")
      break
    }
    queue <- c(queue, setdiff(children, seen))
  }
  if (length(reasons)) {
    return(list(transitive = character(), incomplete = TRUE, reasons = reasons))
  }
  list(
    transitive = sort(setdiff(seen, direct)),
    incomplete = FALSE,
    reasons = list()
  )
}

rho_lockfile_safe_remote_label <- function(value) {
  value <- rho_lockfile_inventory_text(value, 1000L)
  if (is.null(value) || !nzchar(value)) return(NULL)
  value <- sub("#.*$", "", value)
  value <- sub("\\?.*$", "", value)
  value <- sub("^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]+@", "\\1", value)
  value <- sub("^([A-Za-z][A-Za-z0-9+.-]*://)", "", value)
  value <- sub("^[^@/]+@", "", value)
  rho_lockfile_inventory_text(value, 256L)
}

rho_lockfile_local_source_label <- function(value, project_dir) {
  value <- rho_lockfile_inventory_text(value, 1000L)
  if (is.null(value) || !nzchar(value)) return(NULL)
  path_components <- strsplit(value, "[/\\\\]+")[[1L]]
  if (any(path_components == "..")) return(NULL)
  candidate <- if (grepl("^([A-Za-z]:[/\\\\]|/)", value)) value else file.path(project_dir, value)
  unresolved <- character()
  probe <- candidate
  repeat {
    link_target <- suppressWarnings(Sys.readlink(probe))
    if (length(link_target) == 1L && !is.na(link_target) && nzchar(link_target) &&
        !file.exists(probe) && !dir.exists(probe)) return(NULL)
    if (file.exists(probe) || dir.exists(probe)) break
    parent <- dirname(probe)
    if (identical(parent, probe)) return(NULL)
    unresolved <- c(basename(probe), unresolved)
    probe <- parent
  }
  if (any(unresolved == "..")) return(NULL)
  normalized <- tryCatch(
    normalizePath(probe, winslash = "/", mustWork = TRUE),
    error = function(error) NULL
  )
  if (is.null(normalized)) return(NULL)
  if (length(unresolved)) {
    normalized <- file.path(normalized, do.call(file.path, as.list(unresolved)))
    normalized <- gsub("\\\\", "/", normalized)
  }
  project_dir <- tryCatch(
    normalizePath(project_dir, winslash = "/", mustWork = TRUE),
    error = function(error) NULL
  )
  if (is.null(project_dir)) return(NULL)
  compare_path <- function(path) {
    if (.Platform$OS.type == "windows") tolower(path) else path
  }
  normalized_key <- compare_path(normalized)
  project_key <- compare_path(project_dir)
  if (identical(normalized_key, project_key)) return(".")
  if (!startsWith(normalized_key, paste0(project_key, "/"))) return(NULL)
  rho_lockfile_inventory_text(substring(normalized, nchar(project_dir) + 2L), 256L)
}

rho_lockfile_package_source <- function(metadata, project_dir) {
  value <- function(name) rho_lockfile_inventory_text(metadata[[name]], 1000L)
  source <- tolower(value("Source") %||% "")
  remote_type <- tolower(value("RemoteType") %||% "")
  repository <- value("Repository")
  if (source == "repository" || !is.null(repository)) {
    return(list(kind = "repository", detail = rho_lockfile_inventory_text(repository, 128L)))
  }
  remote_kind <- if (remote_type %in% c("github", "gitlab", "bitbucket")) remote_type else source
  if (remote_kind %in% c("github", "gitlab", "bitbucket")) {
    owner <- value("RemoteUsername")
    repo <- value("RemoteRepo")
    ref <- value("RemoteRef")
    detail <- paste0(
      if (!is.null(owner) && !is.null(repo)) paste0(owner, "/", repo) else repo %||% "",
      if (!is.null(ref)) paste0("@", ref) else ""
    )
    return(list(kind = remote_kind, detail = rho_lockfile_inventory_text(detail, 256L)))
  }
  if (remote_type == "git" || source == "git") {
    return(list(kind = "git", detail = rho_lockfile_safe_remote_label(value("RemoteUrl") %||% value("URL"))))
  }
  if (remote_type == "url" || source == "url") {
    return(list(kind = "url", detail = rho_lockfile_safe_remote_label(value("RemoteUrl") %||% value("URL"))))
  }
  if (remote_type %in% c("local", "path") || source %in% c("local", "cellar", "path")) {
    return(list(
      kind = "local",
      detail = rho_lockfile_local_source_label(value("Path") %||% value("RemoteUrl"), project_dir)
    ))
  }
  list(kind = "unknown", detail = NULL)
}

rho_lockfile_inventory_error <- function(project_dir, lockfile, message) {
  list(
    project_dir = project_dir,
    lockfile = list(
      path = lockfile,
      exists = file.exists(lockfile),
      valid = FALSE,
      state = "invalid_lockfile",
      parse_error = rho_lockfile_inventory_text(message, 1000L)
    ),
    packages = list(),
    total_count = NULL,
    returned_count = 0L,
    counts = list(
      matched = 0L,
      version_mismatch = 0L,
      missing_in_library = 0L,
      missing_in_lockfile = 0L
    ),
    truncated = FALSE,
    incomplete = TRUE,
    incomplete_reasons = list("lockfile_invalid")
  )
}

#' Return a bounded lockfile and installed-library comparison.
#'
#' @param project_dir Explicit project root containing `renv.lock`.
#' @param limit Maximum number of sorted comparison rows returned (1 to 500).
#' @export
rho_list_lockfile_packages <- function(project_dir, limit = 500L) {
  project_dir <- normalizePath(project_dir, winslash = "/", mustWork = FALSE)
  lockfile_path <- normalizePath(
    file.path(project_dir, "renv.lock"),
    winslash = "/",
    mustWork = FALSE
  )
  limit <- rho_lockfile_inventory_limit(limit)
  source_limit <- 10000L

  installed_result <- tryCatch(rho_lockfile_inventory_installed_rows(), error = function(e) e)
  if (inherits(installed_result, "error")) {
    result <- rho_lockfile_inventory_error(
      project_dir,
      lockfile_path,
      paste("Installed package enumeration failed:", conditionMessage(installed_result))
    )
    result$lockfile$state <- if (file.exists(lockfile_path)) "unavailable" else "no_lockfile"
    result$lockfile$exists <- file.exists(lockfile_path)
    result$incomplete_reasons <- list("installed_packages_unavailable")
    return(result)
  }

  installed_source_count <- nrow(installed_result)
  installed_truncated <- installed_source_count > source_limit
  installed_result <- installed_result[seq_len(min(installed_source_count, source_limit)), , drop = FALSE]
  library_paths <- normalizePath(
    rho_lockfile_inventory_library_paths(),
    winslash = "/",
    mustWork = FALSE
  )
  library_rank <- function(path) {
    normalized <- normalizePath(path, winslash = "/", mustWork = FALSE)
    matched <- match(tolower(normalized), tolower(library_paths))
    if (is.na(matched)) length(library_paths) + 1L else matched
  }
  installed <- lapply(seq_len(nrow(installed_result)), function(index) {
    source_metadata <- stats::setNames(lapply(
      c("Repository", "RemoteType", "RemoteUrl", "RemoteUsername", "RemoteRepo", "RemoteRef"),
      function(field) rho_lockfile_inventory_matrix_value(installed_result, index, field)
    ), c("Repository", "RemoteType", "RemoteUrl", "RemoteUsername", "RemoteRepo", "RemoteRef"))
    list(
      name = rho_lockfile_inventory_text(installed_result[index, "Package"], 256L),
      version = rho_lockfile_inventory_text(installed_result[index, "Version"], 128L),
      library = rho_lockfile_inventory_text(
        normalizePath(installed_result[index, "LibPath"], winslash = "/", mustWork = FALSE),
        1000L
      ),
      source = rho_lockfile_package_source(source_metadata, project_dir),
      library_rank = library_rank(installed_result[index, "LibPath"]),
      source_index = index
    )
  })
  installed <- installed[vapply(installed, function(item) !is.null(item$name) && nzchar(item$name), logical(1))]
  installed <- installed[order(
    vapply(installed, function(item) item$name, character(1)),
    vapply(installed, function(item) item$library_rank, integer(1)),
    vapply(installed, function(item) item$source_index, integer(1))
  )]
  installed_names <- vapply(installed, function(item) item$name, character(1))
  installed <- installed[!duplicated(installed_names)]
  installed_names <- vapply(installed, function(item) item$name, character(1))

  lockfile_exists <- file.exists(lockfile_path)
  locked <- list()
  lockfile_valid <- FALSE
  lockfile_state <- "no_lockfile"
  parse_error <- NULL
  lockfile_truncated <- FALSE
  requirements <- list()
  if (lockfile_exists) {
    lockfile_bytes <- file.info(lockfile_path)$size
    if (is.na(lockfile_bytes) || lockfile_bytes > 5L * 1024L * 1024L) {
      result <- rho_lockfile_inventory_error(
        project_dir,
        lockfile_path,
        "renv.lock exceeds the 5 MiB inventory budget"
      )
      result$incomplete_reasons <- list("lockfile_size_limit")
      return(result)
    }
    parsed <- tryCatch(jsonlite::fromJSON(lockfile_path, simplifyVector = FALSE), error = function(e) e)
    if (inherits(parsed, "error") || !is.list(parsed$Packages)) {
      parse_error <- if (inherits(parsed, "error")) conditionMessage(parsed) else "renv.lock Packages must be an object"
      return(rho_lockfile_inventory_error(project_dir, lockfile_path, parse_error))
    }
    lockfile_valid <- TRUE
    lockfile_state <- "available"
    entries <- parsed$Packages
    entry_names <- names(entries) %||% character()
    lockfile_truncated <- length(entry_names) > source_limit
    entry_names <- head(entry_names, source_limit)
    locked <- lapply(entry_names, function(name) {
      item <- entries[[name]] %||% list()
      source_fields <- c(
        "Source", "Repository", "RemoteType", "RemoteHost", "RemoteUsername",
        "RemoteRepo", "RemoteRef", "RemoteUrl", "URL", "Path"
      )
      source_metadata <- stats::setNames(lapply(source_fields, function(field) item[[field]]), source_fields)
      package_requirements <- rho_lockfile_dependency_names(item$Requirements)
      requirements[[name]] <<- package_requirements
      list(
        name = rho_lockfile_inventory_text(name, 256L),
        version = rho_lockfile_inventory_text(item$Version, 128L),
        source = rho_lockfile_package_source(source_metadata, project_dir)
      )
    })
    locked <- locked[vapply(locked, function(item) !is.null(item$name) && nzchar(item$name), logical(1))]
    locked <- locked[order(vapply(locked, function(item) item$name, character(1)))]
    locked <- locked[!duplicated(vapply(locked, function(item) item$name, character(1)))]
  }

  locked_names <- vapply(locked, function(item) item$name, character(1))
  dependency_roles <- rho_lockfile_description_roles(project_dir)
  dependency_closure <- if (identical(dependency_roles$state, "available")) {
    rho_lockfile_dependency_closure(
      dependency_roles$direct,
      requirements,
      graph_complete = !lockfile_truncated
    )
  } else {
    list(transitive = character(), incomplete = FALSE, reasons = list())
  }
  dependency_roles$incomplete <- dependency_closure$incomplete
  dependency_roles$incomplete_reasons <- dependency_closure$reasons
  direct_names <- dependency_roles$direct
  dependency_roles$direct <- NULL
  union_names <- sort(unique(c(locked_names, installed_names)))
  packages <- lapply(union_names, function(name) {
    locked_index <- match(name, locked_names)
    installed_index <- match(name, installed_names)
    locked_version <- if (is.na(locked_index)) NULL else locked[[locked_index]]$version
    installed_version <- if (is.na(installed_index)) NULL else installed[[installed_index]]$version
    library <- if (is.na(installed_index)) NULL else installed[[installed_index]]$library
    source <- if (!is.na(locked_index)) locked[[locked_index]]$source else installed[[installed_index]]$source
    dependency_role <- if (name %in% direct_names) {
      "direct"
    } else if (name %in% dependency_closure$transitive) {
      "transitive"
    } else {
      "unclassified"
    }
    state <- if (is.na(locked_index)) {
      "missing_in_lockfile"
    } else if (is.na(installed_index)) {
      "missing_in_library"
    } else if (identical(locked_version, installed_version)) {
      "matched"
    } else {
      "version_mismatch"
    }
    list(
      name = name,
      locked_version = locked_version,
      installed_version = installed_version,
      library = library,
      dependency_role = dependency_role,
      source = source,
      state = state
    )
  })
  states <- vapply(packages, function(item) item$state, character(1))
  incomplete_reasons <- list()
  if (installed_truncated) incomplete_reasons <- append(incomplete_reasons, "installed_packages_source_limit")
  if (lockfile_truncated) incomplete_reasons <- append(incomplete_reasons, "lockfile_packages_source_limit")
  source_incomplete <- length(incomplete_reasons) > 0L

  list(
    project_dir = project_dir,
    lockfile = list(
      path = lockfile_path,
      exists = lockfile_exists,
      valid = lockfile_valid,
      state = lockfile_state,
      parse_error = parse_error
    ),
    dependency_roles = dependency_roles,
    packages = head(packages, limit),
    total_count = if (source_incomplete) NULL else length(packages),
    returned_count = min(length(packages), limit),
    counts = list(
      matched = sum(states == "matched"),
      version_mismatch = sum(states == "version_mismatch"),
      missing_in_library = sum(states == "missing_in_library"),
      missing_in_lockfile = sum(states == "missing_in_lockfile")
    ),
    truncated = source_incomplete || length(packages) > limit,
    incomplete = source_incomplete,
    incomplete_reasons = incomplete_reasons
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
    runtime = rho_runtime_state(),
    library_paths = rho_effective_library_paths(),
    renv = rho_detect_renv_state(),
    bioconductor = rho_detect_bioc_state(),
    attached_packages = rho_attached_packages(),
    render = rho_render_capabilities()
  )
}

#' Capture Immutable Environment Evidence For Broker Persistence
#' @export
rho_environment_evidence <- function(project_dir = getwd(), package_limit = 10000L) {
  project_dir <- normalizePath(project_dir, winslash = "/", mustWork = FALSE)
  list(
    project_dir = project_dir,
    runtime = rho_runtime_state(),
    library_paths = rho_effective_library_paths(),
    installed_packages = rho_installed_packages(limit = package_limit),
    renv = rho_detect_renv_state(project_dir = project_dir),
    bioconductor = rho_detect_bioc_state()
  )
}

#' Preview renv status and bounded lockfile drift
#' @export
rho_environment_status_preview <- function(project_dir = getwd(), diff_limit = 50L) {
  project_dir <- normalizePath(project_dir, winslash = "/", mustWork = FALSE)
  installed <- rho_project_installed_packages(project_dir, limit = 10000L)
  lockfile <- rho_read_lockfile(project_dir)
  renv_status <- rho_read_only_renv_status(project_dir)
  diff <- if (isTRUE(lockfile$valid)) {
    rho_compare_lockfile_library(lockfile$packages, installed$values, limit = diff_limit)
  } else {
    list(values = list(), truncated = FALSE)
  }

  list(
    project_dir = project_dir,
    runtime = rho_runtime_state(),
    renv = rho_detect_renv_state(project_dir = project_dir),
    bioconductor = rho_detect_bioc_state(),
    renv_status = renv_status,
    diff = diff
  )
}

rho_read_only_renv_status <- function(project_dir) {
  if (!requireNamespace("renv", quietly = TRUE)) {
    return(list(
      ok = FALSE,
      synchronized = NULL,
      messages = character(),
      warnings = character(),
      error = list(message = "Package `renv` is unavailable.", call = NULL)
    ))
  }

  messages <- character()
  warnings <- character()
  status_result <- tryCatch(
    withCallingHandlers(
      renv::status(
        project = project_dir,
        sources = FALSE,
        cache = FALSE
      ),
      warning = function(warning) {
        warnings <<- c(warnings, conditionMessage(warning))
        invokeRestart("muffleWarning")
      },
      message = function(message) {
        messages <<- c(messages, conditionMessage(message))
        invokeRestart("muffleMessage")
      }
    ),
    error = function(error) error
  )

  if (inherits(status_result, "error")) {
    return(list(
      ok = FALSE,
      synchronized = NULL,
      messages = messages,
      warnings = warnings,
      error = list(
        message = conditionMessage(status_result),
        call = if (is.null(conditionCall(status_result))) NULL else safe_call_text(conditionCall(status_result))
      )
    ))
  }

  synchronized <- tryCatch(
    {
      lockfile_packages <- rho_read_lockfile(project_dir)$packages
      installed <- rho_project_installed_packages(project_dir, limit = 10000L)
      length(rho_compare_lockfile_library(lockfile_packages, installed$values, limit = 1L)$values) == 0L
    },
    error = function(e) NULL
  )

  list(
    ok = TRUE,
    synchronized = synchronized,
    messages = messages,
    warnings = warnings,
    error = NULL
  )
}

rho_environment_package_name <- function(package) {
  package <- rho_lockfile_inventory_text(package, 129L)
  if (is.null(package) || nchar(package, type = "bytes") > 128L ||
      !grepl("^[A-Za-z][A-Za-z0-9.]*$", package)) {
    stop("Package must be one valid R package name (1 to 128 ASCII characters).", call. = FALSE)
  }
  package
}

rho_renv_project_library_path <- function(project_dir) renv::paths$library(project = project_dir)

rho_environment_project_library <- function(project_dir) {
  project_dir <- normalizePath(project_dir, winslash = "/", mustWork = TRUE)
  library <- normalizePath(
    rho_renv_project_library_path(project_dir),
    winslash = "/",
    mustWork = FALSE
  )
  if (!startsWith(tolower(library), paste0(tolower(project_dir), "/"))) {
    stop("The configured renv project library is outside the active project root.", call. = FALSE)
  }
  library
}

rho_environment_renv_available <- function() requireNamespace("renv", quietly = TRUE)

rho_environment_diagnostics <- function(values) {
  values <- trimws(head(as.character(values), 50L))
  unname(vapply(values, function(value) {
    rho_lockfile_inventory_text(value, 1000L) %||% ""
  }, character(1)))
}

rho_environment_package_repositories <- function(repositories = NULL) {
  repositories <- repositories %||% getOption("repos")
  if (is.null(repositories) || !length(repositories) || length(repositories) > 16L) {
    stop("Install and update require 1 to 16 configured repositories.", call. = FALSE)
  }
  repo_names <- names(repositories)
  repositories <- as.character(repositories)
  if (is.null(repo_names)) repo_names <- rep("", length(repositories))
  repo_names[!nzchar(repo_names)] <- paste0("repo", which(!nzchar(repo_names)))
  if (any(nchar(repo_names, type = "bytes") > 64L) || anyDuplicated(repo_names)) {
    stop("Repository names must be unique and no longer than 64 bytes.", call. = FALSE)
  }
  invalid <- is.na(repositories) |
    repositories == "@CRAN@" |
    nchar(repositories, type = "bytes") > 1000L |
    !grepl("^https?://", repositories, ignore.case = TRUE) |
    grepl("^https?://[^/@]+@", repositories, ignore.case = TRUE) |
    grepl("[?#]", repositories)
  if (any(invalid)) {
    stop(
      "Repositories must be explicit HTTP(S) URLs without credentials, query strings, or fragments.",
      call. = FALSE
    )
  }
  repositories <- stats::setNames(repositories, repo_names)
  repositories[order(names(repositories))]
}

rho_environment_project_installed_version <- function(project_library, package) {
  rows <- tryCatch(
    utils::installed.packages(lib.loc = project_library),
    error = function(e) matrix(character(), nrow = 0L, ncol = 0L)
  )
  if (!("Package" %in% colnames(rows)) || !("Version" %in% colnames(rows))) return(NULL)
  matched <- which(rows[, "Package"] == package)
  if (!length(matched)) return(NULL)
  rho_lockfile_inventory_text(rows[matched[[1L]], "Version"], 128L)
}

rho_environment_package_priority <- function(package) {
  rows <- tryCatch(
    utils::installed.packages(lib.loc = .Library, fields = "Priority"),
    error = function(e) matrix(character(), nrow = 0L, ncol = 0L)
  )
  if (!("Package" %in% colnames(rows)) || !("Priority" %in% colnames(rows))) return(NULL)
  matched <- which(rows[, "Package"] == package)
  if (!length(matched)) return(NULL)
  rho_lockfile_inventory_text(rows[matched[[1L]], "Priority"], 32L)
}

#' Preview one bounded package mutation in the explicit project library.
#' @export
rho_environment_package_preview <- function(operation,
                                            package,
                                            project_dir = getwd(),
                                            repositories = NULL) {
  operation <- match.arg(operation, c("install_package", "update_package", "remove_package"))
  package <- rho_environment_package_name(package)
  project_dir <- normalizePath(project_dir, winslash = "/", mustWork = TRUE)
  if (!rho_environment_renv_available()) {
    stop("Package `renv` is unavailable.", call. = FALSE)
  }
  project_library <- rho_environment_project_library(project_dir)
  installed_version <- rho_environment_project_installed_version(project_library, package)
  lockfile <- rho_read_lockfile(project_dir)
  locked <- if (isTRUE(lockfile$valid)) {
    Filter(function(item) identical(item$name, package), lockfile$packages)
  } else {
    list()
  }
  locked_version <- if (length(locked)) locked[[1L]]$version else NULL
  priority <- rho_environment_package_priority(package)
  if (operation == "install_package" && !is.null(installed_version)) {
    stop(sprintf("Package `%s` is already installed in the project library; use Update.", package), call. = FALSE)
  }
  if (operation %in% c("update_package", "remove_package") && is.null(installed_version)) {
    stop(sprintf("Package `%s` is not installed in the project library.", package), call. = FALSE)
  }
  if (operation == "remove_package" && isTRUE(priority %in% c("base", "recommended"))) {
    stop(sprintf("Package `%s` is a %s package and cannot be removed.", package, priority), call. = FALSE)
  }
  repositories <- if (operation == "remove_package") {
    character()
  } else {
    rho_environment_package_repositories(repositories)
  }
  disposition <- switch(
    operation,
    install_package = "will_install",
    update_package = "will_update",
    remove_package = "will_remove"
  )
  warnings <- c(
    if (operation != "remove_package") {
      "Dependency resolution may install or update additional packages."
    },
    "Package operations can leave partial library writes after failure or cancellation; refresh before recovery."
  )
  list(
    ok = TRUE,
    operation = operation,
    package = package,
    project_dir = project_dir,
    project_library = project_library,
    installed_version = installed_version,
    locked_version = locked_version,
    disposition = disposition,
    repositories = as.list(repositories),
    warnings = as.list(warnings)
  )
}

rho_renv_install_package <- function(arguments) do.call(renv::install, arguments)
rho_renv_update_package <- function(arguments) do.call(renv::update, arguments)
rho_renv_remove_package <- function(arguments) do.call(renv::remove, arguments)

rho_execute_renv_operation <- function(operation,
                                       project_dir = getwd(),
                                       repositories = NULL,
                                       bioconductor = NULL,
                                       package = NULL,
                                       project_library = NULL) {
  stopifnot(is.character(operation), length(operation) == 1L, nzchar(operation))
  project_dir <- normalizePath(project_dir, winslash = "/", mustWork = FALSE)
  project_lockfile <- normalizePath(
    file.path(project_dir, "renv.lock"),
    winslash = "/",
    mustWork = FALSE
  )
  if (!rho_environment_renv_available()) {
    return(list(
      ok = FALSE,
      operation = operation,
      project_dir = project_dir,
      lockfile = project_lockfile,
      messages = character(),
      warnings = character(),
      error = list(message = "Package `renv` is unavailable.", call = NULL)
    ))
  }

  messages <- character()
  warnings <- character()
  result <- tryCatch(
    withCallingHandlers(
      {
        if (operation %in% c("install_package", "update_package", "remove_package")) {
          package <- rho_environment_package_name(package)
          expected_library <- rho_environment_project_library(project_dir)
          confirmed_library <- normalizePath(project_library, winslash = "/", mustWork = FALSE)
          if (!identical(tolower(expected_library), tolower(confirmed_library))) {
            stop("Confirmed package library no longer matches the active renv project library.", call. = FALSE)
          }
          repositories <- if (operation == "remove_package") {
            character()
          } else {
            rho_environment_package_repositories(repositories)
          }
          rho_environment_package_preview(
            operation = operation,
            package = package,
            project_dir = project_dir,
            repositories = repositories
          )
          arguments <- switch(
            operation,
            install_package = list(
              packages = package, library = confirmed_library, rebuild = FALSE,
              repos = repositories, prompt = FALSE, dependencies = NA,
              transactional = TRUE, lock = FALSE, project = project_dir
            ),
            update_package = list(
              packages = package, library = confirmed_library, rebuild = FALSE,
              check = FALSE, prompt = FALSE, lock = FALSE, all = FALSE,
              repos = repositories, project = project_dir
            ),
            remove_package = list(
              packages = package, library = confirmed_library, project = project_dir
            )
          )
          switch(
            operation,
            install_package = rho_renv_install_package(arguments),
            update_package = rho_renv_update_package(arguments),
            remove_package = rho_renv_remove_package(arguments)
          )
        } else if (identical(operation, "snapshot")) {
          renv::snapshot(
            project = project_dir,
            lockfile = project_lockfile,
            prompt = FALSE,
            update = FALSE,
            force = FALSE,
            reprex = FALSE
          )
        } else if (identical(operation, "restore")) {
          renv::restore(
            project = project_dir,
            lockfile = project_lockfile,
            packages = NULL,
            exclude = NULL,
            rebuild = FALSE,
            clean = FALSE,
            strict = TRUE,
            transactional = TRUE,
            prompt = FALSE
          )
        } else if (identical(operation, "initialize")) {
          renv::init(
            project = project_dir,
            # Initialization scaffolds only; Restore is a separate explicit operation.
            bare = TRUE,
            force = FALSE,
            repos = repositories,
            bioconductor = bioconductor,
            load = FALSE,
            restart = FALSE
          )
        } else {
          stop(sprintf("Unsupported renv operation: %s", operation), call. = FALSE)
        }
      },
      warning = function(warning) {
        warnings <<- c(warnings, conditionMessage(warning))
        invokeRestart("muffleWarning")
      },
      message = function(message) {
        messages <<- c(messages, conditionMessage(message))
        invokeRestart("muffleMessage")
      }
    ),
    error = function(error) error
  )

  if (inherits(result, "error")) {
    messages <- rho_environment_diagnostics(messages)
    warnings <- rho_environment_diagnostics(warnings)
    return(list(
      ok = FALSE,
      operation = operation,
      project_dir = project_dir,
      lockfile = project_lockfile,
      messages = messages,
      warnings = warnings,
      error = list(
        message = conditionMessage(result),
        call = if (is.null(conditionCall(result))) NULL else safe_call_text(conditionCall(result))
      )
    ))
  }

  messages <- rho_environment_diagnostics(messages)
  warnings <- rho_environment_diagnostics(warnings)

  list(
    ok = TRUE,
    operation = operation,
    project_dir = project_dir,
    lockfile = project_lockfile,
    repositories = repositories,
    bioconductor = bioconductor,
    package = package,
    project_library = project_library,
    messages = messages,
    warnings = warnings,
    value = compact_text(capture.output(str(result, max.level = 2L)), max_chars = 4000L),
    error = NULL
  )
}

#' Run a typed renv operation with fixed arguments
#' @export
rho_environment_operation <- function(operation,
                                      project_dir = getwd(),
                                      repositories = NULL,
                                      bioconductor = NULL,
                                      package = NULL,
                                      project_library = NULL) {
  rho_execute_renv_operation(
    operation = operation,
    project_dir = project_dir,
    repositories = repositories,
    bioconductor = bioconductor,
    package = package,
    project_library = project_library
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

rho_viewer_max_rows <- function() 100L
rho_viewer_max_columns <- function() 50L
rho_viewer_max_cell_bytes <- function() 4096L
rho_viewer_max_payload_bytes <- function() 1024L * 1024L
rho_viewer_max_query_bytes <- function() 256L
rho_viewer_max_search_rows <- function() 50000L
rho_viewer_max_search_cells <- function() 100000L

rho_viewer_error <- function(code, message, ...) {
  extras <- list(...)
  output <- c(
    list(
      ok = FALSE,
      error_code = code,
      message = message
    ),
    extras
  )
  output
}

rho_viewer_hex <- function(text) {
  bytes <- as.integer(charToRaw(enc2utf8(text %||% "")))
  paste(sprintf("%02x", bytes), collapse = "")
}

rho_viewer_token <- function(name, classes, dimensions, views) {
  payload <- list(
    name = name,
    classes = as.character(classes %||% character()),
    dimensions = as.integer(dimensions %||% integer()),
    views = lapply(views, function(view) {
      list(
        kind = view$kind,
        key = view$key,
        rows = as.integer(view$rows %||% 0L),
        columns = as.integer(view$columns %||% 0L)
      )
    })
  )
  rho_viewer_hex(jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null"))
}

rho_viewer_missing_dependency <- function(classes) {
  classes <- as.character(classes %||% character())
  if ("SingleCellExperiment" %in% classes
      && !requireNamespace("SingleCellExperiment", quietly = TRUE)) {
    return("SingleCellExperiment")
  }
  if ("SummarizedExperiment" %in% classes
      && !requireNamespace("SummarizedExperiment", quietly = TRUE)) {
    return("SummarizedExperiment")
  }
  NULL
}

rho_viewer_dimensions <- function(value) {
  dimensions <- tryCatch(dim(value), error = function(e) NULL)
  if (is.null(dimensions)) {
    return(NULL)
  }
  as.integer(dimensions)
}

rho_viewer_view_descriptor <- function(kind, key, rows, columns, label = NULL) {
  list(
    kind = kind,
    key = key,
    label = label %||% key,
    rows = as.integer(rows),
    columns = as.integer(columns)
  )
}

rho_viewer_describe_object <- function(value, name) {
  classes <- class(value)
  missing_dependency <- rho_viewer_missing_dependency(classes)
  if (!is.null(missing_dependency)) {
    return(rho_viewer_error(
      "optional_package_unavailable",
      sprintf("Viewer support for `%s` requires the optional `%s` package.", name, missing_dependency),
      name = name,
      classes = classes
    ))
  }

  dimensions <- rho_viewer_dimensions(value)
  display_kind <- NULL
  views <- NULL

  if (is.data.frame(value)) {
    display_kind <- "data_frame"
    views <- list(rho_viewer_view_descriptor(
      kind = "table",
      key = "table",
      rows = nrow(value),
      columns = ncol(value),
      label = "Table"
    ))
  } else if (is.matrix(value)) {
    display_kind <- "matrix"
    views <- list(rho_viewer_view_descriptor(
      kind = "matrix",
      key = "matrix",
      rows = nrow(value),
      columns = ncol(value),
      label = "Matrix"
    ))
  } else if (requireNamespace("SummarizedExperiment", quietly = TRUE)
             && methods::is(value, "SummarizedExperiment")) {
    display_kind <- if (methods::is(value, "SingleCellExperiment")) {
      "single_cell_experiment"
    } else {
      "summarized_experiment"
    }
    assay_names <- as.character(SummarizedExperiment::assayNames(value))
    assay_views <- lapply(assay_names, function(assay_name) {
      assay <- SummarizedExperiment::assay(value, assay_name, withDimnames = TRUE)
      rho_viewer_view_descriptor(
        kind = "assay",
        key = assay_name,
        rows = nrow(assay),
        columns = ncol(assay),
        label = assay_name
      )
    })
    row_data <- as.data.frame(SummarizedExperiment::rowData(value), stringsAsFactors = FALSE)
    col_data <- as.data.frame(SummarizedExperiment::colData(value), stringsAsFactors = FALSE)
    views <- c(
      assay_views,
      list(
        rho_viewer_view_descriptor(
          kind = "row_data",
          key = "rowData",
          rows = nrow(row_data),
          columns = ncol(row_data),
          label = "rowData"
        ),
        rho_viewer_view_descriptor(
          kind = "col_data",
          key = "colData",
          rows = nrow(col_data),
          columns = ncol(col_data),
          label = "colData"
        )
      )
    )
  } else if (isS4(value)) {
    return(rho_viewer_error(
      "unsupported_object_class",
      sprintf("Viewer support is not available for S4 class `%s`.", paste(classes, collapse = "/")),
      name = name,
      classes = classes
    ))
  } else {
    return(rho_viewer_error(
      "unsupported_object_class",
      sprintf("Viewer support is not available for class `%s`.", paste(classes, collapse = "/")),
      name = name,
      classes = classes
    ))
  }

  list(
    ok = TRUE,
    name = name,
    class = classes,
    display_kind = display_kind,
    dimensions = dimensions,
    view_token = rho_viewer_token(name, classes, dimensions, views),
    views = views,
    truncated = FALSE,
    truncation_reason = NULL
  )
}

rho_viewer_checked_limit <- function(limit, maximum, label) {
  limit <- as.integer(limit %||% 0L)
  if (is.na(limit) || limit < 0L) {
    stop(sprintf("%s must be a non-negative integer.", label), call. = FALSE)
  }
  if (limit > maximum) {
    structure(
      list(limit = maximum, label = label),
      class = "rho_viewer_limit_error"
    )
  } else {
    limit
  }
}

rho_viewer_subset_indices <- function(offset, limit, total) {
  offset <- as.integer(offset %||% 0L)
  limit <- as.integer(limit %||% 0L)
  if (is.na(offset) || offset < 0L) {
    stop("Offsets must be non-negative integers.", call. = FALSE)
  }
  if (limit <= 0L || total <= 0L || offset >= total) {
    return(integer())
  }
  start <- offset + 1L
  end <- min(total, offset + limit)
  seq.int(start, end)
}

rho_viewer_column_labels <- function(names, offset = 0L, count = NULL) {
  values <- as.character(names %||% character())
  if (!length(values)) {
    values <- paste0("V", seq_len(as.integer(count %||% 0L)) + as.integer(offset))
  }
  lapply(seq_along(values), function(index) {
    value <- values[[index]]
    if (!nzchar(value)) {
      value <- paste0("V", as.integer(offset) + index)
    }
    list(
      index = as.integer(offset) + index - 1L,
      name = value,
      label = bounded_text(value, max_chars = 256L)
    )
  })
}

rho_viewer_column_type <- function(value) {
  if (is.factor(value)) return("factor")
  if (inherits(value, "Date")) return("date")
  if (inherits(value, "POSIXt")) return("datetime")
  if (is.logical(value)) return("logical")
  if (is.integer(value)) return("integer")
  if (is.double(value)) return("double")
  if (is.character(value)) return("character")
  if (is.complex(value)) return("complex")
  if (is.list(value)) return("list")
  "other"
}

rho_viewer_column_metadata <- function(columns, data, column_indices, row_indices) {
  lapply(seq_along(columns), function(index) {
    value <- rho_viewer_column(data, column_indices[[index]])
    classes <- head(as.character(class(value)), 8L)
    columns[[index]]$type <- rho_viewer_column_type(value)
    columns[[index]]$classes <- lapply(classes, bounded_text, max_chars = 128L)
    columns[[index]]$page_missing_count <- as.integer(sum(is.na(value[row_indices])))
    columns[[index]]
  })
}

rho_viewer_cell_state <- function(value) {
  if (is.null(value) || !length(value)) return("na")
  if (is.list(value) && !is.data.frame(value)) return("value")
  if (length(value) != 1L) return("value")
  scalar <- unclass(value)[[1L]]
  if (is.numeric(scalar) && is.nan(scalar)) return("nan")
  if (is.numeric(scalar) && is.infinite(scalar)) {
    return(if (scalar > 0) "pos_inf" else "neg_inf")
  }
  if (length(scalar) == 1L && is.na(scalar)) return("na")
  if (is.character(scalar) && identical(scalar, "")) return("empty")
  "value"
}

rho_viewer_normalize_query <- function(query) {
  if (is.null(query)) {
    return(list(ok = TRUE, value = NULL))
  }
  if (!is.character(query) || length(query) != 1L || is.na(query)) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "invalid_query",
      "Search query must be one UTF-8 string or null."
    )))
  }
  value <- trimws(enc2utf8(query))
  bytes <- charToRaw(value)
  if (any(bytes == as.raw(0L)) || grepl("[\r\n]", value)) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "invalid_query",
      "Search query cannot contain NUL or newline controls."
    )))
  }
  if (length(bytes) > rho_viewer_max_query_bytes()) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "invalid_query",
      "Search query exceeds the supported UTF-8 byte limit.",
      supported_maximum_bytes = rho_viewer_max_query_bytes()
    )))
  }
  list(ok = TRUE, value = if (nzchar(value)) value else NULL)
}

rho_viewer_normalize_sort <- function(sort_column, sort_direction, total_columns) {
  if (is.null(sort_column)) {
    if (!is.null(sort_direction)) {
      return(list(ok = FALSE, error = rho_viewer_error(
        "invalid_sort",
        "Sort direction requires a sort column."
      )))
    }
    return(list(ok = TRUE, column = NULL, direction = NULL))
  }
  if (length(sort_column) != 1L || is.na(sort_column)
      || !is.numeric(sort_column) || sort_column != as.integer(sort_column)
      || sort_column < 0L || sort_column >= total_columns) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "invalid_sort",
      "Sort column must be a valid zero-based absolute column index."
    )))
  }
  if (!is.character(sort_direction) || length(sort_direction) != 1L
      || is.na(sort_direction) || !(sort_direction %in% c("asc", "desc"))) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "invalid_sort",
      "Sort direction must be `asc` or `desc`."
    )))
  }
  list(ok = TRUE, column = as.integer(sort_column), direction = sort_direction)
}

rho_viewer_column <- function(data, column_index) {
  if (is.data.frame(data)) {
    return(data[[column_index]])
  }
  data[, column_index, drop = TRUE]
}

rho_viewer_matching_rows <- function(data, row_names, query, total_rows, total_columns) {
  if (is.null(query)) {
    return(list(ok = TRUE, indices = seq_len(total_rows)))
  }
  cells <- as.double(total_rows) * as.double(total_columns)
  if (total_rows > rho_viewer_max_search_rows() || cells > rho_viewer_max_search_cells()) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "search_scope_exceeded",
      "Exact search is unavailable because this view exceeds the supported scope.",
      source_total_rows = as.integer(total_rows),
      source_total_cells = cells,
      supported_maximum_rows = rho_viewer_max_search_rows(),
      supported_maximum_cells = rho_viewer_max_search_cells()
    )))
  }
  normalized_query <- tolower(enc2utf8(query))
  matches_query <- function(values) {
    grepl(normalized_query, tolower(enc2utf8(as.character(values))), fixed = TRUE)
  }
  matched <- matches_query(row_names)
  for (column_index in seq_len(total_columns)) {
    values <- rho_viewer_column(data, column_index)
    text <- vapply(seq_len(total_rows), function(row_index) {
      rho_viewer_cell_text(values[row_index]) %||% ""
    }, character(1))
    matched <- matched | matches_query(text)
  }
  list(ok = TRUE, indices = which(matched))
}

rho_viewer_sorted_rows <- function(data, row_indices, sort_column, sort_direction) {
  if (is.null(sort_column) || !length(row_indices)) {
    return(list(ok = TRUE, indices = row_indices))
  }
  values <- rho_viewer_column(data, sort_column + 1L)
  if (is.list(values) || is.complex(values)) {
    return(list(ok = FALSE, error = rho_viewer_error(
      "unsupported_sort_column",
      "This column type cannot be sorted in the Data Viewer.",
      sort_column = sort_column
    )))
  }
  selected <- values[row_indices]
  missing <- is.na(selected)
  present_positions <- which(!missing)
  if (length(present_positions)) {
    order_positions <- order(
      selected[present_positions],
      present_positions,
      decreasing = c(identical(sort_direction, "desc"), FALSE),
      method = "radix"
    )
    present_positions <- present_positions[order_positions]
  }
  list(ok = TRUE, indices = row_indices[c(present_positions, which(missing))])
}

rho_viewer_cell_text <- function(value) {
  if (is.null(value) || !length(value)) {
    return(NULL)
  }
  if (is.list(value) && !is.data.frame(value)) {
    if (length(value) == 1L) {
      return(rho_viewer_cell_text(value[[1L]]))
    }
    return(bounded_text(compact_text(capture.output(str(value, max.level = 1L))), max_chars = rho_viewer_max_cell_bytes()))
  }
  if (length(value) > 1L && !is.matrix(value) && !is.data.frame(value)) {
    return(bounded_text(
      compact_text(capture.output(str(value, max.level = 1L))),
      max_chars = rho_viewer_max_cell_bytes()
    ))
  }
  state <- rho_viewer_cell_state(value)
  if (identical(state, "na")) return(NULL)
  if (identical(state, "nan")) return("NaN")
  if (identical(state, "pos_inf")) return("Inf")
  if (identical(state, "neg_inf")) return("-Inf")
  if (is.factor(value) || inherits(value, c("Date", "POSIXt"))) {
    return(bounded_text(as.character(value[[1L]]), max_chars = rho_viewer_max_cell_bytes()))
  }
  if (is.atomic(value)) {
    scalar <- unclass(value)[[1L]]
    if (is.numeric(scalar) && is.nan(scalar)) {
      return("NaN")
    }
    if (is.numeric(scalar) && is.infinite(scalar)) {
      return(if (scalar > 0) "Inf" else "-Inf")
    }
    if (length(scalar) == 1L && is.na(scalar)) {
      return(NULL)
    }
    return(bounded_text(as.character(scalar), max_chars = rho_viewer_max_cell_bytes()))
  }
  bounded_text(
    compact_text(capture.output(str(value, max.level = 1L))),
    max_chars = rho_viewer_max_cell_bytes()
  )
}

rho_viewer_materialize_view <- function(value, view_kind, view_key) {
  if (view_kind %in% c("table", "matrix")) {
    if (is.data.frame(value)) {
      return(list(
        data = value,
        row_names = rownames(value),
        column_names = colnames(value),
        total_rows = nrow(value),
        total_columns = ncol(value)
      ))
    }
    if (is.matrix(value)) {
      return(list(
        data = value,
        row_names = rownames(value),
        column_names = colnames(value),
        total_rows = nrow(value),
        total_columns = ncol(value)
      ))
    }
  }

  if (!(requireNamespace("SummarizedExperiment", quietly = TRUE)
        && methods::is(value, "SummarizedExperiment"))) {
    stop(sprintf("Unsupported view `%s` for the selected object.", view_kind), call. = FALSE)
  }

  if (identical(view_kind, "assay")) {
    assay_names <- as.character(SummarizedExperiment::assayNames(value))
    if (!(view_key %in% assay_names)) {
      stop(sprintf("Assay `%s` is not available.", view_key), call. = FALSE)
    }
    assay <- SummarizedExperiment::assay(value, view_key, withDimnames = TRUE)
    return(list(
      data = assay,
      row_names = rownames(assay),
      column_names = colnames(assay),
      total_rows = nrow(assay),
      total_columns = ncol(assay)
    ))
  }

  if (identical(view_kind, "row_data")) {
    data <- as.data.frame(SummarizedExperiment::rowData(value), stringsAsFactors = FALSE)
    return(list(
      data = data,
      row_names = rownames(data) %||% rownames(value),
      column_names = colnames(data),
      total_rows = nrow(data),
      total_columns = ncol(data)
    ))
  }

  if (identical(view_kind, "col_data")) {
    data <- as.data.frame(SummarizedExperiment::colData(value), stringsAsFactors = FALSE)
    return(list(
      data = data,
      row_names = rownames(data) %||% colnames(value),
      column_names = colnames(data),
      total_rows = nrow(data),
      total_columns = ncol(data)
    ))
  }

  stop(sprintf("Unsupported view `%s` for the selected object.", view_kind), call. = FALSE)
}

rho_viewer_subset_data <- function(data, row_indices, column_indices) {
  if (is.data.frame(data)) {
    return(data[row_indices, column_indices, drop = FALSE])
  }
  data[row_indices, column_indices, drop = FALSE]
}

rho_viewer_rows_payload <- function(data, row_indices, column_indices, row_names) {
  if (!length(row_indices) || !length(column_indices)) {
    return(list())
  }
  subset <- rho_viewer_subset_data(data, row_indices, column_indices)
  lapply(seq_along(row_indices), function(index) {
    row_index <- row_indices[[index]]
    if (is.data.frame(subset)) {
      source_values <- lapply(subset[index, , drop = FALSE], function(cell) cell[[1L]])
      row_values <- lapply(source_values, function(cell) {
        rho_viewer_cell_text(cell)
      })
    } else {
      source_values <- lapply(seq_along(column_indices), function(column_index) subset[index, column_index])
      row_values <- lapply(source_values, rho_viewer_cell_text)
    }
    list(
      row_name = bounded_text((row_names %||% character())[[row_index]] %||% as.character(row_index), max_chars = 256L),
      cells = unname(row_values),
      cell_states = unname(lapply(source_values, rho_viewer_cell_state))
    )
  })
}

rho_viewer_payload_bytes <- function(value) {
  nchar(
    jsonlite::toJSON(value, auto_unbox = TRUE, null = "null"),
    type = "bytes"
  )
}

#' Inspect One Supported Data Object for the Paged Viewer
#' @export
rho_inspect_data_object <- function(object_name, envir = .GlobalEnv) {
  stopifnot(is.character(object_name), length(object_name) == 1L, nzchar(object_name))
  if (!exists(object_name, envir = envir, inherits = FALSE)) {
    return(rho_viewer_error(
      "object_not_found",
      sprintf("Object `%s` does not exist in the workspace.", object_name),
      name = object_name
    ))
  }
  value <- get(object_name, envir = envir, inherits = FALSE)
  response <- rho_viewer_describe_object(value, object_name)
  if (!isTRUE(response$ok)) {
    return(response)
  }
  if (rho_viewer_payload_bytes(response) > rho_viewer_max_payload_bytes()) {
    response$truncated <- TRUE
    response$truncation_reason <- "payload_limit"
  }
  response
}

#' Read One Bounded Page from a Supported Data Object View
#' @export
rho_read_data_view <- function(object_name,
                               view_token,
                               view_kind,
                               view_key,
                               row_offset = 0L,
                               row_limit = 50L,
                               column_offset = 0L,
                               column_limit = 20L,
                               query = NULL,
                               sort_column = NULL,
                               sort_direction = NULL,
                               envir = .GlobalEnv) {
  stopifnot(is.character(object_name), length(object_name) == 1L, nzchar(object_name))
  stopifnot(is.character(view_token), length(view_token) == 1L, nzchar(view_token))
  stopifnot(is.character(view_kind), length(view_kind) == 1L, nzchar(view_kind))
  stopifnot(is.character(view_key), length(view_key) == 1L, nzchar(view_key))

  if (!exists(object_name, envir = envir, inherits = FALSE)) {
    return(rho_viewer_error(
      "object_not_found",
      sprintf("Object `%s` does not exist in the workspace.", object_name),
      name = object_name
    ))
  }

  row_limit_checked <- tryCatch(
    rho_viewer_checked_limit(row_limit, rho_viewer_max_rows(), "row_limit"),
    rho_viewer_limit_error = function(error) error
  )
  if (inherits(row_limit_checked, "rho_viewer_limit_error")) {
    return(rho_viewer_error(
      "page_limit_exceeded",
      "Requested row limit exceeds the supported maximum.",
      limit_name = row_limit_checked$label,
      supported_maximum = row_limit_checked$limit
    ))
  }
  column_limit_checked <- tryCatch(
    rho_viewer_checked_limit(column_limit, rho_viewer_max_columns(), "column_limit"),
    rho_viewer_limit_error = function(error) error
  )
  if (inherits(column_limit_checked, "rho_viewer_limit_error")) {
    return(rho_viewer_error(
      "page_limit_exceeded",
      "Requested column limit exceeds the supported maximum.",
      limit_name = column_limit_checked$label,
      supported_maximum = column_limit_checked$limit
    ))
  }

  value <- get(object_name, envir = envir, inherits = FALSE)
  descriptor <- rho_viewer_describe_object(value, object_name)
  if (!isTRUE(descriptor$ok)) {
    return(descriptor)
  }
  if (!identical(descriptor$view_token, view_token)) {
    return(rho_viewer_error(
      "stale_view_token",
      "The selected data view is stale. Reload the object before requesting another page.",
      object_name = object_name,
      view_kind = view_kind,
      view_key = view_key
    ))
  }

  view <- Filter(function(item) identical(item$kind, view_kind) && identical(item$key, view_key), descriptor$views)
  if (!length(view)) {
    return(rho_viewer_error(
      "unsupported_view",
      sprintf("View `%s/%s` is not available for `%s`.", view_kind, view_key, object_name),
      object_name = object_name,
      view_kind = view_kind,
      view_key = view_key
    ))
  }

  materialized <- rho_viewer_materialize_view(value, view_kind, view_key)
  normalized_query <- rho_viewer_normalize_query(query)
  if (!isTRUE(normalized_query$ok)) {
    return(normalized_query$error)
  }
  normalized_sort <- rho_viewer_normalize_sort(
    sort_column,
    sort_direction,
    materialized$total_columns
  )
  if (!isTRUE(normalized_sort$ok)) {
    return(normalized_sort$error)
  }
  row_names <- materialized$row_names %||% as.character(seq_len(materialized$total_rows))
  matched <- rho_viewer_matching_rows(
    materialized$data,
    row_names,
    normalized_query$value,
    materialized$total_rows,
    materialized$total_columns
  )
  if (!isTRUE(matched$ok)) {
    return(matched$error)
  }
  sorted <- rho_viewer_sorted_rows(
    materialized$data,
    matched$indices,
    normalized_sort$column,
    normalized_sort$direction
  )
  if (!isTRUE(sorted$ok)) {
    return(sorted$error)
  }
  page_positions <- rho_viewer_subset_indices(row_offset, row_limit_checked, length(sorted$indices))
  row_indices <- sorted$indices[page_positions]
  column_indices <- rho_viewer_subset_indices(column_offset, column_limit_checked, materialized$total_columns)
  rows <- list()
  truncated <- FALSE
  truncation_reason <- NULL
  column_labels <- rho_viewer_column_labels(
    materialized$column_names[column_indices],
    offset = as.integer(column_offset),
    count = length(column_indices)
  )

  for (index in seq_along(row_indices)) {
    candidate_rows <- c(
      rows,
      rho_viewer_rows_payload(
        materialized$data,
        row_indices[[index]],
        column_indices,
        row_names
      )
    )
    candidate_columns <- rho_viewer_column_metadata(
      column_labels,
      materialized$data,
      column_indices,
      row_indices[seq_along(candidate_rows)]
    )
    candidate <- list(
      ok = TRUE,
      page = list(
        object_name = object_name,
        class = descriptor$class,
        dimensions = descriptor$dimensions,
        view_kind = view_kind,
        view_key = view_key,
        view_token = descriptor$view_token,
        source_total_rows = as.integer(materialized$total_rows),
        total_rows = as.integer(length(sorted$indices)),
        total_columns = as.integer(materialized$total_columns),
        row_offset = as.integer(row_offset),
        row_limit = as.integer(row_limit_checked),
        column_offset = as.integer(column_offset),
        column_limit = as.integer(column_limit_checked),
        query = normalized_query$value,
        sort_column = normalized_sort$column,
        sort_direction = normalized_sort$direction,
        columns = candidate_columns,
        rows = candidate_rows,
        truncated = FALSE,
        truncation_reason = NULL,
        payload_bytes = 0L
      )
    )
    candidate$page$payload_bytes <- rho_viewer_payload_bytes(candidate)
    if (candidate$page$payload_bytes > rho_viewer_max_payload_bytes()) {
      truncated <- TRUE
      truncation_reason <- "payload_limit"
      break
    }
    rows <- candidate_rows
  }

  if (!truncated && length(row_indices) < as.integer(row_limit_checked)
      && (as.integer(row_offset) + length(row_indices)) < length(sorted$indices)) {
    truncated <- TRUE
    truncation_reason <- "payload_limit"
  }

  columns <- rho_viewer_column_metadata(
    column_labels,
    materialized$data,
    column_indices,
    row_indices[seq_along(rows)]
  )

  response <- list(
    ok = TRUE,
    page = list(
      object_name = object_name,
      class = descriptor$class,
      dimensions = descriptor$dimensions,
      view_kind = view_kind,
      view_key = view_key,
      view_token = descriptor$view_token,
      source_total_rows = as.integer(materialized$total_rows),
      total_rows = as.integer(length(sorted$indices)),
      total_columns = as.integer(materialized$total_columns),
      row_offset = as.integer(row_offset),
      row_limit = as.integer(row_limit_checked),
      column_offset = as.integer(column_offset),
      column_limit = as.integer(column_limit_checked),
      query = normalized_query$value,
      sort_column = normalized_sort$column,
      sort_direction = normalized_sort$direction,
      columns = columns,
      rows = rows,
      truncated = truncated,
      truncation_reason = truncation_reason,
      payload_bytes = 0L
    )
  )
  response$page$payload_bytes <- rho_viewer_payload_bytes(response)
  response
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
  if (bindingIsActive(name, envir)) {
    stop("Active bindings cannot be inspected without evaluating project code.", call. = FALSE)
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

#' Find the definition of an R function in project source files.
#' Returns list(file, line) or NULL if not found.
rho_find_function_definition <- function(name, project_root) {
  if (is.null(name) || nchar(name) == 0) return(NULL)

  # Find .R and .Rmd/.qmd files in the project
  project_files <- list.files(
    project_root,
    pattern = "\\.(R|Rmd|qmd)$",
    recursive = TRUE,
    full.names = TRUE,
    ignore.case = TRUE
  )

  # Limit scan to avoid unbounded search
  if (length(project_files) > 500) {
    project_files <- head(project_files, 500)
  }

  pattern <- sprintf(
    "^\\s*%s\\s*(<-|<<-|=)\\s*function\\s*\\(",
    name
  )

  for (f in project_files) {
    lines <- tryCatch(
      suppressWarnings(readLines(f, warn = FALSE)),
      error = function(e) NULL
    )
    if (is.null(lines)) next

    for (i in seq_along(lines)) {
      if (grepl(pattern, lines[[i]], perl = TRUE)) {
        return(list(
          file = normalizePath(f, winslash = "/", mustWork = FALSE),
          line = i,
          column = regexpr("function", lines[[i]])[[1]]
        ))
      }
    }
  }

  NULL
}

#' Find bounded references to one symbol in project R source.
#' @return A JSON-safe reference result with project-relative paths.
rho_find_project_references <- function(name, project_root, limit = 100L) {
  rho_find_project_references_impl(name, project_root, limit = limit)
}

rho_reference_lookup_name <- function(name) {
  if (!is.character(name) || length(name) != 1L || is.na(name) || !nzchar(name) ||
      nchar(enc2utf8(name), type = "bytes") > 128L || grepl("[[:cntrl:]]", name)) {
    stop("Reference name must contain 1 to 128 UTF-8 bytes without control characters.", call. = FALSE)
  }
  enc2utf8(name)
}

rho_reference_project_root <- function(project_root) {
  if (!is.character(project_root) || length(project_root) != 1L || is.na(project_root) ||
      !nzchar(project_root) || nchar(enc2utf8(project_root), type = "bytes") > 1000L ||
      grepl("[[:cntrl:]]", project_root)) {
    stop("Reference project root must be one existing directory.", call. = FALSE)
  }
  root <- tryCatch(
    normalizePath(project_root, winslash = "/", mustWork = TRUE),
    error = function(e) NULL
  )
  if (is.null(root) || !dir.exists(root)) {
    stop("Reference project root must be one existing directory.", call. = FALSE)
  }
  root
}

rho_reference_bounded_text <- function(value, max_bytes) {
  value <- enc2utf8(as.character(value %||% ""))
  if (nchar(value, type = "bytes") <= max_bytes) return(value)
  while (nzchar(value) && nchar(value, type = "bytes") > max_bytes - 3L) {
    value <- substr(value, 1L, nchar(value) - 1L)
  }
  paste0(value, "...")
}

rho_reference_is_inside <- function(path, root) {
  path <- tolower(path)
  root <- tolower(root)
  identical(path, root) || startsWith(path, paste0(root, "/"))
}

rho_reference_project_files <- function(root, file_limit = 500L, entry_limit = 5000L,
                                        depth_limit = 8L) {
  ignored <- c(".git", ".rho", ".rproj.user", "renv", "node_modules", "target")
  queue <- list(list(path = root, relative = "", depth = 0L))
  files <- list()
  notices <- character()
  entries_seen <- 0L

  while (length(queue)) {
    current <- queue[[1L]]
    queue <- queue[-1L]
    entries <- tryCatch(
      list.files(current$path, all.files = TRUE, full.names = TRUE, no.. = TRUE),
      error = function(e) NULL
    )
    if (is.null(entries)) {
      notices <- c(notices, "directory_read_error")
      next
    }
    entries <- entries[order(tolower(basename(entries)), basename(entries))]
    for (entry in entries) {
      entries_seen <- entries_seen + 1L
      if (entries_seen > entry_limit) {
        notices <- c(notices, "entry_limit")
        queue <- list()
        break
      }
      name <- basename(entry)
      relative <- if (nzchar(current$relative)) file.path(current$relative, name) else name
      relative <- gsub("\\\\", "/", relative)
      if (nzchar(Sys.readlink(entry))) {
        notices <- c(notices, "path_containment")
        next
      }
      info <- tryCatch(file.info(entry), error = function(e) NULL)
      if (is.null(info) || is.na(info$isdir[[1L]])) {
        notices <- c(notices, "file_metadata_error")
        next
      }
      normalized <- tryCatch(
        normalizePath(entry, winslash = "/", mustWork = TRUE),
        error = function(e) NULL
      )
      if (is.null(normalized) || !rho_reference_is_inside(normalized, root)) {
        notices <- c(notices, "path_containment")
        next
      }
      if (isTRUE(info$isdir[[1L]])) {
        if (tolower(name) %in% ignored) next
        if (current$depth >= depth_limit) {
          notices <- c(notices, "depth_limit")
          next
        }
        queue[[length(queue) + 1L]] <- list(
          path = normalized,
          relative = relative,
          depth = current$depth + 1L
        )
        next
      }
      if (!grepl("\\.(r|rmd|qmd)$", name, ignore.case = TRUE)) next
      if (nchar(enc2utf8(relative), type = "bytes") > 1000L) {
        notices <- c(notices, "path_limit")
        next
      }
      if (length(files) >= file_limit) {
        notices <- c(notices, "file_limit")
        queue <- list()
        break
      }
      files[[length(files) + 1L]] <- list(
        path = normalized,
        relative = relative,
        size = as.numeric(info$size[[1L]])
      )
    }
  }
  if (length(files)) {
    order_index <- order(
      tolower(vapply(files, `[[`, character(1), "relative")),
      vapply(files, `[[`, character(1), "relative")
    )
    files <- files[order_index]
  }
  list(files = files, notices = unique(notices))
}

rho_reference_r_regions <- function(lines, extension) {
  if (extension == "r") return(list(list(lines = lines, offset = 0L)))
  regions <- list()
  in_r_chunk <- FALSE
  start <- 0L
  for (index in seq_along(lines)) {
    line <- lines[[index]]
    if (!in_r_chunk && grepl("^[[:space:]]*```[[:space:]]*\\{?[rR]([,}[:space:]].*)?$", line)) {
      in_r_chunk <- TRUE
      start <- index + 1L
      next
    }
    if (in_r_chunk && grepl("^[[:space:]]*```[[:space:]]*$", line)) {
      end <- index - 1L
      regions[[length(regions) + 1L]] <- list(
        lines = if (end >= start) lines[start:end] else character(),
        offset = start - 1L
      )
      in_r_chunk <- FALSE
    }
  }
  if (in_r_chunk) {
    regions[[length(regions) + 1L]] <- list(lines = lines[start:length(lines)], offset = start - 1L)
  }
  regions
}

rho_reference_tokens <- function(lines, name, line_offset = 0L) {
  if (!length(lines)) return(list(tokens = list(), parse_incomplete = FALSE))
  parse_region <- function(region_lines, offset) {
    source <- srcfilecopy("<rho-reference>", region_lines, isFile = FALSE)
    expression <- parse(text = region_lines, srcfile = source, keep.source = TRUE)
    data <- getParseData(expression)
    data <- data[grepl("^SYMBOL", data$token), , drop = FALSE]
    if (!nrow(data)) return(list())
    matches <- data[vapply(data$text, function(value) {
      identical(sub("^`(.*)`$", "\\1", value), name)
    }, logical(1)), , drop = FALSE]
    if (!nrow(matches)) return(list())
    lapply(seq_len(nrow(matches)), function(index) {
      row <- matches[index, , drop = FALSE]
      line_index <- as.integer(row$line1[[1L]])
      column <- as.integer(row$col1[[1L]])
      source_line <- region_lines[[line_index]]
      tail <- substring(source_line, min(nchar(source_line) + 1L, column + nchar(row$text[[1L]])))
      list(
        line = line_index + offset,
        column = column,
        preview = rho_reference_bounded_text(trimws(source_line), 240L),
        kind = if (grepl("^[[:space:]]*(<-|<<-|=)[[:space:]]*function[[:space:]]*\\(", tail)) {
          "definition"
        } else {
          "reference"
        }
      )
    })
  }

  parsed <- tryCatch(parse_region(lines, line_offset), error = function(e) NULL)
  if (!is.null(parsed)) return(list(tokens = parsed, parse_incomplete = FALSE))

  tokens <- list()
  for (index in seq_along(lines)) {
    line_tokens <- tryCatch(parse_region(lines[[index]], line_offset + index - 1L), error = function(e) NULL)
    if (!is.null(line_tokens) && length(line_tokens)) tokens <- c(tokens, line_tokens)
  }
  list(tokens = tokens, parse_incomplete = TRUE)
}

rho_find_project_references_impl <- function(name, project_root, limit = 100L,
                                             file_limit = 500L,
                                             per_file_bytes = 1024L * 1024L,
                                             total_bytes = 8L * 1024L * 1024L) {
  name <- rho_reference_lookup_name(name)
  root <- rho_reference_project_root(project_root)
  limit <- suppressWarnings(as.integer(limit))
  if (length(limit) != 1L || is.na(limit)) limit <- 100L
  limit <- max(1L, min(200L, limit))
  discovery <- rho_reference_project_files(root, file_limit = file_limit)
  notices <- discovery$notices
  references <- list()
  matched_count <- 0L
  files_scanned <- 0L
  bytes_scanned <- 0

  for (file in discovery$files) {
    if (is.na(file$size) || file$size > per_file_bytes) {
      notices <- c(notices, "file_byte_limit")
      next
    }
    if (bytes_scanned + file$size > total_bytes) {
      notices <- c(notices, "total_byte_limit")
      break
    }
    lines <- tryCatch(
      suppressWarnings(readLines(file$path, warn = FALSE, encoding = "UTF-8")),
      error = function(e) NULL
    )
    if (is.null(lines)) {
      notices <- c(notices, "file_read_error")
      next
    }
    files_scanned <- files_scanned + 1L
    bytes_scanned <- bytes_scanned + file$size
    extension <- tolower(tools::file_ext(file$relative))
    regions <- rho_reference_r_regions(lines, extension)
    for (region in regions) {
      parsed <- rho_reference_tokens(region$lines, name, region$offset)
      if (parsed$parse_incomplete) notices <- c(notices, "parse_incomplete")
      for (token in parsed$tokens) {
        matched_count <- matched_count + 1L
        if (length(references) < limit) {
          references[[length(references) + 1L]] <- c(list(file = file$relative), token)
        }
      }
    }
  }

  list(
    name = name,
    references = references,
    matched_count = matched_count,
    files_scanned = files_scanned,
    bytes_scanned = as.numeric(bytes_scanned),
    truncated = matched_count > length(references),
    incomplete = length(notices) > 0L,
    notices = as.list(unique(notices))
  )
}

#' Discover code chunks in .Rmd/.qmd documents for the Chunk panel.
rho_discover_chunks <- function(path, limit = 200L) {
  extension <- tolower(tools::file_ext(path))
  if (!extension %in% c("rmd", "qmd")) {
    return(list(
      chunks = list(),
      total_count = 0L,
      truncated = FALSE,
      unsupported = TRUE
    ))
  }

  lines <- tryCatch(
    suppressWarnings(readLines(path, warn = FALSE)),
    error = function(e) NULL
  )
  if (is.null(lines)) {
    return(list(
      chunks = list(),
      total_count = 0L,
      truncated = FALSE,
      error = "Could not read file"
    ))
  }

  chunk_start_pattern <- "^[[:space:]]*```\\{([a-zA-Z0-9_]+)"

  chunk_list <- list()
  in_chunk <- FALSE
  chunk_start <- 0L
  chunk_header <- ""
  chunk_lines <- character()

  for (idx in seq_along(lines)) {
    line <- lines[[idx]]
    m <- regmatches(line, regexec(chunk_start_pattern, line))[[1]]
    if (length(m) > 1 && !in_chunk) {
      in_chunk <- TRUE
      chunk_start <- idx
      chunk_header <- line
      chunk_lines <- character()
    } else if (grepl("^[[:space:]]*```[[:space:]]*$", line) && in_chunk) {
      in_chunk <- FALSE

      header_clean <- sub("^[[:space:]]*```\\{", "", chunk_header)
      header_clean <- sub("\\}[[:space:]]*$", "", header_clean)
      parts <- strsplit(header_clean, "[[:space:],]+")[[1]]
      parts <- parts[nzchar(parts)]
      engine <- parts[[1]]
      label <- NULL
      opts <- character()
      if (length(parts) > 1) {
        if (!grepl("=", parts[[2]])) {
          label <- parts[[2]]
          if (length(parts) > 2) opts <- parts[-(1:2)]
        } else {
          opts <- parts[-1]
        }
      }

      code_text <- paste(chunk_lines, collapse = "\n")
      preview_lines <- head(chunk_lines, 4L)
      preview <- paste(preview_lines, collapse = "\n")
      if (nchar(preview) > 500) {
        preview <- paste0(substr(preview, 1, 497), "...")
      }

      chunk_list[[length(chunk_list) + 1L]] <- list(
        label = if (is.null(label)) paste0("unnamed-chunk-", length(chunk_list) + 1L) else label,
        engine = engine,
        options = if (length(opts)) paste(opts, collapse = ", ") else "",
        start_line = chunk_start,
        end_line = idx,
        code = code_text,
        code_preview = preview
      )

      if (length(chunk_list) >= as.integer(limit)) break
    } else if (in_chunk) {
      chunk_lines <- c(chunk_lines, line)
    }
  }

  # Handle unclosed chunk at end of file
  if (in_chunk && length(chunk_lines) > 0) {
    chunk_list[[length(chunk_list) + 1L]] <- list(
      label = paste0("unnamed-chunk-", length(chunk_list) + 1L),
      engine = "unknown",
      options = "",
      start_line = chunk_start,
      end_line = length(lines),
      code = paste(chunk_lines, collapse = "\n"),
      code_preview = paste(head(chunk_lines, 4L), collapse = "\n"),
      unclosed = TRUE
    )
  }

  list(
    chunks = chunk_list,
    total_count = length(chunk_list),
    truncated = length(chunk_list) >= as.integer(limit),
    unsupported = FALSE
  )
}
