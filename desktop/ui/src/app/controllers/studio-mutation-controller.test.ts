import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type { SceneEdit, StudioRuntimeSnapshot } from "../../transport";
import type { StudioMutationPorts } from "./studio-mutation-controller";
import { StudioMutationController } from "./studio-mutation-controller";
import { workbenchOperationTrace } from "../operation-trace";

const generatedStudio = fixture.studio_runtime_snapshot as unknown as StudioRuntimeSnapshot;

function harness(status: "ready" | "loading" = "ready") {
  let snapshot = structuredClone(generatedStudio);
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
    apply,
    undo,
    redo,
    report,
    allocateLayoutNodeId: (() => {
      let next = 0;
      return () => `test-node:${next++}`;
    })(),
  };
  return { controller: new StudioMutationController(ports), apply, undo, redo, report };
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
    }));
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
});
