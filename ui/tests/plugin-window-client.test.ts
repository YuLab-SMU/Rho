import { expect, it, vi } from "vitest";
import { createPluginWindowState } from "../src/plugin-window-client";
import type { HostClient } from "../src/host-client";
import type { Invocation } from "../src/generated/Invocation";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
const saved = { window: "window", project: "project", principal: "principal", version: 0, layout: { kind: "empty" } };
const layout = { kind: "tabs" as const, id: "group", views: ["view"], selected: "view" };
function fixture() {
  const query = vi.fn(async () => ({ status: "ready", data: saved, notices: [] }) as unknown as QuerySnapshot);
  const invoke = vi.fn(async (_project: string, invocation: Invocation) => ({
    operation: { operation_id: "operation", client_request_id: invocation.client_request_id, capability: invocation.capability },
    status: "succeeded", outcome: "succeeded", output: { ...saved, version: 1, layout },
  }) as unknown as OperationRecord);
  const client: Pick<HostClient, "windowId" | "query" | "invoke"> = { windowId: "window", query, invoke };
  return { owner: createPluginWindowState(client, "/selected-project"), query, invoke };
}
it("uses the containing window and selected project through shared Host ports", async () => {
  const { owner, query, invoke } = fixture(); await owner.load(); owner.change(layout); await owner.save();
  expect(query).toHaveBeenCalledExactlyOnceWith("/selected-project", "windows.layout", { window: "window" });
  expect(invoke.mock.calls[0]).toEqual(["/selected-project", { client_request_id: expect.any(String),
    capability: { id: "windows.update_layout", version: 1 }, arguments: { window: "window", expected_version: 0, layout }, preconditions: [] }]);
  expect(owner.getSnapshot()).toMatchObject({ dirty: false, saved: { version: 1 } });
});
it.each(["accepted", "running", "reconciling", "uncertain", "failed", "cancelled"] as const)("never treats %s as a saved layout", async status => {
  const { owner, invoke } = fixture();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (...args) => ({ ...await original(...args), status, outcome: null }));
  await owner.load(); owner.change(layout); await expect(owner.save()).rejects.toThrow(`Layout save is ${status}`);
  expect(owner.getSnapshot()).toMatchObject({ dirty: true, saved: { version: 0 }, layout });
});
it("refuses unrelated Operation replies and unavailable observations", async () => {
  const { owner, invoke, query } = fixture(), original = invoke.getMockImplementation()!;
  query.mockResolvedValueOnce({ status: "unavailable", data: null, notices: ["No current observation"] } as unknown as QuerySnapshot);
  await expect(owner.load()).rejects.toThrow("No current observation"); await owner.load(); owner.change(layout);
  invoke.mockImplementation(async (...args) => { const value = await original(...args); value.operation.capability = { id: "something.else", version: 1 }; return value; });
  await expect(owner.save()).rejects.toThrow("different Operation"); expect(owner.getSnapshot().dirty).toBe(true);
});
