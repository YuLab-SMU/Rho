test_that("execution retains workspace state", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("x <- 41; x + 1", envir = workspace)

  expect_true(result$ok)
  expect_equal(workspace$x, 41)
  expect_match(result$value, "42")
  expect_null(result$help)
})

test_that("execution projects final local Help results without printing them", {
  workspace <- new.env(parent = globalenv())

  unqualified <- rho_execute("?mean", envir = workspace)
  qualified <- rho_execute("help('lm', package = 'stats')", envir = workspace)
  namespace_qualified <- rho_execute("?stats::lm", envir = workspace)

  expect_true(unqualified$ok)
  expect_identical(unqualified$help, list(topic = "mean", package = "base"))
  expect_null(unqualified$value)
  expect_identical(qualified$help, list(topic = "lm", package = "stats"))
  expect_null(qualified$value)
  expect_identical(namespace_qualified$help, list(topic = "lm", package = "stats"))
  expect_null(namespace_qualified$value)
  expect_true(is.character(jsonlite::toJSON(
    list(unqualified, qualified, namespace_qualified),
    auto_unbox = TRUE,
    null = "null"
  )))
})

test_that("execution projects missing Help topics for truthful unavailable state", {
  workspace <- new.env(parent = globalenv())
  result <- suppressWarnings(rho_execute("help('rhoDefinitelyMissingTopic')", envir = workspace))

  expect_true(result$ok)
  expect_identical(
    result$help,
    list(topic = "rhoDefinitelyMissingTopic", package = NULL)
  )
  expect_null(result$value)
})

test_that("execution rejects malformed Help projection metadata without printing", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute(
    "structure('C:/outside/not-a-package/help/topic', class = 'help_files_with_topic', topic = paste(rep('x', 129), collapse = ''))",
    envir = workspace
  )

  expect_true(result$ok)
  expect_null(result$help)
  expect_null(result$value)
})

test_that("errors and prior mutations are retained", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("x <- 1; stop('boom')", envir = workspace)

  expect_false(result$ok)
  expect_equal(workspace$x, 1)
  expect_equal(result$error$message, "boom")
  expect_gt(length(result$calls), 0L)
  expect_identical(
    result$error$source_range,
    list(start_line = 1L, start_column = 9L, end_line = 1L, end_column = 21L)
  )
  expect_identical(result$error$stage, "evaluation")
  expect_identical(result$error$range_kind, "r_expression")
})

test_that("execution errors expose the exact multiline top-level expression", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute(
    paste(
      "value <- 1",
      "broken <- local({",
      "  stop('boom')",
      "})",
      "value <- 2",
      sep = "\n"
    ),
    envir = workspace
  )

  expect_false(result$ok)
  expect_identical(
    result$error$source_range,
    list(start_line = 2L, start_column = 1L, end_line = 4L, end_column = 3L)
  )
})

test_that("parse failures admit only an exact parser token", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute(
    paste(
      "data.frame(",
      "    y     = intercept + 0.8 * runif(34, 0, 10，) + rnorm(34)",
      ")",
      sep = "\n"
    ),
    envir = workspace
  )

  expect_false(result$ok)
  expect_identical(result$error$stage, "parse")
  expect_identical(result$error$range_kind, "r_parse_token")
  expect_identical(
    result$error$source_range,
    list(start_line = 2L, start_column = 46L, end_line = 2L, end_column = 47L)
  )
})

test_that("ASCII and supplementary-Unicode parse tokens use character columns", {
  workspace <- new.env(parent = baseenv())

  ascii <- rho_execute("value <- @", envir = workspace)
  expect_false(ascii$ok)
  expect_identical(ascii$error$stage, "parse")
  expect_identical(ascii$error$range_kind, "r_parse_token")
  expect_identical(
    ascii$error$source_range,
    list(start_line = 1L, start_column = 10L, end_line = 1L, end_column = 11L)
  )

  unicode <- rho_execute('value <- c("😀"， 2)', envir = workspace)
  expect_false(unicode$ok)
  expect_identical(unicode$error$stage, "parse")
  expect_identical(unicode$error$range_kind, "r_parse_token")
  expect_identical(
    unicode$error$source_range,
    list(start_line = 1L, start_column = 15L, end_line = 1L, end_column = 16L)
  )
})

test_that("parse EOF remains unlocated instead of inventing a token", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("value <- (", envir = workspace)

  expect_false(result$ok)
  expect_identical(result$error$stage, "parse")
  expect_null(result$error$source_range)
  expect_null(result$error$range_kind)
})

test_that("nested parse messages remain evaluation expression errors", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("parse(text = 'value <- (')", envir = workspace)

  expect_false(result$ok)
  expect_identical(result$error$stage, "evaluation")
  expect_identical(result$error$range_kind, "r_expression")
  expect_identical(
    result$error$source_range,
    list(start_line = 1L, start_column = 1L, end_line = 1L, end_column = 27L)
  )
})

test_that("parser token admission validates bounded anchored Unicode coordinates", {
  range <- rho.bridge:::rho_execution_parse_token_range

  expect_identical(
    range(simpleError("<text>:1:4: localized reason"), "😀ab，z"),
    list(start_line = 1L, start_column = 4L, end_line = 1L, end_column = 5L)
  )
  expect_identical(
    range(simpleError("<text>:2:1: localized reason"), "first\n错"),
    list(start_line = 2L, start_column = 1L, end_line = 2L, end_column = 2L)
  )

  for (message in c(
    "prefix <text>:1:1: reason",
    "<console>:1:1: reason",
    "<text>:01:1: reason",
    "<text>:1:01: reason",
    "<text>:0:1: reason",
    "<text>:1:0: reason",
    "<text>:10000001:1: reason",
    "<text>:1:1000000: reason",
    "<text>:2:1: reason",
    "<text>:1:6: reason",
    "<text>:1: reason"
  )) {
    expect_null(range(simpleError(message), "😀ab，z"), info = message)
  }
})

test_that("source ranges use character columns and an exclusive end", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("变量 <- '值'\nstop('错误')", envir = workspace)

  expect_false(result$ok)
  expect_identical(
    result$error$source_range,
    list(start_line = 2L, start_column = 1L, end_line = 2L, end_column = 11L)
  )
})

test_that("source range admission rejects incomplete inverted and excessive coordinates", {
  range <- rho.bridge:::rho_execution_srcref_range

  expect_null(range(c(0L, 1L, 1L, 1L, 1L, 1L)))
  expect_null(range(c(2L, 1L, 1L, 1L, 1L, 1L)))
  expect_null(range(c(1L, 1L, 1L, 1L, 2L, 1L)))
  expect_null(range(c(10000001L, 1L, 10000001L, 1L, 1L, 1L)))
  expect_null(range(c(1L, 1L, 1L, 1L, 1L, 1000000L)))
  expect_null(range(c(1L, 1L, 1L)))
})

test_that("execution accepts a leading source marker", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("\uFEFFvalue <- 7; value", envir = workspace)

  expect_true(result$ok)
  expect_equal(workspace$value, 7)
  expect_match(result$value, "7")
})

test_that("execution normalizes Windows selection line endings", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("\r\nvalue <- 9\r\nvalue", envir = workspace)

  expect_true(result$ok)
  expect_equal(workspace$value, 9)
  expect_match(result$value, "9")
})

test_that("single conditions remain serializable for the desktop client", {
  workspace <- new.env(parent = baseenv())
  result <- rho_execute("message('loaded')", envir = workspace)
  encoded <- jsonlite::fromJSON(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null"))

  expect_match(encoded$messages, "loaded")
})

test_that("object inspection is bounded metadata", {
  workspace <- new.env(parent = baseenv())
  workspace$x <- data.frame(a = 1:10, b = letters[1:10])
  result <- rho_inspect_object("x", envir = workspace)

  expect_true(result$ok)
  expect_equal(result$dimensions, c(10L, 2L))
  expect_true("data.frame" %in% result$classes)
  expect_equal(result$preview$kind, "tabular")
  expect_equal(length(result$preview$rows), 8L)
  expect_lt(nchar(result$structure), 4001L)
})

test_that("workspace snapshot reports environment contract", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(sample = letters[1:4], value = 1:4)
  result <- rho_workspace_snapshot(envir = workspace, object_limit = 10L)

  expect_true(result$ok)
  expect_true(is.list(result$environment$renv))
  expect_true(is.list(result$environment$render))
  expect_true(any(vapply(result$objects, function(item) identical(item$name, "qc"), logical(1))))
})

