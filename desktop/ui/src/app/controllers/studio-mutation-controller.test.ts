import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type { SceneEdit, StudioRuntimeSnapshot } from "../../transport";
import type { StudioMutationPorts } from "./studio-mutation-controller";
import { StudioMutationController } from "./studio-mutation-controller";
import { workbenchOperationTrace } from "../operation-trace";

const generatedStudio = fixture.studio_runtime_snapshot as unknown as StudioRuntimeSnapshot;

function harness(status: "ready" | "loading" = "ready") {
  let snapshot = structuredClone(generatedStudio);
  let admissionOpen = true;
  const report = vi.fn();
  const apply = vi.fn<StudioMutationPorts["apply"]>(async () => {
    snapshot = {
      ...snapshot,
      snapshot_revision: snapshot.snapshot_revision + 1,
      scene: { ...snapshot.scene, layout_revision: snapshot.scene.layout_revision + 1 },
    };
    return snapshot;
  });
  const undo = vi.fn<StudioMutationPorts["undo"]>(async () => snapshot);
  const redo = vi.fn<StudioMutationPorts["redo"]>(async () => snapshot);
  const ports: StudioMutationPorts = {
    getStudio: () => status === "ready"
      ? { status: "ready", source: "mock", snapshot }
      : { status: "loading" },
    admit: async (projectId, operation) => {
      if (!admissionOpen) throw new Error("Project transition is in progress.");
      return operation({ projectId, admissionEpoch: 0 });
    },
    apply,
    undo,
    redo,
    captureReport: () => report,
    allocateLayoutNodeId: (() => {
      let next = 0;
      return () => `test-node:${next++}`;
    })(),
  };
  return {
    controller: new StudioMutationController(ports),
    apply,
    undo,
    redo,
    report,
    setAdmissionOpen: (open: boolean) => { admissionOpen = open; },
  };
}

const focusEdit = (instanceId: string): SceneEdit => ({ kind: "set_focus", instance_id: instanceId });

