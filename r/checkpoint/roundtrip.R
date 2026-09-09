# Each phase runs in a distinct --vanilla process; no live user session is used.
local({
  bridge <- new.env(parent=baseenv())
  sys.source("r/bridge/checkpoint.R",bridge)
  bridge$rho_checkpoint_initialize(Sys.getenv("RHO_CHECKPOINT_TEST_LIBRARY"))
  directory <- Sys.getenv("RHO_CHECKPOINT_FIXTURE_DIRECTORY")
  payload <- file.path(directory,"objects.rds")
  if (identical(Sys.getenv("RHO_CHECKPOINT_FIXTURE_PHASE"),"capture")) {
    shared <- new.env(parent=emptyenv()); shared$value <- 12L; shared$self <- shared
    assign("shared1",shared,.GlobalEnv);assign("shared2",shared,.GlobalEnv)
    assign("table",data.frame(x=1:30,y=rep("α你好",30)),.GlobalEnv)
    assign(".hidden",c(NA_real_,NaN,Inf,-Inf),.GlobalEnv)
    assign("f",eval(quote(function() shared1$value),.GlobalEnv),.GlobalEnv)
    report <- bridge$rho_checkpoint_capture(list(path=payload,max_bytes=1024^2,max_seconds=10,include_names=NULL,exclude_names=list()))
    stopifnot(identical(report$coverage,"complete_eligible_graph"),length(report$skipped)==0L)
    jsonlite::write_json(report,file.path(directory,"manifest.json"),auto_unbox=TRUE)
    cat("PASS: whole native global graph captured\n")
  } else {
    report <- jsonlite::fromJSON(file.path(directory,"manifest.json"),simplifyVector=FALSE)
    request <- c(report,list(path=payload,max_bytes=1024^2))
    bad <- request;bad$package_inventory_digest <- "incorrect"
    stopifnot(inherits(try(bridge$rho_checkpoint_restore(bad),silent=TRUE),"try-error"),length(ls(.GlobalEnv,all.names=TRUE))==0L)
    result <- bridge$rho_checkpoint_restore(request)
    stopifnot(identical(get("shared1",.GlobalEnv),get("shared2",.GlobalEnv)),
              identical(get("shared1",.GlobalEnv),get("shared1",.GlobalEnv)$self),
              get("f",.GlobalEnv)()==12L,nrow(get("table",.GlobalEnv))==30L,
              identical(get(".hidden",.GlobalEnv),c(NA_real_,NaN,Inf,-Inf)))
    stopifnot(inherits(try(bridge$rho_checkpoint_restore(request),silent=TRUE),"try-error"),get("f",.GlobalEnv)()==12L)
    cat("PASS: cold restore preserves shared roots/global closures/Unicode/hidden values, rejects mismatch and nonempty target\n")
  }
})
