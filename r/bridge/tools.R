# Native code tools. Inputs are text, never eval'ed or written back to a project.
rho_help_exact_files <- function(path) {
  root <- normalizePath(path, winslash = "/", mustWork = TRUE)
  names <- c("help/AnIndex", "help/aliases.rds", paste0("help/", basename(path), c(".rdx", ".rdb")))
  bytes <- 0
  lapply(names, function(name) {
    file <- file.path(path, name)
    if (!file.exists(file)) return(list(path = name, digest = "absent"))
    canonical <- normalizePath(file, winslash = "/", mustWork = TRUE)
    if (!startsWith(canonical, paste0(root, "/"))) rho_object_error("content_changed", "Help database escaped its selected package copy.")
    info <- file.info(file)
    if (is.na(info$size) || info$isdir) rho_object_error("unavailable", "Help resource is not a readable regular file.")
    bytes <<- bytes + info$size
    if (bytes > 64 * 1024 * 1024) rho_object_error("budget_exhausted", "Selected help metadata/database exceeds 64 MiB.")
    list(path = name, digest = paste0("md5:", unname(rho_readonly_binding("tools", "md5sum")(file)), ":", canonical))
  })
}

rho_help_exact_entry <- function(path, topic) {
  # find.package() deliberately substitutes .Library for base/recommended names
  # such as stats, even with lib.loc. Resolve the observed copy's static aliases
  # directly instead of letting that global selection override the caller.
  aliases <- file.path(path, "help", "AnIndex")
  keys <- character()
  if (file.exists(aliases)) {
    for (line in readLines(aliases, warn = FALSE, encoding = "UTF-8")) {
      fields <- strsplit(line, "\t", fixed = TRUE)[[1L]]
      if (length(fields) == 2L && identical(fields[[1L]], topic)) keys <- c(keys, fields[[2L]])
    }
  } else if (file.exists(aliases <- file.path(path, "help", "aliases.rds"))) {
    values <- readRDS(aliases)
    if (!is.character(values) || is.object(values) || isS4(values)) rho_object_error("unavailable", "Native help aliases must be a plain named character vector.")
    keys <- .subset(values, which(names(values) == topic))
  }
  keys <- unique(unname(keys))
  if (!length(keys)) return(character())
  if (length(keys) != 1L || is.na(keys) || !nzchar(keys) || keys %in% c(".", "..") ||
      grepl("[/\\\\]", keys) || grepl("[[:cntrl:]]", keys)) rho_object_error("unavailable", "Exact help alias is ambiguous or has an invalid database key.")
  file.path(path, "help", keys)
}

rho_help <- function(payload) {
  # Help is an explicit Operation; dispatch already revoked object observations.
  if (base::is.null(base::.Internal(getRegisteredNamespace("tools")))) base::loadNamespace("tools")
  exact <- !is.null(payload$library_path)
  path <- NULL
  identities <- NULL
  help_identities <- NULL
  if (exact) {
    copy <- rho_package_exact_copy(payload)
    path <- copy$path
    identities <- rho_package_index_files(path)
    if (!is.null(payload$expected_index_files) && !identical(identities, payload$expected_index_files)) rho_object_error("content_changed", "Package index files changed before help rendering.")
    help_identities <- rho_help_exact_files(path)
  }
  entry <- if (exact) rho_help_exact_entry(path, payload$topic) else utils::help(payload$topic, package = payload$package,
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
  if (exact && !identical(help_identities, rho_help_exact_files(path))) rho_object_error("content_changed", "Selected help metadata/database changed during rendering.")
  if (nchar(text, type = "bytes") > 16 * 1024 * 1024) rho_object_error("budget_exhausted", "Rendered help exceeds the 16 MiB text artifact limit; no partial document was stored.")
  list(topic = payload$topic, package = payload$package, library_path = payload$library_path,
       found = TRUE, text = text, preview = substr(text, 1L, payload$max_chars),
       preview_truncated = nchar(text) > payload$max_chars, truncated = FALSE)
}

rho_help_text_page <- function(text, offset, limit) {
  bytes <- charToRaw(enc2utf8(text)); total <- length(bytes)
  if (offset > total || (offset < total && bitwAnd(as.integer(bytes[[offset + 1L]]), 192L) == 128L)) rho_object_error("invalid_input", "Help offset is not a UTF-8 boundary.")
  to <- min(total, offset + limit)
  while (to < total && to > offset && bitwAnd(as.integer(bytes[[to + 1L]]), 192L) == 128L) to <- to - 1L
  list(text = if (to > offset) rawToChar(bytes[seq.int(offset + 1L, to)]) else "",
       offset_utf8 = offset, next_offset_utf8 = if (to < total) to else NULL,
       total_bytes = total, complete = to == total)
}

# Exact-copy help for the Query lane. Missing providers remain unavailable.
rho_read_help <- function(payload) {
  get_help <- rho_readonly_binding("utils", ".getHelpFile")
  render <- rho_readonly_binding("tools", "Rd2txt")
  capture <- rho_readonly_binding("utils", "capture.output")
  copy <- rho_package_exact_copy(payload)
  path <- copy$path
  index_files <- rho_package_index_files(path)
  if (!identical(index_files, payload$expected_index_files)) rho_object_error("content_changed", "Package index changed before help reading.")
  help_files <- rho_help_exact_files(path)
  if (!is.null(payload$expected_help_files) && !identical(help_files, payload$expected_help_files)) rho_object_error("content_changed", "Help files changed between pages.")
  entry <- rho_help_exact_entry(path, payload$topic)
  found <- length(entry) == 1L
  text <- if (found) paste(capture(render(get_help(entry[[1L]]), stages = character(), options = list(underline_titles = FALSE))), collapse = "\n") else ""
  text <- enc2utf8(text)
  if (nchar(text, type = "bytes") > 16 * 1024 * 1024) rho_object_error("budget_exhausted", "Rendered help exceeds 16 MiB.")
  if (!identical(index_files, rho_package_index_files(path)) || !identical(help_files, rho_help_exact_files(path))) rho_object_error("content_changed", "Package help changed during reading.")
  c(list(observation_id = payload$observation_id, package = payload$package, library_path = payload$library_path,
         topic = payload$topic, found = found, help_files = help_files),
    rho_help_text_page(text, payload$offset_utf8, payload$limit_bytes))
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