describe("Studio mutation controller", () => {
  afterEach(() => workbenchOperationTrace.reset());

  it("serializes edits and constructs each request from the latest revision", async () => {
    const current = harness();
    const first = current.controller.commit(focusEdit("instance:file-source"));
    const second = current.controller.commit(focusEdit("instance:console-a"));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(current.apply).toHaveBeenCalledTimes(2);
    const firstRequest = current.apply.mock.calls[0]![0];
    const secondRequest = current.apply.mock.calls[1]![0];
    expect(secondRequest.expected_layout_revision).toBe(firstRequest.expected_layout_revision + 1);
  });

  it("computes one ordinary replace-root edit for a valid drop", async () => {
    const current = harness();
    await expect(current.controller.drop("instance:console-a", {
      nodeId: "node:navigator",
      instanceId: "instance:navigator",
      zone: "right",
    })).resolves.toBe(true);
    expect(current.apply).toHaveBeenCalledWith(expect.objectContaining({
      edit: expect.objectContaining({ kind: "replace_root" }),
    }), expect.anything());
  });

  it("treats a self-drop and an unready Studio as no-op admissions", async () => {
    const ready = harness();
    await expect(ready.controller.drop("instance:navigator", {
      nodeId: "node:navigator",
      instanceId: "instance:navigator",
      zone: "center",
    })).resolves.toBe(false);
    expect(ready.apply).not.toHaveBeenCalled();

    const loading = harness("loading");
    await expect(loading.controller.commit(focusEdit("instance:file-source"))).resolves.toBe(false);
    expect(loading.apply).not.toHaveBeenCalled();
  });

  it("reports an apply rejection and keeps the queue recoverable", async () => {
    const current = harness();
    current.apply
      .mockRejectedValueOnce(new Error("stale layout revision"))
      .mockResolvedValueOnce(structuredClone(generatedStudio));
    await expect(current.controller.commit(focusEdit("instance:file-source"))).resolves.toBe(false);
    await expect(current.controller.commit(focusEdit("instance:console-a"))).resolves.toBe(true);
    expect(current.report).toHaveBeenCalledWith("stale layout revision");
    expect(current.apply).toHaveBeenCalledTimes(2);
  });

  it("binds each queued failure to the reporter captured at admission", async () => {
    let snapshot = structuredClone(generatedStudio);
    let rejectA: ((reason?: unknown) => void) | undefined;
    const reportA = vi.fn();
    const reportB = vi.fn();
    let currentReport = reportA;
    const apply = vi.fn<StudioMutationPorts["apply"]>()
      .mockImplementationOnce(() => new Promise<StudioRuntimeSnapshot>((_resolve, reject) => {
        rejectA = reject;
      }))
      .mockRejectedValueOnce(new Error("project B failure"));
    const ports: StudioMutationPorts = {
      getStudio: () => ({ status: "ready", source: "mock", snapshot }),
      admit: async (projectId, operation) => operation({ projectId, admissionEpoch: 0 }),
      apply,
      undo: vi.fn(async () => snapshot),
      redo: vi.fn(async () => snapshot),
      captureReport: () => currentReport,
      allocateLayoutNodeId: () => "test-node",
    };
    const controller = new StudioMutationController(ports);
    const first = controller.commit(focusEdit("instance:file-source"));
    currentReport = reportB;
    await vi.waitFor(() => expect(rejectA).toBeTypeOf("function"));
    rejectA?.(new Error("project A failure"));
    await expect(first).resolves.toBe(false);
    expect(reportA).toHaveBeenCalledWith("project A failure");
    expect(reportB).not.toHaveBeenCalled();

    snapshot = { ...snapshot, project_revision: snapshot.project_revision + 1 };
    await expect(controller.commit(focusEdit("instance:console-a"))).resolves.toBe(false);
    expect(reportB).toHaveBeenCalledWith("project B failure");
  });

  it("admits undo and redo through the same latest-revision queue", async () => {
    const current = harness();
    await expect(current.controller.undo()).resolves.toBe(true);
    await expect(current.controller.redo()).resolves.toBe(true);
    expect(current.undo).toHaveBeenCalledTimes(1);
    expect(current.redo).toHaveBeenCalledTimes(1);
    expect(current.undo.mock.calls[0]![0]).toMatchObject({
      expected_layout_revision: generatedStudio.scene.layout_revision,
    });
  });

  it("drains every pre-close queue entry after rejection and recovers after reopen", async () => {
    const current = harness();
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    let resolveSecond: ((snapshot: StudioRuntimeSnapshot) => void) | undefined;
    current.apply
      .mockImplementationOnce(() => new Promise<StudioRuntimeSnapshot>((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce(() => new Promise<StudioRuntimeSnapshot>((resolve) => {
        resolveSecond = resolve;
      }));

    const first = current.controller.commit(focusEdit("instance:file-source"));
    const second = current.controller.commit(focusEdit("instance:console-a"));
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    current.setAdmissionOpen(false);

    const rejectedAfterClose = current.controller.commit(focusEdit("instance:agent-shared"));
    await expect(rejectedAfterClose).resolves.toBe(false);
    expect(current.apply).toHaveBeenCalledTimes(1);

    let settled = false;
    const waiting = current.controller.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    rejectFirst?.(new Error("first admitted edit failed"));
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(resolveSecond).toBeTypeOf("function"));
    expect(current.apply).toHaveBeenCalledTimes(2);
    expect(current.apply.mock.calls.map(([request]) => request.edit)).toEqual([
      focusEdit("instance:file-source"),
      focusEdit("instance:console-a"),
    ]);
    expect(settled).toBe(false);

    resolveSecond?.(structuredClone(generatedStudio));
    await expect(second).resolves.toBe(true);
    await waiting;
    expect(settled).toBe(true);
    expect(current.report).toHaveBeenCalledWith("first admitted edit failed");

    current.setAdmissionOpen(true);
    await expect(current.controller.commit(focusEdit("instance:agent-shared"))).resolves.toBe(true);
    expect(current.apply).toHaveBeenCalledTimes(3);
  });
});
