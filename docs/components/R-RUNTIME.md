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

## External Agent client

External Agent lifecycle, model loops, tools, and sessions are not implemented
by Rho. `rho-acp-client` connects to an installed ACP Agent and projects only
public protocol events; effects still enter `rho-control-plane`. No Agent R
package or aisdk adapter is part of the Runtime support environment.

Package APIs are defined by `DESCRIPTION`, `NAMESPACE`, source, and adjacent
tests.
