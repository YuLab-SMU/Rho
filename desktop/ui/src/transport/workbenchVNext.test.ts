import { describe, expect, it, vi } from "vitest";

import { WORKBENCH_VNEXT_FIXTURE } from "../contracts/workbenchVNext";
import {
  MAX_WORKBENCH_COMMAND_BYTES,
  WorkbenchVNextTransport,
  createBrowserMockWorkbenchHandlers,
  type WorkbenchCommandEnvelopeVNext,
  type WorkbenchLiveEventVNext,
} from "./workbenchVNext";

function submitGoal(goalId = "goal_transport"): WorkbenchCommandEnvelopeVNext {
  return {
    contract: "rho.ui.workbench.vnext.v1",
    contract_major: 1,
    command: {
      command: "submit_goal",
      goal_id: goalId,
      text: "Find sample-controlled markers",
      expected_snapshot_revision: 44,
    },
    bounded_arguments: { goal_id: goalId },
  };
}

describe("Workbench vNext Desktop/browser transport parity", () => {
  it("distinguishes committed state and dedupes renderer retry by command identity", async () => {
    const backend = createBrowserMockWorkbenchHandlers(WORKBENCH_VNEXT_FIXTURE);
    const firstTransport = new WorkbenchVNextTransport(backend);
    const first = await firstTransport.command(submitGoal());

    // Simulates renderer crash/reload using the same authoritative backend.
    const reloadedTransport = new WorkbenchVNextTransport(backend);
    const second = await reloadedTransport.command(submitGoal());
    expect(first).toEqual(second);
    expect(first.status).toBe("committed");
    expect("ok" in first).toBe(false);
  });

  it("reconnects with snapshot/cursor/gap and never replays token history", async () => {
    const transport = new WorkbenchVNextTransport(
      createBrowserMockWorkbenchHandlers(WORKBENCH_VNEXT_FIXTURE),
    );
    const reconnect = await transport.reconnect();
    expect(reconnect.gap).not.toBeNull();
    expect(reconnect.replayed_token_history).toBe(false);
    expect(reconnect.hot_cursor).toEqual(WORKBENCH_VNEXT_FIXTURE.hot_cursor);
  });

  it("cleans up unsubscribe resources and ignores events after close", async () => {
    let listener: ((event: WorkbenchLiveEventVNext) => void) | undefined;
    const backend = createBrowserMockWorkbenchHandlers(WORKBENCH_VNEXT_FIXTURE);
    const originalSubscribe = backend.subscribe;
    const cleanup = vi.fn();
    backend.subscribe = async (after, next) => {
      listener = next;
      const originalCleanup = await originalSubscribe(after, next);
      return () => {
        cleanup();
        originalCleanup();
      };
    };
    const transport = new WorkbenchVNextTransport(backend);
    const received = vi.fn();
    const unsubscribe = await transport.subscribe(received);
    unsubscribe();
    listener?.({
      cursor: { cursor: 92 },
      payload: { kind: "snapshot_invalidated", snapshot_revision: 45 },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
  });

  it("rejects oversized command payloads before invoking backend", async () => {
    const backend = createBrowserMockWorkbenchHandlers(WORKBENCH_VNEXT_FIXTURE);
    const commandSpy = vi.spyOn(backend, "command");
    const transport = new WorkbenchVNextTransport(backend);
    const envelope = submitGoal("goal_oversized");
    if (envelope.command.command === "submit_goal") {
      envelope.command.text = "x".repeat(MAX_WORKBENCH_COMMAND_BYTES + 1);
    }
    expect(await transport.command(envelope)).toEqual({
      status: "rejected",
      reason_code: "command_too_large",
    });
    expect(commandSpy).not.toHaveBeenCalled();
  });

  it("contains no provider-specific, private-thinking, or Tauri-internal surface", () => {
    const fixture = JSON.stringify(WORKBENCH_VNEXT_FIXTURE).toLowerCase();
    for (const forbidden of [
      "acp",
      "aisdk",
      "private_thinking",
      "chain_of_thought",
      "plaintext_secret",
    ]) {
      expect(fixture).not.toContain(forbidden);
    }
  });
});
