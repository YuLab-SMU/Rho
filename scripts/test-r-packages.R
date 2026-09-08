# Read-only inventory against temporary DESCRIPTION fixtures; no installation.
local({
  bridge <- new.env(parent = asNamespace("utils"))
  sys.source("r/bridge/packages.R", bridge)
  directory <- tempfile("rho-package-query-")
  dir.create(directory)
  original <- .libPaths()
  on.exit({ .libPaths(original); unlink(directory, recursive = TRUE) }, add = TRUE)
  libs <- file.path(directory, c("库一", "库二"))
  invisible(lapply(libs, dir.create))
  write_package <- function(lib, name, version, extra = character()) {
    dir.create(file.path(lib, name))
    writeLines(c(paste("Package:", name), paste("Version:", version), "Title: 中文 <script>metadata</script>", "Built: R 4.5.2; test", extra), file.path(lib, name, "DESCRIPTION"), useBytes = TRUE)
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

  observe <- function(...) {
    bridge$rho_packages(modifyList(list(filter = "", mode = "installed", offset = 0L, limit = 100L, grouped = TRUE), list(...)))
  }
  write_package(libs[[1L]], "rhoRemote", "1.0", c(
    "RemoteType: github", "RemoteHost: api.github.com", "RemoteUsername: example", "RemoteRepo: science",
    "RemoteRef: main", "RemoteSha: 1234567890abcdef", "Repository: CRAN"))
  write_package(libs[[2L]], "rhoRemote", "0.9", "Repository: CRAN")
  write_package(libs[[1L]], "rhoUnknown", "1.0", "URL: https://github.com/example/science")
  write_package(libs[[1L]], "rhoDelivery", "1.0", c("Repository: CRAN", "RemoteType: standard",
    "RemoteUrl: https://user:secret@packagemanager.posit.co/cran/2026-09-01/src/contrib/pkg.tar.gz?token=private"))
  write_package(libs[[1L]], "rhoUniverse", "1.0", c("Repository: https://example.r-universe.dev", "RemoteType: git", "RemoteRef: main"))
  grouped <- observe(filter = "rhoRemote", limit = 1L)
  stopifnot(length(grouped$groups) == 1L, grouped$total_matches == 1L, grouped$groups[[1L]]$copy_count == 2L,
            grouped$groups[[1L]]$source_count == 2L,
            grouped$counts$installations > grouped$counts$installed)
  id <- grouped$observation_id
  copies <- observe(observation_id = id, package_name = "rhoRemote", limit = 1L)
  next_copy <- observe(observation_id = id, package_name = "rhoRemote", offset = 1L, limit = 1L)
  stopifnot(copies$total_matches == 2L, copies$next_offset == 1L, is.null(next_copy$next_offset),
            identical(copies$observed_at_ms, grouped$observed_at_ms))
  all_copies <- c(copies$packages, next_copy$packages)
  github <- Filter(function(x) x$source$kind == "GitHub", all_copies)[[1L]]
  stopifnot(github$source$repository_url == "https://github.com/example/science",
            github$source$remote_sha == "1234567890abcdef")
  unknown <- observe(observation_id = id, package_name = "rhoUnknown")$packages[[1L]]$source
  stopifnot(unknown$kind == "Not recorded", length(unknown$links) == 1L)
  delivery <- observe(observation_id = id, package_name = "rhoDelivery")$packages[[1L]]$source
  stopifnot(delivery$kind == "CRAN", delivery$provider == "Posit Package Manager", delivery$snapshot == "2026-09-01",
            !any(grepl("secret|private|user:|token=", unlist(delivery))))
  stopifnot(observe(observation_id = id, package_name = "rhoUniverse")$packages[[1L]]$source$kind == "R-universe")
  # Subsequent pages belong to the captured observation even if files change.
  metadata_path <- file.path(libs[[1L]], "rhoRemote", "DESCRIPTION")
  writeLines(sub("Version: 1.0", "Version: 2.0", readLines(metadata_path), fixed = TRUE), metadata_path)
  retained <- observe(observation_id = id, package_name = "rhoRemote")
  stopifnot(any(vapply(retained$packages, function(x) x$version == "1.0", TRUE)),
            !any(vapply(retained$packages, function(x) x$version == "2.0", TRUE)))
  fresh <- observe(package_name = "rhoRemote")
  stopifnot(any(vapply(fresh$packages, function(x) x$version == "2.0", TRUE)))
  observe(filter = "rhoRemote")
  stopifnot(inherits(try(observe(observation_id = id), silent = TRUE), "try-error"))
  # A namespace remains inspectable outside the observed library search path.
  bridge$.libPaths <- function() libs
  outside <- observe(mode = "loaded")
  stopifnot(any(vapply(outside$groups, function(x) x$name == "base" && x$copy_count == 0L && x$loaded_copy_observed, TRUE)))
  rm(".libPaths", envir = bridge)
  stopifnot(identical(loadedNamespaces(), before_namespaces), identical(search(), before_search))
})
message("Read-only package grouping, counts, pinned observations, per-copy provenance/redaction, library precedence, outside-path namespaces and no namespace mutation passed.")
