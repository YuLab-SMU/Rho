\name{rho-bridge-api}
\alias{rho_execute}
\alias{rho_environment_evidence}
\alias{rho_get_last_execution}
\alias{rho_inspect_data_object}
\alias{rho_inspect_object}
\alias{rho_list_objects}
\alias{rho_read_data_view}
\alias{rho_workspace_snapshot}
\title{Internal Workspace Bridge Entry Points}
\usage{
rho_execute(code, envir = .GlobalEnv, max_output_chars = 16000L)

rho_environment_evidence(project_dir = getwd(), package_limit = 10000L)

rho_get_last_execution()

rho_inspect_data_object(object_name, envir = .GlobalEnv)

rho_inspect_object(
  name,
  envir = .GlobalEnv,
  max_chars = 4000L,
  max_level = 2L,
  max_rows = 8L,
  max_cols = 8L,
  max_items = 12L
)

rho_list_objects(envir = .GlobalEnv, limit = 200L)

rho_read_data_view(
  object_name,
  view_token,
  view_kind,
  view_key,
  row_offset = 0L,
  row_limit = 50L,
  column_offset = 0L,
  column_limit = 20L,
  query = NULL,
  sort_column = NULL,
  sort_direction = NULL,
  envir = .GlobalEnv
)

rho_workspace_snapshot(envir = .GlobalEnv, object_limit = 200L)
}
\description{
Bounded bridge functions used by the Rho broker to inspect the authoritative
Workspace R session, capture read-only environment evidence, and serve paged
data viewer requests.
}
\details{
These exported functions form the desktop-to-workspace contract for the local
R session. They are exported for broker loading and automated verification, not
as a general end-user API.
}
\keyword{internal}
