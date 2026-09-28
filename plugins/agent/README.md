# Agent package source

The public native transport, task state machine and Rig model engine are extracted
parts of the Agent plugin.
`api/` owns its Rust DTOs; `sdk/` contains generated TypeScript declarations and
JSON schemas. `backend/client/` owns deterministic Codex app-server, Kimi ACP and
DeepSeek ACP communication, bounded observations and owned-process recovery.
`backend/owner/` owns task admission, captured drafts, original receipts, control
generation, observation-only restart handling, model-setting/credential validation
and the repository port. `backend/engine/` owns the sole Rig driver, provider
protocols, synthetic diagnostics and deterministic permission rules. These
libraries do not depend on private Rho core crates. The transport and task owner
have no model-engine dependency.

`AgentControllerRef` is owner-supplied correlation data, not a credential. Admission,
project scope, native MCP credentials and authorized scientific execution remain
the responsibility of the containing owner. The task state machine uses one
injected repository; the transitional application store implements that public
port. The current Host converts its admitted scope/window identity at the boundary.
Moving DTO ownership does not change wire field names, replay input, authorize tools or transfer scientific
truth to the transport.

Generate declarations with `node plugins/agent/generate-sdk.mjs`; add `--check` to
verify freshness. `node scripts/test-agent-plugin-types.mjs` checks an independent
TypeScript consumer. Run `node scripts/test-agent-plugin-client.mjs` from the checkout
to assemble these sources outside it, check dependency containment and run all
native protocol/recovery fixtures. Those fixtures use local fake processes, never
real providers, model requests or user sessions. The native transport's explicit
DeepSeek setup entry point is retained but is not invoked by these checks.

`node scripts/test-agent-plugin-owner.mjs` builds the task owner and public API
outside the checkout. Its focused fixtures cover original-request deduplication,
scope and draft fences, atomic write failure, captured input retention, uncertain
restart observations and stop/takeover fencing. Shared SQLite, component handoff
and Host integration retain their own cross-boundary tests.

`node scripts/test-agent-plugin-engine.mjs` builds the API, owner and model engine
outside the checkout and runs protocol, production-driver and task-owner tests.
The production driver accepts captured public model input and an owner callback
port. Tool tickets are opaque, transient handles returned to the same port;
interrupted waits retain the original owner receipt. Model output cannot replace
an owner-admitted request or receipt, or commit an operation. Image labels and
verified bytes are supplied by the containing owner. The transitional core adapter
preserves admitted actions and records owner diagnostics before returning errors.

This source is not yet a loadable Agent plugin: ordinary backend/storage composition,
component-task ownership, context/handoff and Agent views still require migration. No backend manifest,
default activation or delivery claim is made until those owners use public ports.
