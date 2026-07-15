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
      typeof = typeof(value)
    )
  })
}

#' Return a Bounded Workspace Snapshot
#' @export
rho_workspace_snapshot <- function(envir = .GlobalEnv, object_limit = 200L) {
  list(
    r = list(
      version = R.version.string,
      platform = R.version$platform,
      cwd = normalizePath(getwd(), winslash = "/", mustWork = FALSE),
      lib_paths = normalizePath(.libPaths(), winslash = "/", mustWork = FALSE),
      attached = search(),
      loaded_namespaces = loadedNamespaces()
    ),
    objects = rho_list_objects(envir = envir, limit = object_limit),
    last_execution = rho_get_last_execution()
  )
}

#' Inspect One Workspace Object with Bounded Output
#' @export
rho_inspect_object <- function(name,
                               envir = .GlobalEnv,
                               max_chars = 4000L,
                               max_level = 2L) {
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
    name = name,
    classes = class(value),
    dimensions = if (is.null(dimensions)) NULL else as.integer(dimensions),
    size_bytes = as.numeric(object.size(value)),
    typeof = typeof(value),
    structure = compact_text(structure_text, max_chars = max_chars)
  )
}

