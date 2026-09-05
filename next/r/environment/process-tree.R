# Native ps identities survive processx/callr creating a new session. This is
# cleanup of cooperative child processes, not containment of hostile code.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) %in% c(2L, 3L), requireNamespace("ps", quietly = TRUE))
if (identical(args[[1L]], "mark")) {
  writeLines(ps::ps_mark_tree(), args[[2L]])
} else if (args[[1L]] %in% c("cleanup", "inspect")) {
  stopifnot(length(args) == 3L)
  marker <- args[[2L]]
  live <- function(handle) {
    tryCatch(ps::ps_is_running(handle) && !ps::ps_status(handle) %in% c("zombie", "dead"),
             error = function(error) {
               if (ps::ps_is_running(handle)) stop(error)
               FALSE
             })
  }
  handles <- ps::ps_find_tree(marker)
  # Check the operation tag before sending any signal, including when a saved
  # marker file was copied or damaged. Native ps handles also check process age.
  for (handle in handles) {
    if (nzchar(args[[3L]]) && live(handle)) {
      env <- tryCatch(ps::ps_environ(handle), error = function(error) {
        if (live(handle)) stop(error)
        NULL
      })
      if (is.null(env)) next
      if (!"RHO_OPERATION_ID" %in% names(env) || !identical(unname(env[["RHO_OPERATION_ID"]]), args[[3L]])) {
        if (live(handle)) stop("process-tree operation identity mismatch")
      }
    }
  }
  killed <- integer()
  if (identical(args[[1L]], "cleanup")) {
    killed <- ps::ps_kill_tree(marker)
    if (length(handles)) ps::ps_wait(handles, timeout = 3000L)
  }
  remaining <- Filter(live, ps::ps_find_tree(marker))
  if (identical(args[[1L]], "cleanup") && length(remaining)) stop("marked descendants are still running")
  cat(jsonlite::toJSON(list(stopped_pids = unname(as.list(killed)), remaining_pids = unname(lapply(remaining, ps::ps_pid))), auto_unbox = TRUE))
} else {
  stop("unsupported process-tree action")
}
