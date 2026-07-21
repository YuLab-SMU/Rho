# ADR-003: Agent R transport

## Status

Accepted for Phase 0 validation.

## Decision

The broker binds an ephemeral loopback TCP listener and supplies Agent R with a single-use 256-bit token through stdin. Agent R connects outward and authenticates in its first length-prefixed JSON frame. The token is invalidated after one successful connection.

Protocol frames use a four-byte unsigned big-endian payload length followed by UTF-8 JSON. Stdout and stderr are diagnostic streams and are never parsed as protocol.

