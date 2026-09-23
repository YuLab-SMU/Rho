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
# HTML uses the same static Rd stage; no dynamic sections or examples run.
rho_read_help <- function(payload) {
  html <- identical(payload$format, "html")
  get_help <- rho_readonly_binding("utils", ".getHelpFile")
  render <- rho_readonly_binding("tools", if (html) "Rd2HTML" else "Rd2txt")
  capture <- rho_readonly_binding("utils", "capture.output")
  copy <- rho_package_exact_copy(payload)
  path <- copy$path
  index_files <- rho_package_index_files(path)
  if (!identical(index_files, payload$expected_index_files)) rho_object_error("content_changed", "Package index changed before help reading.")
  help_files <- rho_help_exact_files(path)
  if (!is.null(payload$expected_help_files) && !identical(help_files, payload$expected_help_files)) rho_object_error("content_changed", "Help files changed between pages.")
  entry <- rho_help_exact_entry(path, payload$topic)
  found <- length(entry) == 1L
  text <- if (!found) "" else if (html) {
    # dynamic = TRUE emits relative ../../<pkg>/help/<topic> links that the client
    # resolves through the same exact-copy reader; nothing is fetched from R's httpd.
    suppressWarnings(paste(capture(render(get_help(entry[[1L]]), package = c(payload$package, copy$copy$version),
                         stages = character(), dynamic = TRUE, no_links = FALSE, stylesheet = "")), collapse = "\n"))
  } else {
    paste(capture(render(get_help(entry[[1L]]), stages = character(), options = list(underline_titles = FALSE))), collapse = "\n")
  }
  text <- enc2utf8(text)
  if (nchar(text, type = "bytes") > 16 * 1024 * 1024) rho_object_error("budget_exhausted", "Rendered help exceeds 16 MiB.")
  if (!identical(index_files, rho_package_index_files(path)) || !identical(help_files, rho_help_exact_files(path))) rho_object_error("content_changed", "Package help changed during reading.")
  c(list(observation_id = payload$observation_id, package = payload$package, library_path = payload$library_path,
         topic = payload$topic, found = found, help_files = help_files,
         format = if (html) "html" else "text", version = copy$copy$version),
    rho_help_text_page(text, payload$offset_utf8, payload$limit_bytes))
}

