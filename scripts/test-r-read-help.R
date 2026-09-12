# A real read-only help query must preserve R state and exact file identities.
stopifnot(requireNamespace("tools", quietly=TRUE), requireNamespace("jsonlite", quietly=TRUE), requireNamespace("rlang", quietly=TRUE))
bridge <- new.env(parent=asNamespace("utils")); bridge$can_inspect_bindings <- TRUE
for (file in c("packages.R", "objects.R", "package-index.R", "tools.R", "dispatch.R")) sys.source(file.path("r/bridge",file),bridge)
local({
  text <- "A中文😀éZ"; offset <- 0; pages <- character()
  repeat {
    page <- bridge$rho_help_text_page(text,offset,4L)
    stopifnot(validUTF8(page$text),nchar(page$text,type="bytes")<=4L)
    pages <- c(pages,page$text)
    if (page$complete) break
    stopifnot(page$next_offset_utf8>offset);offset <- page$next_offset_utf8
  }
  stopifnot(identical(paste0(pages,collapse=""),text))
  bad <- tryCatch(bridge$rho_help_text_page(text,2L,4L),error=identity)
  stopifnot(inherits(bad,"error"),grepl("UTF-8 boundary",conditionMessage(bad),fixed=TRUE))
})
local({
  scope <- list(project="read-help-test",principal="local",session="native")
  inventory <- bridge$rho_packages(list(mode="installed",filter="",limit=200L,offset=0L,grouped=FALSE,package_name="base",observation_id=NULL))
  copy <- inventory$packages[[1L]]
  arguments <- list(expected_session="native",observation_id=inventory$observation_id,package="base",library_path=copy$library_path,
                    topic="mean",expected_index_files=bridge$rho_package_index_files(file.path(copy$library_path,"base")),
                    expected_help_files=NULL,offset_utf8=0L,limit_bytes=64L,scope=scope)
  namespaces <- sort(loadedNamespaces()); attached <- search(); settings <- options(); bindings <- ls(.GlobalEnv,all.names=TRUE)
  serial <- bridge$rho_object_state$serial
  pages <- character(); previous <- -1
  repeat {
    response <- bridge$rho_dispatch(list(protocol_version=1L,request_id="read-help",action="read_help",payload=arguments))
    stopifnot(response$outcome=="succeeded")
    page <- response$value
    stopifnot(page$found, nchar(page$text,type="bytes")<=64L, validUTF8(page$text), page$offset_utf8>previous)
    previous <- page$offset_utf8; pages <- c(pages,page$text)
    if (is.null(page$next_offset_utf8)) break
    arguments$offset_utf8 <- page$next_offset_utf8; arguments$expected_help_files <- page$help_files
  }
  text <- paste0(pages,collapse="")
  stopifnot(grepl("Arithmetic Mean",text,fixed=TRUE),nchar(text,type="bytes")==page$total_bytes,
            identical(namespaces,sort(loadedNamespaces())),identical(attached,search()),identical(settings,options()),
            identical(bindings,ls(.GlobalEnv,all.names=TRUE)),identical(serial,bridge$rho_object_state$serial))
  arguments$expected_help_files[[1L]]$digest <- "changed"
  response <- bridge$rho_dispatch(list(protocol_version=1L,request_id="changed",action="read_help",payload=arguments))
  stopifnot(response$outcome=="failed",response$value$query_error$code=="content_changed")
  arguments$offset_utf8 <- 0L;arguments$expected_help_files <- NULL;arguments$topic <- "missing-rho-help-topic"
  response <- bridge$rho_dispatch(list(protocol_version=1L,request_id="absent",action="read_help",payload=arguments))
  stopifnot(response$outcome=="succeeded",!response$value$found,response$value$complete,response$value$text=="")
  event <- base::packageEvent("tools","onLoad"); old <- base::getHook(event); loads <- 0L
  base::setHook(event,function(...)loads <<- loads+1L,action="append")
  on.exit(base::setHook(event,old,action="replace"),add=TRUE)
  base::unloadNamespace("tools")
  before <- sort(loadedNamespaces())
  response <- bridge$rho_dispatch(list(protocol_version=1L,request_id="provider-absent",action="read_help",payload=arguments))
  stopifnot(response$outcome=="failed",response$value$query_error$code=="unavailable",loads==0L,
            is.null(base::.Internal(getRegisteredNamespace("tools"))),identical(before,sort(loadedNamespaces())))
})
cat("Read-only exact-copy help preserves namespaces, search/options/bindings and observation handles; paging and changed/missing evidence checks passed.\n")
