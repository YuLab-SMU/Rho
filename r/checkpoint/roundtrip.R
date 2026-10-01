# Each phase runs in a distinct --vanilla process; no live user session is used.
local({
  bridge <- new.env(parent=baseenv())
  sys.source("plugins/r/backend/engine/r/bridge/checkpoint.R",bridge)
  bridge$rho_checkpoint_initialize(Sys.getenv("RHO_CHECKPOINT_TEST_LIBRARY"))
  directory <- Sys.getenv("RHO_CHECKPOINT_FIXTURE_DIRECTORY")
  payload <- file.path(directory,"objects.rds")
  if (identical(Sys.getenv("RHO_CHECKPOINT_FIXTURE_PHASE"),"capture")) {
    shared <- new.env(parent=emptyenv()); shared$value <- 12L; shared$self <- shared
    assign("shared1",shared,.GlobalEnv);assign("shared2",shared,.GlobalEnv)
    assign("table",data.frame(x=1:30,y=rep("α你好",30)),.GlobalEnv)
    assign(".hidden",c(NA_real_,NaN,Inf,-Inf),.GlobalEnv)
    assign("f",eval(quote(function() shared1$value),.GlobalEnv),.GlobalEnv)
    set.seed(20260909L);assign("rng_expected",runif(3),.GlobalEnv);set.seed(20260909L)
    assign("rho_user_result",42L,.GlobalEnv)
    assign("linear_model",eval(quote(lm(mpg~wt,data=mtcars)),.GlobalEnv),.GlobalEnv)
    assign("general_model",eval(quote(glm(vs~mpg,data=mtcars,family=binomial())),.GlobalEnv),.GlobalEnv)
    assign("factor_samples",data.frame(id=1:24,condition=rep(c("control","treated"),each=12),value=c(seq(4.0,6.2,by=0.2),seq(6.4,8.6,by=0.2))),.GlobalEnv)
    assign("factor_lm",eval(quote(lm(value~condition,data=factor_samples)),.GlobalEnv),.GlobalEnv)
    assign("factor_glm",eval(quote(glm(value~condition,data=transform(factor_samples,condition=factor(condition)),family=gaussian())),.GlobalEnv),.GlobalEnv)
    assign("expected_lm",unname(predict(get("linear_model",.GlobalEnv))),.GlobalEnv)
    assign("expected_glm",unname(predict(get("general_model",.GlobalEnv),type="response")),.GlobalEnv)
    assign("expected_factor_lm",unname(predict(get("factor_lm",.GlobalEnv))),.GlobalEnv)
    assign("expected_factor_glm",unname(predict(get("factor_glm",.GlobalEnv),type="response")),.GlobalEnv)
    assign("promise_hits",0L,.GlobalEnv)
    lazy_box <- new.env(parent=baseenv())
    delayedAssign("later",{assign("promise_hits",get("promise_hits",.GlobalEnv)+1L,.GlobalEnv);42L},eval.env=new.env(parent=baseenv()),assign.env=lazy_box)
    assign("lazy_box",lazy_box,.GlobalEnv)
    assign("factor_value",factor(c("low","high",NA),levels=c("low","high","unused")),.GlobalEnv)
    assign("time_value",as.POSIXct(c("2020-01-01 10:00:00","2021-06-01 12:00:00"),tz="America/New_York"),.GlobalEnv)
    if (requireNamespace("Matrix",quietly=TRUE)) assign("sparse_matrix",Matrix::sparseMatrix(i=c(1,2),j=c(1,3),x=c(2,4),dims=c(3,4)),.GlobalEnv)
    if (requireNamespace("SingleCellExperiment",quietly=TRUE)) assign("sce",SingleCellExperiment::SingleCellExperiment(assays=list(counts=matrix(1:6,2))),.GlobalEnv)
    if (requireNamespace("ape",quietly=TRUE)) assign("tree",ape::read.tree(text="((a:1,b:1):1,c:2);"),.GlobalEnv)
    options(digits=12L,width=101L,scipen=5L,OutDec=",",warn=1L)
    report <- bridge$rho_checkpoint_capture(list(path=payload,project_root=getwd(),max_bytes=1024^2,max_seconds=10,include_names=NULL,exclude_names=list()))
    stopifnot(get("promise_hits",.GlobalEnv)==0L)
    if(length(report$skipped)) print(report$skipped)
    stopifnot(identical(report$coverage,"complete_eligible_graph"),length(report$skipped)==0L)
    jsonlite::write_json(report,file.path(directory,"manifest.json"),auto_unbox=TRUE)
    cat("PASS: whole native global graph captured\n")
  } else {
    report <- jsonlite::fromJSON(file.path(directory,"manifest.json"),simplifyVector=FALSE)
    request <- c(report,list(path=payload,project_root=getwd(),max_bytes=1024^2))
    bad <- request;bad$package_inventory_digest <- "incorrect"
    stopifnot(inherits(try(bridge$rho_checkpoint_restore(bad),silent=TRUE),"try-error"),length(ls(.GlobalEnv,all.names=TRUE))==0L)
    before_namespaces <- loadedNamespaces()
    result <- bridge$rho_checkpoint_restore(request)
    added_namespaces <- setdiff(loadedNamespaces(),before_namespaces)
    stopifnot(setequal(unlist(result$initialized_namespaces,use.names=FALSE),added_namespaces))
    if(length(added_namespaces)) cat("Recorded package preparation: ",paste(added_namespaces,collapse=", "),"\n",sep="")
    stopifnot(identical(get("shared1",.GlobalEnv),get("shared2",.GlobalEnv)),
              identical(get("shared1",.GlobalEnv),get("shared1",.GlobalEnv)$self),
              get("f",.GlobalEnv)()==12L,identical(runif(3),get("rng_expected",.GlobalEnv)),get("rho_user_result",.GlobalEnv)==42L,getOption("digits")==12L,getOption("width")==101L,identical(getOption("OutDec"),","),nrow(get("table",.GlobalEnv))==30L,
              identical(get(".hidden",.GlobalEnv),c(NA_real_,NaN,Inf,-Inf)))
    stopifnot(inherits(try(bridge$rho_checkpoint_restore(request),silent=TRUE),"try-error"),get("f",.GlobalEnv)()==12L)
    stopifnot(get("promise_hits",.GlobalEnv)==0L)
    stopifnot(get("lazy_box",.GlobalEnv)$later==42L,get("promise_hits",.GlobalEnv)==1L)
    stopifnot(identical(unname(predict(get("linear_model",.GlobalEnv))),get("expected_lm",.GlobalEnv)),identical(unname(predict(get("general_model",.GlobalEnv),type="response")),get("expected_glm",.GlobalEnv)))
    stopifnot(identical(unname(predict(get("factor_lm",.GlobalEnv))),get("expected_factor_lm",.GlobalEnv)),
              identical(unname(predict(get("factor_glm",.GlobalEnv),type="response")),get("expected_factor_glm",.GlobalEnv)),
              inherits(get("factor_lm",.GlobalEnv),"lm"),inherits(get("factor_glm",.GlobalEnv),"glm"),
              identical(get("factor_lm",.GlobalEnv)$xlevels$condition,c("control","treated")),
              is.factor(get("factor_glm",.GlobalEnv)$model$condition),
              identical(get("factor_samples",.GlobalEnv)$condition,rep(c("control","treated"),each=12)))
    stopifnot(inherits(get("linear_model",.GlobalEnv),"lm"),inherits(get("general_model",.GlobalEnv),"glm"),identical(levels(get("factor_value",.GlobalEnv)),c("low","high","unused")),identical(attr(get("time_value",.GlobalEnv),"tzone"),"America/New_York"))
    if(exists("sparse_matrix",.GlobalEnv,inherits=FALSE)) {
      expected_sparse <- matrix(0,3,4);expected_sparse[1,1]<-2;expected_sparse[2,3]<-4
      stopifnot(identical(as.matrix(get("sparse_matrix",.GlobalEnv)),expected_sparse))
    }
    if(exists("sce",.GlobalEnv,inherits=FALSE)) stopifnot(identical(SummarizedExperiment::assay(get("sce",.GlobalEnv),"counts"),matrix(1:6,2)))
    if(exists("tree",.GlobalEnv,inherits=FALSE)) stopifnot(inherits(get("tree",.GlobalEnv),"phylo"))
    cat("PASS: cold restore preserves graph aliases, numeric/factor-predictor lm/glm predictions, sparse/SCE values, factors/time, RNG/options, Unicode/hidden values and nested promises; mismatches/nonempty target rejected\n")
  }
})
