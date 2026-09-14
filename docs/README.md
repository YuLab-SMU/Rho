# Rho documentation

Start with the current product and the work being improved. Each page has one job.

| Need | Read |
| --- | --- |
| Understand what works and what needs attention | [Current state and focus](STATUS.md) |
| Judge product and interaction decisions | [Product design philosophy](RHO-DESIGN.md) |
| Review the user's Studio issues and analysis scenario | [Studio feedback](STUDIO-FEEDBACK.md) |
| Understand ownership, request flow and recovery | [Architecture](ARCHITECTURE.md) |
| Change and verify the application | [Development](DEVELOPMENT.md) |
| Launch Studio, configure R or use CLI/MCP | [Operator guide](OPERATIONS.md) |
| Prepare a requested build or distribution | [Build and release](RELEASE.md) |

[Scenario plugins](SCENARIO-PLUGINS.md) is exploratory research, separate from
current product commitments. The [page index](INDEX.md) and
[source/check index](SOURCE-INDEX.md) are generated navigation aids.

The [built-in component Agent plan](BUILTIN-AGENT-PLAN.md) defines the authorized
Rig integration and bounded extension to the external-Agent-only rule. The P0
experiment, component context and authorized backend execution are implemented.
The unified Agent interface, independent permission policy and local key storage
are implemented in the current source. Scientific work still uses the existing
owners. A20 manual handoff remains a proposal awaiting user review and implementation.
The new 33-scenario real-model matrix is defined but has not run; the earlier
27-scenario evidence remains the prior baseline. See Status for executed checks
and the remaining acceptance limits.

## Maintenance

Code and reproducible results establish current behavior. Product principles
explain design choices; feedback preserves user experience problems; `STATUS.md`
summarizes current focus and evidence. Git stores completed work and past decisions.
Do not copy history into a growing status archive or repeat a capability registry
that the running Host already provides.

Keep proposed, implemented and verified behavior distinct. Replace stale text and
broken examples. Document a stable constraint once and link to its owning page.
A documentation edit does not establish a new runtime test result.

Register pages in `governance/registry.json`; map source areas and checks in
`governance/source-map.json`. After changing the map:

```sh
node scripts/governance.mjs generate
node scripts/governance.mjs check
node scripts/test-governance.mjs
```
