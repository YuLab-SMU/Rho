.rho_environment_project <- function(project) {
  if (!is.character(project) || length(project) != 1L || is.na(project) || !nzchar(project)) {
    stop("project must be one non-empty path", call. = FALSE)
  }
  normalizePath(project, winslash = "/", mustWork = TRUE)
}

.rho_environment_namespace <- function(package) {
  if (!requireNamespace(package, quietly = TRUE)) {
    stop(sprintf("required helper package is unavailable: %s", package), call. = FALSE)
  }
}

#' Observe the current R runtime and library stack without mutation
#' @export
rho_environment_observe <- function(project) {
  project <- .rho_environment_project(project)
  installations <- as.data.frame(utils::installed.packages(lib.loc = .libPaths()), stringsAsFactors = FALSE)
  list(
    schema = 1L,
    project = project,
    r = R.home("bin"),
    r_home = R.home(),
    version = paste(R.version$major, R.version$minor, sep = "."),
    platform = R.version$platform,
    architecture = R.version$arch,
    library_paths = unname(normalizePath(.libPaths(), winslash = "/", mustWork = FALSE)),
    installations = unname(lapply(seq_len(nrow(installations)), function(index) {
      row <- installations[index, , drop = FALSE]
      list(
        name = unname(row$Package),
        version = unname(row$Version),
        library = normalizePath(unname(row$LibPath), winslash = "/", mustWork = FALSE),
        built = unname(row$Built),
        priority = unname(row$Priority %||% NA_character_)
      )
    }))
  )
}

#' Resolve a project package plan without writing a lockfile or installing
#' @export
rho_environment_renv_plan <- function(project, packages = NULL) {
  .rho_environment_namespace("renv")
  project <- .rho_environment_project(project)
  renv::plan(packages = packages, lockfile = NULL, project = project)
}

#' Restore an existing lock into an exact staged library
#' @export
rho_environment_renv_restore <- function(project, lockfile, library) {
  .rho_environment_namespace("renv")
  project <- .rho_environment_project(project)
  lockfile <- normalizePath(lockfile, winslash = "/", mustWork = TRUE)
  library <- normalizePath(library, winslash = "/", mustWork = FALSE)
  renv::restore(
    project = project,
    library = library,
    lockfile = lockfile,
    rebuild = FALSE,
    clean = FALSE,
    strict = TRUE,
    transactional = TRUE,
    retry = FALSE,
    prompt = FALSE
  )
}

#' Write a candidate lockfile outside the authoritative project path
#' @export
rho_environment_renv_snapshot_candidate <- function(project, candidate_lockfile, packages = NULL) {
  .rho_environment_namespace("renv")
  project <- .rho_environment_project(project)
  candidate_lockfile <- normalizePath(candidate_lockfile, winslash = "/", mustWork = FALSE)
  renv::snapshot(
    project = project,
    lockfile = candidate_lockfile,
    packages = packages,
    prompt = FALSE,
    update = FALSE,
    force = FALSE
  )
}

#' Query package system requirements without installing
#' @export
rho_environment_pak_sysreqs <- function(packages) {
  .rho_environment_namespace("pak")
  pak::pkg_sysreqs(packages)
}

#' Install exact package specs into an exact staged library
#' @export
rho_environment_pak_install <- function(packages, library) {
  .rho_environment_namespace("pak")
  library <- normalizePath(library, winslash = "/", mustWork = FALSE)
  pak::pkg_install(packages, lib = library, upgrade = FALSE, ask = FALSE)
}

#' Dispatch one fixed helper action
#' @export
rho_environment_dispatch <- function(request) {
  if (!is.list(request) || !is.character(request$action) || length(request$action) != 1L) {
    stop("request requires one action", call. = FALSE)
  }
  switch(
    request$action,
    observe = rho_environment_observe(request$project),
    renv_plan = rho_environment_renv_plan(request$project, request$packages),
    renv_restore = rho_environment_renv_restore(request$project, request$lockfile, request$library),
    renv_snapshot_candidate = rho_environment_renv_snapshot_candidate(
      request$project,
      request$candidate_lockfile,
      request$packages
    ),
    pak_sysreqs = rho_environment_pak_sysreqs(request$packages),
    pak_install = rho_environment_pak_install(request$packages, request$library),
    stop("unsupported rho.environment action", call. = FALSE)
  )
}

`%||%` <- function(left, right) {
  if (length(left) == 0L || is.na(left)) right else left
}
