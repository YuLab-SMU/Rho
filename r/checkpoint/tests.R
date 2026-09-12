bridge <- new.env(parent = baseenv())
sys.source("r/bridge/checkpoint.R", bridge)
bridge$rho_checkpoint_initialize(Sys.getenv("RHO_CHECKPOINT_TEST_LIBRARY"))
local({
  fixture <- dyn.load(Sys.getenv("RHO_CHECKPOINT_ALTREP_FIXTURE"))
  make_fixture <- getNativeSymbolInfo("make_fixture",fixture)$address
  access_count <- getNativeSymbolInfo("access_count",fixture)$address
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
  scope$unknown <- .Call(make_fixture)
  scope$nested_unknown <- list(value=scope$unknown)
  .Call(access_count,TRUE)
  scan <- .Call(bridge$rho_checkpoint_provider$roots, scope, 1024^2, 10, NULL)
  names <- scan[[1L]]; keep <- scan[[3L]]
  stopifnot(counter == 0L, .Call(access_count,FALSE) == 0L,
            all(c("one", "two", "data", "unicode", "deferred") %in% names[keep]),
            all(c("active", "lazy", "unsafe", "foreign", "unknown", "nested_unknown") %in% names[!keep]),
            all(scan[[4L]][names %in% c("unknown","nested_unknown")] == "unknown_altrep_provider"))
  alias_scope <- new.env(parent=emptyenv())
  alias_scope$a <- new.env(parent=emptyenv()); alias_scope$a$raw <- raw(100)
  alias_scope$b <- alias_scope$a
  alias_scan <- .Call(bridge$rho_checkpoint_provider$roots,alias_scope,300,10,NULL)
  stopifnot(all(alias_scan[[3L]]))
  file <- tempfile("检查点-α-")
  values <- scan[[2L]][keep]
  .Call(bridge$rho_checkpoint_provider$write, values, file, 1024^2, 10)
  restored <- readRDS(file)
  stopifnot(identical(restored$one, restored$two), identical(restored$one, restored$one$self),
            identical(restored$data, scope$data), identical(restored$unicode, scope$unicode),
            identical(restored$deferred, as.character(seq_len(10))), counter == 0L,
            .Call(access_count,FALSE) == 0L)
  unlink(file)
  too_small <- tempfile()
  rejected <- try(.Call(bridge$rho_checkpoint_provider$write, values, too_small, 16, 10), silent=TRUE)
  stopifnot(inherits(rejected,"try-error"))
  unlink(too_small)
  repeated <- new.env(parent=emptyenv());repeated$text <- rep("same",200000)
  repeated_scan <- .Call(bridge$rho_checkpoint_provider$roots,repeated,4*1024^2,2,NULL)
  stopifnot(all(repeated_scan[[3L]]))
  original_inventory <- bridge$rho_checkpoint_inventory
  bridge$rho_checkpoint_inventory <- function() {Sys.sleep(0.11);"fixture-inventory"}
  fractional_path <- tempfile("fractional-budget-")
  fractional <- try(bridge$rho_checkpoint_capture(list(path=fractional_path,project_root=getwd(),max_bytes=1024^2,max_seconds=0.1,include_names=NULL,exclude_names=list(),include_patterns=list(),exclude_patterns=list())),silent=TRUE)
  bridge$rho_checkpoint_inventory <- original_inventory
  stopifnot(inherits(fractional,"try-error"),grepl("time budget",as.character(fractional),fixed=TRUE),!file.exists(fractional_path))
  cat("PASS: fractional 0.1 second budget includes metadata observation; no artifact published after exhaustion\n")
  cat("PASS: shared roots, cycles, compact sequences, Unicode, passive binding exclusions, unknown ALTREP, byte limit\n")
})
