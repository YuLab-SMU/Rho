import { describe, expect, it, vi } from "vitest";

import type {
  WorkspacePreparation,
  WorkspacePreparationProgressListener,
} from "../../transport";
import { createMockUiKernelTransport } from "../../transport/mock";
import { createStartupController } from "./startup-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function states(controller: ReturnType<typeof createStartupController>) {
  return controller.getSnapshot().ledger.steps.map((step) => step.state);
}

const readyPreparation: WorkspacePreparation = {
  status: "ready",
  phase: "project_ready",
  workspace_ready: true,
  restored_project_status: "ready",
  issue: null,
};

const projectAttention: WorkspacePreparation = {
  status: "needs_attention",
  phase: "project_restore_incomplete",
  workspace_ready: true,
  restored_project_status: "unavailable",
  issue: {
    code: "PROJECT_RESTORE_INCOMPLETE",
    title: "The saved project could not be restored",
    message: "Choose another project.",
    technical_detail: "/missing/project",
  },
};

describe("startup controller", () => {
  it("caches observer progress without subscribers and admits Workbench only on final ready", async () => {
    const transport = createMockUiKernelTransport();
    const final = deferred<WorkspacePreparation>();
    let progress: WorkspacePreparationProgressListener | undefined;
    const prepare = vi.fn((
      _chooseRscript?: boolean,
      onProgress?: WorkspacePreparationProgressListener,
    ) => {
      progress = onProgress;
      onProgress?.({ stage: "runtime", state: "active" });
      return final.promise;
    });
    transport.prepareWorkspace = prepare;
    const controller = createStartupController(transport, { now: () => 100 });

    controller.start();
    expect(prepare).toHaveBeenCalledOnce();
    expect(states(controller)).toEqual(["active", "waiting", "waiting"]);

    progress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
    progress?.({ stage: "workspace", state: "active" });
    progress?.({ stage: "workspace", state: "complete", workspace_pid: 42 });
    progress?.({ stage: "project", state: "active" });
    progress?.({ stage: "project", state: "complete", project_root: "/project" });
    expect(states(controller)).toEqual(["complete", "complete", "complete"]);
    expect(controller.getSnapshot().status).toBe("preparing");

    final.resolve(readyPreparation);
    await settle();
    expect(controller.getSnapshot().status).toBe("ready");
    const admitted = controller.getSnapshot();
    progress?.({ stage: "runtime", state: "active" });
    expect(controller.getSnapshot()).toBe(admitted);
  });

  it("closes the observer before terminal attention so late progress cannot clear the issue", async () => {
    const transport = createMockUiKernelTransport();
    const final = deferred<WorkspacePreparation>();
    let progress: WorkspacePreparationProgressListener | undefined;
    transport.prepareWorkspace = vi.fn((_choose, onProgress) => {
      progress = onProgress;
      onProgress?.({ stage: "runtime", state: "active" });
      return final.promise;
    });
    const controller = createStartupController(transport);
    controller.start();

    final.resolve({
      status: "needs_attention",
      phase: "needs_attention",
      workspace_ready: false,
      restored_project_status: null,
      issue: {
        code: "R_NOT_FOUND",
        title: "R was not found",
        message: "Choose Rscript manually.",
        technical_detail: null,
      },
    });
    await settle();
    const attention = controller.getSnapshot();
    expect(attention.status).toBe("needs_attention");
    expect(attention.issue?.code).toBe("R_NOT_FOUND");

    progress?.({ stage: "runtime", state: "active" });
    progress?.({ stage: "runtime", state: "complete", r_version: "late" });
    expect(controller.getSnapshot()).toBe(attention);
    expect(states(controller)).toEqual(["attention", "waiting", "waiting"]);
  });

  it("closes the observer before final ready so late progress cannot revoke admission", async () => {
    const transport = createMockUiKernelTransport();
    const final = deferred<WorkspacePreparation>();
    let progress: WorkspacePreparationProgressListener | undefined;
    transport.prepareWorkspace = vi.fn((_choose, onProgress) => {
      progress = onProgress;
      onProgress?.({ stage: "runtime", state: "active" });
      return final.promise;
    });
    const controller = createStartupController(transport);
    controller.start();

    final.resolve(readyPreparation);
    await settle();
    const ready = controller.getSnapshot();
    expect(ready.status).toBe("ready");
    expect(states(controller)).toEqual(["active", "waiting", "waiting"]);

    progress?.({ stage: "runtime", state: "complete", r_version: "late" });
    progress?.({ stage: "workspace", state: "active" });
    expect(controller.getSnapshot()).toBe(ready);
    expect(controller.getSnapshot().status).toBe("ready");
  });

  it("keeps one bootstrap across the StrictMode disconnect gap and retires after real disconnect", async () => {
    const transport = createMockUiKernelTransport();
    const final = deferred<WorkspacePreparation>();
    let progress: WorkspacePreparationProgressListener | undefined;
    const prepare = vi.fn((
      _chooseRscript?: boolean,
      onProgress?: WorkspacePreparationProgressListener,
    ) => {
      progress = onProgress;
      onProgress?.({ stage: "runtime", state: "active" });
      return final.promise;
    });
    transport.prepareWorkspace = prepare;
    const controller = createStartupController(transport);

    const firstDisconnect = controller.connect();
    firstDisconnect();
    progress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
    const secondDisconnect = controller.connect();
    await Promise.resolve();

    expect(prepare).toHaveBeenCalledOnce();
    expect(states(controller)).toEqual(["complete", "waiting", "waiting"]);

    secondDisconnect();
    await Promise.resolve();
    const retired = controller.getSnapshot();
    progress?.({ stage: "workspace", state: "active" });
    final.resolve(readyPreparation);
    await settle();
    expect(controller.getSnapshot()).toBe(retired);
  });

  it("maps runtime, Workspace, and sparse project failures to exact recovery authority", async () => {
    const runtimeTransport = createMockUiKernelTransport();
    runtimeTransport.prepareWorkspace = vi.fn(async (_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      return {
        status: "needs_attention",
        phase: "needs_attention",
        workspace_ready: false,
        restored_project_status: null,
        issue: {
          code: "R_NOT_FOUND",
          title: "R was not found",
          message: "Choose Rscript manually.",
          technical_detail: null,
        },
      } as const;
    });
    const runtime = createStartupController(runtimeTransport);
    runtime.start();
    await settle();
    expect(states(runtime)).toEqual(["attention", "waiting", "waiting"]);
    expect(runtime.getSnapshot().recovery).toBe("choose_rscript");

    const workspaceTransport = createMockUiKernelTransport();
    workspaceTransport.prepareWorkspace = vi.fn(async (_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
      onProgress?.({ stage: "workspace", state: "active" });
      return {
        status: "needs_attention",
        phase: "workspace_start_failed",
        workspace_ready: false,
        restored_project_status: null,
        issue: {
          code: "WORKSPACE_START_FAILED",
          title: "Workspace R could not start",
          message: "Retry startup.",
          technical_detail: null,
        },
      } as const;
    });
    const workspace = createStartupController(workspaceTransport);
    workspace.start();
    await settle();
    expect(states(workspace)).toEqual(["complete", "attention", "waiting"]);
    expect(workspace.getSnapshot().recovery).toBeNull();

    const projectTransport = createMockUiKernelTransport();
    projectTransport.prepareWorkspace = vi.fn(async () => projectAttention);
    const project = createStartupController(projectTransport);
    project.start();
    await settle();
    expect(states(project)).toEqual(["complete", "complete", "attention"]);
    expect(project.getSnapshot().recovery).toBe("choose_project");
  });

  it("restarts a full retry at runtime while direct project recovery preserves established facts", async () => {
    const transport = createMockUiKernelTransport();
    const retry = deferred<WorkspacePreparation>();
    let attempts = 0;
    const prepare = vi.fn((
      _chooseRscript?: boolean,
      onProgress?: WorkspacePreparationProgressListener,
    ) => {
      attempts += 1;
      if (attempts === 1) {
        onProgress?.({ stage: "runtime", state: "active" });
        onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
        onProgress?.({ stage: "workspace", state: "active" });
        return Promise.resolve({
          status: "needs_attention",
          phase: "workspace_start_failed",
          workspace_ready: false,
          restored_project_status: null,
          issue: {
            code: "WORKSPACE_START_FAILED",
            title: "Workspace R could not start",
            message: "Retry startup.",
            technical_detail: null,
          },
        } as const);
      }
      onProgress?.({ stage: "runtime", state: "active" });
      return retry.promise;
    });
    transport.prepareWorkspace = prepare;
    const controller = createStartupController(transport);
    controller.start();
    await settle();

    controller.retry();
    controller.retry();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]?.[0]).toBe(false);
    expect(states(controller)).toEqual(["active", "waiting", "waiting"]);

    retry.resolve(projectAttention);
    await settle();
    expect(states(controller)).toEqual(["attention", "waiting", "waiting"]);

    const projectTransport = createMockUiKernelTransport();
    projectTransport.prepareWorkspace = vi.fn(async (_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
      onProgress?.({ stage: "workspace", state: "active" });
      onProgress?.({ stage: "workspace", state: "complete", workspace_pid: 42 });
      onProgress?.({ stage: "project", state: "active" });
      return projectAttention;
    });
    const picker = deferred<ReturnType<typeof cancelledProjectResponse>>();
    projectTransport.pickProjectDirectory = vi.fn(() => picker.promise);
    const projectController = createStartupController(projectTransport);
    projectController.start();
    await settle();
    projectController.chooseProject();
    expect(states(projectController)).toEqual(["complete", "complete", "active"]);
  });

  it("restores exact project attention and chooser focus on cancel, then focuses a new failure heading", async () => {
    const transport = createMockUiKernelTransport();
    transport.prepareWorkspace = vi.fn(async (_choose, onProgress) => {
      onProgress?.({ stage: "runtime", state: "active" });
      onProgress?.({ stage: "runtime", state: "complete", r_version: "4.5.1" });
      onProgress?.({ stage: "workspace", state: "active" });
      onProgress?.({ stage: "workspace", state: "complete", workspace_pid: 42 });
      onProgress?.({ stage: "project", state: "active" });
      return projectAttention;
    });
    const cancel = deferred<ReturnType<typeof cancelledProjectResponse>>();
    const pick = vi.fn()
      .mockImplementationOnce(() => cancel.promise)
      .mockRejectedValueOnce(new Error("x".repeat(3_000)));
    transport.pickProjectDirectory = pick;
    const controller = createStartupController(transport);
    controller.start();
    await settle();
    const previous = controller.getSnapshot();

    controller.chooseProject();
    controller.chooseProject();
    expect(pick).toHaveBeenCalledOnce();
    expect(states(controller)).toEqual(["complete", "complete", "active"]);
    cancel.resolve(cancelledProjectResponse());
    await settle();

    const restored = controller.getSnapshot();
    expect(restored.status).toBe("needs_attention");
    expect(restored.ledger).toBe(previous.ledger);
    expect(restored.issue).toBe(previous.issue);
    expect(restored.focusTarget).toBe("recovery_action");
    expect(restored.focusRequest).toBeGreaterThan(previous.focusRequest);

    controller.chooseProject();
    await settle();
    const failed = controller.getSnapshot();
    expect(failed.status).toBe("needs_attention");
    expect(failed.issue?.code).toBe("PROJECT_SELECTION_FAILED");
    expect(failed.issue?.technical_detail).toHaveLength(2_048);
    expect(failed.focusTarget).toBe("issue_heading");
    expect(failed.focusRequest).toBeGreaterThan(restored.focusRequest);
  });
});

function cancelledProjectResponse() {
  return {
    status: "cancelled",
    project: null,
    session: {},
    unavailable: null,
    blocker: null,
    reason_code: null,
    message: null,
    restored_root: null,
    restart_required: false,
  } as const;
}
