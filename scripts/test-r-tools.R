# Native library contract checks; Host/Operation acceptance lives in real_r.rs.
bridge <- new.env(parent = asNamespace("utils"))
sys.source("plugins/r/backend/engine/r/bridge/objects.R", bridge)
sys.source("plugins/r/backend/engine/r/bridge/packages.R", bridge)
sys.source("plugins/r/backend/engine/r/bridge/package-index.R", bridge)
sys.source("plugins/r/backend/engine/r/bridge/dispatch.R", bridge)
sys.source("plugins/r/backend/engine/r/bridge/tools.R", bridge)
dispatch <- function(action, payload) {
  bridge$rho_dispatch(list(protocol_version = 1L, request_id = "native-tools",
                          action = action, payload = payload))
}
stopifnot(requireNamespace("lintr", quietly = TRUE),
          requireNamespace("styler", quietly = TRUE))

help <- dispatch("help", list(topic = "mean", package = "base", max_chars = 32L))
stopifnot(identical(help$outcome, "succeeded"), help$value$found,
          !help$value$truncated, help$value$preview_truncated, nchar(help$value$preview) == 32L, nchar(help$value$text) > 32L)
# Exact-copy help resolves one observed library and rejects changed index evidence.
base_inventory <- bridge$rho_packages(list(mode = "installed", filter = "", limit = 200L, offset = 0L, grouped = FALSE, package_name = "base", observation_id = NULL))
base_copy <- base_inventory$packages[[1L]]
base_files <- bridge$rho_package_index_files(file.path(base_copy$library_path, "base"))
exact <- dispatch("help", list(topic = "mean", package = "base", max_chars = 32L, library_path = base_copy$library_path, observation_id = base_inventory$observation_id, expected_index_files = base_files))
stopifnot(exact$outcome == "succeeded", exact$value$found, identical(exact$value$text, help$value$text))
base_files[[1L]]$digest <- "changed"
changed <- dispatch("help", list(topic = "mean", package = "base", max_chars = 32L, library_path = base_copy$library_path, observation_id = base_inventory$observation_id, expected_index_files = base_files))
stopifnot(changed$outcome == "failed", grepl("content_changed", changed$error, fixed = TRUE))
missing <- dispatch("help", list(topic = "rho_nonexistent_help_topic", package = "base", max_chars = 32L))
stopifnot(identical(missing$outcome, "succeeded"), !missing$value$found)

local({
  directory <- tempfile("rho-tools-")
  dir.create(directory)
  previous_wd <- setwd(directory)
  on.exit({ setwd(previous_wd); unlink(directory, recursive = TRUE) }, add = TRUE)
  writeLines("linters: { stop('project config must not execute') }", ".lintr")
  code <- "writeLines('executed', 'unexpected.txt'); tool_value=1"
  lint <- dispatch("lint", list(code = code, limit = 1L))
  stopifnot(identical(lint$outcome, "succeeded"), length(lint$value$diagnostics) == 1L,
            lint$value$truncated)
  previous_options <- options("styler.cache_name", "styler.quiet")
  formatted <- dispatch("format", list(code = code))
  stopifnot(identical(formatted$outcome, "succeeded"), formatted$value$changed,
            identical(options("styler.cache_name", "styler.quiet"), previous_options),
            !file.exists("unexpected.txt"), !exists("tool_value", envir = .GlobalEnv),
            identical(list.files(all.files = TRUE, no.. = TRUE), ".lintr"))
})
syntax <- dispatch("format", list(code = "x <- ("))
stopifnot(identical(syntax$outcome, "failed"), is.null(syntax$value))

local({
  stopifnot(requireNamespace("htmltools", quietly = TRUE), requireNamespace("htmlwidgets", quietly = TRUE))
  methods <- base::get(".__S3MethodsTable__.", envir = base::get(".BaseNamespaceEnv", envir = baseenv()))
  had_method <- base::exists("print.htmlwidget", envir = methods, inherits = FALSE)
  previous_method <- if (had_method) base::get("print.htmlwidget", envir = methods) else NULL
  pending <- tempfile("rho-widget-")
  dir.create(pending)
  previous_viewer <- options(viewer = bridge$rho_viewer(pending))
  on.exit({
    options(previous_viewer)
    if (had_method) base::assign("print.htmlwidget", previous_method, envir = methods) else base::rm("print.htmlwidget", envir = methods)
    if (base::exists("rho_tool_widget", envir = .GlobalEnv, inherits = FALSE)) base::rm("rho_tool_widget", envir = .GlobalEnv)
    unlink(pending, recursive = TRUE)
  }, add = TRUE)
  bridge$rho_install_htmlwidget_print()
  method <- base::get("print.htmlwidget", envir = methods)
  stopifnot(identical(body(method), body(bridge$rho_print_htmlwidget)),
            identical(attr(method, "positron.s3_override", exact = TRUE), TRUE),
            identical(attr(method, ".positron.s3_override", exact = TRUE), TRUE))
  widget <- htmlwidgets::createWidget("rho_test", list(value = 1), sizingPolicy = htmlwidgets::sizingPolicy())
  assign("rho_tool_widget", widget, envir = .GlobalEnv)
  stopifnot(identical(print(widget, view = FALSE), widget), !length(list.files(pending, pattern = "\\.html$")))
  stopifnot(identical(print(widget, view = TRUE), widget), length(list.files(pending, pattern = "\\.html$")) == 1L)
  base::assign("print.htmlwidget", function(...) stop("Ark reattached method"), envir = methods)
  bridge$rho_htmlwidget_onload()
  method <- base::get("print.htmlwidget", envir = methods)
  stopifnot(identical(body(method), body(bridge$rho_print_htmlwidget)),
            identical(attr(method, "positron.s3_override", exact = TRUE), TRUE),
            identical(attr(method, ".positron.s3_override", exact = TRUE), TRUE))
  printed <- dispatch("execute", list(code = "print(rho_tool_widget, view = TRUE)"))
  stopifnot(identical(printed$outcome, "succeeded"), length(list.files(pending, pattern = "\\.html$")) == 2L)
  failed <- dispatch("execute", list(code = "stop('UI comm is not connected')"))
  stopifnot(identical(failed$outcome, "failed"), identical(failed$error, "UI comm is not connected"))
})
message("Native R htmlwidget override, print semantics, reattachment and ordinary failure checks passed.")

