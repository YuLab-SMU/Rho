# Metadata only is retained between requests. Values are resolved again in the native lane.
rho_object_state <- new.env(parent = emptyenv())
rho_object_state$handles <- list()
rho_object_state$serial <- 0
# Read native provider bindings without getNamespace/::, which may load missing namespaces.
rho_readonly_binding <- function(package, name) {
  namespace <- base::.Internal(getRegisteredNamespace(package))
  if (base::is.null(namespace)) rho_object_error("unavailable", base::paste0(package, " is not loaded in this native session; read-only queries do not load providers."))
  if (!base::exists(name, envir = namespace, inherits = FALSE) || base::bindingIsActive(name, namespace)) rho_object_error("unavailable", base::paste0(package, "::", name, " is not a resident ordinary provider binding."))
  base::get(name, envir = namespace, inherits = FALSE)
}
# This is the same serializer gate used by the Rust read-only bridge call.
# The unavailable reply is encoded by Host so an absent serializer is not loaded to report it.
rho_query_json <- function(request_json, result_path, unavailable_response) {
  namespace <- base::.Internal(getRegisteredNamespace("jsonlite"))
  unavailable <- base::is.null(namespace)
  if (!unavailable) unavailable <- !base::exists("fromJSON", envir = namespace, inherits = FALSE) || !base::exists("write_json", envir = namespace, inherits = FALSE) || base::bindingIsActive("fromJSON", namespace) || base::bindingIsActive("write_json", namespace)
  if (unavailable) {
    base::writeLines(unavailable_response, con = result_path, useBytes = TRUE)
    return(base::invisible(NULL))
  }
  decode <- base::get("fromJSON", envir = namespace, inherits = FALSE)
  encode <- base::get("write_json", envir = namespace, inherits = FALSE)
  if (!base::is.function(decode) || !base::is.function(encode)) {
    base::writeLines(unavailable_response, con = result_path, useBytes = TRUE)
    return(base::invisible(NULL))
  }
  request <- decode(request_json, simplifyVector = FALSE)
  response <- rho_dispatch(request)
  encode(response, result_path, auto_unbox = TRUE, null = "null", digits = NA)
  base::invisible(NULL)
}
rho_object_length <- function(value) base::.Call(rho_readonly_binding("rlang", "ffi_length"), value)
rho_object_address <- function(value) rho_readonly_binding("rlang", "obj_address")(value)
rho_object_metadata_bytes <- function(value) base::.subset2(rho_readonly_binding("utils", "object.size")(value), 1L)
rho_object_now <- function() base::floor(base::.subset2(base::Sys.time(), 1L) * 1000)
rho_invalidate_objects <- function() { rho_object_state$handles <- list(); invisible(NULL) }
rho_object_error <- function(kind, message) stop(structure(list(message = paste0(kind, ": ", message), call = NULL, code = kind), class = c("rho_query_error", "error", "condition")))
rho_object_scope <- function(payload) {
  scope <- payload$scope
  if (!is.list(scope) || !all(c("project", "principal", "session") %in% names(scope))) stop("Object query requires trusted scope")
  scope
}
rho_object_prune <- function() {
  now <- rho_object_now()
  rho_object_state$handles <- Filter(function(h) now - h$used < 60000 && now - h$created < 300000, rho_object_state$handles)
}
rho_object_handle <- function(id, payload, kind) {
  force(id); force(payload)
  rho_object_prune()
  handles <- rho_object_state$handles
  if (is.null(id) || !id %in% names(handles)) rho_object_error("observation_expired", "Reference expired or was invalidated; open a new observation.")
  h <- handles[[id]]
  if (!identical(h$scope, rho_object_scope(payload)) || !identical(h$kind, kind)) rho_object_error("observation_invalid", "Reference does not belong to this principal, project, session or read kind.")
  rho_object_state$handles[[id]]$used <- rho_object_now()
  h
}
rho_object_store <- function(payload, kind, data) {
  rho_object_prune()
  scope <- rho_object_scope(payload)
  same <- Filter(function(h) identical(h$scope, scope) && identical(h$kind, kind), rho_object_state$handles)
  if (length(same) >= if (kind == "directory") 4L else 32L) rho_object_error("budget_exhausted", "Reference quota reached; wait for expiry or narrow and reuse an existing observation.")
  now <- rho_object_now()
  h <- c(list(scope = scope, kind = kind, created = now, used = now), data)
  size <- rho_object_metadata_bytes(h)
  used <- sum(vapply(rho_object_state$handles, function(h) rho_object_metadata_bytes(h), 0))
  if (used + size > 8 * 1024 * 1024) rho_object_error("budget_exhausted", "Object handle metadata exceeds 8 MiB; narrow the name/type filter.")
  rho_object_state$serial <- rho_object_state$serial + 1
  id <- paste0("object_", rho_object_state$serial)
  rho_object_state$handles[[id]] <- h
  id
}
rho_object_binding <- function(name) {
  if (!exists(name, .GlobalEnv, inherits = FALSE)) return(list(kind = "missing", address = NULL))
  if (bindingIsActive(name, .GlobalEnv)) return(list(kind = "active_binding", address = NULL))
  if (isTRUE(rho_readonly_binding("rlang", "env_binding_are_lazy")(.GlobalEnv, name)[[1L]])) return(list(kind = "promise", address = NULL))
  value <- get(name, .GlobalEnv, inherits = FALSE)
  list(kind = "value", address = rho_object_address(value), value = value)
}
rho_object_supported <- function(value) {
  classes <- attr(value, "class", exact = TRUE)
  if (isS4(value)) return(FALSE)
  if (!is.null(classes) && !(identical(classes, "factor") || identical(classes, c("ordered", "factor")) || identical(classes, "Date") || identical(classes, c("POSIXct", "POSIXt")) || identical(classes, "difftime") || identical(classes, "data.frame") || identical(classes, c("tbl_df", "tbl", "data.frame")))) return(FALSE)
  typeof(value) %in% c("NULL", "logical", "integer", "double", "complex", "raw", "character", "list")
}
rho_object_metadata <- function(value = NULL, binding_kind = "value") {
  m <- list(kind = binding_kind, object_type = NULL, classes = list(), length = NULL, dimensions = list(), supported_reads = list(), attributes = list(), notice = NULL)
  if (binding_kind != "value") { m$supported_reads <- list("structure"); m$notice <- "Only binding metadata is available; active bindings and promises are never evaluated."; return(m) }
  m$object_type <- typeof(value)
  classes <- attr(value, "class", exact = TRUE)
  if (is.character(classes) && !is.object(classes)) m$classes <- unname(as.list(substr(.subset(classes, seq_len(min(length(classes), 16L))), 1L, 128L)))
  if (is.character(classes) && !is.object(classes) && (length(classes) > 16L || any(nchar(classes, type = "chars") > 128L))) m$notice <- "Class metadata is limited to 16 entries and 128 characters each; this unsupported metadata has no further read method."
  if (!rho_object_supported(value)) { m$supported_reads <- list("structure"); m$notice <- "Unsupported value reads: safe metadata only; no user methods were called. Class metadata is limited to 16 names of 128 characters; this interface cannot continue class metadata for unsupported objects."; return(m) }
  bare <- value
  m$length <- rho_object_length(bare)
  dims <- attr(value, "dim", exact = TRUE)
  if (is.numeric(dims) && !is.object(dims)) m$dimensions <- unname(as.list(dims))
  frame <- identical(classes, "data.frame") || identical(classes, c("tbl_df", "tbl", "data.frame"))
  if (frame) m$dimensions <- list(.row_names_info(value, 2L), rho_object_length(bare))
  for (attribute in c("units", "tzone")) {
    av <- attr(value, attribute, exact = TRUE)
    if (!is.null(av)) {
      if (!is.character(av) || is.object(av) || length(av) > 16L || any(nchar(av, type = "bytes") > 1024L)) { m$notice <- "Nonstandard units/timezone attributes: metadata only."; return(m) }
      m$attributes[[length(m$attributes) + 1L]] <- list(name = attribute, values = unname(as.list(av)))
    }
  }
  reads <- "structure"
  if (!is.null(attr(value, "names", exact = TRUE))) reads <- c(reads, "names")
  if (frame || (length(dims) == 2L && is.atomic(bare))) reads <- c(reads, "table")
  if (typeof(bare) == "list") reads <- c(reads, "children")
  else if (!is.null(bare)) reads <- c(reads, "values")
  if (typeof(bare) == "character" || !is.null(attr(value, "names", exact = TRUE)) || "factor" %in% unlist(m$classes)) reads <- c(reads, "text")
  if (typeof(bare) == "integer" && "factor" %in% unlist(m$classes)) reads <- c(reads, "levels")
  m$supported_reads <- as.list(reads)
  m
}
rho_object_resolve <- function(value, path) {
  for (step in path) {
    if (!rho_object_supported(value) || typeof(value) != "list") rho_object_error("unsupported", "Child paths require an ordinary list or standard data frame.")
    if (identical(step$kind, "index")) index <- step$index
    else if (identical(step$kind, "name")) {
      names <- attr(value, "names", exact = TRUE)
      if (!is.character(names) || is.object(names)) rho_object_error("unsupported", "Exact names are unavailable.")
      hits <- which(names == step$name)
      if (length(hits) != 1L) rho_object_error("invalid_path", "Exact name is missing or duplicated; use the one-based index.")
      index <- hits[[1L]]
    } else rho_object_error("invalid_path", "Only structured index or exact-name paths are accepted.")
    bare <- value
    if (!is.numeric(index) || length(index) != 1L || index < 1 || index > rho_object_length(bare) || index != floor(index)) rho_object_error("invalid_path", "Child index is outside the object.")
    value <- .subset2(bare, index)
  }
  value
}
rho_object_identity <- function(binding) paste(binding$kind, binding$address, sep = ":")
rho_list_objects <- function(payload) {
  if (is.null(payload$directory_ref)) {
    names <- sort(ls(.GlobalEnv, all.names = TRUE), method = "radix")
    if (nzchar(payload$name_contains)) names <- names[grepl(payload$name_contains, names, fixed = TRUE)]
    identities <- vector("list", length(names)); selected <- character(length(names)); selected_count <- 0L
    budget <- 0
    for (name in names) {
      binding <- rho_object_binding(name)
      if (!is.null(payload$object_type) && !identical(if (binding$kind == "value") typeof(binding$value) else binding$kind, payload$object_type)) next
      budget <- budget + nchar(name, type = "bytes") + 512
      if (budget > 8 * 1024 * 1024) rho_object_error("budget_exhausted", "Directory metadata exceeds 8 MiB; narrow the name/type filter.")
      selected_count <- selected_count + 1L; selected[[selected_count]] <- name; identities[[selected_count]] <- rho_object_identity(binding)
    }
    selected <- head(selected, selected_count); identities <- head(identities, selected_count)
    id <- rho_object_store(payload, "directory", list(names = selected, identities = identities, filter = list(payload$name_contains, payload$object_type)))
    h <- rho_object_handle(id, payload, "directory")
  } else {
    id <- payload$directory_ref; h <- rho_object_handle(id, payload, "directory")
    if (!identical(h$filter, list(payload$name_contains, payload$object_type))) rho_object_error("observation_invalid", "Directory filters must match the original observation.")
  }
  offset <- payload$offset; entries <- list(); bytes <- 0
  if (offset > length(h$names)) rho_object_error("invalid_cursor", "Directory offset exceeds observation size.")
  while (offset + length(entries) < length(h$names) && length(entries) < payload$limit) {
    index <- offset + length(entries) + 1L; name <- h$names[[index]]; binding <- rho_object_binding(name)
    if (!identical(rho_object_identity(binding), h$identities[[index]])) rho_object_error("content_changed", "Binding changed; open a new directory observation.")
    entry <- list(name = name, metadata = rho_object_metadata(binding$value, binding$kind))
    size <- nchar(rho_readonly_binding("jsonlite", "toJSON")(entry, auto_unbox = TRUE, null = "null"), type = "bytes")
    if (bytes + size > 240000 && length(entries)) break
    if (size > 240000) rho_object_error("budget_exhausted", "One directory entry exceeds the response budget; narrow the filter.")
    entries[[length(entries) + 1L]] <- entry; bytes <- bytes + size
  }
  next_offset <- offset + length(entries)
  list(directory_ref = id, entries = entries, total = length(h$names), offset = offset, next_offset = if (next_offset < length(h$names)) next_offset else NULL, observed_at_ms = h$created, complete = next_offset == length(h$names), notices = if (next_offset < length(h$names)) list("Continue with directory_ref and next_offset using unchanged filters.") else list())
}
rho_observe_object <- function(payload) {
  binding <- rho_object_binding(payload$name)
  if (binding$kind == "missing") rho_object_error("not_found", "Object binding does not exist.")
  if (binding$kind != "value" && length(payload$path)) rho_object_error("unsupported", "Unevaluated bindings expose only root metadata.")
  value <- if (binding$kind == "value") rho_object_resolve(binding$value, payload$path) else NULL
  id <- rho_object_store(payload, "object", list(name = payload$name, path = payload$path, identity = rho_object_identity(binding), child_address = if (binding$kind == "value") rho_object_address(value) else NULL))
  h <- rho_object_handle(id, payload, "object")
  list(object_ref = id, name = payload$name, path = payload$path, metadata = rho_object_metadata(value, binding$kind), observed_at_ms = h$created, expires_at_ms = h$created + 60000)
}
rho_object_text <- function(text, start, max_bytes) {
  count <- nchar(text, type = "chars")
  if (start > count + 1) rho_object_error("invalid_cursor", "Text character offset exceeds length.")
  part <- enc2utf8(substr(text, start, min(count, start + max_bytes - 1L)))
  while (nchar(part, type = "bytes") > max_bytes) part <- substr(part, 1L, max(0L, floor(nchar(part, type = "chars") * 0.75)))
  if (!nzchar(part) && start <= count) rho_object_error("budget_exhausted", "The next Unicode character exceeds text_limit_bytes; request at least 4 bytes.")
  next_start <- start + nchar(part, type = "chars")
  list(text = part, total = count, next_start = if (next_start <= count) next_start else NULL)
}
rho_object_scalar <- function(value, text_start = 1, text_limit = 512L) {
  type <- typeof(value)
  out <- list(kind = "value", object_type = type, logical = NULL, number = NULL, imaginary = NULL, text = NULL, label = NULL, text_characters = NULL, next_text_start = NULL)
  if (type == "raw") { out$number <- as.integer(value); return(out) }
  if (is.na(value)) { out$kind <- if (type %in% c("double", "complex") && is.nan(value)) "non_finite" else "missing"; out$label <- if (out$kind == "missing") "NA" else "NaN"; return(out) }
  if (type %in% c("double", "complex") && is.infinite(value)) { out$kind <- "non_finite"; out$label <- if (type == "complex") paste(Re(value), Im(value), sep = ",") else if (value > 0) "Inf" else "-Inf"; return(out) }
  if (type == "logical") out$logical <- value
  else if (type %in% c("integer", "double", "complex")) { out$number <- Re(value); if (type == "complex") out$imaginary <- Im(value) }
  else if (type == "character") { page <- rho_object_text(value, text_start, text_limit); out$text <- page$text; out$text_characters <- page$total; out$next_text_start <- page$next_start }
  out
}
rho_read_object <- function(payload) {
  h <- rho_object_handle(payload$object_ref, payload, "object")
  binding <- rho_object_binding(h$name)
  if (!identical(h$identity, rho_object_identity(binding))) rho_object_error("content_changed", "Binding changed; open a new object observation.")
  if (binding$kind != "value") {
    if (payload$kind != "structure" || length(h$path) || length(payload$path)) rho_object_error("unsupported", "Binding cannot be evaluated safely; only root metadata is readable.")
    value <- NULL
  } else {
    value <- rho_object_resolve(binding$value, h$path)
    if (!identical(h$child_address, rho_object_address(value))) rho_object_error("content_changed", "Observed child changed.")
    value <- rho_object_resolve(value, payload$path)
  }
  metadata <- rho_object_metadata(value, binding$kind)
  if (!payload$kind %in% unlist(metadata$supported_reads)) rho_object_error("unsupported", "This read kind is not supported; inspect metadata.supported_reads.")
  bare <- value
  result <- list(object_ref = payload$object_ref, root_name = h$name, observed_path = h$path, path = payload$path, kind = payload$kind, metadata = metadata, values = list(), children = list(), columns = list(), start = payload$start, next_start = NULL, column_start = payload$column_start, next_column_start = NULL, text_start = payload$text_start, next_text_start = NULL, observed_at_ms = h$created, complete = TRUE, notices = list())
  start <- payload$start; limit <- payload$limit
  if (payload$kind %in% c("values", "levels", "names", "text")) {
    if (payload$kind == "text" && !is.null(payload$text_attribute)) { bare <- attr(value, payload$text_attribute, exact = TRUE); if (!is.character(bare) || is.object(bare)) rho_object_error("unsupported", "Text attribute is absent or nonstandard.") }
    if (payload$kind == "text" && typeof(bare) != "character") rho_object_error("unsupported", "Text reads require character values or an explicit names/levels text_attribute.")
    if (payload$kind == "names") { bare <- attr(value, "names", exact = TRUE); if (!is.character(bare) || is.object(bare)) rho_object_error("unsupported", "Names are nonstandard.") }
    if (payload$kind == "levels") { bare <- attr(value, "levels", exact = TRUE); if (!is.character(bare) || is.object(bare)) rho_object_error("unsupported", "Factor levels are nonstandard.") }
    if (start > rho_object_length(bare) + 1) rho_object_error("invalid_cursor", "Vector index exceeds length.")
    n <- if (payload$kind == "text") min(1, rho_object_length(bare) - start + 1) else min(limit, rho_object_length(bare) - start + 1)
    if (n > 0) result$values <- lapply(seq.int(start, length.out = n), function(index) rho_object_scalar(.subset2(bare, index), if (payload$kind == "text") payload$text_start else 1, if (payload$kind == "text") payload$text_limit_bytes else 512L))
    if (start + n <= rho_object_length(bare)) result$next_start <- start + n
    if (payload$kind == "text" && n) result$next_text_start <- result$values[[1L]]$next_text_start
  } else if (payload$kind %in% c("children", "structure")) {
    if (typeof(bare) == "list") {
      names <- attr(value, "names", exact = TRUE); n <- min(limit, max(0, rho_object_length(bare) - start + 1))
      if (n) result$children <- lapply(seq.int(start, length.out = n), function(index) list(index = index, name = if (is.character(names) && !is.object(names)) .subset2(names, index) else NULL, metadata = rho_object_metadata(.subset2(bare, index))))
      if (start + n <= rho_object_length(bare)) result$next_start <- start + n
    }
  } else if (payload$kind == "table") {
    dims <- metadata$dimensions; rows <- dims[[1L]]; cols <- dims[[2L]]
    cs <- payload$column_start
    if (start > rows + 1 || cs > cols + 1) rho_object_error("invalid_cursor", "Table row or column index exceeds dimensions.")
    nc <- min(payload$column_limit, 50L, max(0, cols - cs + 1)); nr <- min(limit, 200L, max(0, rows - start + 1), if (nc) floor(2000 / nc) else 200L)
    if (nc) result$columns <- lapply(seq.int(cs, length.out = nc), function(index) {
      matrix <- typeof(bare) != "list"
      column <- if (matrix) NULL else .subset2(bare, index)
      cm <- if (matrix) { m <- metadata; m$dimensions <- list(); m$length <- rows; m } else rho_object_metadata(column)
      safe <- matrix || (rho_object_supported(column) && typeof(column) != "list")
      cv <- column
      values <- if (safe && nr) lapply(seq.int(start, length.out = nr), function(row) rho_object_scalar(if (matrix) .subset2(bare, row + (index - 1) * rows) else .subset2(cv, row))) else list()
      names <- if (matrix) { dn <- attr(value, "dimnames", exact = TRUE); if (is.list(dn) && !is.object(dn) && length(dn) == 2L) .subset2(dn, 2L) else NULL } else attr(value, "names", exact = TRUE)
      list(index = index, name = if (is.character(names) && !is.object(names)) .subset2(names, index) else NULL, metadata = cm, values = values)
    })
    if (start + nr <= rows) result$next_start <- start + nr
    if (cs + nc <= cols) result$next_column_start <- cs + nc
  }
  # Reduce an oversized page without dropping continuation. Scalar text can be read separately.
  while (nchar(rho_readonly_binding("jsonlite", "toJSON")(result, auto_unbox = TRUE, null = "null", digits = NA), type = "bytes") > 250000) {
    if (length(result$values) > 1L) { result$values <- head(result$values, -1L); result$next_start <- start + length(result$values) }
    else if (length(result$children) > 1L) { result$children <- head(result$children, -1L); result$next_start <- start + length(result$children) }
    else if (length(result$columns) && length(result$columns[[1L]]$values) > 1L) { result$columns <- lapply(result$columns, function(c) { c$values <- head(c$values, -1L); c }); result$next_start <- start + length(result$columns[[1L]]$values) }
    else if (length(result$columns) > 1L) { result$columns <- head(result$columns, -1L); result$next_column_start <- payload$column_start + length(result$columns) }
    else rho_object_error("budget_exhausted", "One metadata entry exceeds the page budget; a narrower structural path is required.")
  }
  result$complete <- is.null(result$next_start) && is.null(result$next_column_start) && is.null(result$next_text_start) && !any(vapply(result$values, function(v) !is.null(v$next_text_start), TRUE)) && !any(vapply(result$columns, function(c) any(vapply(c$values, function(v) !is.null(v$next_text_start), TRUE)), TRUE))
  if (!result$complete) result$notices <- list("Continue row/column pages independently with the same reference and path. For shortened character values use kind=text, one-based element index and next_text_start. Data-frame cells append the exact column index to path and use start=row; atomic matrix cells keep path and use start=row+(column-1)*nrow. For names/levels use text_attribute=names/levels. Text offsets count Unicode scalar characters; budgets count UTF-8 bytes.")
  result
}
