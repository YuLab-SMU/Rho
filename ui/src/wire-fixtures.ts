import type { HostRequest } from "./generated/HostRequest";
import type { SessionReply } from "./generated/SessionReply";
import type { OperationRecord } from "./generated/OperationRecord";

// Wire-level compile checks: JSON numbers, optional skipped fields and tagged
// requests. These aren't a hand-written second model.
export const reply = {
  id: "request",
  ok: false,
  error: "invalid",
} satisfies SessionReply;
export const cursor = {
  method: "subscribe",
  params: { after_sequence: 42, limit: 100 },
} satisfies HostRequest;
export const record: OperationRecord = {
  operation: {
    operation_id: "operation",
    client_request_id: "request",
    caller: { kind: "human", id: "local-user" },
    capability: { id: "workspace.run_r", version: 1 },
    domain: "workspace",
    target: { kind: "workspace", identity: "session" },
    normalized_arguments: { code: "1 + 1" },
    invocation_digest: "digest",
    preconditions: [],
    potential_effects: [],
    correlation_id: "operation",
    causation_id: null,
    trace_parent: null,
    accepted_at_ms: 0,
  },
  status: "uncertain",
  outcome: "uncertain",
  output: null,
  error: "connection lost",
  recovery: {},
  cancellation_requested: true,
  updated_at_ms: 42,
};
