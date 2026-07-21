# aisdk family integration

Status: implemented in the current product baseline

Audit date: 2026-07-15

Validated revisions:

- `aisdk`: `1e2fa54358dda647a6d5cbf64c0625642c673e4c`
- `aisdk.console`: `a985f05ba28308972f6e8c47575b56182558cf8b`

## Decision

Rho uses `aisdk` core as the Agent R execution engine and treats
`aisdk.console` as the existing reference frontend. Rho does not embed the
terminal REPL. Its React UI consumes broker-owned Workbench Protocol events.

This preserves the useful existing behavior without weakening Rho's two-process
authority model:

- Agent R owns model credentials, `ChatSession`, reasoning and tool selection.
- Workspace R owns `.GlobalEnv`, scientific objects and arbitrary R execution.
- The Rust broker owns policy, approvals, process creation, revisions and storage.

## Reuse map

| Package | Reuse now | Reuse later | Do not use unchanged |
|---|---|---|---|
| `aisdk` | `ChatSession`, streaming events, trace sink, hooks, run state, schemas, context and branch semantics | provider/model setup and session import/export | local/global R helpers as Workspace operations |
| `aisdk.console` | turn-loop behavior, tool timeline and inspector UX reference | developer fallback and compatibility tests | `console_chat()` as GUI Console; default direct shell/file/local-R tools |
| `aisdk.bioc` | semantic class vocabulary and bounded rendering contracts | class-specific Workspace bridge adapters | moving scientific objects into Agent R |
| `aisdk.skills` | registry/discovery contracts | skill browser and authoring UI | sourcing project skill scripts in Agent R |
| `aisdk.mcp` | MCP schemas and remote-client concepts | managed connector catalog | spawning local MCP children with Agent R's inherited credentials |
| `aisdk.orchestration` | none in the first vertical slice | Flow/Team/Mission after one-agent stability | concurrent Workspace R execution |

## Existing extension seams

The current core already provides most of the agent event model:

- `ChatSession$send_stream(..., on_event=)` publicly emits `text_delta`,
  `thinking_text`, `intermediate_text`, `final_text`, and `done`.
- `set_run_trace_sink()` emits typed lifecycle events for model calls,
  responses, tool results, policy decisions, network failures, token usage and
  latency.
- `HookHandler` exposes generation start/end, tool start/end and synchronous
  tool approval hooks.
- normalized run states cover running, completed, waiting, blocked, cancelled,
  safety abort and error, with `continue_run()` actions.
- session event and branching functions provide a compatibility format for
  existing console sessions.

Rho maps those outputs to stable Workbench Protocol events. It does not parse
terminal markup.

## Tool boundary

The default `aisdk.console` tools are designed for a single interactive R
process. Some execute in callr, some inspect Agent R or `.GlobalEnv`, and the
legacy `execute_r_code_local` mutates the current process directly. They cannot
represent Rho's Ark workspace.

Rho therefore creates Tool objects whose execution closures issue authenticated
broker RPC requests:

```text
aisdk Tool -> rho.agent request -> Rust broker policy/queue -> Ark Workspace R
           <- correlated bounded result and new revisions <-
```

The model supplies domain arguments such as object name or R code. The adapter
adds `kernel_instance_id`, `state_revision` and `project_revision`; the model is
not trusted to supply concurrency identities.

## Persistence

The `aisdk` JSONL event store remains an import/export format and supports the
standalone terminal frontend. In desktop mode, Agent R emits events to the
broker and SQLite remains the sole authoritative writer. This avoids duplicate
event IDs, divergent branches and recovery races.

## Required follow-up

1. Extend the broker probe into a bidirectional Agent R request loop.
2. Add a real-provider opt-in test with credential redaction assertions. The
   mocked typed stream, trace and run-state mapping is already verified.
3. Implement the organization-owned family package changes in
   `proposed-aisdk-family-change-proposals.md`, beginning with MCP environment isolation,
   correlated events and cooperative cancellation. Typed streaming is already
   public as `on_event`, and Rho must not depend on unexported `aisdk.console`
   functions.
4. Implement Bioconductor semantic adapters in `rho.bridge` using the bounded
   contracts from `aisdk.bioc`.
