import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectSwitchResponse } from "../../transport";
import { workbenchOperationTrace } from "../operation-trace";
import { ProjectSwitchController, projectSwitchFailure } from "./project-switch-controller";

function response(status: ProjectSwitchResponse["status"]): ProjectSwitchResponse {
  return {
    status,
    project: status === "ready" ? { root: "/projects/b", files: [], truncated: false } : null,
    session: {},
    unavailable: null,
    blocker: null,
    reason_code: null,
    message: null,
    restored_root: null,
    restart_required: status === "fatal",
  };
}

function lifecycle() {
  return {
    start: vi.fn(),
    accept: vi.fn(async () => undefined),
    refreshRestored: vi.fn(async () => undefined),
    report: vi.fn(),
    finish: vi.fn(),
  };
}

describe("Project switch controller", () => {
  afterEach(() => workbenchOperationTrace.reset());

  it("commits an accepted broker response exactly once", async () => {
    const controller = new ProjectSwitchController();
    const hooks = lifecycle();
    await expect(controller.perform(async () => response("ready"), "/projects/b", hooks)).resolves.toBe("ready");
    expect(hooks.start).toHaveBeenCalledWith("/projects/b");
    expect(hooks.accept).toHaveBeenCalledTimes(1);
    expect(hooks.refreshRestored).not.toHaveBeenCalled();
    expect(hooks.finish).toHaveBeenCalledTimes(1);
  });

  it("keeps cancel silent and maps blocked and unavailable responses beside the action", async () => {
    const cancelled = lifecycle();
    await new ProjectSwitchController().perform(async () => response("cancelled"), null, cancelled);
    expect(cancelled.report).toHaveBeenLastCalledWith(null);

    const blockedResponse = {
      ...response("blocked"),
      blocker: {
        kind: "active_run" as const,
        message: "Stop the active run first.",
        pending_count: 1,
        run_id: "run:fixture",
        turn_id: null,
        request_id: null,
        operation_status: "running",
      },
    };
    expect(projectSwitchFailure(blockedResponse, "/projects/b")).toBe("Stop the active run first.");
    const unavailableResponse = {
      ...response("unavailable"),
      unavailable: { path: "/projects/missing", reason: "not a directory" },
    };
    expect(projectSwitchFailure(unavailableResponse, "/projects/b")).toBe("missing is unavailable: not a directory");
  });

  it("refreshes restored truth but not fatal truth", async () => {
    const restored = lifecycle();
    const restoredResponse = { ...response("failed_restored"), restored_root: "/projects/a", message: "Watcher failed." };
    await new ProjectSwitchController().perform(async () => restoredResponse, "/projects/b", restored);
    expect(restored.refreshRestored).toHaveBeenCalledTimes(1);
    expect(restored.report).toHaveBeenLastCalledWith(expect.stringContaining("restored a"));

    const fatal = lifecycle();
    await new ProjectSwitchController().perform(async () => response("fatal"), "/projects/b", fatal);
    expect(fatal.refreshRestored).not.toHaveBeenCalled();
    expect(fatal.report).toHaveBeenLastCalledWith(expect.stringContaining("recovery did not complete"));
  });

  it("normalizes thrown failures and always finishes", async () => {
    const hooks = lifecycle();
    await expect(new ProjectSwitchController().perform(
      async () => { throw new Error("Validation failed in /Users/alice/private-project"); },
      "/projects/b",
      hooks,
    )).resolves.toBe("fatal");
    expect(hooks.report).toHaveBeenLastCalledWith("Validation failed in [local path]");
    expect(hooks.finish).toHaveBeenCalledTimes(1);
  });

  it("suppresses a rapid duplicate while the first broker operation is pending", async () => {
    const controller = new ProjectSwitchController();
    const hooks = lifecycle();
    let resolveFirst: ((value: ProjectSwitchResponse) => void) | undefined;
    const operation = vi.fn(() => new Promise<ProjectSwitchResponse>((resolve) => { resolveFirst = resolve; }));
    const first = controller.perform(operation, "/projects/b", hooks);
    await expect(controller.perform(operation, "/projects/b", hooks)).resolves.toBe("ignored");
    expect(operation).toHaveBeenCalledTimes(1);
    resolveFirst?.(response("ready"));
    await expect(first).resolves.toBe("ready");
  });
});
