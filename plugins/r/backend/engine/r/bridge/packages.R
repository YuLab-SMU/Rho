# Package observation never loads, attaches, installs or tests a package.
# Only the private bridge retains the last two bounded observations.
rho_package_location <- function(value) {
  if (is.null(value)) return(NULL)
  # Credentials and URL query/fragment data must not reach views or link targets.
  value <- gsub("([[:alpha:]][[:alnum:]+.-]*://)[^/[:space:]]*@", "\\1", value, perl = TRUE)
  value <- sub("^[^/@[:space:]]+@([^/:[:space:]]+):", "\\1:", value, perl = TRUE)
  value <- gsub("[?#][^[:space:],]*", "", value, perl = TRUE)
  value <- gsub("/t/[^/[:space:]]+", "/t/[redacted]", value, perl = TRUE)
  value
}

rho_package_source <- function(metadata, path, base_package = FALSE) {
  field <- function(name) if (name %in% names(metadata)) metadata[[name]] else NULL
  repo <- field("Repository")
  remote <- field("RemoteType")
  remote <- if (is.null(remote)) "" else tolower(remote)
  host <- function(url) {
    if (is.null(url) || !grepl("^https?://", url, ignore.case = TRUE)) return("")
    tolower(sub("[:/].*$", "", sub("^https?://", "", url, ignore.case = TRUE)))
  }
  repo_url <- if (!is.null(repo) && grepl("^https?://", repo, ignore.case = TRUE)) repo else NULL
  remote_url <- field("RemoteUrl")
  remote_host <- field("RemoteHost")
  delivery <- repo_url
  if (is.null(delivery) && remote %in% c("url", "standard", "cran")) delivery <- remote_url
  provider <- NULL
  if (host(delivery) %in% c("packagemanager.posit.co", "packagemanager.rstudio.com")) provider <- "Posit Package Manager"
  if (grepl("(^|\\.)r-universe\\.dev$", host(delivery))) provider <- "R-universe"
  snapshot <- NULL
  if (identical(provider, "Posit Package Manager") && grepl("/[0-9]{4}-[0-9]{2}-[0-9]{2}(/|$)", delivery)) {
    snapshot <- sub("^.*?/([0-9]{4}-[0-9]{2}-[0-9]{2})(/.*)?$", "\\1", delivery, perl = TRUE)
  }
  kind <- "Not recorded"
  remote_types <- c(github = "GitHub", gitlab = "GitLab", bitbucket = "Bitbucket", git = "Git", svn = "SVN", url = "URL", local = "Local")
  if (base_package) kind <- "R distribution"
  else if (identical(provider, "R-universe")) kind <- "R-universe"
  else if (remote %in% names(remote_types)) kind <- unname(remote_types[[remote]])
  else if (!is.null(repo)) {
    if (identical(toupper(repo), "CRAN")) kind <- "CRAN"
    else if (grepl("^Bioconductor([ :]|$)", repo, ignore.case = TRUE)) kind <- "Bioconductor"
    else if (grepl("(^|\\.)r-forge\\.r-project\\.org$", host(repo)) || identical(tolower(repo), "r-forge")) kind <- "R-Forge"
    else kind <- "Repository"
  } else if (remote %in% c("cran", "bioc", "bioconductor")) {
    kind <- if (remote == "cran") "CRAN" else "Bioconductor"
  }
  repository <- repo
  repository_url <- repo_url
  owner <- field("RemoteUsername")
  remote_repo <- field("RemoteRepo")
  if (!is.null(remote_repo)) {
    repository <- if (is.null(owner)) remote_repo else paste(owner, remote_repo, sep = "/")
    if (identical(remote, "github") && !is.null(owner) &&
        isTRUE(remote_host %in% c("github.com", "api.github.com")) &&
        all(grepl("^[A-Za-z0-9_-][A-Za-z0-9_.-]*$", c(owner, remote_repo)))) {
      repository_url <- paste0("https://github.com/", owner, "/", remote_repo)
    }
  } else if (!is.null(remote_url) && remote %in% c("git", "svn", "url", "local")) {
    repository <- remote_url
    repository_url <- if (grepl("^https?://", remote_url)) remote_url else NULL
  }
  keys <- intersect(c("Repository", "RemoteType", "RemoteHost", "RemoteUsername", "RemoteRepo", "RemoteRef", "RemoteSha", "RemoteUrl", "RemoteSubdir"), names(metadata))
  evidence <- unname(lapply(keys, function(key) list(field = key, value = metadata[[key]])))
  if (base_package) evidence <- list(list(field = "Priority", value = "base"), list(field = "Location", value = "R distribution library"))
  links <- list()
  if (!is.null(field("URL"))) {
    urls <- unique(strsplit(field("URL"), "[,[:space:]]+", perl = TRUE)[[1L]])
    urls <- head(urls[grepl("^https?://", urls, ignore.case = TRUE)], 4L)
    links <- unname(lapply(urls, function(url) list(label = "Website", url = url)))
  }
  list(kind = kind, repository = repository, repository_url = repository_url,
       remote_host = remote_host, remote_ref = field("RemoteRef"), remote_sha = field("RemoteSha"),
       delivery_url = delivery, provider = provider, snapshot = snapshot,
       evidence = evidence, links = links,
       notice = if (kind == "Not recorded") "Installed metadata does not identify the source of this copy." else NULL)
}

