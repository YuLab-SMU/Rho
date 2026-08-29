# R runtimes

Rho uses two separate R roles.

## Workspace R

Ark hosts the persistent Workspace R session. `rho-kernel` speaks the kernel
protocol, while the server workspace lane and desktop runtime commands manage
identity, execution ordering, interruption, and output projection.

`r/rho.bridge` is loaded into that session. It provides bounded helpers for
execution, inspection, completion, formatting, linting, package/environment
queries, and scientific targets. Callers pass an explicit project root when a
result is project-owned.

## Agent R

`r/rho.agent` is a separate process adapter around `aisdk`. It exchanges
authenticated framed messages through `rho-agent-transport` and the server
Agent coordinator. The Rust side owns admission, project/revision context,
approvals, file proposals, persistence, and redacted public outcomes.

The two roles do not share process authority: Agent orchestration can request
work, but Workspace R remains the executor for the live scientific session.
`present_in_studio` is a pure Agent tool that emits a bounded declarative
handoff referencing committed result identities. It does not mutate UI,
scientific state, or Vibe content; the desktop validates and applies the
handoff through its Surface, Studio, and profile owners after the turn
completes. Package APIs are documented by their `DESCRIPTION`, `NAMESPACE`, and
generated Rd files beside the source.
