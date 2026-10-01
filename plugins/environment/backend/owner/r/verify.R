# Parse base-R command arguments before loading any helper namespace. Dependencies
# must resolve in the staged library or R's own library, never the user's library.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) >= 4L)
library <- normalizePath(args[[1L]], winslash = "/", mustWork = TRUE)
support <- args[[2L]]
output <- args[[3L]]
request_id <- args[[4L]]
specs <- if (length(args) > 4L) args[-seq_len(4L)] else character()
.libPaths(c(library, .Library), include.site = FALSE)
probes <- unname(lapply(specs, function(spec) {
  parts <- strsplit(spec, "@", fixed = TRUE)[[1L]]
  stopifnot(length(parts) == 2L)
  name <- parts[[1L]]
  tryCatch({
    namespace <- loadNamespace(name, lib.loc = library)
    version <- as.character(getNamespaceVersion(namespace))
    actual_library <- normalizePath(dirname(getNamespaceInfo(namespace, "path")), winslash = "/", mustWork = TRUE)
    matches <- identical(version, parts[[2L]]) && identical(actual_library, library)
    list(name = name, version = version, library = actual_library,
         loadable = matches, error = if (matches) NULL else "namespace version/library mismatch")
  }, error = function(error) list(name = name, version = NULL, library = NULL,
      loadable = FALSE, error = substr(conditionMessage(error), 1L, 2000L)))
}))
value <- list(r_version = paste(R.version$major, R.version$minor, sep = "."),
              platform = R.version$platform, probes = probes)
requireNamespace("jsonlite", lib.loc = support, quietly = TRUE)
jsonlite::write_json(list(protocol_version = 1L, request_id = request_id,
                         ok = TRUE, value = value, error = NULL),
                    output, auto_unbox = TRUE, null = "null", digits = NA)