# A deterministic missing-dependency path; never modify an installed library.
bridge$requireNamespace <- function(...) FALSE
for (action in c("lint", "format")) {
  absent <- dispatch(action, list(code = "x=1", limit = 10L))
  stopifnot(identical(absent$outcome, "failed"),
            grepl("no package was installed", absent$error, fixed = TRUE))
}
message("Native R help/lintr/styler checks passed, including no evaluation, no project configuration, bounds and missing dependencies.")

# R's find.package() special-cases base/recommended packages and ignores lib.loc.
# Exact-copy help must use the observed copy, including its own static aliases.
local({
  directory <- tempfile("rho-exact-help-"); dir.create(directory)
  previous <- .libPaths()
  on.exit({ .libPaths(previous); unlink(directory, recursive = TRUE) }, add = TRUE)
  libraries <- file.path(directory, c("alpha", "beta"))
  for (i in seq_along(libraries)) {
    dir.create(libraries[[i]])
    stopifnot(file.copy(find.package("stats"), libraries[[i]], recursive = TRUE))
    copy <- file.path(libraries[[i]], "stats")
    description <- read.dcf(file.path(copy, "DESCRIPTION"))
    description[1L, "Version"] <- paste0(i, ".0")
    write.dcf(description, file.path(copy, "DESCRIPTION"))
    topic <- if (i == 1L) "lm" else "glm"
    cat(paste0("rho_copy_only\t", topic, "\n"), file = file.path(copy, "help", "AnIndex"), append = TRUE)
    aliases <- readRDS(file.path(copy, "help", "aliases.rds"))
    aliases["rho_copy_only"] <- topic
    saveRDS(aliases, file.path(copy, "help", "aliases.rds"))
  }
  libraries <- normalizePath(libraries, winslash = "/")
  .libPaths(c(libraries, previous))
  before <- sort(loadedNamespaces())
  observation <- bridge$rho_packages(list(mode = "installed", filter = "", limit = 200L, offset = 0L, grouped = FALSE, package_name = "stats", observation_id = NULL))
  results <- lapply(libraries, function(library) {
    payload <- list(topic = "rho_copy_only", package = "stats", max_chars = 100L,
                    library_path = library, observation_id = observation$observation_id,
                    expected_index_files = bridge$rho_package_index_files(file.path(library, "stats")))
    answer <- dispatch("help", payload)
    stopifnot(answer$outcome == "succeeded", answer$value$found,
              identical(answer$value$library_path, library), !answer$value$truncated)
    answer$value$text
  })
  stopifnot(grepl("Fitting Linear Models", results[[1L]], fixed = TRUE),
            grepl("Fitting Generalized Linear Models", results[[2L]], fixed = TRUE),
            !identical(results[[1L]], results[[2L]]), identical(before, sort(loadedNamespaces())))
  # No outside database may be read through a symlink in an otherwise valid copy.
  if (.Platform$OS.type == "unix") {
    database <- file.path(libraries[[2L]], "stats", "help", "stats.rdb")
    outside <- file.path(directory, "outside.rdb")
    stopifnot(file.copy(database, outside), file.remove(database), file.symlink(outside, database))
    rejected <- dispatch("help", list(topic = "rho_copy_only", package = "stats", max_chars = 100L,
      library_path = libraries[[2L]], observation_id = observation$observation_id,
      expected_index_files = bridge$rho_package_index_files(file.path(libraries[[2L]], "stats"))))
    stopifnot(rejected$outcome == "failed", grepl("content_changed", rejected$error, fixed = TRUE))
  }
})
message("Exact copied-stats help aliases/databases verified without package installation or namespace loading.")