rho_package_inventory <- function() {
  libs <- .libPaths()
  complete <- length(libs) <= 128L
  libs <- head(libs, 128L)
  notices <- character()
  note <- function(text) { notices <<- unique(c(notices, text)); complete <<- FALSE }
  if (!complete) note("Library paths limited to 128.")
  namespaces <- sort(loadedNamespaces())
  if (length(namespaces) > 512L) note("Loaded namespaces limited to 512.")
  attached <- sub("^package:", "", grep("^package:", search(), value = TRUE))
  loaded <- setNames(lapply(head(namespaces, 512L), function(name) {
    tryCatch(list(version = unname(.subset(getNamespaceVersion(name), 1L)),
                  path = if (identical(name, "base")) file.path(R.home("library"), "base") else getNamespaceInfo(name, "path")),
             error = function(e) { note("Some loaded namespace metadata could not be read."); list(version = NULL, path = NULL) })
  }), head(namespaces, 512L))
  fields <- c("Package", "Version", "Title", "Built", "Priority", "Repository", "RemoteType", "RemoteHost", "RemoteUsername", "RemoteRepo", "RemoteRef", "RemoteSha", "RemoteUrl", "RemoteSubdir", "URL")
  read_metadata <- function(entry) {
    description <- file.path(entry, "DESCRIPTION")
    if (!file_test("-f", description)) return(NULL)
    info <- file.info(description)
    size <- .subset2(info, "size")
    if (is.na(size)) { note("Some package metadata could not be observed."); return(NULL) }
    if (size > 262144L) { note("Oversized package DESCRIPTION metadata was skipped (256 KiB limit)."); return(NULL) }
    matrix <- tryCatch(read.dcf(description, fields = fields), error = function(e) NULL)
    if (is.null(matrix) || nrow(matrix) != 1L || anyNA(matrix[1L, c("Package", "Version")])) {
      note("Unreadable or invalid package DESCRIPTION metadata was skipped."); return(NULL)
    }
    if (!identical(unname(matrix[1L, "Package"]), basename(entry))) {
      note("Package directory and DESCRIPTION names disagree; entry skipped."); return(NULL)
    }
    row <- list()
    for (field in fields) {
      value <- unname(matrix[1L, field])
      if (is.na(value) || !nzchar(value)) next
      limit <- if (field %in% c("Version", "Package", "RemoteType", "Priority")) 128L else 512L
      # Sanitize before truncation so a long authority cannot expose a credential prefix.
      if (field %in% c("Repository", "RemoteHost", "RemoteRepo", "RemoteRef", "RemoteUrl", "URL")) value <- rho_package_location(value)
      if (nchar(value) > limit) note("Long package metadata fields were shortened.")
      row[[field]] <- substr(value, 1L, limit)
    }
    row
  }
  entry <- function(name, lib, index, first, metadata) {
    native <- if (name %in% names(loaded)) loaded[[name]] else list(version = NULL, path = NULL)
    value <- function(field) if (!is.null(metadata) && field %in% names(metadata)) metadata[[field]] else NULL
    path <- if (is.null(lib)) NULL else file.path(lib, name)
    same <- !is.null(native$path) && !is.null(path) && identical(normalizePath(native$path, winslash = "/", mustWork = FALSE), normalizePath(path, winslash = "/", mustWork = FALSE))
    base_package <- !is.null(path) && identical(value("Priority"), "base") &&
      identical(normalizePath(path, winslash = "/", mustWork = FALSE), normalizePath(file.path(R.home("library"), name), winslash = "/", mustWork = FALSE))
    list(name = name, version = if (is.null(value("Version"))) "Unknown" else value("Version"), title = value("Title"), built = value("Built"),
         library_path = lib, library_index = index, first_in_library_path = first,
         loaded_version = native$version, loaded_path = native$path, loaded_from_library = same,
         attached = name %in% attached, source = rho_package_source(metadata, path, base_package))
  }
  rows <- list(); seen <- character(); libraries <- list(); scanned <- 0L; metadata_bytes <- 0
  exhausted <- FALSE
  for (index in seq_along(libs)) {
    lib <- libs[[index]]
    status <- "readable"; reason <- NULL
    if (exhausted) { status <- "not_scanned"; reason <- "Observation limit reached." }
    else if (!dir.exists(lib) || file.access(lib, 4L) != 0L) {
      status <- "unavailable"; reason <- "Library could not be read."; note(paste("Library unavailable:", lib))
    } else {
      entries <- list.files(lib, pattern = "^[A-Za-z][A-Za-z0-9.]*$", full.names = TRUE)
      budget <- max(0L, 10000L - scanned)
      if (length(entries) > budget) { note("Library scan limited to 10,000 entries."); status <- "partial"; reason <- "Entry limit reached." }
      for (path in head(entries, budget)) {
        scanned <- scanned + 1L
        metadata <- read_metadata(path)
        if (is.null(metadata)) next
        name <- metadata[["Package"]]
        item <- entry(name, lib, index, !name %in% seen, metadata)
        metadata_bytes <- metadata_bytes + sum(nchar(as.character(unlist(item, use.names = FALSE)), type = "bytes"))
        if (metadata_bytes > 8 * 1024 * 1024) {
          note("Package metadata observation limited to 8 MiB."); exhausted <- TRUE; status <- "partial"; reason <- "Metadata limit reached."; break
        }
        rows[[length(rows) + 1L]] <- item
        seen <- c(seen, name)
      }
      if (scanned >= 10000L) exhausted <- TRUE
    }
    libraries[[index]] <- list(index = index, path = lib, status = status, notice = reason)
  }
  if (any(vapply(libraries, function(x) x$status == "not_scanned", TRUE))) note("Later libraries were not scanned after the observation limit.")
  installed_count <- length(rows)
  # Retain namespaces loaded outside .libPaths(), or whose files disappeared.
  for (name in names(loaded)) {
    native <- loaded[[name]]
    if (any(vapply(rows, function(x) x$name == name && x$loaded_from_library, TRUE))) next
    lib <- if (is.null(native$path)) NULL else dirname(native$path)
    metadata <- if (is.null(native$path)) NULL else read_metadata(native$path)
    rows[[length(rows) + 1L]] <- entry(name, lib, NULL, FALSE, metadata)
  }
  grouped <- split(rows, vapply(rows, function(row) row$name, ""))
  groups <- lapply(sort(names(grouped)), function(name) {
    copies <- grouped[[name]]
    in_libraries <- Filter(function(x) !is.null(x$library_index), copies)
    first <- if (length(in_libraries)) in_libraries[[1L]] else NULL
    native <- if (name %in% names(loaded)) loaded[[name]] else list(version = NULL, path = NULL)
    matching <- Filter(function(x) x$loaded_from_library && identical(x$version, native$version), copies)
    preferred <- if (length(matching)) matching[[1L]] else if (!is.null(first)) first else copies[[1L]]
    kinds <- unique(vapply(copies, function(x) x$source$kind, ""))
    list(name = name, title = preferred$title, version = if (is.null(native$version)) preferred$version else native$version,
         first_version = if (is.null(first)) NULL else first$version,
         primary_library_path = if (!is.null(native$version) && !length(matching)) NULL else preferred$library_path,
         copy_count = length(in_libraries), loaded_version = native$version, loaded_path = native$path,
         loaded_copy_observed = length(matching) > 0L, attached = name %in% attached,
         source_kind = if (!is.null(native$version) && !length(matching)) "Not recorded" else preferred$source$kind,
         source_count = length(kinds))
  })
  counts <- list(all = length(groups), installed = length(unique(seen)), installations = installed_count,
                 loaded = length(loaded), attached = sum(names(loaded) %in% attached),
                 multiple = sum(vapply(groups, function(x) x$copy_count > 1L, TRUE)))
  list(r_version = paste(R.version$major, R.version$minor, sep = "."), r_home = R.home(), platform = R.version$platform,
       library_paths = unname(as.list(libs)), libraries = libraries, rows = rows, groups = groups, counts = counts,
       scanned = scanned, scan_complete = complete, notices = unname(as.list(head(notices, 20L))))
}