test_that("environment evidence remains structured and bounded", {
  result <- rho_environment_evidence(package_limit = 32L)
  encoded <- jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")

  expect_true(is.character(result$project_dir))
  expect_true(is.list(result$runtime))
  expect_true(is.list(result$installed_packages))
  expect_lte(length(result$installed_packages$values), 32L)
  expect_true(is.logical(result$installed_packages$truncated))
  expect_true(is.character(encoded))
})

test_that("installed inventory includes explicit non-standard R library paths", {
  library_dir <- file.path(tempdir(), paste0("rho-custom-library-", Sys.getpid()))
  source_package_name <- "jsonlite"
  skip_if_not_installed(source_package_name)
  package_source <- find.package(source_package_name)
  package_dir <- file.path(library_dir, "rhoCustomInventoryPackage")
  dir.create(file.path(package_dir, "Meta"), recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(library_dir, recursive = TRUE, force = TRUE), add = TRUE)
  writeLines(
    c(
      "Package: rhoCustomInventoryPackage",
      "Version: 0.0.1",
      "Title: Rho inventory test package",
      "Description: Temporary package used by the Rho inventory regression test.",
      "Author: Rho",
      "Maintainer: Rho <rho@example.org>",
      "License: MIT"
    ),
    file.path(package_dir, "DESCRIPTION")
  )
  package_metadata <- readRDS(file.path(package_source, "Meta", "package.rds"))
  package_metadata$DESCRIPTION[["Package"]] <- "rhoCustomInventoryPackage"
  package_metadata$DESCRIPTION[["Version"]] <- "0.0.1"
  saveRDS(package_metadata, file.path(package_dir, "Meta", "package.rds"))
  previous <- Sys.getenv("R_LIBS", unset = NA_character_)
  previous_paths <- .libPaths()
  on.exit(
    if (is.na(previous)) Sys.unsetenv("R_LIBS") else Sys.setenv(R_LIBS = previous),
    add = TRUE
  )
  on.exit(.libPaths(previous_paths), add = TRUE)
  .libPaths(setdiff(previous_paths, dirname(package_source)))
  Sys.setenv(R_LIBS = library_dir)

  result <- rho_list_installed_packages(limit = 10000L)
  matches <- vapply(
    result$packages,
    function(item) {
      identical(item$name, "rhoCustomInventoryPackage") &&
        identical(item$library, normalizePath(library_dir, winslash = "/", mustWork = TRUE))
    },
    logical(1)
  )

  expect_true(any(matches))
  expect_equal(
    result$packages[[which(matches)[[1L]]]]$library,
    normalizePath(library_dir, winslash = "/", mustWork = TRUE)
  )
})

test_that("environment status preview reports bounded diff", {
  project <- file.path(tempdir(), paste0("rho-bridge-preview-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  writeLines(
    c(
      "{",
      "  \"Packages\": {",
      "    \"definitelyMissingForRhoPreview\": {",
      "      \"Version\": \"1.0.0\",",
      "      \"Source\": \"Repository\"",
      "    }",
      "  }",
      "}"
    ),
    file.path(project, "renv.lock")
  )

  result <- rho_environment_status_preview(project_dir = project, diff_limit = 10L)

  expect_true(is.list(result$renv))
  expect_true(is.list(result$renv_status))
  expect_true(is.list(result$diff))
  expect_true(
    any(vapply(
      result$diff$values,
      function(item) identical(item$name, "definitelyMissingForRhoPreview"),
      logical(1)
    ))
  )
})

test_that("lockfile inventory reports all comparison states and library precedence", {
  project <- file.path(tempdir(), paste0("rho-lockfile-inventory-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  jsonlite::write_json(
    list(Packages = list(
      matched = list(Version = "1.0.0"),
      mismatch = list(Version = "2.0.0"),
      lockedOnly = list(Version = "3.0.0")
    )),
    file.path(project, "renv.lock"),
    auto_unbox = TRUE
  )
  installed <- matrix(
    c(
      "matched", "1.0.0", "C:/lib-second",
      "matched", "1.0.0", "C:/lib-first",
      "mismatch", "2.1.0", "C:/lib-first",
      "libraryOnly", "4.0.0", "C:/lib-first"
    ),
    ncol = 3L,
    byrow = TRUE,
    dimnames = list(NULL, c("Package", "Version", "LibPath"))
  )
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() c("C:/lib-first", "C:/lib-second"),
    .package = "rho.bridge"
  )

  result <- rho_list_lockfile_packages(project, limit = 500L)
  by_name <- stats::setNames(result$packages, vapply(result$packages, `[[`, character(1), "name"))

  expect_identical(vapply(result$packages, `[[`, character(1), "name"), sort(names(by_name)))
  expect_identical(by_name$matched$state, "matched")
  expect_identical(by_name$matched$library, "C:/lib-first")
  expect_identical(by_name$mismatch$state, "version_mismatch")
  expect_identical(by_name$lockedOnly$state, "missing_in_library")
  expect_identical(by_name$libraryOnly$state, "missing_in_lockfile")
  expect_identical(unlist(result$counts, use.names = FALSE), rep(1L, 4L))
  expect_identical(result$total_count, 4L)
  expect_false(result$truncated)
  expect_true(is.character(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")))
})

test_that("lockfile inventory distinguishes missing malformed and enumeration recovery", {
  project_a <- file.path(tempdir(), paste0("rho-lockfile-a-", Sys.getpid()))
  project_b <- file.path(tempdir(), paste0("rho-lockfile-b-", Sys.getpid()))
  dir.create(project_a, recursive = TRUE, showWarnings = FALSE)
  dir.create(project_b, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(c(project_a, project_b), recursive = TRUE, force = TRUE), add = TRUE)
  writeLines("{ broken", file.path(project_b, "renv.lock"))
  installed <- matrix(
    c("libraryOnly", "1.0.0", "C:/lib"),
    ncol = 3L,
    dimnames = list(NULL, c("Package", "Version", "LibPath"))
  )
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() "C:/lib",
    .package = "rho.bridge"
  )

  missing <- rho_list_lockfile_packages(project_a)
  malformed <- rho_list_lockfile_packages(project_b)

  expect_identical(missing$lockfile$state, "no_lockfile")
  expect_identical(missing$packages[[1L]]$state, "missing_in_lockfile")
  expect_identical(malformed$lockfile$state, "invalid_lockfile")
  expect_true(malformed$incomplete)
  expect_length(malformed$packages, 0L)
  expect_match(malformed$lockfile$parse_error, "parse|lexical|broken", ignore.case = TRUE)

  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() stop("enumeration unavailable"),
    .package = "rho.bridge"
  )
  failed <- rho_list_lockfile_packages(project_a)
  expect_true(failed$incomplete)
  expect_identical(failed$incomplete_reasons[[1L]], "installed_packages_unavailable")
  expect_match(failed$lockfile$parse_error, "enumeration unavailable")
})

test_that("lockfile inventory clamps limits, isolates projects, and bounds Unicode", {
  project_a <- file.path(tempdir(), paste0("rho-lockfile-isolation-a-", Sys.getpid()))
  project_b <- file.path(tempdir(), paste0("rho-lockfile-isolation-b-", Sys.getpid()))
  dir.create(project_a, recursive = TRUE, showWarnings = FALSE)
  dir.create(project_b, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(c(project_a, project_b), recursive = TRUE, force = TRUE), add = TRUE)
  jsonlite::write_json(
    list(Packages = setNames(list(list(Version = "1.0.0")), "项目包")),
    file.path(project_a, "renv.lock"),
    auto_unbox = TRUE
  )
  jsonlite::write_json(
    list(Packages = list(otherProject = list(Version = "2.0.0"))),
    file.path(project_b, "renv.lock"),
    auto_unbox = TRUE
  )
  installed <- matrix(character(), nrow = 0L, ncol = 3L, dimnames = list(NULL, c("Package", "Version", "LibPath")))
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() character(),
    .package = "rho.bridge"
  )

  a <- rho_list_lockfile_packages(project_a, limit = 0L)
  b <- rho_list_lockfile_packages(project_b, limit = 9999L)

  expect_identical(a$returned_count, 1L)
  expect_identical(a$packages[[1L]]$name, "项目包")
  expect_identical(b$packages[[1L]]$name, "otherProject")
  expect_false(any(vapply(b$packages, function(item) identical(item$name, "项目包"), logical(1))))
})

