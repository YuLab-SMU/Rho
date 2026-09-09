# Only this provider may classify automatic persistence. Viewer projections are insufficient.
rho_checkpoint_initialize <- function(path) {
  dll <- base::dyn.load(path, local = TRUE)
  provider <- new.env(parent = baseenv())
  provider$roots <- base::getNativeSymbolInfo("rho_checkpoint_roots", dll)$address
  provider$write <- base::getNativeSymbolInfo("rho_checkpoint_write", dll)$address
  init <- base::getNativeSymbolInfo("rho_checkpoint_initialize", dll)$address
  base::.Call(init, 1L:2L, base::as.double(1L:2L))
  rho_checkpoint_provider <<- provider
  invisible(TRUE)
}
rho_checkpoint_provider <- NULL
rho_checkpoint_capture <- function(payload) {
  if (is.null(rho_checkpoint_provider)) stop("Native checkpoint provider unavailable")
  all_names <- ls(.GlobalEnv, all.names = TRUE)
  match_patterns <- function(patterns) {
    patterns <- unlist(patterns, use.names = FALSE)
    if (!length(patterns)) return(character())
    unique(unlist(lapply(patterns,function(pattern) all_names[grepl(utils::glob2rx(pattern),all_names)]),use.names=FALSE))
  }
  included_patterns <- match_patterns(payload$include_patterns)
  selection <- if (is.null(payload$include_names) && !length(payload$include_patterns)) all_names else union(unlist(payload$include_names,use.names=FALSE),included_patterns)
  selection <- setdiff(selection, union(unlist(payload$exclude_names, use.names = FALSE),match_patterns(payload$exclude_patterns)))
  scan <- .Call(rho_checkpoint_provider$roots, .GlobalEnv, payload$max_bytes, payload$max_seconds, selection)
  keep <- scan[[3L]]
  # One stream preserves aliases across independently named roots.
  values <- .subset(scan[[2L]], which(keep))
  .Call(rho_checkpoint_provider$write, values, payload$path, payload$max_bytes, max(0, payload$max_seconds - scan[[5L]]))
  skipped <- lapply(which(!keep), function(i) list(name = .subset2(scan[[1L]], i), reason = .subset2(scan[[4L]], i)))
  list(saved_names = unname(as.list(names(values))), skipped = skipped,
       r_version = as.character(getRversion()), platform = R.version$platform,
       library_paths = unname(as.list(.libPaths())),
       package_inventory_digest = rho_checkpoint_inventory(),
       coverage = if (all(keep)) "complete_eligible_graph" else "partial")
}
rho_checkpoint_restore <- function(payload) {
  if (is.null(rho_checkpoint_provider)) stop("Native checkpoint provider unavailable")
  if (length(ls(.GlobalEnv, all.names = TRUE))) stop("Checkpoint restore requires an empty candidate session")
  if (!identical(rho_checkpoint_inventory(), payload$package_inventory_digest)) stop("Installed package inventory differs from checkpoint")
  if (!identical(as.character(getRversion()), payload$r_version) || !identical(R.version$platform, payload$platform) || !identical(.libPaths(), unlist(payload$library_paths, use.names = FALSE))) stop("Checkpoint runtime or library configuration differs")
  # The adapter verifies the artifact digest and origin before sending this action.
  values <- base::readRDS(payload$path)
  if (typeof(values) != "list" || is.object(values) || (length(values) > 0L && is.null(names(values))) || anyDuplicated(names(values))) stop("Invalid checkpoint root graph")
  if (!identical(names(values), unlist(payload$saved_names, use.names = FALSE))) stop("Checkpoint roots differ from manifest")
  staging <- new.env(parent = emptyenv())
  for (name in names(values)) assign(name, .subset2(values, name), staging)
  # Structural verification calls no class methods or connection reconstruction.
  scan <- .Call(rho_checkpoint_provider$roots, staging, payload$max_bytes, 30, NULL)
  if (!all(scan[[3L]])) stop("Restored graph failed conservative structural validation")
  for (name in names(values)) assign(name, .subset2(values, name), .GlobalEnv)
  list(restored_names = unname(as.list(names(values))))
}

# Exact installed DESCRIPTION bytes plus copy paths; no namespace is loaded.
rho_checkpoint_inventory <- function() {
  paths <- sort(unique(unlist(lapply(.libPaths(), function(lib) {
    children <- list.files(lib, full.names = TRUE, all.files = FALSE)
    descriptions <- file.path(children, "DESCRIPTION")
    descriptions[file.exists(descriptions) & !dir.exists(descriptions)]
  }), use.names = FALSE)), method = "radix")
  hashes <- tools::md5sum(paths)
  if (anyNA(hashes)) stop("Cannot fingerprint installed package metadata")
  # Hash inventory encoding without leaving persistent query material.
  temporary <- tempfile("rho-checkpoint-inventory-")
  on.exit(unlink(temporary))
  writeBin(serialize(list(paths=paths,md5=unname(hashes)),NULL,version=2), temporary)
  unname(tools::md5sum(temporary))
}
