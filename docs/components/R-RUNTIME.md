# R runtimes

Rho has one authoritative interactive R role and one non-authoritative
first-party Provider adapter.

## Workspace R

The Workspace bridge is owned by `rho-workspace` and `r/rho.bridge`. Every
request binds project, Workspace, kernel instance, expected state/project
revision, execution, operation, and Broker lease. Mutation concurrency is one;
while busy, callers receive only bounded status/stream observations. R errors
are terminal observations rather than rollback claims, and arbitrary or
uncertain evaluation advances revision truth as required.

Bridge helpers receive the normalized project root explicitly. Output,
conditions, and object summaries have byte/item limits. Project file mutation
is not a Workspace side channel; it uses the sandbox patch and Broker commit
path.

## First-party Provider adapter

`r/rho.agent` contains bounded translation helpers for the first-party aisdk
adapter. It maps visible deltas, provider plans, canonical capability requests,
and terminal events. Private reasoning is discarded. Child environment keys
are an exact allowlist supplied by the Secret Broker.

Provider lifecycle, logical sessions, cancellation, quotas, and event
normalization are owned by `rho-agent-host`; effects still enter
`rho-control-plane`. The R adapter has no Store, Workspace mutation, project
path, approval, or secret-resolution handle.

Package APIs are defined by `DESCRIPTION`, `NAMESPACE`, source, and adjacent
tests.