rho_packages <- local({
  observations <- list()
  serial <- 0L
  function(payload) {
    stopifnot(payload$mode %in% c("installed", "loaded", "attached"),
              length(payload$filter) == 1L, nchar(payload$filter) <= 128L,
              payload$limit >= 1L, payload$limit <= 200L,
              payload$offset >= 0L, payload$offset <= 10000L)
    id <- payload$observation_id
    if (is.null(id)) {
      inventory <- rho_package_inventory()
      serial <<- serial + 1L
      id <- paste0("packages_", serial)
      inventory$observed_at_ms <- floor(as.numeric(Sys.time()) * 1000)
      observations[[id]] <<- inventory
      if (length(observations) > 2L) observations <<- tail(observations, 2L)
    } else {
      if (!id %in% names(observations)) stop("Package observation expired. Refresh Packages to obtain a new observation.")
      inventory <- observations[[id]]
    }
    name <- payload$package_name
    is_grouped <- isTRUE(payload$grouped) && is.null(name)
    rows <- if (is_grouped) inventory$groups else inventory$rows
    if (!is.null(name)) rows <- Filter(function(x) identical(x$name, name), rows)
    else {
      if (payload$mode == "loaded") rows <- Filter(function(x) !is.null(x$loaded_version) && (is_grouped || x$loaded_from_library), rows)
      else if (payload$mode == "attached") rows <- Filter(function(x) x$attached && (is_grouped || x$loaded_from_library), rows)
      else if (!is_grouped) rows <- Filter(function(x) !is.null(x$library_index), rows)
      if (!is_grouped && payload$mode != "installed" && length(rows)) {
        rows <- rows[!duplicated(vapply(rows, function(x) x$name, ""))]
        rows <- lapply(rows, function(x) {
          if (!identical(x$version, x$loaded_version)) x$source <- NULL
          x$version <- if (is.null(x$loaded_version)) "Unknown" else x$loaded_version
          x
        })
      }
      if (nzchar(payload$filter)) rows <- Filter(function(x) grepl(tolower(payload$filter), tolower(paste(x$name, x$title)), fixed = TRUE), rows)
    }
    if (length(rows)) rows <- rows[order(vapply(rows, function(x) tolower(x$name), ""))]
    total <- length(rows); start <- payload$offset + 1L; end <- min(total, payload$offset + payload$limit)
    page <- if (start <= end) rows[seq.int(start, end)] else list()
    # Conservative wire budget; large copy/source records remain paginated.
    size <- function(item) { flat <- unlist(item, use.names = FALSE); sum(nchar(as.character(flat), type = "bytes")) * 6 + length(flat) * 64 + 512 }
    while (length(page) > 1L && sum(vapply(page, size, 0)) > 512 * 1024) page <- head(page, -1L)
    end <- payload$offset + length(page)
    list(r_version = inventory$r_version, r_home = inventory$r_home, platform = inventory$platform,
         library_paths = inventory$library_paths, libraries = inventory$libraries,
         mode = payload$mode, filter = payload$filter, offset = payload$offset,
         next_offset = if (end < total) end else NULL,
         packages = if (is_grouped) list() else unname(page), groups = if (is_grouped) unname(page) else list(),
         counts = inventory$counts, observation_id = id, observed_at_ms = inventory$observed_at_ms,
         package_name = name, total_matches = total, scanned = inventory$scanned,
         scan_complete = inventory$scan_complete, notices = inventory$notices)
  }
})
