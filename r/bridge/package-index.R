# Static files only. parse() produces syntax trees; no namespace declaration is evaluated.
rho_package_index_files <- function(path) {
  names <- c("DESCRIPTION", "NAMESPACE", "help/AnIndex", "INDEX")
  lapply(names, function(name) {
    file <- file.path(path, name)
    if (!file.exists(file)) return(list(path = name, digest = "absent"))
    canonical <- normalizePath(file, winslash = "/", mustWork = TRUE)
    root <- normalizePath(path, winslash = "/", mustWork = TRUE)
    if (!startsWith(canonical, paste0(root, "/"))) rho_object_error("content_changed", "Package resource escaped its selected copy.")
    size <- file.info(file)$size
    if (is.na(size) || size > 4 * 1024 * 1024) rho_object_error("budget_exhausted", "Package index file exceeds 4 MiB static-read budget.")
    # Native tools::md5sum reads bytes; include resolved path to fence symlink replacements.
    list(path = name, digest = paste0("md5:", unname(tools::md5sum(file)), ":", canonical))
  })
}
rho_package_exact_copy <- function(payload) {
  p <- list(mode = "installed", filter = "", limit = 200L, offset = 0L, grouped = FALSE, package_name = payload$package, observation_id = payload$observation_id)
  inventory <- rho_packages(p)
  matches <- Filter(function(row) identical(row$name, payload$package) && identical(row$library_path, payload$library_path), inventory$packages)
  while (!length(matches) && !is.null(inventory$next_offset)) {
    p$offset <- inventory$next_offset
    inventory <- rho_packages(p)
    matches <- Filter(function(row) identical(row$name, payload$package) && identical(row$library_path, payload$library_path), inventory$packages)
  }
  if (length(matches) != 1L) rho_object_error("observation_invalid", "Exact package copy is absent from the package observation.")
  path <- file.path(payload$library_path, payload$package)
  if (!dir.exists(path)) rho_object_error("content_changed", "Package copy is no longer installed.")
  # A retained inventory cannot attribute an updated installation to its old version.
  description_size <- file.info(file.path(path, "DESCRIPTION"))$size
  if (is.na(description_size) || description_size > 262144L) rho_object_error("budget_exhausted", "Package DESCRIPTION exceeds the inventory 256 KiB bound or is unavailable.")
  current <- tryCatch(read.dcf(file.path(path, "DESCRIPTION"), fields = c("Package", "Version")), error = function(e) NULL)
  if (is.null(current) || nrow(current) != 1L || !identical(unname(current[1L, "Package"]), payload$package) || !identical(unname(current[1L, "Version"]), matches[[1L]]$version)) rho_object_error("content_changed", "Installed copy changed since its package observation.")
  list(path = path, copy = matches[[1L]], observed_at_ms = inventory$observed_at_ms)
}
rho_package_static_index <- function(path) {
  rows <- list(); notices <- character()
  add <- function(kind, name, topic = NULL, title = NULL, declaration = NULL, resolved = TRUE) {
    rows[[length(rows) + 1L]] <<- list(kind = kind, name = name, topic = topic, title = title, declaration = declaration, resolved = resolved)
  }
  namespace <- file.path(path, "NAMESPACE")
  if (file.exists(namespace)) {
    expressions <- tryCatch(parse(file = namespace, keep.source = FALSE), error = function(e) NULL)
    if (is.null(expressions)) { notices <- c(notices, "NAMESPACE could not be parsed statically."); add("unresolved", "NAMESPACE", resolved = FALSE) }
    else for (expression in expressions) {
      if (!is.call(expression)) { add("unresolved", "declaration", declaration = paste(deparse(expression), collapse = " "), resolved = FALSE); next }
      op <- as.character(expression[[1L]])
      args <- as.list(expression)[-1L]
      if (length(op) == 1L && op %in% c("export", "exportClasses", "exportMethods") && all(vapply(args, function(x) is.symbol(x) || (is.character(x) && length(x) == 1L), TRUE))) {
        for (arg in args) add("export", as.character(arg), declaration = op)
      } else if (length(op) == 1L && op %in% c("import", "importFrom", "importClassesFrom", "importMethodsFrom", "S3method", "useDynLib")) {
        add("declaration", op, declaration = paste(deparse(expression, width.cutoff = 500L), collapse = " "))
      } else add("unresolved", if (length(op) == 1L) op else "expression", declaration = paste(deparse(expression, width.cutoff = 500L), collapse = " "), resolved = FALSE)
    }
  }
  titles <- list(); index <- file.path(path, "INDEX")
  if (file.exists(index)) {
    lines <- readLines(index, warn = FALSE, encoding = "UTF-8")
    current <- NULL
    for (line in lines) {
      if (grepl("^[^[:space:]]+[[:space:]]+", line)) {
        current <- sub("[[:space:]].*$", "", line)
        titles[[current]] <- trimws(sub("^[^[:space:]]+[[:space:]]+", "", line))
      } else if (!is.null(current) && grepl("^[[:space:]]+", line)) titles[[current]] <- paste(titles[[current]], trimws(line))
    }
    for (topic in names(titles)) add("topic", topic, topic = topic, title = titles[[topic]])
  }
  aliases <- file.path(path, "help", "AnIndex")
  if (file.exists(aliases)) for (line in readLines(aliases, warn = FALSE, encoding = "UTF-8")) {
    parts <- strsplit(line, "\t", fixed = TRUE)[[1L]]
    if (length(parts) == 2L) add("alias", parts[[1L]], topic = parts[[2L]], title = if (parts[[2L]] %in% names(titles)) titles[[parts[[2L]]]] else NULL)
    else notices <- c(notices, "Malformed help alias entry could not be parsed.")
  }
  if (any(vapply(rows, function(x) !x$resolved, TRUE))) notices <- c(notices, "Conditional declarations and exportPattern remain unresolved; namespace was not loaded.")
  description <- read.dcf(file.path(path, "DESCRIPTION"))
  fields <- if (nrow(description) == 1L) lapply(colnames(description), function(name) list(name = name, value = rho_package_location(unname(description[1L, name])))) else list()
  list(entries = rows, description = fields, notices = as.list(unique(notices)))
}
rho_package_index <- function(payload) {
  copy <- rho_package_exact_copy(payload)
  files <- rho_package_index_files(copy$path)
  if (is.null(payload$index_ref)) {
    index <- rho_package_static_index(copy$path)
    if (!identical(files, rho_package_index_files(copy$path))) rho_object_error("content_changed", "Package files changed during index construction.")
    id <- rho_object_store(payload, "package_index", list(files = files, copy = list(payload$observation_id, payload$package, payload$library_path), index = index))
    h <- rho_object_handle(id, payload, "package_index")
  } else {
    id <- payload$index_ref; h <- rho_object_handle(id, payload, "package_index")
    if (!identical(h$copy, list(payload$observation_id, payload$package, payload$library_path)) || !identical(h$files, files)) rho_object_error("content_changed", "Package copy or index files changed; open a new index.")
    index <- h$index
  }
  entries <- index$entries
  if (!is.null(payload$kind)) entries <- Filter(function(x) identical(x$kind, payload$kind), entries)
  if (nzchar(payload$filter)) entries <- Filter(function(x) grepl(tolower(payload$filter), tolower(paste(x$name, x$title)), fixed = TRUE), entries)
  if (payload$offset > length(entries)) rho_object_error("invalid_cursor", "Index offset exceeds selected entry count.")
  n <- min(payload$limit, length(entries) - payload$offset)
  page <- if (n) entries[seq.int(payload$offset + 1L, length.out = n)] else list()
  result <- list(index_ref = id, observation_id = payload$observation_id, package = payload$package, library_path = payload$library_path, version = copy$copy$version, files = files, description = index$description, entries = page, total = length(entries), offset = payload$offset, next_offset = NULL, observed_at_ms = h$created, complete = FALSE, notices = index$notices)
  while (nchar(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null"), type = "bytes") > 250000 && length(result$entries) > 1L) result$entries <- head(result$entries, -1L)
  if (nchar(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null"), type = "bytes") > 250000) rho_object_error("budget_exhausted", "Package description or one declaration exceeds 256 KiB; content cannot fit in a page.")
  end <- payload$offset + length(result$entries)
  result$next_offset <- if (end < length(entries)) end else NULL
  result$complete <- is.null(result$next_offset) && !length(index$notices)
  result
}
