root <- getwd()
bridge <- new.env(parent = asNamespace("utils")); bridge$can_inspect_bindings <- requireNamespace("rlang", quietly = TRUE)
stopifnot(bridge$can_inspect_bindings, requireNamespace("jsonlite", quietly = TRUE))
for (file in c("packages.R", "objects.R", "package-index.R", "tools.R", "dispatch.R")) sys.source(file.path(root, "plugins/r/backend/engine/r/bridge", file), bridge)
local({
  base <- tempfile("rho-package-index-"); dir.create(base); on.exit(unlink(base, recursive = TRUE), add = TRUE)
  libs <- file.path(base, c("lib1", "lib2")); for (lib in libs) dir.create(lib)
  old_libs <- .libPaths(); on.exit(.libPaths(old_libs), add = TRUE)
  for (i in seq_along(libs)) {
    path <- file.path(libs[[i]], "fixturepkg"); dir.create(path); dir.create(file.path(path, "help"))
    writeLines(c("Package: fixturepkg", paste0("Version: ", i, ".0"), "Title: Static package fixture", "Description: Purpose for testing."), file.path(path, "DESCRIPTION"))
    writeLines(c('export(alpha, "beta")', 'exportPattern("^dyn")', 'if (FALSE) export(conditional)', 'importFrom(stats, lm)', 'stop("NAMESPACE MUST NEVER EXECUTE")'), file.path(path, "NAMESPACE"))
    writeLines(c("alpha\talpha", "alias_a\talpha", "beta\tbeta"), file.path(path, "help/AnIndex"))
    writeLines(c("alpha                  Alpha title", "beta                   Beta title"), file.path(path, "INDEX"))
  }
  libs <- normalizePath(libs, winslash = "/")
  .libPaths(c(libs, old_libs))
  stopifnot(requireNamespace("tools", quietly = TRUE))
  native <- loadedNamespaces()
  observation <- bridge$rho_packages(list(mode = "installed", filter = "fixturepkg", limit = 200L, offset = 0L, grouped = FALSE, package_name = NULL, observation_id = NULL))
  stopifnot(length(observation$packages) == 2)
  scope <- list(project = base, principal = "test", session = "native")
  arguments <- list(expected_session = "native", observation_id = observation$observation_id, package = "fixturepkg", library_path = libs[[1L]], index_ref = NULL, filter = "", kind = NULL, offset = 0L, limit = 2L, scope = scope)
  page <- bridge$rho_package_index(arguments); rows <- page$entries; id <- page$index_ref
  stopifnot(page$version == "1.0", !page$complete, length(page$notices) > 0)
  while (!is.null(page$next_offset)) { arguments$index_ref <- id; arguments$offset <- page$next_offset; page <- bridge$rho_package_index(arguments); rows <- c(rows, page$entries) }
  stopifnot(any(vapply(rows, function(x) x$name == "alpha" && x$kind == "export", TRUE)), any(vapply(rows, function(x) x$name == "alias_a" && x$topic == "alpha", TRUE)), any(vapply(rows, function(x) !x$resolved, TRUE)), identical(native, loadedNamespaces()))
  writeLines(c('export(omega, "zeta")', 'exportPattern("^dyn")', 'if (FALSE) export(conditional)', 'importFrom(stats, lm)', 'stop("NAMESPACE MUST NEVER EXECUTE")'), file.path(libs[[1L]], "fixturepkg/NAMESPACE"))
  error <- tryCatch(bridge$rho_package_index(arguments), error = identity)
  stopifnot(inherits(error, "error"), grepl("content_changed", conditionMessage(error), fixed = TRUE))
  arguments$index_ref <- NULL; arguments$offset <- 0L; arguments$library_path <- libs[[2L]]
  page <- bridge$rho_package_index(arguments); stopifnot(page$version == "2.0")
  writeLines(c("Package: fixturepkg", "Version: 3.0", "Title: Replacement"), file.path(libs[[2L]], "fixturepkg/DESCRIPTION"))
  error <- tryCatch(bridge$rho_package_index(arguments), error = identity)
  stopifnot(inherits(error, "error"), grepl("content_changed", conditionMessage(error), fixed = TRUE))
})
cat("R static package index checks passed\n")

# Unloading a startup provider must not turn a static Query into namespace initialization.
local({
  stopifnot(!is.null(base::.Internal(getRegisteredNamespace("tools"))))
  event <- base::packageEvent("tools", "onLoad"); previous <- base::getHook(event); loads <- 0L
  on.exit({ base::setHook(event, previous, action = "replace"); base::loadNamespace("tools") }, add = TRUE)
  base::setHook(event, function(...) { loads <<- loads + 1L }, action = "append")
  base::unloadNamespace("tools")
  before <- base::sort(base::loadedNamespaces())
  observation <- bridge$rho_packages(list(mode = "installed", filter = "", limit = 200L, offset = 0L, grouped = FALSE, package_name = "base", observation_id = NULL))
  copy <- observation$packages[[1L]]
  payload <- list(expected_session = "native", observation_id = observation$observation_id, package = "base", library_path = copy$library_path, index_ref = NULL, filter = "", kind = NULL, offset = 0L, limit = 20L, scope = list(project = "/isolated", principal = "test", session = "native"))
  response <- bridge$rho_dispatch(list(protocol_version = 1L, request_id = "tools-unloaded", action = "package_index", payload = payload))
  stopifnot(response$outcome == "failed", response$value$query_error$code == "unavailable", grepl("tools is not loaded", response$error, fixed = TRUE), loads == 0L, is.null(base::.Internal(getRegisteredNamespace("tools"))), identical(before, base::sort(base::loadedNamespaces())))
})
cat("R unloaded package-index provider checks passed\n")
