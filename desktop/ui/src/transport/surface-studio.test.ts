import { describe, expect, it } from "vitest";

import { createMockUiKernelTransport } from "./mock";
import {
  createTauriSurfaceStudioTransport,
  type OpenSurfaceRequest,
  type RuntimeAttachmentRequest,
  type SceneEditRequest,
  type StudioRuntimeSnapshot,
  type SurfaceInstanceRequest,
  type SurfaceRuntimeSnapshot,
  type SurfaceStudioTransport,
  type UpdateSurfaceRequest,
} from "./surface-studio";

const surfaceSnapshot = {
  contract: "rho.ui.surface-runtime.snapshot.v1",
  contract_major: 1,
  snapshot_revision: 5,
  project_id: "project-a",
  project_revision: 7,
  catalog: { factories: [], instances: [] },
} satisfies SurfaceRuntimeSnapshot;

const studioSnapshot = {
  contract: "rho.ui.studio-runtime.snapshot.v1",
  contract_major: 1,
  snapshot_revision: 11,
  project_id: "project-a",
  project_revision: 7,
  scene: {
    scene_id: "scene.main",
    project_id: "project-a",
    label: "Studio",
    layout_revision: 13,
    root: {
      kind: "container",
      node_id: "layout.root",
      axis: "horizontal",
      children: [],
    },
    focused_surface_instance_id: null,
    utility_tray: null,
  },
  unplaced_instance_ids: [],
  can_undo: false,
  can_redo: false,
} satisfies StudioRuntimeSnapshot;

const target = {
  project_id: "project-a",
  instance_id: "surface.console",
  activation_generation: 3,
  expected_project_revision: 7,
  expected_surface_revision: 17,
} satisfies SurfaceInstanceRequest;

describe("Surface and Studio generated transport", () => {
  it("owns all twelve command identities and preserves request nesting", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, ...(args === undefined ? {} : { args }) });
      return (command.startsWith("studio_") ? studioSnapshot : surfaceSnapshot) as T;
    };
    const transport = createTauriSurfaceStudioTransport(invoke);
    const open = {
      surface_id: "rho.console",
      project_id: "project-a",
      mode_id: null,
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: { selection: [1, 2] },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: 7,
      expected_layout_revision: 13,
    } satisfies OpenSurfaceRequest;
    const update = {
      target,
      mutation: { kind: "set_view_state", view_state: { zoom: 1.25 } },
    } satisfies UpdateSurfaceRequest;
    const edit = {
      project_id: "project-a",
      expected_project_revision: 7,
      expected_layout_revision: 13,
      edit: { kind: "normalize" },
    } satisfies SceneEditRequest;
    const revision = {
      project_id: "project-a",
      expected_project_revision: 7,
      expected_layout_revision: 13,
    };
    const attachment = {
      runtime: {
        project_id: "project-a",
        runtime_provider_id: "rho.ark-r",
        runtime_instance_id: "runtime.workspace-r",
        activation_generation: 2,
        expected_project_revision: 7,
        expected_state_revision: 19,
      },
      surface: target,
    } satisfies RuntimeAttachmentRequest;

    await transport.loadSurfaces();
    await transport.openSurface(open);
    await transport.updateSurface(update);
    await transport.closeSurface(target);
    await transport.suspendSurface(target);
    await transport.resumeSurface(target);
    await transport.loadStudio();
    await transport.applyStudio(edit);
    await transport.undoStudio(revision);
    await transport.redoStudio(revision);
    await transport.attachRuntime(attachment);
    await transport.detachRuntime({ surface: target });

    expect(calls).toEqual([
      { command: "surface_list" },
      { command: "surface_open", args: { request: open } },
      { command: "surface_update", args: { request: update } },
      { command: "surface_close", args: { request: target } },
      { command: "surface_suspend", args: { request: target } },
      { command: "surface_resume", args: { request: target } },
      { command: "studio_scene" },
      { command: "studio_apply", args: { request: edit } },
      { command: "studio_undo", args: { request: revision } },
      { command: "studio_redo", args: { request: revision } },
      { command: "runtime_attach", args: { request: attachment } },
      { command: "runtime_detach", args: { request: { surface: target } } },
    ]);
  });

  it("preserves rejection semantics and rejects an unknown snapshot contract", async () => {
    const rejected = createTauriSurfaceStudioTransport(async () => {
      throw new Error("stale layout revision");
    });
    await expect(rejected.applyStudio({
      project_id: "project-a",
      expected_project_revision: 7,
      expected_layout_revision: 12,
      edit: { kind: "normalize" },
    })).rejects.toThrow("stale layout revision");

    const incompatible = createTauriSurfaceStudioTransport(async <T,>() => ({
      ...surfaceSnapshot,
      contract_major: 2,
    }) as T);
    await expect(incompatible.loadSurfaces()).rejects.toThrow("unsupported contract version");
  });

  it("keeps browser/mock mode assignable to the narrow domain facet", async () => {
    const transport: SurfaceStudioTransport = createMockUiKernelTransport();
    await expect(transport.loadSurfaces()).resolves.toMatchObject({
      contract: "rho.ui.surface-runtime.snapshot.v1",
    });
    await expect(transport.loadStudio()).resolves.toMatchObject({
      contract: "rho.ui.studio-runtime.snapshot.v1",
    });
  });
});
