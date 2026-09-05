# Fixed non-interactive provider actions. The caller supplies data, never R code.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L)
request <- jsonlite::read_json(args[[1L]], simplifyVector = FALSE)
stopifnot(identical(request$protocol_version, 1L))
payload <- request$payload
runtime <- function() list(r_version = paste(R.version$major, R.version$minor, sep = "."),
                           platform = R.version$platform)
packages <- function(library) {
  rows <- utils::installed.packages(lib.loc = library, noCache = TRUE)
  rows <- rows[!duplicated(rows[, "Package"]), , drop = FALSE]
  rows <- rows[order(rows[, "Package"]), , drop = FALSE]
  unname(lapply(seq_len(nrow(rows)), function(i) list(
    name = unname(rows[i, "Package"]), version = unname(rows[i, "Version"]),
    library = normalizePath(unname(rows[i, "LibPath"]), winslash = "/", mustWork = TRUE))))
}
read_plan <- function(manager, lockfile) {
  lock <- if (manager == "renv") renv::lockfile_read(lockfile) else jsonlite::read_json(lockfile)
  if (manager == "renv" && !is.null(lock$R$Version) && lock$R$Version != runtime()$r_version) {
    stop("selected R version differs from renv.lock")
  }
  expected <- if (manager == "renv") {
    unname(lapply(lock$Packages, function(package) list(name = package$Package, version = package$Version)))
  } else {
    unname(lapply(lock$packages, function(package) list(name = package$package, version = package$version)))
  }
  expected <- expected[order(vapply(expected, function(package) package$name, character(1)))]
  local_sources <- if (manager == "renv") {
    unname(Filter(Negate(is.null), lapply(lock$Packages, function(package) {
      if (!is.null(package$Path)) package$Path else if (identical(package$Source, "Local")) {
        if (!is.null(package$RemoteUrl)) package$RemoteUrl else sub("^local::", "", package$RemotePkgRef)
      } else NULL
    })))
  } else {
    unname(Filter(Negate(is.null), lapply(lock$packages, function(package) {
      if (identical(package$type, "local")) sub("^local::", "", package$ref) else NULL
    })))
  }
  c(runtime(), list(packages = expected, local_sources = local_sources))
}
result <- tryCatch({
  value <- switch(request$action,
    observe = {
      libs <- if (is.null(payload$library)) .libPaths() else payload$library
      inventory <- if (all(dir.exists(libs))) packages(libs) else list()
      c(runtime(), list(r_home = R.home(), library_paths = unname(as.list(libs)),
        packages = head(inventory, payload$limit), truncated = length(inventory) > payload$limit,
        jsonlite_library = dirname(find.package("jsonlite")),
        renv_available = requireNamespace("renv", quietly = TRUE),
        pak_available = requireNamespace("pak", quietly = TRUE)))
    },
    plan_pak = {
      pak::lockfile_create(pkg = unlist(payload$packages, use.names = FALSE),
                          lockfile = payload$lockfile, lib = payload$library,
                          upgrade = FALSE, dependencies = NA)
      read_plan("pak", payload$lockfile)
    },
    plan_renv = read_plan("renv", payload$lockfile),
    install_pak = {
      pak::lockfile_install(lockfile = payload$lockfile, lib = payload$library, update = FALSE)
      runtime()
    },
    install_renv = {
      renv::restore(project = payload$project, lockfile = payload$lockfile,
                    library = payload$library, transactional = TRUE, prompt = FALSE, clean = FALSE)
      runtime()
    },
    snapshot = {
      selected <- unname(utils::installed.packages(lib.loc = payload$library, noCache = TRUE)[, "Package"])
      renv::snapshot(project = payload$project, library = payload$library,
                     lockfile = payload$lockfile, packages = selected, prompt = FALSE,
                     update = FALSE, force = FALSE)
      lock <- renv::lockfile_read(payload$lockfile)
      for (name in names(lock$Packages)) {
        record <- lock$Packages[[name]]
        # pak's Local metadata uses RemotePkgRef. renv restore's native local
        # source mechanism is Path; retain it in the candidate lockfile.
        if (identical(record$Source, "Local") && !is.null(record$RemotePkgRef) &&
            startsWith(record$RemotePkgRef, "local::")) {
          lock$Packages[[name]]$Path <- sub("^local::", "", record$RemotePkgRef)
        }
      }
      renv::lockfile_write(lock, file = payload$lockfile)
      runtime()
    },
    stop("unsupported Environment action", call. = FALSE))
  list(protocol_version = 1L, request_id = request$request_id, ok = TRUE, value = value, error = NULL)
}, error = function(error) {
  list(protocol_version = 1L, request_id = request$request_id, ok = FALSE,
       value = NULL, error = substr(conditionMessage(error), 1L, 2000L))
})
jsonlite::write_json(result, args[[2L]], auto_unbox = TRUE, null = "null", digits = NA)
