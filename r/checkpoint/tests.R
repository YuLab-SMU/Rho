bridge <- new.env(parent = baseenv())
sys.source("r/bridge/checkpoint.R", bridge)
bridge$rho_checkpoint_initialize(Sys.getenv("RHO_CHECKPOINT_TEST_LIBRARY"))
local({
  scope <- new.env(parent = emptyenv())
  shared <- new.env(parent = emptyenv()); shared$value <- 5L; shared$self <- shared
  scope$one <- shared; scope$two <- shared
  scope$data <- data.frame(x = 1:10, y = rep("hello", 10))
  scope$unicode <- c("你好", NA_character_, "α")
  counter <- 0L
  makeActiveBinding("active", function() { counter <<- counter + 1L; 1L }, scope)
  delayedAssign("lazy", { counter <<- counter + 1L; 42L }, assign.env = scope)
  unsafe <- new.env(parent = emptyenv())
  makeActiveBinding("nested", function() { counter <<- counter + 1L; 1L }, unsafe)
  scope$unsafe <- list(unsafe)
  scope$foreign <- new("externalptr")
  scope$deferred <- as.character(1:10)
  scan <- .Call(bridge$rho_checkpoint_provider$roots, scope, 1024^2, 10, NULL)
  names <- scan[[1L]]; keep <- scan[[3L]]
  stopifnot(counter == 0L, all(c("one", "two", "data", "unicode") %in% names[keep]),
            all(c("active", "lazy", "unsafe", "foreign", "deferred") %in% names[!keep]))
  alias_scope <- new.env(parent=emptyenv())
  alias_scope$a <- new.env(parent=emptyenv()); alias_scope$a$raw <- raw(100)
  alias_scope$b <- alias_scope$a
  alias_scan <- .Call(bridge$rho_checkpoint_provider$roots,alias_scope,300,10,NULL)
  stopifnot(all(alias_scan[[3L]]))
  file <- tempfile()
  values <- scan[[2L]][keep]
  .Call(bridge$rho_checkpoint_provider$write, values, file, 1024^2, 10)
  restored <- readRDS(file)
  stopifnot(identical(restored$one, restored$two), identical(restored$one, restored$one$self),
            identical(restored$data, scope$data), identical(restored$unicode, scope$unicode), counter == 0L)
  unlink(file)
  too_small <- tempfile()
  rejected <- try(.Call(bridge$rho_checkpoint_provider$write, values, too_small, 16, 10), silent=TRUE)
  stopifnot(inherits(rejected,"try-error"))
  unlink(too_small)
  cat("PASS: shared roots, cycles, compact sequences, Unicode, passive binding exclusions, unknown ALTREP, byte limit\n")
})
