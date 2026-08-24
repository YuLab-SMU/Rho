import { describe, expect, it, vi } from "vitest";

import { ConsoleExecutionRouter } from "./console-execution-router";
import type { ConsoleExecutionEndpoint } from "./console-execution-router";
import type { SourceExecutionSubmission } from "../source-execution";

const execution: SourceExecutionSubmission = {
  kind: "expression",
  code: "1 + 1",
  start: 0,
  end: 5,
  range: { start_line: 1, start_column: 1, end_line: 1, end_column: 6 },
  next_cursor: null,
  source_path: "analysis.R",
  document_version: 1,
};

function endpoint(instanceId: string, accepted = true): ConsoleExecutionEndpoint {
  return {
    instanceId,
    submitSource: vi.fn(() => ({ accepted, message: accepted ? null : "Console is busy." })),
  };
}

describe("Console execution router", () => {
  it("uses the sole endpoint, then preserves an explicitly preferred Console", async () => {
    const router = new ConsoleExecutionRouter();
    const first = endpoint("console:first");
    const second = endpoint("console:second");
    router.register(first);
    const report = vi.fn();
    await expect(router.run("source", execution, vi.fn(), report)).resolves.toBe(true);
    router.register(second);
    router.markPreferred("console:second");
    await expect(router.run("source", execution, vi.fn(), report)).resolves.toBe(true);
    expect(first.submitSource).toHaveBeenCalledTimes(1);
    expect(second.submitSource).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(null);
  });

  it("requires an explicit choice when multiple endpoints are visible", async () => {
    const router = new ConsoleExecutionRouter();
    router.register(endpoint("console:a"));
    router.register(endpoint("console:b"));
    const report = vi.fn();
    await expect(router.run("source", execution, vi.fn(), report)).resolves.toBe(false);
    expect(report).toHaveBeenCalledWith(expect.stringContaining("More than one R Console"));
  });

  it("resolves renderer waiters on registration and times out deterministically", async () => {
    vi.useFakeTimers();
    try {
      const router = new ConsoleExecutionRouter(250);
      const mounted = endpoint("console:mounted");
      const waiting = router.waitFor(mounted.instanceId);
      router.register(mounted);
      await expect(waiting).resolves.toBe(mounted);
      const timeout = router.waitFor("console:missing");
      const rejected = expect(timeout).rejects.toThrow("renderer did not become ready");
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates rapid preparation and admits both requests through the mounted endpoint", async () => {
    const router = new ConsoleExecutionRouter();
    const mounted = endpoint("console:new");
    let resolvePreparation: ((value: ConsoleExecutionEndpoint) => void) | undefined;
    const prepare = vi.fn(() => new Promise<ConsoleExecutionEndpoint>((resolve) => {
      resolvePreparation = resolve;
    }));
    const report = vi.fn();
    const first = router.run("source", execution, prepare, report);
    const second = router.run("source", execution, prepare, report);
    expect(prepare).toHaveBeenCalledTimes(1);
    resolvePreparation?.(mounted);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mounted.submitSource).toHaveBeenCalledTimes(2);
  });

  it("keeps admission rejection actionable and clears endpoint truth on project reset", async () => {
    const router = new ConsoleExecutionRouter();
    router.activateProject("project:a");
    router.register(endpoint("console:busy", false));
    const report = vi.fn();
    await expect(router.run("source", execution, vi.fn(), report)).resolves.toBe(false);
    expect(report).toHaveBeenCalledWith("Console is busy.");
    router.activateProject("project:b");
    const prepare = vi.fn(async () => endpoint("console:new"));
    await expect(router.run("source", execution, prepare, report)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("rejects pending waiters on reset and disposal", async () => {
    const router = new ConsoleExecutionRouter();
    const projectWait = router.waitFor("console:project");
    router.reset();
    await expect(projectWait).rejects.toThrow("project changed");
    const closeWait = router.waitFor("console:close");
    router.dispose();
    await expect(closeWait).rejects.toThrow("workbench closed");
  });
});
