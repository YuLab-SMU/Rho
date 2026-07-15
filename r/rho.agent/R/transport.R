.rho_agent_state <- new.env(parent = emptyenv())
.rho_agent_state$connection <- NULL
.rho_agent_state$protocol_version <- 1L
.rho_agent_state$max_frame_bytes <- 8L * 1024L * 1024L

read_exact <- function(connection, length) {
  output <- raw()
  while (length(output) < length) {
    chunk <- readBin(connection, what = "raw", n = length - length(output))
    if (!length(chunk)) {
      stop("Agent transport closed before a complete frame was received.", call. = FALSE)
    }
    output <- c(output, chunk)
  }
  output
}

#' Write One Length-prefixed Agent Protocol Frame
#' @export
rho_write_frame <- function(connection, message) {
  payload <- charToRaw(jsonlite::toJSON(
    message,
    auto_unbox = TRUE,
    null = "null",
    digits = NA
  ))
  if (length(payload) > .rho_agent_state$max_frame_bytes) {
    stop("Agent protocol frame exceeds the configured maximum.", call. = FALSE)
  }
  writeBin(as.integer(length(payload)), connection, size = 4L, endian = "big")
  writeBin(payload, connection)
  flush(connection)
  invisible(message)
}

#' Read One Length-prefixed Agent Protocol Frame
#' @export
rho_read_frame <- function(connection) {
  length_raw <- read_exact(connection, 4L)
  length_connection <- rawConnection(length_raw, open = "rb")
  on.exit(close(length_connection), add = TRUE)
  size <- readBin(length_connection, integer(), n = 1L, size = 4L, endian = "big")
  if (!length(size) || size < 0L || size > .rho_agent_state$max_frame_bytes) {
    stop("Invalid Agent protocol frame length.", call. = FALSE)
  }
  payload <- read_exact(connection, size)
  jsonlite::fromJSON(rawToChar(payload), simplifyVector = FALSE)
}

#' Connect Agent R to the Broker
#' @export
rho_agent_connect <- function(host = "127.0.0.1", port, token) {
  stopifnot(is.numeric(port), length(port) == 1L)
  stopifnot(is.character(token), length(token) == 1L, nzchar(token))
  connection <- socketConnection(
    host = host,
    port = as.integer(port),
    server = FALSE,
    blocking = TRUE,
    open = "r+b",
    timeout = 30
  )
  auth <- list(
    protocol_version = .rho_agent_state$protocol_version,
    id = paste0("auth_", as.integer(Sys.time()), "_", Sys.getpid()),
    kind = "request",
    timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3%z"),
    payload = list(type = "authenticate", token = token)
  )
  rho_write_frame(connection, auth)
  response <- rho_read_frame(connection)
  if (!identical(response$kind, "response") ||
      !identical(response$payload$type, "authenticated") ||
      !identical(response$payload$request_id, auth$id)) {
    close(connection)
    stop("Agent R authentication was not acknowledged by the broker.", call. = FALSE)
  }
  .rho_agent_state$connection <- connection
  invisible(connection)
}

#' Emit a Structured Agent Event
#' @export
rho_agent_emit <- function(type, payload = list(), connection = .rho_agent_state$connection) {
  if (is.null(connection)) {
    stop("Agent R is not connected to the Rho broker.", call. = FALSE)
  }
  message <- list(
    protocol_version = .rho_agent_state$protocol_version,
    id = paste0("evt_", as.integer(Sys.time()), "_", sample.int(.Machine$integer.max, 1L)),
    kind = "event",
    timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%OS3%z"),
    payload = c(list(type = type), payload)
  )
  rho_write_frame(connection, message)
}
