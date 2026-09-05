# Native ps identities survive processx/callr creating a new session. This is
# cleanup of cooperative child processes, not containment of hostile code.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L, requireNamespace("ps", quietly = TRUE))
if (identical(args[[1L]], "mark")) {
  writeLines(ps::ps_mark_tree(), args[[2L]])
} else if (identical(args[[1L]], "cleanup")) {
  marker <- args[[2L]]
  handles <- ps::ps_find_tree(marker)
  killed <- ps::ps_kill_tree(marker)
  if (length(handles)) ps::ps_wait(handles, timeout = 3000L)
  remaining <- Filter(function(handle) {
    tryCatch(ps::ps_is_running(handle) && !ps::ps_status(handle) %in% c("zombie", "dead"),
             error = function(error) {
               if (ps::ps_is_running(handle)) stop(error)
               FALSE
             })
  }, ps::ps_find_tree(marker))
  if (length(remaining)) stop("marked descendants are still running")
  cat("Stopped marked processes:", paste(unname(killed), collapse = ","), "\n")
} else {
  stop("unsupported process-tree action")
}
