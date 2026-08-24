import { describe, expect, it } from "vitest";

import { WorkbenchOperationTrace } from "./operation-trace";

describe("Workbench operation trace", () => {
  it("records success and typed failure without payloads, paths, or source code", async () => {
    let now = 10;
    const trace = new WorkbenchOperationTrace(64, () => now);
    await trace.run("runtime.execute", async () => { now = 18; return 2; }, { fallback: "Runtime failed." });
    await expect(trace.run("studio.apply", async () => {
      now = 31;
      throw new Error("Revision is stale at /Users/alice/project");
    }, { fallback: "Studio failed." })).rejects.toThrow("stale");
    expect(trace.snapshot()).toEqual([
      { operation_id: "op-000001", operation: "runtime.execute", stage: "started", elapsed_ms: 0, failure_kind: null },
      { operation_id: "op-000001", operation: "runtime.execute", stage: "succeeded", elapsed_ms: 8, failure_kind: null },
      { operation_id: "op-000002", operation: "studio.apply", stage: "started", elapsed_ms: 0, failure_kind: null },
      { operation_id: "op-000002", operation: "studio.apply", stage: "failed", elapsed_ms: 13, failure_kind: "conflict" },
    ]);
    expect(JSON.stringify(trace.snapshot())).not.toContain("Users");
  });

  it("caps the ring and resets project-local evidence", () => {
    let now = 0;
    const trace = new WorkbenchOperationTrace(3, () => now++);
    const first = trace.start("one");
    trace.succeed(first);
    const second = trace.start("two");
    trace.succeed(second);
    expect(trace.snapshot()).toHaveLength(3);
    expect(trace.snapshot()[0]?.operation).toBe("one");
    expect(trace.snapshot()[0]?.stage).toBe("succeeded");
    trace.reset();
    expect(trace.snapshot()).toEqual([]);
  });

  it("records a later successful retry without rewriting the failed attempt", async () => {
    let now = 0;
    const trace = new WorkbenchOperationTrace(64, () => now);
    await expect(trace.run("resource.save", async () => {
      now = 5;
      throw new Error("Transport connection closed.");
    }, { fallback: "Save failed." })).rejects.toThrow();
    await expect(trace.run("resource.save", async () => {
      now = 9;
      return "saved";
    }, { fallback: "Save failed." })).resolves.toBe("saved");
    expect(trace.snapshot().map(({ operation_id, stage, failure_kind }) => ({ operation_id, stage, failure_kind }))).toEqual([
      { operation_id: "op-000001", stage: "started", failure_kind: null },
      { operation_id: "op-000001", stage: "failed", failure_kind: "transport" },
      { operation_id: "op-000002", stage: "started", failure_kind: null },
      { operation_id: "op-000002", stage: "succeeded", failure_kind: null },
    ]);
  });
});
