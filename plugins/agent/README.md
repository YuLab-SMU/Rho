# Agent package source

The public native transport is the first extracted part of the Agent plugin.
`api/` owns its Rust DTOs; `sdk/` contains generated TypeScript declarations and
JSON schemas. `backend/client/` owns deterministic Codex app-server, Kimi ACP and
DeepSeek ACP communication, bounded observations and owned-process recovery.
Neither library depends on private Rho core crates or a model behavior engine.

`AgentControllerRef` is owner-supplied correlation data, not a credential. Admission,
project scope, native MCP credentials, task persistence and authorized scientific
execution remain the responsibility of the containing owner. The current Host
converts its admitted window identity at that boundary. Moving DTO ownership does
not change wire field names, replay input, authorize tools or transfer scientific
truth to the transport.

Generate declarations with `node plugins/agent/generate-sdk.mjs`; add `--check` to
verify freshness. `node scripts/test-agent-plugin-types.mjs` checks an independent
TypeScript consumer. Run `node scripts/test-agent-plugin-client.mjs` from the checkout
to assemble these sources outside it, check dependency containment and run all
native protocol/recovery fixtures. Those fixtures use local fake processes, never
real providers, model requests or user sessions. The native transport's explicit
DeepSeek setup entry point is retained but is not invoked by these checks.

This source is not yet a loadable Agent plugin: task persistence, Rig integration,
context/handoff and Agent views still require migration. No backend manifest,
default activation or delivery claim is made until those owners use public ports.
