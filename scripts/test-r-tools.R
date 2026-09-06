# Native library contract checks; Host/Operation acceptance lives in real_r.rs.
bridge <- new.env(parent = asNamespace("utils"))
sys.source("r/bridge/dispatch.R", bridge)
sys.source("r/bridge/tools.R", bridge)
dispatch <- function(action, payload) {
  bridge$rho_dispatch(list(protocol_version = 1L, request_id = "native-tools",
                          action = action, payload = payload))
}
stopifnot(requireNamespace("lintr", quietly = TRUE),
          requireNamespace("styler", quietly = TRUE))

help <- dispatch("help", list(topic = "mean", package = "base", max_chars = 32L))
stopifnot(identical(help$outcome, "succeeded"), help$value$found,
          help$value$truncated, nchar(help$value$text) == 32L)
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

# A deterministic missing-dependency path; never modify an installed library.
bridge$requireNamespace <- function(...) FALSE
for (action in c("lint", "format")) {
  absent <- dispatch(action, list(code = "x=1", limit = 10L))
  stopifnot(identical(absent$outcome, "failed"),
            grepl("no package was installed", absent$error, fixed = TRUE))
}
message("Native R help/lintr/styler checks passed, including no evaluation, no project configuration, bounds and missing dependencies.")