test_that("lockfile inventory marks source and response bounds truthfully", {
  project <- file.path(tempdir(), paste0("rho-lockfile-bounds-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  package_names <- paste0("locked", seq_len(4L))
  packages <- stats::setNames(lapply(package_names, function(name) {
    list(Version = strrep(name, 200000L))
  }), package_names)
  jsonlite::write_json(list(Packages = packages), file.path(project, "renv.lock"), auto_unbox = TRUE)
  installed <- matrix(character(), nrow = 0L, ncol = 3L, dimnames = list(NULL, c("Package", "Version", "LibPath")))
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() character(),
    .package = "rho.bridge"
  )

  result <- rho_list_lockfile_packages(project, limit = 2L)

  expect_length(result$packages, 0L)
  expect_false(result$truncated)
  expect_true(result$incomplete)
  expect_null(result$total_count)
  expect_identical(result$incomplete_reasons[[1L]], "lockfile_size_limit")
  expect_match(result$lockfile$parse_error, "5 MiB")
})

test_that("lockfile inventory accepts an empty Packages object", {
  project <- file.path(tempdir(), paste0("rho-lockfile-empty-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  writeLines('{"Packages": {}}', file.path(project, "renv.lock"))
  installed <- matrix(character(), nrow = 0L, ncol = 3L, dimnames = list(NULL, c("Package", "Version", "LibPath")))
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() character(),
    .package = "rho.bridge"
  )

  result <- rho_list_lockfile_packages(project)

  expect_true(result$lockfile$valid)
  expect_identical(result$lockfile$state, "available")
  expect_identical(result$total_count, 0L)
  expect_length(result$packages, 0L)
})

test_that("lockfile inventory binds dependency roles to DESCRIPTION and bounded closure", {
  project <- file.path(tempdir(), paste0("rho-lockfile-roles-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  writeLines(c(
    "Package: rolefixture",
    "Version: 1.0.0",
    "Imports: directA (>= 1.0),",
    "  directB",
    "LinkingTo: compiledDirect",
    "Suggests: optionalDirect",
    "Depends: R (>= 4.4)"
  ), file.path(project, "DESCRIPTION"))
  jsonlite::write_json(list(Packages = list(
    directA = list(Version = "1.0", Requirements = list("transitiveA", "directB")),
    directB = list(Version = "1.0", Requirements = "transitiveB"),
    compiledDirect = list(Version = "1.0"),
    optionalDirect = list(Version = "1.0"),
    transitiveA = list(Version = "1.0", Requirements = "transitiveB"),
    transitiveB = list(Version = "1.0", Requirements = "directA"),
    unreachable = list(Version = "1.0")
  )), file.path(project, "renv.lock"), auto_unbox = TRUE)
  installed <- matrix(character(), nrow = 0L, ncol = 3L, dimnames = list(NULL, c("Package", "Version", "LibPath")))
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() character(),
    .package = "rho.bridge"
  )

  result <- rho_list_lockfile_packages(project)
  roles <- stats::setNames(
    vapply(result$packages, `[[`, character(1), "dependency_role"),
    vapply(result$packages, `[[`, character(1), "name")
  )

  expect_identical(result$dependency_roles$state, "available")
  expect_false(result$dependency_roles$incomplete)
  expect_identical(unlist(result$dependency_roles$fields$Imports), c("directA", "directB"))
  expect_identical(
    unname(roles[c("compiledDirect", "directA", "directB", "optionalDirect")]),
    rep("direct", 4L)
  )
  expect_identical(unname(roles[c("transitiveA", "transitiveB")]), rep("transitive", 2L))
  expect_identical(roles[["unreachable"]], "unclassified")
})

test_that("lockfile inventory normalizes and redacts package sources", {
  project <- file.path(tempdir(), paste0("rho-lockfile-sources-", Sys.getpid()))
  dir.create(file.path(project, "vendor", "inside"), recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  jsonlite::write_json(list(Packages = list(
    cranPkg = list(Version = "1", Source = "Repository", Repository = "CRAN"),
    githubPkg = list(Version = "1", RemoteType = "github", RemoteUsername = "org", RemoteRepo = "repo", RemoteRef = "v1"),
    gitlabPkg = list(Version = "1", RemoteType = "gitlab", RemoteUsername = "org", RemoteRepo = "repo"),
    bitbucketPkg = list(Version = "1", RemoteType = "bitbucket", RemoteUsername = "org", RemoteRepo = "repo"),
    gitPkg = list(Version = "1", Source = "git", RemoteUrl = "https://token:secret@example.org/org/repo.git?key=secret#frag"),
    scpGitPkg = list(Version = "1", Source = "git", RemoteUrl = "git@example.org:org/repo.git"),
    urlPkg = list(Version = "1", Source = "URL", URL = "https://user:password@example.org/pkg.tar.gz?token=secret#fragment"),
    localPkg = list(Version = "1", Source = "Local", Path = "vendor/inside"),
    escapedPkg = list(Version = "1", Source = "Local", Path = "../outside"),
    unknownPkg = list(Version = "1", Source = "Mystery")
  )), file.path(project, "renv.lock"), auto_unbox = TRUE)
  installed <- matrix(
    c("installedOnly", "2", "C:/lib", "Bioconductor"),
    ncol = 4L,
    dimnames = list(NULL, c("Package", "Version", "LibPath", "Repository"))
  )
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() "C:/lib",
    .package = "rho.bridge"
  )

  result <- rho_list_lockfile_packages(project)
  packages <- stats::setNames(result$packages, vapply(result$packages, `[[`, character(1), "name"))

  expect_identical(packages$cranPkg$source, list(kind = "repository", detail = "CRAN"))
  expect_identical(packages$githubPkg$source, list(kind = "github", detail = "org/repo@v1"))
  expect_identical(packages$gitlabPkg$source, list(kind = "gitlab", detail = "org/repo"))
  expect_identical(packages$bitbucketPkg$source, list(kind = "bitbucket", detail = "org/repo"))
  expect_identical(packages$gitPkg$source, list(kind = "git", detail = "example.org/org/repo.git"))
  expect_identical(packages$scpGitPkg$source, list(kind = "git", detail = "example.org:org/repo.git"))
  expect_identical(packages$urlPkg$source, list(kind = "url", detail = "example.org/pkg.tar.gz"))
  expect_identical(packages$localPkg$source, list(kind = "local", detail = "vendor/inside"))
  expect_identical(packages$escapedPkg$source, list(kind = "local", detail = NULL))
  expect_identical(packages$unknownPkg$source, list(kind = "unknown", detail = NULL))
  expect_identical(packages$installedOnly$source, list(kind = "repository", detail = "Bioconductor"))
  encoded <- jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")
  expect_false(grepl("token|secret|key=|frag", encoded, ignore.case = TRUE))
})

test_that("local lockfile source labels require provable project containment", {
  root <- file.path(tempdir(), paste0("rho-local-source-containment-", Sys.getpid()))
  project <- file.path(root, "project")
  sibling <- file.path(root, "project-sibling")
  outside <- file.path(root, "outside")
  dir.create(file.path(project, "vendor", "inside"), recursive = TRUE, showWarnings = FALSE)
  dir.create(file.path(project, "vendor", "\u79d1\u5b66"), recursive = TRUE, showWarnings = FALSE)
  dir.create(sibling, recursive = TRUE, showWarnings = FALSE)
  dir.create(outside, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)

  label <- function(path) rho.bridge:::rho_lockfile_local_source_label(path, project)
  expect_identical(label("vendor/inside"), "vendor/inside")
  expect_identical(label("vendor/missing/package"), "vendor/missing/package")
  expect_identical(label("vendor/\u79d1\u5b66"), "vendor/\u79d1\u5b66")
  expect_identical(label("."), ".")
  expect_null(label("../outside"))
  expect_null(label("vendor/missing/../../outside-missing"))
  expect_null(label("vendor\\missing\\..\\..\\outside-missing"))
  expect_null(label(sibling))
  expect_null(label(outside))

  linked <- suppressWarnings(file.symlink(outside, file.path(project, "vendor", "linked-outside")))
  if (isTRUE(linked)) {
    expect_null(label("vendor/linked-outside"))
    expect_null(label("vendor/linked-outside/missing"))
  }
})

test_that("lockfile inventory reports DESCRIPTION absence invalidity and size limits", {
  projects <- file.path(tempdir(), paste0("rho-description-state-", Sys.getpid(), "-", c("missing", "invalid", "large")))
  lapply(projects, dir.create, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(projects, recursive = TRUE, force = TRUE), add = TRUE)
  for (project in projects) writeLines('{"Packages": {"pkg": {"Version": "1"}}}', file.path(project, "renv.lock"))
  writeLines("not a dcf record", file.path(projects[[2L]], "DESCRIPTION"))
  writeLines(c("Package: huge", "Version: 1", paste0("Description: ", strrep("x", 270000L))), file.path(projects[[3L]], "DESCRIPTION"))
  installed <- matrix(character(), nrow = 0L, ncol = 3L, dimnames = list(NULL, c("Package", "Version", "LibPath")))
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() character(),
    .package = "rho.bridge"
  )

  states <- vapply(projects, function(project) {
    rho_list_lockfile_packages(project)$dependency_roles$state
  }, character(1))

  expect_identical(unname(states), c("no_description", "invalid_description", "description_size_limit"))
})