# Viewer hook. htmltools/htmlwidgets call getOption("viewer")(url) with a temporary
# HTML file. Local script/style/image dependencies are inlined so the retained
# document stands alone; nothing is fetched remotely and no service is started.
rho_inline_html <- function(path, budget = 16 * 1024 * 1024) {
  root <- normalizePath(dirname(path), winslash = "/", mustWork = TRUE)
  html <- paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  used <- nchar(html, type = "bytes")
  local_file <- function(reference) {
    reference <- sub("[?#].*$", "", reference)
    if (!nzchar(reference) || grepl("^(https?:|data:|blob:|//|/)", reference)) return(NULL)
    candidate <- tryCatch(normalizePath(file.path(root, utils::URLdecode(reference)), winslash = "/", mustWork = TRUE), error = function(e) NULL)
    if (is.null(candidate) || !startsWith(candidate, paste0(root, "/"))) return(NULL)
    info <- file.info(candidate)
    if (is.na(info$size) || info$isdir) return(NULL)
    if (used + info$size > budget) stop("Viewer document with dependencies exceeds 16 MiB.")
    used <<- used + info$size
    candidate
  }
  replace_all <- function(text, pattern, make) {
    matches <- gregexpr(pattern, text, perl = TRUE)[[1L]]
    if (matches[[1L]] == -1L) return(text)
    pieces <- regmatches(text, list(matches))[[1L]]
    replacements <- vapply(pieces, make, character(1L), USE.NAMES = FALSE)
    regmatches(text, list(matches)) <- list(replacements)
    text
  }
  html <- replace_all(html, "<script\\b[^>]*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>\\s*</script>", function(tag) {
    src <- sub(".*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"'].*", "\\1", tag, perl = TRUE)
    file <- local_file(src)
    if (is.null(file)) return(tag)
    code <- paste(readLines(file, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
    paste0("<script>", gsub("</script", "<\\/script", code, fixed = TRUE), "</script>")
  })
  html <- replace_all(html, "<link\\b[^>]*\\bhref\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>", function(tag) {
    if (!grepl("stylesheet", tag, ignore.case = TRUE)) return(tag)
    href <- sub(".*\\bhref\\s*=\\s*[\"']([^\"']+)[\"'].*", "\\1", tag, perl = TRUE)
    file <- local_file(href)
    if (is.null(file)) return(tag)
    css <- paste(readLines(file, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
    paste0("<style>", gsub("</style", "<\\/style", css, fixed = TRUE), "</style>")
  })
  html <- replace_all(html, "<img\\b[^>]*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"']", function(tag) {
    src <- sub(".*\\bsrc\\s*=\\s*[\"']([^\"']+)[\"'].*", "\\1", tag, perl = TRUE)
    file <- local_file(src)
    if (is.null(file)) return(tag)
    type <- switch(tolower(tools::file_ext(file)), png = "image/png", jpg = "image/jpeg", jpeg = "image/jpeg", gif = "image/gif", svg = "image/svg+xml", NULL)
    if (is.null(type)) return(tag)
    bytes <- readBin(file, "raw", file.info(file)$size)
    sub(src, paste0("data:", type, ";base64,", jsonlite::base64_enc(bytes)), tag, fixed = TRUE)
  })
  html
}

rho_viewer <- function(pending_dir) {
  force(pending_dir)
  function(url, height = NULL, ...) {
    if (!is.character(url) || length(url) != 1L || grepl("^https?://", url)) {
      stop("This HTML widget needs a live R UI connection that is not available in Rho.", call. = FALSE)
    }
    path <- sub("^file://", "", url)
    if (!file.exists(path)) stop("This HTML widget needs a live R UI connection that is not available in Rho.", call. = FALSE)
    html <- rho_inline_html(path)
    dir.create(pending_dir, showWarnings = FALSE, recursive = TRUE)
    target <- file.path(pending_dir, paste0(format(Sys.time(), "%Y%m%d%H%M%OS6"), "-", basename(tempfile("view")), ".html"))
    writeLines(enc2utf8(html), target, useBytes = TRUE)
    invisible(NULL)
  }
}

rho_print_htmlwidget <- function(x, ..., view = interactive()) {
  viewer <- getOption("viewer")
  viewer_func <- if (is.null(viewer)) utils::browseURL else {
    function(url) {
      height <- x$sizingPolicy$viewer$paneHeight
      if (identical(height, "maximize")) height <- -1
      viewer(url, height = height)
    }
  }
  htmltools::html_print(htmltools::as.tags(x, standalone = TRUE), viewer = if (view) viewer_func)
  invisible(x)
}

rho_install_htmlwidget_print <- function(...) {
  if (!requireNamespace("htmltools", quietly = TRUE)) return(invisible(FALSE))
  base_namespace <- base::get(".BaseNamespaceEnv", envir = baseenv())
  methods <- base::get(".__S3MethodsTable__.", envir = base_namespace)
  method <- rho_print_htmlwidget
  attr(method, "positron.s3_override") <- TRUE
  attr(method, ".positron.s3_override") <- TRUE
  base::assign("print.htmlwidget", method, envir = methods)
  invisible(TRUE)
}

rho_htmlwidget_onload <- function(...) {
  rho_install_htmlwidget_print()
}

base::setHook(base::packageEvent("htmlwidgets", "onLoad"), rho_htmlwidget_onload, action = "append")
base::setHook("positron.session_reconnect", rho_htmlwidget_onload, action = "append")
if ("htmlwidgets" %in% base::loadedNamespaces()) rho_install_htmlwidget_print()

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
