import { describe, expect, it } from "vitest";

import { createMockUiKernelTransport } from "./mock";
import { createTauriUiKernelTransport, type Invoke } from "./tauri";
import type { WorkspacePreparationProgress } from "./types";

const listen = async () => () => undefined;
const utf8Encoder = new TextEncoder();

function runtimeReady(rVersion = "4.5.1") {
  return {
    phase: "runtime_ready",
    busy: false,
    runtime: {
      rscript: "/usr/local/bin/Rscript",
      r_version: rVersion,
      agent_runtime: {
        available: false,
        aisdk_version: null,
        error: null,
      },
    },
    issue: null,
  };
}

function workspaceReady(kernelPid: number | null = 4_321) {
  return {
    status: "idle",
    r_version: "4.5.1",
    r_home: "/Library/Frameworks/R.framework/Resources",
    kernel_pid: kernelPid,
    workspace: { workspace_id: "workspace:fixture" },
    agent_runtime: runtimeReady().runtime.agent_runtime,
    python_required: false,
  };
}

function readyProject(root: string) {
  return {
    status: "ready",
    project: { root, files: [], truncated: false },
    session: {},
    unavailable: null,
    blocker: null,
    reason_code: null,
    message: null,
    restored_root: null,
    restart_required: false,
  };
}

function progressLabel(snapshot: WorkspacePreparationProgress): string {
  return `progress:${snapshot.stage}:${snapshot.state}`;
}