test_that("dependency role bounds discard partial transitive claims", {
  requirements <- list(root = c("a", "b", "c"), a = "d", b = "e")

  requirement_result <- rho.bridge:::rho_lockfile_dependency_closure(
    "root", requirements, requirement_limit = 2L
  )
  edge_result <- rho.bridge:::rho_lockfile_dependency_closure(
    "root", requirements, requirement_limit = 3L, edge_limit = 2L
  )
  node_result <- rho.bridge:::rho_lockfile_dependency_closure(
    "root", list(root = "a", a = "b"), node_limit = 2L
  )
  source_result <- rho.bridge:::rho_lockfile_dependency_closure(
    "root", requirements, graph_complete = FALSE
  )

  expect_identical(requirement_result$reasons[[1L]], "dependency_requirement_limit")
  expect_identical(edge_result$reasons[[1L]], "dependency_edge_limit")
  expect_identical(node_result$reasons[[1L]], "dependency_node_limit")
  expect_identical(source_result$reasons[[1L]], "lockfile_packages_source_limit")
  for (result in list(requirement_result, edge_result, node_result, source_result)) {
    expect_true(result$incomplete)
    expect_length(result$transitive, 0L)
  }
})

test_that("dependency roles and source labels stay isolated across Unicode projects", {
  root <- file.path(tempdir(), paste0("rho-role-isolation-", Sys.getpid()))
  projects <- file.path(root, c("project-alpha", "project-\u79d1\u5b66"))
  lapply(projects, dir.create, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)
  writeLines(c("Package: alpha", "Version: 1", "Imports: alphaDirect"), file.path(projects[[1L]], "DESCRIPTION"))
  writeLines(c("Package: unicode", "Version: 1", "Imports: unicodeDirect"), file.path(projects[[2L]], "DESCRIPTION"))
  jsonlite::write_json(
    list(Packages = list(alphaDirect = list(Version = "1", Source = "Local", Path = "vendor/alpha"))),
    file.path(projects[[1L]], "renv.lock"), auto_unbox = TRUE
  )
  jsonlite::write_json(
    list(Packages = list(unicodeDirect = list(Version = "1", Source = "Repository", Repository = "\u955c\u50cf\u6e90"))),
    file.path(projects[[2L]], "renv.lock"), auto_unbox = TRUE
  )
  installed <- matrix(character(), nrow = 0L, ncol = 3L, dimnames = list(NULL, c("Package", "Version", "LibPath")))
  local_mocked_bindings(
    rho_lockfile_inventory_installed_rows = function() installed,
    rho_lockfile_inventory_library_paths = function() character(),
    .package = "rho.bridge"
  )

  alpha <- rho_list_lockfile_packages(projects[[1L]])
  unicode <- rho_list_lockfile_packages(projects[[2L]])

  expect_identical(alpha$packages[[1L]]$name, "alphaDirect")
  expect_identical(alpha$packages[[1L]]$dependency_role, "direct")
  expect_identical(alpha$packages[[1L]]$source, list(kind = "local", detail = "vendor/alpha"))
  expect_identical(unicode$packages[[1L]]$name, "unicodeDirect")
  expect_identical(unicode$packages[[1L]]$dependency_role, "direct")
  expect_identical(unicode$packages[[1L]]$source, list(kind = "repository", detail = "\u955c\u50cf\u6e90"))
  expect_false(grepl("alpha", jsonlite::toJSON(unicode, auto_unbox = TRUE), fixed = TRUE))
})

test_that("dependency roles reject DESCRIPTION symlink escape when supported", {
  project <- file.path(tempdir(), paste0("rho-description-link-", Sys.getpid()))
  outside <- tempfile("rho-description-outside-")
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  writeLines(c("Package: outside", "Version: 1"), outside)
  on.exit(unlink(c(project, outside), recursive = TRUE, force = TRUE), add = TRUE)
  linked <- suppressWarnings(file.symlink(outside, file.path(project, "DESCRIPTION")))
  skip_if_not(linked, "File symlinks are unavailable in this Windows session")

  result <- rho.bridge:::rho_lockfile_description_roles(
    normalizePath(project, winslash = "/", mustWork = TRUE)
  )

  expect_identical(result$state, "invalid_description")
  expect_match(result$error, "regular file inside")
})

