# Native code tools. Inputs are text, never eval'ed or written back to a project.
rho_help <- function(payload) {
  exact <- !is.null(payload$library_path)
  path <- NULL
  identities <- NULL
  if (exact) {
    copy <- rho_package_exact_copy(payload)
    path <- copy$path
    identities <- rho_package_index_files(path)
    if (!is.null(payload$expected_index_files) && !identical(identities, payload$expected_index_files)) rho_object_error("content_changed", "Package index files changed before help rendering.")
  }
  entry <- utils::help(payload$topic, package = payload$package,
                       lib.loc = if (exact) payload$library_path else NULL,
                       help_type = "text", try.all.packages = FALSE)
  if (!length(entry)) {
    return(list(topic = payload$topic, package = payload$package, library_path = payload$library_path,
                found = FALSE, text = "", truncated = FALSE))
  }
  if (length(entry) != 1L) stop("Help topic is ambiguous; select an exact installed copy and help alias.")
  if (exact && !startsWith(normalizePath(dirname(entry[[1L]]), winslash = "/", mustWork = TRUE), paste0(normalizePath(path, winslash = "/", mustWork = TRUE), "/"))) stop("Help topic resolved outside the selected package copy.")
  # Read/render exactly once. No dynamic Rd stages or examples are executed.
  rd <- utils:::.getHelpFile(entry[[1L]])
  text <- paste(utils::capture.output(tools::Rd2txt(
    rd, stages = character(), options = list(underline_titles = FALSE)
  )), collapse = "\n")
  if (exact && !identical(identities, rho_package_index_files(path))) rho_object_error("content_changed", "Package index files changed during help rendering.")
  if (nchar(text, type = "bytes") > 16 * 1024 * 1024) rho_object_error("budget_exhausted", "Rendered help exceeds the 16 MiB text artifact limit; no partial document was stored.")
  list(topic = payload$topic, package = payload$package, library_path = payload$library_path,
       found = TRUE, text = text, preview = substr(text, 1L, payload$max_chars),
       preview_truncated = nchar(text) > payload$max_chars, truncated = FALSE)
}

rho_lint <- function(payload) {
  if (!requireNamespace("lintr", quietly = TRUE)) {
    stop("workspace.lint requires an installed lintr package; no package was installed")
  }
  # Explicit built-in linters only: never source project .lintr configuration.
  lints <- lintr::lint(text = payload$code, cache = FALSE, parse_settings = FALSE,
                      exclusions = list(), linters = list(
                        assignment_linter = lintr::assignment_linter(),
                        commas_linter = lintr::commas_linter(),
                        infix_spaces_linter = lintr::infix_spaces_linter(),
                        line_length_linter = lintr::line_length_linter(120L)))
  selected <- head(lints, payload$limit)
  diagnostics <- lapply(selected, function(lint) {
    list(line = lint$line_number, column = lint$column_number,
         type = lint$type, message = substr(lint$message, 1L, 1000L),
         linter = lint$linter)
  })
  list(tool_version = as.character(utils::packageVersion("lintr")),
       diagnostics = diagnostics,
       truncated = length(lints) > payload$limit ||
         any(vapply(selected, function(lint) nchar(lint$message) > 1000L, logical(1L))))
}

rho_format <- function(payload) {
  previous <- options("styler.cache_name", "styler.quiet")
  on.exit(options(previous), add = TRUE)
  if (!requireNamespace("styler", quietly = TRUE)) {
    stop("workspace.format requires an installed styler package; no package was installed")
  }
  options(styler.cache_name = NULL, styler.quiet = TRUE)
  text <- paste(as.character(styler::style_text(
    payload$code, include_roxygen_examples = FALSE
  )), collapse = "\n")
  # Never return a truncated program that could be mistaken for a usable edit.
  if (nchar(text, type = "bytes") > 131072L) stop("formatted code exceeds 128 KiB")
  list(tool_version = as.character(utils::packageVersion("styler")),
       code = text, changed = !identical(text, payload$code))
}