describe("workspace preparation progress", () => {
  it("emits frozen bounded facts in strict command-boundary order without awaiting Agent retry", async () => {
    const events: string[] = [];
    const progress: WorkspacePreparationProgress[] = [];
    const pendingAgentRetry = new Promise<never>(() => undefined);
    const exactLimitRuntimeVersion = "é".repeat(256);
    const longProjectRoot = `/${"😀".repeat(200)}`;
    const invoke: Invoke = <T,>(command: string): Promise<T> => {
      events.push(`command:${command}`);
      if (command === "startup_bootstrap") {
        return Promise.resolve(runtimeReady(exactLimitRuntimeVersion) as T);
      }
      if (command === "workspace_start") {
        return Promise.resolve(workspaceReady(9_876) as T);
      }
      if (command === "agent_runtime_retry") return pendingAgentRetry as Promise<T>;
      if (command === "project_restore_session") {
        return Promise.resolve(readyProject(longProjectRoot) as T);
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    };
    const transport = createTauriUiKernelTransport(invoke, listen);

    await expect(transport.prepareWorkspace(false, (snapshot) => {
      progress.push(snapshot);
      events.push(progressLabel(snapshot));
    })).resolves.toEqual({
      status: "ready",
      phase: "project_ready",
      workspace_ready: true,
      restored_project_status: "ready",
      issue: null,
    });

    expect(events).toEqual([
      "progress:runtime:active",
      "command:startup_bootstrap",
      "progress:runtime:complete",
      "progress:workspace:active",
      "command:workspace_start",
      "progress:workspace:complete",
      "command:agent_runtime_retry",
      "progress:project:active",
      "command:project_restore_session",
      "progress:project:complete",
    ]);
    expect(progress.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
    expect(progress[1]).toMatchObject({ stage: "runtime", state: "complete" });
    expect(progress[3]).toEqual({
      stage: "workspace",
      state: "complete",
      workspace_pid: 9_876,
    });
    expect(progress[5]).toMatchObject({ stage: "project", state: "complete" });

    const runtimeComplete = progress[1];
    const projectComplete = progress[5];
    if (
      runtimeComplete?.stage !== "runtime" || runtimeComplete.state !== "complete" ||
      projectComplete?.stage !== "project" || projectComplete.state !== "complete"
    ) {
      throw new Error("Expected completed runtime and project progress facts");
    }
    expect(runtimeComplete.r_version).toBe(exactLimitRuntimeVersion);
    expect(utf8Encoder.encode(runtimeComplete.r_version).byteLength).toBe(512);
    expect(utf8Encoder.encode(projectComplete.project_root).byteLength).toBeLessThanOrEqual(512);
    expect(projectComplete.project_root).toBe(`/${"😀".repeat(127)}…`);
    expect(projectComplete.project_root?.endsWith("…")).toBe(true);
  });

  it("short-circuits after runtime attention without claiming completion or later stages", async () => {
    const commands: string[] = [];
    const progress: WorkspacePreparationProgress[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command !== "startup_choose_rscript") throw new Error(`unexpected command ${command}`);
      return {
        phase: "needs_attention",
        busy: false,
        runtime: null,
        issue: {
          code: "R_NOT_FOUND",
          title: "R was not found",
          message: "Choose Rscript manually.",
          technical_detail: "No compatible executable was resolved.",
        },
      } as T;
    }, listen);

    const result = await transport.prepareWorkspace(true, (snapshot) => progress.push(snapshot));

    expect(result.status).toBe("needs_attention");
    expect(commands).toEqual(["startup_choose_rscript"]);
    expect(progress).toEqual([{ stage: "runtime", state: "active" }]);
  });

  it("omits invalid or absent Workspace PID facts", async () => {
    for (const invalidPid of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const progress: WorkspacePreparationProgress[] = [];
      const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
        if (command === "startup_bootstrap") return runtimeReady() as T;
        if (command === "workspace_start") return workspaceReady(invalidPid) as T;
        if (command === "agent_runtime_retry") return { available: false } as T;
        if (command === "project_restore_session") return readyProject("/normalized/project") as T;
        throw new Error(`unexpected command ${command}`);
      }, listen);

      await transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot));

      const workspaceComplete = progress.find(
        (snapshot) => snapshot.stage === "workspace" && snapshot.state === "complete",
      );
      expect(workspaceComplete).toEqual({ stage: "workspace", state: "complete" });
      expect(Object.hasOwn(workspaceComplete ?? {}, "workspace_pid")).toBe(false);
    }
  });

  it("normalizes isolated UTF-16 surrogates before exposing progress facts", async () => {
    const progress: WorkspacePreparationProgress[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
      if (command === "startup_bootstrap") return runtimeReady("R-\ud800-version") as T;
      if (command === "workspace_start") return workspaceReady() as T;
      if (command === "agent_runtime_retry") return { available: false } as T;
      if (command === "project_restore_session") return readyProject("/project/\udc00-root") as T;
      throw new Error(`unexpected command ${command}`);
    }, listen);

    await transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot));

    expect(progress[1]).toEqual({
      stage: "runtime",
      state: "complete",
      r_version: "R-�-version",
    });
    expect(progress[5]).toEqual({
      stage: "project",
      state: "complete",
      project_root: "/project/�-root",
    });
  });

  it("short-circuits a rejected Workspace start before completion, Agent retry, or project restore", async () => {
    const commands: string[] = [];
    const progress: WorkspacePreparationProgress[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "startup_bootstrap") return runtimeReady() as T;
      if (command === "workspace_start") throw new Error("Workspace broker unavailable");
      throw new Error(`unexpected command ${command}`);
    }, listen);

    const result = await transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot));

    expect(result).toMatchObject({
      status: "needs_attention",
      phase: "workspace_start_failed",
      workspace_ready: false,
    });
    expect(commands).toEqual(["startup_bootstrap", "workspace_start"]);
    expect(progress.map(progressLabel)).toEqual([
      "progress:runtime:active",
      "progress:runtime:complete",
      "progress:workspace:active",
    ]);
  });

  it("does not claim project completion when restore returns an unavailable project", async () => {
    const progress: WorkspacePreparationProgress[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
      if (command === "startup_bootstrap") return runtimeReady() as T;
      if (command === "workspace_start") return workspaceReady() as T;
      if (command === "agent_runtime_retry") return { available: false } as T;
      if (command === "project_restore_session") return {
        status: "unavailable",
        project: null,
        session: {},
        unavailable: { path: "/missing/project", reason: "Directory does not exist" },
        blocker: null,
        reason_code: null,
        message: null,
        restored_root: null,
        restart_required: false,
      } as T;
      throw new Error(`unexpected command ${command}`);
    }, listen);

    const result = await transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot));

    expect(result).toMatchObject({
      status: "needs_attention",
      phase: "project_restore_incomplete",
      workspace_ready: true,
      restored_project_status: "unavailable",
    });
    expect(progress.map(progressLabel)).toEqual([
      "progress:runtime:active",
      "progress:runtime:complete",
      "progress:workspace:active",
      "progress:workspace:complete",
      "progress:project:active",
    ]);
  });

  it("does not claim project completion when the restore command rejects", async () => {
    const progress: WorkspacePreparationProgress[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
      if (command === "startup_bootstrap") return runtimeReady() as T;
      if (command === "workspace_start") return workspaceReady() as T;
      if (command === "agent_runtime_retry") return { available: false } as T;
      if (command === "project_restore_session") throw new Error("Project store unavailable");
      throw new Error(`unexpected command ${command}`);
    }, listen);

    const result = await transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot));

    expect(result).toMatchObject({
      status: "needs_attention",
      phase: "project_restore_failed",
      workspace_ready: true,
      issue: { technical_detail: "Project store unavailable" },
    });
    expect(progress.map(progressLabel)).toEqual([
      "progress:runtime:active",
      "progress:runtime:complete",
      "progress:workspace:active",
      "progress:workspace:complete",
      "progress:project:active",
    ]);
  });

  it("isolates listener exceptions from commands and final readiness", async () => {
    const commands: string[] = [];
    let listenerCalls = 0;
    const transport = createTauriUiKernelTransport(async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command === "startup_bootstrap") return runtimeReady() as T;
      if (command === "workspace_start") return workspaceReady() as T;
      if (command === "agent_runtime_retry") return { available: false } as T;
      if (command === "project_restore_session") return readyProject("/normalized/project") as T;
      throw new Error(`unexpected command ${command}`);
    }, listen);

    await expect(transport.prepareWorkspace(false, () => {
      listenerCalls += 1;
      throw new Error("observer failed");
    })).resolves.toMatchObject({ status: "ready", phase: "project_ready" });

    expect(listenerCalls).toBe(6);
    expect(commands).toEqual([
      "startup_bootstrap",
      "workspace_start",
      "agent_runtime_retry",
      "project_restore_session",
    ]);
  });

  it("keeps browser/mock progress in the same successful stage order with bounded facts", async () => {
    const longMockRoot = `/${"mock-project/".repeat(60)}`;
    const transport = createMockUiKernelTransport(
      `project=${encodeURIComponent(longMockRoot)}`,
    );
    const progress: WorkspacePreparationProgress[] = [];

    await expect(transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot)))
      .resolves.toMatchObject({ status: "ready", phase: "project_ready" });

    expect(progress.map(progressLabel)).toEqual([
      "progress:runtime:active",
      "progress:runtime:complete",
      "progress:workspace:active",
      "progress:workspace:complete",
      "progress:project:active",
      "progress:project:complete",
    ]);
    expect(progress.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
    expect(progress[1]).toEqual({ stage: "runtime", state: "complete", r_version: "4.5.1" });
    expect(progress[3]).toEqual({ stage: "workspace", state: "complete", workspace_pid: 4_242 });
    const projectComplete = progress[5];
    if (projectComplete?.stage !== "project" || projectComplete.state !== "complete") {
      throw new Error("Expected completed mock project");
    }
    expect(utf8Encoder.encode(projectComplete.project_root).byteLength).toBeLessThanOrEqual(512);
    expect(projectComplete.project_root?.endsWith("…")).toBe(true);
  });

  it("holds each deterministic browser startup frame at its exact active boundary", () => {
    const fixtures = [
      {
        frame: "runtime-active",
        expected: ["progress:runtime:active"],
      },
      {
        frame: "workspace-active",
        expected: [
          "progress:runtime:active",
          "progress:runtime:complete",
          "progress:workspace:active",
        ],
      },
      {
        frame: "project-active",
        expected: [
          "progress:runtime:active",
          "progress:runtime:complete",
          "progress:workspace:active",
          "progress:workspace:complete",
          "progress:project:active",
        ],
      },
    ] as const;

    for (const fixture of fixtures) {
      const progress: WorkspacePreparationProgress[] = [];
      const transport = createMockUiKernelTransport(`startup_frame=${fixture.frame}`);
      const held = transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot));

      expect(held).toBeInstanceOf(Promise);
      expect(progress.map(progressLabel), fixture.frame).toEqual(fixture.expected);
      expect(progress.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
    }
  });

  it("returns a deterministic project-attention browser frame after the truthful prefix", async () => {
    const progress: WorkspacePreparationProgress[] = [];
    const transport = createMockUiKernelTransport("startup_frame=project-attention");

    await expect(transport.prepareWorkspace(false, (snapshot) => progress.push(snapshot)))
      .resolves.toMatchObject({
        status: "needs_attention",
        phase: "project_restore_incomplete",
        workspace_ready: true,
        restored_project_status: "unavailable",
        issue: { code: "PROJECT_RESTORE_INCOMPLETE" },
      });
    expect(progress.map(progressLabel)).toEqual([
      "progress:runtime:active",
      "progress:runtime:complete",
      "progress:workspace:active",
      "progress:workspace:complete",
      "progress:project:active",
    ]);
    expect(progress.every((snapshot) => Object.isFrozen(snapshot))).toBe(true);
  });
});
