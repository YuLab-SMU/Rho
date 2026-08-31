import { describe, expect, it } from "vitest";

import {
  WORKBENCH_VNEXT_COMMANDS,
  WORKBENCH_VNEXT_FIXTURE,
  browserMockWorkbenchVNextFixture,
  validateCommandResponse,
  validateWorkbenchVNextFixture,
} from "./workbenchVNext";
import type { WorkbenchCommandResponseVNext, WorkbenchReconnectResponseVNext } from "./workbenchVNext";

describe("Workbench Protocol vNext", () => {
  it("exposes provider-neutral commands for goal, approval, cancel, provider config, artifact and job query", () => {
    expect(WORKBENCH_VNEXT_COMMANDS).toEqual([
      "submit_goal",
      "approval_decision",
      "cancel",
      "configure_provider",
      "open_artifact",
      "query_job",
    ]);
    expect(validateWorkbenchVNextFixture(WORKBENCH_VNEXT_FIXTURE)).toEqual([]);
  });

  it("makes Tauri fixture and browser mock fixture structurally identical", () => {
    expect(browserMockWorkbenchVNextFixture()).toEqual(WORKBENCH_VNEXT_FIXTURE);
  });

  it("returns durable snapshot plus hot cursor on reconnect without replaying token history", () => {
    expect(WORKBENCH_VNEXT_FIXTURE.snapshot.durable_activities.length).toBeGreaterThan(0);
    expect(WORKBENCH_VNEXT_FIXTURE.hot_cursor).toEqual({ cursor: 91 });
    expect(WORKBENCH_VNEXT_FIXTURE.replayed_token_history).toBe(false);

    const invalid = structuredClone(WORKBENCH_VNEXT_FIXTURE) as Omit<
      WorkbenchReconnectResponseVNext,
      "replayed_token_history"
    > & { replayed_token_history: boolean };
    invalid.replayed_token_history = true;
    expect(validateWorkbenchVNextFixture(invalid as WorkbenchReconnectResponseVNext)).toContain(
      "replayed_token_history",
    );
  });

  it("distinguishes accepted, committed, uncertain and rejected responses instead of ok true", () => {
    const responses: WorkbenchCommandResponseVNext[] = [
      { status: "accepted", operation_id: "operation_a", accepted_at_revision: 44 },
      { status: "committed", operation_id: "operation_b", event_id: "event_b", snapshot_revision: 45 },
      {
        status: "uncertain",
        operation_id: "operation_c",
        reason_code: "ack_without_commit",
        reconcile_after_cursor: { cursor: 92 },
      },
      { status: "rejected", reason_code: "stale_revision" },
    ];
    for (const response of responses) {
      expect(validateCommandResponse(response)).toEqual([]);
      expect("ok" in response).toBe(false);
    }
  });

  it("does not expose ACP, provider-specific enums, secrets, private thinking or raw project payloads", () => {
    const serialized = JSON.stringify(WORKBENCH_VNEXT_FIXTURE).toLowerCase();
    for (const forbidden of [
      "acp",
      "provider_method",
      "provider_specific_enum",
      "private_thinking",
      "chain_of_thought",
      "raw_project_payload",
      "plaintext_secret",
    ]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });
});