test_that("typed environment operation returns structured result", {
  project <- file.path(tempdir(), paste0("rho-bridge-operation-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)

  result <- rho_environment_operation("snapshot", project_dir = project)

  expect_true(is.logical(result$ok))
  expect_identical(result$operation, "snapshot")
  expect_true(is.character(result$project_dir))
  expect_true(is.list(result$error) || is.null(result$error))
})

test_that("package mutation preview validates project-library state and repositories", {
  project <- file.path(tempdir(), paste0("rho-package-preview-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  writeLines('{"Packages":{"lockedPkg":{"Version":"1.2.3"}}}', file.path(project, "renv.lock"))
  project <- normalizePath(project, winslash = "/", mustWork = TRUE)
  library <- paste0(project, "/renv/library")
  local_mocked_bindings(
    rho_environment_renv_available = function() TRUE,
    rho_environment_project_library = function(project_dir) library,
    rho_environment_project_installed_version = function(project_library, package) {
      if (identical(package, "installPkg")) NULL else "1.0.0"
    },
    rho_environment_package_priority = function(package) NULL,
    rho_environment_project_installed_version = function(project_library, package) {
      if (package %in% c("installedPkg", "basePkg")) "1.0.0" else NULL
    },
    rho_environment_package_priority = function(package) {
      if (identical(package, "basePkg")) "base" else NULL
    },
    .package = "rho.bridge"
  )
  repos <- c(CRAN = "https://cloud.r-project.org", BioC = "https://bioconductor.org/packages/3.21/bioc")

  install <- rho_environment_package_preview("install_package", "lockedPkg", project, repos)
  update <- rho_environment_package_preview("update_package", "installedPkg", project, repos)

  expect_identical(install$disposition, "will_install")
  expect_identical(install$locked_version, "1.2.3")
  expect_identical(install$project_library, library)
  expect_identical(names(install$repositories), c("BioC", "CRAN"))
  expect_identical(update$disposition, "will_update")
  expect_identical(update$installed_version, "1.0.0")
  expect_error(rho_environment_package_preview("install_package", "installedPkg", project, repos), "already installed")
  expect_error(rho_environment_package_preview("update_package", "missingPkg", project, repos), "not installed")
  expect_error(rho_environment_package_preview("remove_package", "basePkg", project), "base package")
})

test_that("package mutation rejects unsafe names and repository values", {
  expect_identical(
    rho.bridge:::rho_environment_package_name("valid.pkg2"),
    "valid.pkg2"
  )
  for (value in c("", "bad-name", "pkg@1.0", "../pkg", "\u5305")) {
    expect_error(rho.bridge:::rho_environment_package_name(value), "valid R package name")
  }
  expect_error(
    rho.bridge:::rho_environment_package_repositories(c(CRAN = "@CRAN@")),
    "explicit HTTP"
  )
  expect_error(
    rho.bridge:::rho_environment_package_repositories(c(CRAN = "https://user:secret@example.org/repo")),
    "without credentials"
  )
  expect_error(
    rho.bridge:::rho_environment_package_repositories(c(CRAN = "https://example.org/repo?token=secret")),
    "without credentials"
  )
  expect_error(
    rho.bridge:::rho_environment_package_repositories(c(CRAN = "file:///tmp/repo")),
    "explicit HTTP"
  )
})

test_that("package mutation rejects a renv library outside the project", {
  project <- file.path(tempdir(), paste0("rho-library-root-", Sys.getpid()))
  outside <- file.path(tempdir(), paste0("rho-library-outside-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(c(project, outside), recursive = TRUE, force = TRUE), add = TRUE)
  local_mocked_bindings(
    rho_renv_project_library_path = function(project_dir) outside,
    .package = "rho.bridge"
  )

  expect_error(
    rho.bridge:::rho_environment_project_library(project),
    "outside the active project root"
  )
})

test_that("package mutations forward only fixed arguments to renv", {
  project <- file.path(tempdir(), paste0("rho-package-execute-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  project <- normalizePath(project, winslash = "/", mustWork = TRUE)
  library <- paste0(project, "/renv/library")
  captured <- new.env(parent = emptyenv())
  local_mocked_bindings(
    rho_environment_renv_available = function() TRUE,
    rho_environment_project_library = function(project_dir) library,
    rho_environment_project_installed_version = function(project_library, package) {
      if (identical(package, "installPkg")) NULL else "1.0.0"
    },
    rho_environment_package_priority = function(package) NULL,
    rho_renv_install_package = function(arguments) { captured$install <- arguments; invisible(NULL) },
    rho_renv_update_package = function(arguments) { captured$update <- arguments; warning("update warning"); invisible(NULL) },
    rho_renv_remove_package = function(arguments) { captured$remove <- arguments; message("remove message"); invisible(NULL) },
    .package = "rho.bridge"
  )
  repos <- c(CRAN = "https://cloud.r-project.org")

  install <- rho_environment_operation("install_package", project, repos, package = "installPkg", project_library = library)
  update <- rho_environment_operation("update_package", project, repos, package = "updatePkg", project_library = library)
  remove <- rho_environment_operation("remove_package", project, package = "removePkg", project_library = library)

  expect_true(install$ok)
  expect_true(update$ok)
  expect_true(remove$ok, info = remove$error$message %||% "")
  expect_named(captured$install, c("packages", "library", "rebuild", "repos", "prompt", "dependencies", "transactional", "lock", "project"))
  expect_named(captured$update, c("packages", "library", "rebuild", "check", "prompt", "lock", "all", "repos", "project"))
  expect_named(captured$remove, c("packages", "library", "project"))
  expect_identical(captured$install$dependencies, NA)
  expect_identical(captured$install$transactional, TRUE)
  expect_identical(captured$update$all, FALSE)
  expect_identical(update$warnings, "update warning")
  expect_identical(remove$messages, "remove message")
  expect_false(any(c("version", "url", "path") %in% names(captured$install)))
})

test_that("package execution rejects package state changed after preview", {
  project <- file.path(tempdir(), paste0("rho-package-race-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  project <- normalizePath(project, winslash = "/", mustWork = TRUE)
  library <- paste0(project, "/renv/library")
  installed <- FALSE
  called <- FALSE
  local_mocked_bindings(
    rho_environment_renv_available = function() TRUE,
    rho_environment_project_library = function(project_dir) library,
    rho_environment_project_installed_version = function(project_library, package) {
      if (installed) "1.0.0" else NULL
    },
    rho_environment_package_priority = function(package) NULL,
    rho_renv_install_package = function(arguments) { called <<- TRUE },
    .package = "rho.bridge"
  )

  preview <- rho_environment_package_preview(
    "install_package", "pkg", project,
    c(CRAN = "https://cloud.r-project.org")
  )
  expect_true(preview$ok)
  installed <- TRUE
  result <- rho_environment_operation(
    "install_package", project, c(CRAN = "https://cloud.r-project.org"),
    package = "pkg", project_library = library
  )

  expect_false(result$ok)
  expect_match(result$error$message, "already installed")
  expect_false(called)
})

test_that("package mutation fails safely for missing renv and changed project library", {
  project <- file.path(tempdir(), paste0("rho-package-failure-", Sys.getpid()))
  dir.create(project, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(project, recursive = TRUE, force = TRUE), add = TRUE)
  project <- normalizePath(project, winslash = "/", mustWork = TRUE)
  available <- FALSE
  local_mocked_bindings(
    rho_environment_renv_available = function() available,
    rho_environment_project_library = function(project_dir) paste0(project, "/renv/library/current"),
    .package = "rho.bridge"
  )
  missing <- rho_environment_operation(
    "install_package", project, c(CRAN = "https://cloud.r-project.org"),
    package = "pkg", project_library = paste0(project, "/renv/library")
  )
  expect_false(missing$ok)
  expect_match(missing$error$message, "renv.*unavailable")

  available <- TRUE
  changed <- rho_environment_operation(
    "remove_package", project, package = "pkg",
    project_library = paste0(project, "/renv/library/previewed")
  )
  expect_false(changed$ok)
  expect_match(changed$error$message, "no longer matches")
})

test_that("package previews remain isolated across Unicode projects", {
  root <- file.path(tempdir(), paste0("rho-package-isolation-", Sys.getpid()))
  projects <- file.path(root, c("project A", "project \u79d1\u5b66"))
  lapply(projects, dir.create, recursive = TRUE, showWarnings = FALSE)
  on.exit(unlink(root, recursive = TRUE, force = TRUE), add = TRUE)
  projects <- vapply(projects, normalizePath, character(1), winslash = "/", mustWork = TRUE)
  local_mocked_bindings(
    rho_environment_renv_available = function() TRUE,
    rho_environment_project_library = function(project_dir) paste0(project_dir, "/renv/library"),
    rho_environment_project_installed_version = function(project_library, package) {
      if (grepl("project A", project_library, fixed = TRUE)) "1.0" else "2.0"
    },
    rho_environment_package_priority = function(package) NULL,
    .package = "rho.bridge"
  )
  repos <- c(CRAN = "https://cloud.r-project.org")

  alpha <- rho_environment_package_preview("update_package", "pkg", projects[[1L]], repos)
  unicode <- rho_environment_package_preview("update_package", "pkg", projects[[2L]], repos)

  expect_identical(alpha$installed_version, "1.0")
  expect_identical(unicode$installed_version, "2.0")
  expect_false(identical(alpha$project_dir, unicode$project_dir))
  expect_false(identical(alpha$project_library, unicode$project_library))
})

test_that("vector previews stay bounded", {
  workspace <- new.env(parent = baseenv())
  workspace$x <- 1:100
  result <- rho_inspect_object("x", envir = workspace)

  expect_equal(result$preview$kind, "vector")
  expect_lte(length(result$preview$values), 12L)
  expect_true(result$preview$truncated)
})

test_that("workspace snapshots and inspection never evaluate active bindings", {
  workspace <- new.env(parent = baseenv())
  calls <- 0L
  makeActiveBinding("dynamic", function(value) {
    calls <<- calls + 1L
    42L
  }, env = workspace)

  objects <- rho_list_objects(envir = workspace, limit = 10L)
  dynamic <- objects[[which(vapply(objects, function(item) identical(item$name, "dynamic"), logical(1)))]]
  expect_identical(calls, 0L)
  expect_identical(dynamic$typeof, "active_binding")
  expect_identical(dynamic$preview_kind, "opaque")
  expect_true(dynamic$active_binding)

  expect_error(
    rho_inspect_object("dynamic", envir = workspace),
    "Active bindings cannot be inspected"
  )
  expect_identical(calls, 0L)
})

test_that("function inspection includes bounded source without executing it", {
  workspace <- new.env(parent = baseenv())
  workspace$set_proxy <- function(url = "http://localhost:7890") {
    Sys.setenv(http_proxy = url)
  }

  result <- rho_inspect_object("set_proxy", envir = workspace)

  expect_equal(result$typeof, "closure")
  expect_match(result$function_source$definition, "set_proxy <- function")
  expect_match(result$function_source$definition, "Sys.setenv")
  expect_true(
    is.null(result$function_source$path) ||
      (is.character(result$function_source$path) &&
        length(result$function_source$path) == 1L &&
        nzchar(result$function_source$path))
  )
  expect_true(
    is.null(result$function_source$line) ||
      (is.integer(result$function_source$line) && result$function_source$line >= 1L)
  )
})

test_that("tabular previews bound nested and long cell payloads by bytes", {
  workspace <- new.env(parent = baseenv())
  workspace$x <- data.frame(id = 1L)
  workspace$x$payload <- I(list(strrep("x", 1000000L)))
  result <- rho_inspect_object("x", envir = workspace)
  encoded <- jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")

  expect_lt(nchar(encoded, type = "bytes"), 50000L)
  expect_match(result$preview$rows[[1L]]$payload, "truncated|length")
})

test_that("list previews bound long item names", {
  workspace <- new.env(parent = baseenv())
  workspace$x <- setNames(list(1L), strrep("x", 1000000L))
  result <- rho_inspect_object("x", envir = workspace)
  encoded <- jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")

  expect_lt(nchar(encoded, type = "bytes"), 50000L)
  expect_match(result$preview$items[[1L]], "truncated")
})

test_that("data viewer inspection reports supported tabular metadata", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(
    sample = paste0("S", 1:12),
    reads = seq(10, 120, by = 10),
    stringsAsFactors = FALSE
  )

  result <- rho_inspect_data_object("qc", envir = workspace)
  encoded <- jsonlite::toJSON(result, auto_unbox = TRUE, null = "null")

  expect_true(result$ok)
  expect_identical(result$display_kind, "data_frame")
  expect_equal(result$dimensions, c(12L, 2L))
  expect_true(is.character(result$view_token))
  expect_identical(result$views[[1L]]$kind, "table")
  expect_lt(nchar(encoded, type = "bytes"), 1024L * 1024L)
})

test_that("data viewer pages return bounded rows and token mismatch is stale", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(
    sample = paste0("S", 1:12),
    reads = seq(10, 120, by = 10),
    stringsAsFactors = FALSE,
    row.names = paste0("cell_", 1:12)
  )
  detail <- rho_inspect_data_object("qc", envir = workspace)

  page <- rho_read_data_view(
    object_name = "qc",
    view_token = detail$view_token,
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 5L,
    column_offset = 0L,
    column_limit = 2L,
    envir = workspace
  )

  expect_true(page$ok)
  expect_equal(length(page$page$rows), 5L)
  expect_equal(length(page$page$columns), 2L)
  expect_identical(page$page$rows[[1L]]$row_name, "cell_1")
  expect_null(names(page$page$rows[[1L]]$cells))
  expect_null(names(page$page$rows[[1L]]$cell_states))
  encoded_row <- jsonlite::toJSON(
    page$page$rows[[1L]],
    auto_unbox = TRUE,
    null = "null"
  )
  expect_match(encoded_row, '"cells":\\[')
  expect_match(encoded_row, '"cell_states":\\[')
  expect_lte(page$page$payload_bytes, 1024L * 1024L)

  stale <- rho_read_data_view(
    object_name = "qc",
    view_token = "stale-token",
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 5L,
    column_offset = 0L,
    column_limit = 2L,
    envir = workspace
  )

  expect_false(stale$ok)
  expect_identical(stale$error_code, "stale_view_token")
})

test_that("data viewer searches row names and off-page cells before paging", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(
    sample = paste0("S", seq_len(80L)),
    note = c(rep("ordinary", 79L), "Hidden TARGET value"),
    row.names = c("named-target", paste0("cell_", 2:80)),
    stringsAsFactors = FALSE
  )
  detail <- rho_inspect_data_object("qc", envir = workspace)

  off_page <- rho_read_data_view(
    "qc", detail$view_token, "table", "table",
    row_offset = 0L, row_limit = 5L, query = "target", envir = workspace
  )

  expect_true(off_page$ok)
  expect_identical(off_page$page$source_total_rows, 80L)
  expect_identical(off_page$page$total_rows, 2L)
  expect_identical(off_page$page$query, "target")
  expect_equal(vapply(off_page$page$rows, `[[`, character(1), "row_name"), c("named-target", "cell_80"))

  restored <- rho_read_data_view(
    "qc", detail$view_token, "table", "table",
    row_offset = 75L, row_limit = 5L, query = "  ", envir = workspace
  )
  expect_true(restored$ok)
  expect_null(restored$page$query)
  expect_identical(restored$page$total_rows, 80L)
  expect_identical(restored$page$rows[[5L]]$row_name, "cell_80")
})

test_that("data viewer sorts filtered rows stably by absolute duplicate-name index", {
  workspace <- new.env(parent = baseenv())
  data <- data.frame(
    check.names = FALSE,
    dup = c("group", "group", "group", "other", "group"),
    dup = c(2, NA, 1, 0, 2),
    stringsAsFactors = FALSE,
    row.names = paste0("r", 1:5)
  )
  colnames(data) <- c("dup", "dup")
  workspace$dups <- data
  detail <- rho_inspect_data_object("dups", envir = workspace)

  ascending <- rho_read_data_view(
    "dups", detail$view_token, "table", "table",
    row_limit = 2L, query = "group", sort_column = 1L,
    sort_direction = "asc", envir = workspace
  )
  descending <- rho_read_data_view(
    "dups", detail$view_token, "table", "table",
    row_offset = 0L, row_limit = 4L, query = "group", sort_column = 1L,
    sort_direction = "desc", envir = workspace
  )

  expect_true(ascending$ok)
  expect_identical(ascending$page$columns[[1L]]$index, 0L)
  expect_identical(ascending$page$columns[[2L]]$index, 1L)
  expect_null(names(ascending$page$rows[[1L]]$cells))
  expect_null(names(ascending$page$rows[[1L]]$cell_states))
  expect_identical(
    unlist(ascending$page$rows[[1L]]$cells, use.names = FALSE),
    c("group", "1")
  )
  expect_equal(vapply(ascending$page$rows, `[[`, character(1), "row_name"), c("r3", "r1"))
  expect_equal(vapply(descending$page$rows, `[[`, character(1), "row_name"), c("r1", "r5", "r3", "r2"))
  expect_identical(descending$page$sort_column, 1L)
  expect_identical(descending$page$sort_direction, "desc")
})

test_that("data viewer validates query and sort without silent fallback", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(value = 1:3, nested = I(list(list(1), list(2), list(3))))
  detail <- rho_inspect_data_object("qc", envir = workspace)
  read <- function(...) rho_read_data_view(
    "qc", detail$view_token, "table", "table", envir = workspace, ...
  )

  expect_identical(read(query = paste(rep("x", 257L), collapse = ""))$error_code, "invalid_query")
  expect_identical(read(query = "line\nbreak")$error_code, "invalid_query")
  expect_identical(read(sort_column = 2L, sort_direction = "asc")$error_code, "invalid_sort")
  expect_identical(read(sort_column = 0L, sort_direction = "up")$error_code, "invalid_sort")
  expect_identical(read(sort_direction = "asc")$error_code, "invalid_sort")
  expect_identical(read(sort_column = 1L, sort_direction = "asc")$error_code, "unsupported_sort_column")

  recovered <- read(sort_column = 0L, sort_direction = "desc")
  expect_true(recovered$ok)
  expect_equal(vapply(recovered$page$rows, function(row) row$cells[[1L]], character(1)), c("3", "2", "1"))
})

test_that("data viewer enforces exact search scope and isolates environments", {
  exact <- new.env(parent = baseenv())
  exact$values <- matrix("ordinary", nrow = 50000L, ncol = 2L)
  exact$values[50000L, 2L] <- "needle"
  exact_detail <- rho_inspect_data_object("values", envir = exact)
  exact_result <- rho_read_data_view(
    "values", exact_detail$view_token, "matrix", "matrix",
    row_limit = 1L, query = "needle", envir = exact
  )
  expect_true(exact_result$ok)
  expect_identical(exact_result$page$total_rows, 1L)
  expect_identical(exact_result$page$rows[[1L]]$row_name, "50000")

  over <- new.env(parent = baseenv())
  over$values <- matrix(strrep("x", 20L), nrow = 50001L, ncol = 2L)
  over_detail <- rho_inspect_data_object("values", envir = over)
  over_result <- rho_read_data_view(
    "values", over_detail$view_token, "matrix", "matrix",
    row_limit = 1L, query = "x", envir = over
  )
  expect_false(over_result$ok)
  expect_identical(over_result$error_code, "search_scope_exceeded")
  expect_identical(over_result$supported_maximum_rows, 50000L)
  expect_identical(over_result$supported_maximum_cells, 100000L)

  isolated <- new.env(parent = baseenv())
  isolated$values <- matrix("foreign-needle", nrow = 1L)
  isolated_detail <- rho_inspect_data_object("values", envir = isolated)
  isolated_result <- rho_read_data_view(
    "values", isolated_detail$view_token, "matrix", "matrix",
    row_limit = 1L, query = "foreign", envir = isolated
  )
  expect_true(isolated_result$ok)
  expect_identical(isolated_result$page$total_rows, 1L)

  recovered <- rho_read_data_view(
    "values", over_detail$view_token, "matrix", "matrix",
    row_limit = 1L, query = NULL, envir = over
  )
  expect_true(recovered$ok)
  expect_identical(recovered$page$total_rows, 50001L)
})

test_that("data viewer supports bounded matrix pages", {
  workspace <- new.env(parent = baseenv())
  workspace$mat <- matrix(
    seq_len(12L),
    nrow = 4L,
    dimnames = list(paste0("gene_", 1:4), paste0("sample_", 1:3))
  )
  detail <- rho_inspect_data_object("mat", envir = workspace)
  page <- rho_read_data_view(
    object_name = "mat",
    view_token = detail$view_token,
    view_kind = "matrix",
    view_key = "matrix",
    row_offset = 1L,
    row_limit = 2L,
    column_offset = 1L,
    column_limit = 2L,
    envir = workspace
  )

  expect_true(detail$ok)
  expect_identical(detail$display_kind, "matrix")
  expect_true(page$ok)
  expect_identical(page$page$rows[[1L]]$row_name, "gene_2")
  expect_identical(page$page$columns[[1L]]$label, "sample_2")
})

test_that("data viewer rejects requests above supported page limits", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(sample = paste0("S", 1:4), stringsAsFactors = FALSE)
  detail <- rho_inspect_data_object("qc", envir = workspace)

  result <- rho_read_data_view(
    object_name = "qc",
    view_token = detail$view_token,
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 101L,
    column_offset = 0L,
    column_limit = 1L,
    envir = workspace
  )

  expect_false(result$ok)
  expect_identical(result$error_code, "page_limit_exceeded")
  expect_identical(result$supported_maximum, 100L)

  column_result <- rho_read_data_view(
    object_name = "qc",
    view_token = detail$view_token,
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 1L,
    column_offset = 0L,
    column_limit = 51L,
    envir = workspace
  )

  expect_false(column_result$ok)
  expect_identical(column_result$error_code, "page_limit_exceeded")
  expect_identical(column_result$supported_maximum, 50L)
})

test_that("data viewer accepts zero-dimension and exact-limit pages", {
  workspace <- new.env(parent = baseenv())
  workspace$empty <- data.frame(
    sample = character(),
    reads = numeric(),
    stringsAsFactors = FALSE
  )
  workspace$limit_mat <- matrix(
    seq_len(100L * 50L),
    nrow = 100L,
    ncol = 50L,
    dimnames = list(paste0("gene_", seq_len(100L)), paste0("sample_", seq_len(50L)))
  )

  empty_detail <- rho_inspect_data_object("empty", envir = workspace)
  empty_page <- rho_read_data_view(
    object_name = "empty",
    view_token = empty_detail$view_token,
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 0L,
    column_offset = 0L,
    column_limit = 2L,
    envir = workspace
  )
  limit_detail <- rho_inspect_data_object("limit_mat", envir = workspace)
  limit_page <- rho_read_data_view(
    object_name = "limit_mat",
    view_token = limit_detail$view_token,
    view_kind = "matrix",
    view_key = "matrix",
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 50L,
    envir = workspace
  )

  expect_true(empty_detail$ok)
  expect_true(empty_page$ok)
  expect_equal(length(empty_page$page$rows), 0L)
  expect_equal(empty_page$page$total_rows, 0L)
  expect_true(limit_detail$ok)
  expect_true(limit_page$ok)
  expect_equal(length(limit_page$page$rows), 100L)
  expect_equal(length(limit_page$page$columns), 50L)
  expect_lte(limit_page$page$payload_bytes, 1024L * 1024L)
})

test_that("data viewer truncates pages before the payload byte ceiling", {
  workspace <- new.env(parent = baseenv())
  payload <- strrep("x", 5000L)
  workspace$huge <- as.data.frame(
    replicate(50L, rep(payload, 100L), simplify = FALSE),
    stringsAsFactors = FALSE
  )
  detail <- rho_inspect_data_object("huge", envir = workspace)

  result <- rho_read_data_view(
    object_name = "huge",
    view_token = detail$view_token,
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 100L,
    column_offset = 0L,
    column_limit = 50L,
    envir = workspace
  )

  expect_true(result$ok)
  expect_true(result$page$truncated)
  expect_identical(result$page$truncation_reason, "payload_limit")
  expect_lte(result$page$payload_bytes, 1024L * 1024L)
})

test_that("unsupported S4 classes remain outside the viewer allowlist", {
  if (!methods::isClass("RhoUnsupportedViewerClass")) {
    methods::setClass("RhoUnsupportedViewerClass", slots = c(value = "numeric"))
  }
  workspace <- new.env(parent = baseenv())
  workspace$unsupported <- methods::new("RhoUnsupportedViewerClass", value = 1)

  result <- rho_inspect_data_object("unsupported", envir = workspace)

  expect_false(result$ok)
  expect_identical(result$error_code, "unsupported_object_class")
})

test_that("data viewer preserves bounded strings, list columns, missing values, unicode and duplicate names", {
  workspace <- new.env(parent = baseenv())
  names <- c("dup", "dup", "unicode", "nested")
  data <- data.frame(
    check.names = FALSE,
    dup = c(NA_character_, "plain"),
    dup = c(strrep("x", 5000L), "tail"),
    unicode = c("你好", "éclair"),
    nested = I(list(list(alpha = 1L, beta = 2L), list("z"))),
    stringsAsFactors = FALSE
  )
  colnames(data) <- names
  rownames(data) <- c("样本一", "sample_2")
  workspace$mixed <- data
  detail <- rho_inspect_data_object("mixed", envir = workspace)
  page <- rho_read_data_view(
    object_name = "mixed",
    view_token = detail$view_token,
    view_kind = "table",
    view_key = "table",
    row_offset = 0L,
    row_limit = 2L,
    column_offset = 0L,
    column_limit = 4L,
    envir = workspace
  )

  expect_true(detail$ok)
  expect_true(page$ok)
  expect_identical(page$page$columns[[1L]]$label, "dup")
  expect_identical(page$page$columns[[2L]]$label, "dup")
  expect_identical(page$page$rows[[1L]]$row_name, "样本一")
  expect_null(page$page$rows[[1L]]$cells[[1L]])
  expect_true(nchar(page$page$rows[[1L]]$cells[[2L]], type = "bytes") <= 4096L + 32L)
  expect_identical(page$page$rows[[1L]]$cells[[3L]], "你好")
  expect_match(page$page$rows[[1L]]$cells[[4L]], "alpha|List")
  expect_lte(page$page$payload_bytes, 1024L * 1024L)
})

test_that("data viewer reports column types and aligned special cell states", {
  workspace <- new.env(parent = baseenv())
  workspace$typed <- data.frame(
    logical = c(TRUE, NA, FALSE, TRUE, FALSE, TRUE),
    integer = c(1L, NA, 3L, 4L, 5L, 6L),
    double = c(1, NaN, Inf, -Inf, NA, 2),
    character = c("", NA, "plain", "x", "y", "z"),
    factor = factor(c("a", NA, "b", "a", "b", "a")),
    date = as.Date(c("2026-01-01", NA, "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06")),
    datetime = as.POSIXct(c("2026-01-01", NA, "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"), tz = "UTC"),
    complex = c(1 + 2i, NA, 3 + 4i, 5 + 0i, 6 + 1i, 7 + 2i),
    nested = I(list(list(a = 1L), NULL, list(b = 2L), list(), list(3L), list(4L))),
    check.names = FALSE,
    stringsAsFactors = FALSE
  )
  detail <- rho_inspect_data_object("typed", envir = workspace)
  page <- rho_read_data_view(
    "typed", detail$view_token, "table", "table",
    row_limit = 6L, column_limit = 9L, envir = workspace
  )

  expect_true(page$ok)
  expect_equal(
    vapply(page$page$columns, `[[`, character(1), "type"),
    c("logical", "integer", "double", "character", "factor", "date", "datetime", "complex", "list")
  )
  expect_identical(page$page$columns[[3L]]$page_missing_count, 2L)
  expect_identical(unlist(page$page$columns[[5L]]$classes), "factor")
  expect_identical(page$page$rows[[1L]]$cell_states[[4L]], "empty")
  expect_identical(page$page$rows[[1L]]$cells[[4L]], "")
  expect_identical(page$page$rows[[2L]]$cell_states[[1L]], "na")
  expect_null(page$page$rows[[2L]]$cells[[1L]])
  expect_identical(page$page$rows[[2L]]$cell_states[[3L]], "nan")
  expect_identical(page$page$rows[[2L]]$cells[[3L]], "NaN")
  expect_identical(page$page$rows[[3L]]$cell_states[[3L]], "pos_inf")
  expect_identical(page$page$rows[[3L]]$cells[[3L]], "Inf")
  expect_identical(page$page$rows[[4L]]$cell_states[[3L]], "neg_inf")
  expect_identical(page$page$rows[[4L]]$cells[[3L]], "-Inf")
  expect_identical(page$page$rows[[2L]]$cell_states[[9L]], "na")

  filtered <- rho_read_data_view(
    "typed", detail$view_token, "table", "table",
    row_limit = 6L, column_limit = 9L, query = "nan", envir = workspace
  )
  expect_true(filtered$ok)
  expect_identical(filtered$page$total_rows, 1L)
  expect_identical(filtered$page$columns[[3L]]$page_missing_count, 1L)
  expect_identical(filtered$page$rows[[1L]]$cell_states[[3L]], "nan")
})

test_that("data viewer reports optional package unavailability explicitly", {
  workspace <- new.env(parent = baseenv())
  workspace$qc <- data.frame(sample = "S1", stringsAsFactors = FALSE)
  local_mocked_bindings(
    rho_viewer_missing_dependency = function(classes) "SingleCellExperiment",
    .package = "rho.bridge"
  )

  result <- rho_inspect_data_object("qc", envir = workspace)

  expect_false(result$ok)
  expect_identical(result$error_code, "optional_package_unavailable")
})

test_that("bioconductor fixture metadata records portable build provenance", {
  metadata <- jsonlite::fromJSON(
    testthat::test_path("../fixtures/wp2-bioconductor-fixtures.json"),
    simplifyVector = FALSE
  )

  expect_equal(length(metadata), 2L)
  expect_identical(
    vapply(metadata, `[[`, character(1), "fixture_name"),
    c("summarized-experiment-minimal", "single-cell-experiment-minimal")
  )
  expect_identical(
    vapply(metadata, `[[`, character(1), "class"),
    c("SummarizedExperiment", "SingleCellExperiment")
  )
  for (entry in metadata) {
    expect_match(entry$bioconductor_version, "^[0-9]+\\.[0-9]+$")
    expect_setequal(names(entry$packages), c("SummarizedExperiment", "SingleCellExperiment"))
    expect_true(all(vapply(entry$packages, function(version) {
      is.character(version) && length(version) == 1L && grepl("^[0-9]+(\\.[0-9]+)+$", version)
    }, logical(1))))
  }
})

test_that("summarized experiment fixture exposes assays and annotations through the viewer", {
  skip_if_not_installed("SummarizedExperiment")
  workspace <- new.env(parent = baseenv())
  workspace$se <- readRDS(testthat::test_path("../fixtures/summarized-experiment-minimal.rds"))

  detail <- rho_inspect_data_object("se", envir = workspace)
  page <- rho_read_data_view(
    object_name = "se",
    view_token = detail$view_token,
    view_kind = "assay",
    view_key = "counts",
    row_offset = 0L,
    row_limit = 4L,
    column_offset = 0L,
    column_limit = 3L,
    envir = workspace
  )

  expect_true(detail$ok)
  expect_identical(detail$display_kind, "summarized_experiment")
  expect_true(any(vapply(detail$views, function(item) identical(item$key, "rowData"), logical(1))))
  expect_true(page$ok)
  expect_equal(page$page$total_rows, 4L)
  expect_equal(page$page$total_columns, 3L)
  expect_identical(page$page$rows[[1L]]$cells[[1L]], "10")
  expect_lte(jsonlite::serializeJSON(detail) |> nchar(type = "bytes"), 1024L * 1024L)
  expect_lte(page$page$payload_bytes, 1024L * 1024L)
})

test_that("single cell experiment fixture exposes assay pages through the viewer", {
  skip_if_not_installed("SingleCellExperiment")
  workspace <- new.env(parent = baseenv())
  workspace$sce <- readRDS(testthat::test_path("../fixtures/single-cell-experiment-minimal.rds"))

  detail <- rho_inspect_data_object("sce", envir = workspace)
  page <- rho_read_data_view(
    object_name = "sce",
    view_token = detail$view_token,
    view_kind = "col_data",
    view_key = "colData",
    row_offset = 0L,
    row_limit = 3L,
    column_offset = 0L,
    column_limit = 2L,
    envir = workspace
  )

  expect_true(detail$ok)
  expect_identical(detail$display_kind, "single_cell_experiment")
  expect_true(page$ok)
  expect_identical(page$page$rows[[1L]]$row_name, "cell_1")
  expect_identical(page$page$rows[[1L]]$cells[[1L]], "A")
  expect_lte(jsonlite::serializeJSON(detail) |> nchar(type = "bytes"), 1024L * 1024L)
  expect_lte(page$page$payload_bytes, 1024L * 1024L)
})

test_that("render probe degrades cleanly when tooling is unavailable", {
  file <- tempfile(fileext = ".qmd")
  writeLines("---\ntitle: Test\n---\n\nHello", file)
  result <- rho_render_document(file)

  expect_true(is.list(result$capability))
  if (isTRUE(result$capability$can_render_qmd)) {
    expect_true(isTRUE(result$ok) || !is.null(result$error))
  } else {
    expect_false(result$ok)
    expect_equal(result$error$phase, "capability")
  }
})
