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
  started <- proc.time()[[3L]]
  inventory <- rho_checkpoint_inventory()
  context <- rho_checkpoint_context(payload$project_root)
  all_names <- ls(.GlobalEnv, all.names = TRUE)
  match_patterns <- function(patterns) {
    patterns <- unlist(patterns, use.names = FALSE)
    if (!length(patterns)) return(character())
    unique(unlist(lapply(patterns,function(pattern) all_names[grepl(utils::glob2rx(pattern),all_names)]),use.names=FALSE))
  }
  included_patterns <- match_patterns(payload$include_patterns)
  selection <- if (is.null(payload$include_names) && !length(payload$include_patterns)) all_names else union(unlist(payload$include_names,use.names=FALSE),included_patterns)
  selection <- setdiff(selection, union(unlist(payload$exclude_names, use.names = FALSE),match_patterns(payload$exclude_patterns)))
  remaining <- payload$max_seconds - (proc.time()[[3L]] - started)
  if (remaining <= 0) stop("Checkpoint metadata observation exhausted the capture time budget")
  scan <- .Call(rho_checkpoint_provider$roots, .GlobalEnv, payload$max_bytes, remaining, selection)
  keep <- scan[[3L]]
  # One stream preserves aliases across independently named roots.
  values <- .subset(scan[[2L]], which(keep))
  internal <- scan[[4L]] == "internal_transient"
  skipped <- lapply(which(!keep & !internal), function(i) list(name = .subset2(scan[[1L]], i), reason = .subset2(scan[[4L]], i)))
  report <- list(saved_names = unname(as.list(names(values))), skipped = skipped,
       r_version = as.character(getRversion()), platform = R.version$platform,
       library_paths = unname(as.list(.libPaths())),
       package_inventory_digest = inventory,
       working_directory = context$working_directory, safe_options = context$safe_options, context_notices = context$notices,
       required_class_namespaces = unname(as.list(scan[[6L]])),
       required_core_namespaces = unname(as.list(intersect(loadedNamespaces(), c("stats","utils","methods","graphics","grDevices")))),
       coverage = if (all(keep | internal)) "complete_eligible_graph" else "partial")
  if (nchar(jsonlite::toJSON(report,auto_unbox=TRUE,null="null"),type="bytes")>512*1024) stop("Checkpoint metadata exceeds the 512 KiB publication budget")
  .Call(rho_checkpoint_provider$write, values, payload$path, payload$max_bytes, max(0, payload$max_seconds - (proc.time()[[3L]] - started)))
  report
}
rho_checkpoint_restore <- function(payload) {
  if (is.null(rho_checkpoint_provider)) stop("Native checkpoint provider unavailable")
  if (length(ls(.GlobalEnv, all.names = TRUE))) stop("Checkpoint restore requires an empty candidate session")
  if (!identical(rho_checkpoint_inventory(), payload$package_inventory_digest)) stop("Installed package inventory differs from checkpoint")
  if (!identical(as.character(getRversion()), payload$r_version) || !identical(R.version$platform, payload$platform) || !identical(.libPaths(), unlist(payload$library_paths, use.names = FALSE))) stop("Checkpoint runtime or library configuration differs")
  for (namespace in unlist(payload$required_core_namespaces,use.names=FALSE)) {
    if (is.null(base::.Internal(getRegisteredNamespace(namespace)))) stop("A required resident core namespace is absent; restore does not load it")
  }
  # Package preparation is an explicit effect of this restore operation. It never
  # installs packages or replays a project startup/analysis script.
  before_namespaces <- loadedNamespaces()
  required <- unlist(payload$required_class_namespaces,use.names=FALSE)
  if (length(required)>128L || any(!grepl("^[A-Za-z][A-Za-z0-9.]*$",required))) stop("Checkpoint has an unsupported class namespace requirement")
  for (namespace in required) {
    if (!requireNamespace(namespace,quietly=TRUE)) stop(paste("Required installed namespace could not be prepared:",namespace))
  }
  created_bindings <- ls(.GlobalEnv,all.names=TRUE)
  if (length(setdiff(created_bindings,".Random.seed"))) stop("Package preparation created undeclared global bindings; candidate was not restored")
  if (".Random.seed" %in% created_bindings) rm(list=".Random.seed",envir=.GlobalEnv)
  initialized_namespaces <- setdiff(loadedNamespaces(),before_namespaces)
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
  rho_checkpoint_restore_context(payload)
  list(restored_names = unname(as.list(names(values))),
       initialized_namespaces = unname(as.list(initialized_namespaces)),
       notices = if(length(initialized_namespaces)) list("Required installed namespaces were initialized in this candidate; package initialization hooks ran. Analysis and project startup scripts were not replayed.") else list())
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

rho_checkpoint_context <- function(project_root) {
  notices <- list("Package search paths, arbitrary options, devices, callbacks and external resources are not reconstructed.")
  scalar_int <- function(name, low, high) {
    value <- getOption(name)
    if (!is.object(value) && is.integer(value) && length(value)==1L && !is.na(value) && value>=low && value<=high) return(value)
    if (!is.object(value) && is.double(value) && length(value)==1L && !is.na(value) && is.finite(value) && value==floor(value) && value>=low && value<=high) return(as.integer(value))
    NULL
  }
  decimal <- getOption("OutDec")
  if (!(is.character(decimal) && !is.object(decimal) && length(decimal)==1L && !is.na(decimal) && nchar(decimal,type="chars")==1L && !grepl("[[:cntrl:]]",decimal))) decimal <- NULL
  opts <- list(digits=scalar_int("digits",1L,22L),width=scalar_int("width",10L,10000L),scipen=scalar_int("scipen",-999L,999L),out_dec=decimal,warn=scalar_int("warn",-1L,2L))
  root <- normalizePath(project_root,winslash="/",mustWork=TRUE)
  cwd <- normalizePath(getwd(),winslash="/",mustWork=TRUE)
  relative <- if (identical(root,cwd)) "." else if (startsWith(cwd,paste0(root,"/"))) substring(cwd,nchar(root)+2L) else NULL
  if (is.null(relative)) notices <- c(notices,list("Working directory lies outside the project and is not restored."))
  list(working_directory=relative,safe_options=opts,notices=notices)
}
rho_checkpoint_restore_context <- function(payload) {
  directory <- payload$working_directory
  if (!is.null(directory)) {
    root <- normalizePath(payload$project_root,winslash="/",mustWork=TRUE)
    target <- normalizePath(file.path(root,directory),winslash="/",mustWork=TRUE)
    if (!(identical(root,target)||startsWith(target,paste0(root,"/")))) stop("Checkpoint working directory escapes the project")
    setwd(target)
  }
  values <- payload$safe_options
  restored <- list()
  for (name in c("digits","width","scipen","warn")) if (!is.null(values[[name]])) restored[[name]] <- values[[name]]
  if (!is.null(values$out_dec)) restored$OutDec <- values$out_dec
  if (length(restored)) options(restored)
  invisible(NULL)
}
