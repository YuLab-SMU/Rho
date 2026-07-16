# aisdk family changes proposed for Rho

Status: proposal, no external repository changes made

Date: 2026-07-15

The packages are maintained by the same organization as Rho, so these are
planned upstream collaborations rather than requests against immutable third-
party dependencies. Each change should still remain useful to standalone
aisdk consumers and be versioned independently from the Rho desktop release.

These changes keep the aisdk family generally useful. Ark, Tauri, SQLite and
Rho-specific revision rules remain in Rho rather than leaking into aisdk.

## P0: before the Phase 1A vertical slice

### 1. aisdk: versioned frontend event envelope

The new public `on_event` typed stream is the correct frontend seam. Extend
each event with stable correlation fields:

```text
schema_version
event_id
timestamp
run_id
turn_id
sequence
step
type
tool_call_id (when applicable)
payload
```

Add first-class `tool_call_started`, `tool_call_completed`,
`tool_call_failed`, `run_state_changed` and `usage_updated` events. Today Rho
can reconstruct these from `on_event`, `set_run_trace_sink()` and hooks, but
three partially overlapping streams create ordering and deduplication work.

Keep trace sinks for observability; the frontend stream should be sufficient
for a UI timeline without inspecting a final `GenerateResult`.

### 2. aisdk: cooperative cancellation

Run states already include `cancelled`, but the runtime has no public
cancellation token checked across model steps and tool boundaries. Add a
`cancel_check` or `CancellationToken` argument to `generate_text()`,
`stream_text()`, `ChatSession$send_stream()` and `execute_tool_calls()`.

The token should be checked before provider calls, after streamed chunks,
before and after each tool, and between continuation windows. Providers should
abort active HTTP/SSE work when their transport supports it. Rho will still
retain OS-level Agent R interruption as the bounded fallback.

### 3. aisdk: pluggable tool and R-context backends

Add an executor seam rather than requiring every frontend to replace Tool
definitions manually:

```r
execute_tool_calls(..., executor = NULL, cancel_token = NULL)
create_r_context_tools(backend = local_r_context_backend())
create_r_introspect_tools(backend = local_r_introspection_backend())
```

A backend receives the validated tool call, Tool metadata, session and hooks.
The default preserves current behavior. Rho supplies a broker backend that
adds workspace revisions and returns a correlated result from Ark.

This avoids presenting Agent R's `.GlobalEnv`, callr `r_eval`, or
`execute_r_code_local` as the authoritative Workspace R.

### 4. aisdk.skills: external skill-script executor

Change to:

```r
create_skill_tools(registry, script_executor = NULL)
```

The default calls `Skill$execute_script()` as today. Rho's executor sends the
script path, arguments and declared permissions to the broker, which runs it
in Workspace R or an isolated worker. Reading `SKILL.md` and resources can stay
in Agent R; executing project code cannot.

### 5. aisdk.mcp: secure process launcher

This is both a Rho blocker and a general security correction. `McpClient`
currently constructs local server environment variables with:

```r
c(Sys.getenv(), env)
```

That copies every model API key and token from Agent R into any local MCP
server. Change the default to no inherited environment except a documented
minimal allowlist, and add an injectable launcher/transport:

```r
create_mcp_client(
  command,
  args = character(),
  env = character(),
  inherit_env = FALSE,
  env_allowlist = mcp_default_env_allowlist(),
  process_factory = NULL,
  transport = NULL
)
```

`process_factory` lets Rho ask the broker to create and supervise the child.
`transport` lets `McpClient` use broker-owned stdio without owning a processx
process. Connector-specific credentials remain explicit in `env`.

## P1: useful during desktop productization

### 6. aisdk: external session event store

Split event construction from JSONL writing:

```r
new_session_event(...)
session_append_event(..., store = default_jsonl_store())
create_session_store(append, read, branches, snapshot)
```

Standalone `aisdk.console` keeps JSONL. Rho supplies a broker event sink and
SQLite remains the only writer. Preserve the existing JSONL schema for import
and export.

### 7. aisdk.console: injectable agent preset

Allow reuse of its agent/prompt design without automatically installing
direct local tools:

```r
create_console_agent(
  ...,
  include_default_tools = TRUE,
  tool_backend = NULL,
  additional_tools = NULL
)
```

Alternatively expose a pure agent preset builder from core. Do not add a Rho
profile to terminal rendering, and do not make Rho depend on unexported
`aisdk.console` frame functions.

### 8. aisdk.bioc: lightweight semantic runtime

Separate the semantic adapter protocol and Bioconductor extractors from model
providers and credential-bearing runtime code. A small `aisdk.semantic` layer,
or pure extractor functions in `aisdk.bioc`, could be loaded by `rho.bridge`
inside Workspace R without pulling the entire Agent R stack into that process.

Adapters should support bounded descriptor output and never require returning
the scientific object to Agent R.

### 9. aisdk.orchestration: resource affinity

Add resource keys and locks to Mission/Flow scheduling:

```text
resource_key = workspace_r:<workspace_id>
concurrency = 1
```

Multiple agents may reason concurrently, but calls against one authoritative
Workspace R must serialize through the broker.

## No change needed

- Keep provider/model implementations and credentials in Agent R.
- Keep `ChatSession`, normalized run state, hooks and branching as the agent
  engine; Rho should not create competing versions.
- Keep Workbench Protocol, Ark/Jupyter messages, revision validation, SQLite,
  desktop approvals and process supervision in Rho.
- Keep `aisdk.console` usable as a standalone terminal frontend.

## Suggested implementation order

1. Secure `aisdk.mcp` environment inheritance.
2. Add event correlation and tool lifecycle to public `on_event`.
3. Add cooperative cancellation.
4. Add tool/R-context and skill executor backends.
5. Add external session stores.
6. Add semantic-runtime separation and orchestration resource locks.
