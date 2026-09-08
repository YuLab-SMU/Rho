# Read-only inventory against temporary DESCRIPTION fixtures; no installation.
local({
  bridge <- new.env(parent = asNamespace("utils"))
  sys.source("r/bridge/query.R", bridge)
  directory <- tempfile("rho-package-query-")
  dir.create(directory)
  original <- .libPaths()
  on.exit({ .libPaths(original); unlink(directory, recursive = TRUE) }, add = TRUE)
  libs <- file.path(directory, c("库一", "库二"))
  invisible(lapply(libs, dir.create))
  write_package <- function(lib, name, version) {
    dir.create(file.path(lib, name))
    writeLines(c(paste("Package:", name), paste("Version:", version), "Title: 中文 <script>metadata</script>", "Built: R 4.5.2; test"), file.path(lib, name, "DESCRIPTION"), useBytes = TRUE)
    dir.create(file.path(lib, name, "R"))
    writeLines("stop('package code must never execute')", file.path(lib, name, "R", "onload.R"))
  }
  write_package(libs[[1L]], "rhoFixture", "1.0")
  write_package(libs[[2L]], "rhoFixture", "2.0")
  dir.create(file.path(libs[[1L]], "rhoBad"))
  writeLines("not valid DCF", file.path(libs[[1L]], "rhoBad", "DESCRIPTION"))
  .libPaths(c(libs, original))
  before_namespaces <- loadedNamespaces()
  before_search <- search()
  query <- function(filter = "rhoFixture", mode = "installed", offset = 0L, limit = 100L) {
    bridge$rho_packages(list(filter = filter, mode = mode, offset = offset, limit = limit))
  }
  result <- query(limit = 1L)
  stopifnot(identical(result$library_paths[1:2], as.list(normalizePath(libs))),
            result$total_matches == 2L, length(result$packages) == 1L,
            result$next_offset == 1L, result$packages[[1L]]$version == "1.0",
            result$packages[[1L]]$first_in_library_path, !result$scan_complete)
  later <- query(offset = 1L)
  stopifnot(later$packages[[1L]]$version == "2.0", !later$packages[[1L]]$first_in_library_path,
            is.null(later$packages[[1L]]$loaded_version), is.null(later$next_offset))
  stopifnot(query(filter = "中文")$total_matches == 2L)
  stopifnot(query(filter = "not_present_anywhere")$total_matches == 0L)
  loaded <- query(filter = "stats", mode = "loaded")
  attached <- query(filter = "stats", mode = "attached")
  stopifnot(loaded$total_matches >= 1L, attached$total_matches >= 1L,
            attached$packages[[1L]]$attached)
  # An installed earlier copy must not masquerade as the already loaded namespace.
  write_package(libs[[1L]], "stats", "99.0")
  duplicate <- query(filter = "stats")
  duplicate$packages <- Filter(function(row) identical(row$name, "stats"), duplicate$packages)
  native_version <- as.character(getNamespaceVersion("stats"))
  stopifnot(duplicate$packages[[1L]]$version == "99.0",
            duplicate$packages[[1L]]$loaded_version == native_version,
            duplicate$packages[[1L]]$loaded_path != file.path(libs[[1L]], "stats"))
  stopifnot(!duplicate$packages[[1L]]$loaded_from_library)
  # renv-style package symlinks must resolve to the same loaded physical copy.
  if (file.symlink(getNamespaceInfo("stats", "path"), file.path(libs[[2L]], "stats"))) {
    copies <- Filter(function(row) identical(row$name, "stats"), query(filter = "stats")$packages)
    stopifnot(copies[[2L]]$loaded_from_library, copies[[2L]]$version == native_version)
  }
  base <- query(filter = "base")
  base$packages <- Filter(function(row) identical(row$name, "base"), base$packages)
  stopifnot(base$packages[[1L]]$loaded_from_library, base$packages[[1L]]$attached)
  .libPaths(rev(libs))
  stopifnot(query()$packages[[1L]]$version == "2.0")
  stopifnot(identical(loadedNamespaces(), before_namespaces), identical(search(), before_search))
})
message("Read-only R package metadata, library precedence, pagination, Unicode, loaded/attached state and no namespace mutation passed.")
