\name{rho-agent-api}
\alias{rho_agent_connect}
\alias{rho_agent_emit}
\alias{rho_agent_request}
\alias{rho_agent_set_workspace_identity}
\alias{rho_create_aisdk_hooks}
\alias{rho_create_aisdk_session}
\alias{rho_create_workspace_tools}
\alias{rho_read_frame}
\alias{rho_run_aisdk_turn}
\alias{rho_write_frame}
\title{Internal Agent Process Entry Points}
\usage{
rho_agent_connect(host = "127.0.0.1", port, token)

rho_agent_emit(type, payload = list(), connection = .rho_agent_state$connection)

rho_agent_request(type, payload = list(), connection = .rho_agent_state$connection)

rho_agent_set_workspace_identity(identity)

rho_create_aisdk_hooks(connection = .rho_agent_state$connection)

rho_create_aisdk_session(
  model,
  system_prompt = NULL,
  tools = rho_create_workspace_tools(),
  max_steps = 512L,
  capability_models = list(),
  connection = .rho_agent_state$connection
)

rho_create_workspace_tools(plugin_tools = list())

rho_read_frame(connection)

rho_run_aisdk_turn(session, prompt, connection = .rho_agent_state$connection)

rho_write_frame(connection, message)
}
\description{
Framed transport helpers and aisdk integration points used by the Rho desktop
broker to communicate with the separate Agent R process.
}
\details{
These exports exist so the desktop launcher, broker, and automated tests can
bootstrap the Agent R subprocess through a stable interface. They are internal
process plumbing rather than a user-facing package API.
}
\keyword{internal}
