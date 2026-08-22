import { describe, expect, it, vi } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { createMockUiKernelTransport } from "./mock";
import { ResourceExternalStore, RuntimeExternalStore, StudioExternalStore, SurfaceExternalStore, UiExternalStore, UiProfileExternalStore } from "./store";
import { createTauriUiKernelTransport } from "./tauri";
import type {
  OpenSurfaceRequest,
  ProjectUiProfileSnapshot,
  ResourceRegistrySnapshot,
  RuntimeRegistrySnapshot,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  StudioRuntimeSnapshot,
  UiKernelSnapshot,
} from "./types";

function generated(): UiKernelSnapshot {
  return structuredClone(fixture.kernel_snapshot) as unknown as UiKernelSnapshot;
}

function generatedSurfaces(): SurfaceRuntimeSnapshot {
  return structuredClone(
    fixture.surface_runtime_snapshot,
  ) as unknown as SurfaceRuntimeSnapshot;
}

function generatedStudio(): StudioRuntimeSnapshot {
  return structuredClone(
    fixture.studio_runtime_snapshot,
  ) as unknown as StudioRuntimeSnapshot;
}

function generatedRuntimes(): RuntimeRegistrySnapshot {
  return structuredClone(
    fixture.runtime_registry_snapshot,
  ) as unknown as RuntimeRegistrySnapshot;
}

function generatedResources(): ResourceRegistrySnapshot {
  return structuredClone(
    fixture.resource_registry_snapshot,
  ) as unknown as ResourceRegistrySnapshot;
}

function generatedProfile(): ProjectUiProfileSnapshot {
  return structuredClone(
    fixture.project_ui_profile_snapshot,
  ) as unknown as ProjectUiProfileSnapshot;
}

describe("UI Kernel transport and external store", () => {
  it("loads the exact Rust-generated command registry in mock mode", async () => {
    const transport = createMockUiKernelTransport(
      "?project=%2Ftmp%2F%E7%A7%91%E5%AD%A6%20Project",
    );
    const snapshot = await transport.loadSnapshot();
    expect(snapshot.project.display_label).toBe("科学 Project");
    expect(snapshot.command_registry.registrations).toEqual(
      fixture.kernel_snapshot.command_registry.registrations,
    );
    expect(
      snapshot.command_registry.registrations.find(
        (registration) => registration.definition.command_id === "ui.command.fixture-inspect",
      )?.definition.origin,
    ).toEqual({
      kind: "workspace_plugin",
      plugin_id: "fixture-plugin",
      package_digest: "a".repeat(64),
    });
  });

  it("caches immutable snapshots without tearing and ignores stale responses", async () => {
    const transport = createMockUiKernelTransport();
    const store = new UiExternalStore(transport);
    const changes = vi.fn();
    const unsubscribe = store.subscribe(changes);
    await store.refresh();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("snapshot did not load");
    expect(Object.isFrozen(first.snapshot)).toBe(true);

    const stale = generated();
    (stale as { snapshot_revision: number }).snapshot_revision =
      first.snapshot.snapshot_revision - 1;
    transport.publish(stale);
    await store.refresh();
    expect(store.getSnapshot()).toBe(first);
    unsubscribe();
  });

  it("accepts a monotonic project A/B/A sequence", async () => {
    const transport = createMockUiKernelTransport();
    const store = new UiExternalStore(transport);
    const unsubscribe = store.subscribe(() => undefined);
    await store.refresh();
    const base = generated();
    for (const [revision, project] of [
      [10, "project:a"],
      [11, "project:b"],
      [12, "project:a"],
    ] as const) {
      const next = structuredClone(base);
      (next as { snapshot_revision: number }).snapshot_revision = revision;
      const mutableProject = next.project as {
        project_id: string;
        display_label: string;
        display_path: string;
      };
      mutableProject.project_id = project;
      mutableProject.display_label = project;
      mutableProject.display_path = `/tmp/${project}`;
      (next.context as { project_id: string }).project_id = project;
      transport.publish(next);
      await store.refresh();
      const state = store.getSnapshot();
      expect(state.status).toBe("ready");
      if (state.status === "ready") expect(state.snapshot.project.project_id).toBe(project);
    }
    const final = store.getSnapshot();
    if (final.status !== "ready") throw new Error("final snapshot is unavailable");
    expect(final.snapshot.snapshot_revision).toBe(12);
    unsubscribe();
  });

  it("keeps Project UI Profile mode and Scene mutations CAS-safe", async () => {
    const transport = createMockUiKernelTransport();
    const store = new UiProfileExternalStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("UI Profile fixture did not load");
    const base = state.snapshot.profile;
    await expect(store.setMode({
      target: {
        project_id: base.project_id,
        expected_profile_revision: base.revision - 1,
      },
      mode: "vibe",
    })).rejects.toThrow(/stale/i);
    let snapshot = await store.setMode({
      target: { project_id: base.project_id, expected_profile_revision: base.revision },
      mode: "vibe",
    });
    expect(snapshot.profile.active_mode).toBe("vibe");
    snapshot = await store.duplicateScene({
      target: {
        project_id: snapshot.profile.project_id,
        expected_profile_revision: snapshot.profile.revision,
      },
      scene_id: snapshot.profile.active_studio_scene_id!,
      label: "科学布局副本",
    });
    const duplicateId = snapshot.profile.active_studio_scene_id!;
    expect(snapshot.profile.studio_scenes.find((scene) => scene.scene_id === duplicateId)?.label)
      .toBe("科学布局副本");
    snapshot = await store.renameScene({
      target: {
        project_id: snapshot.profile.project_id,
        expected_profile_revision: snapshot.profile.revision,
      },
      scene_id: duplicateId,
      label: "自由布局",
    });
    snapshot = await store.resetScene({
      target: {
        project_id: snapshot.profile.project_id,
        expected_profile_revision: snapshot.profile.revision,
      },
      scene_id: duplicateId,
    });
    expect(snapshot.profile.studio_scenes.find((scene) => scene.scene_id === duplicateId)?.label)
      .toBe("自由布局");
    snapshot = await store.deleteScene({
      target: {
        project_id: snapshot.profile.project_id,
        expected_profile_revision: snapshot.profile.revision,
      },
      scene_id: duplicateId,
    });
    expect(snapshot.profile.studio_scenes).toHaveLength(1);
    expect(snapshot.profile.active_studio_scene_id).toBe(base.active_studio_scene_id);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    stop();
  });

  it("separates shared documents from immutable previews across repeated file views", async () => {
    const transport = createMockUiKernelTransport();
    const store = new ResourceExternalStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("Resource fixture did not load");
    const descriptor = state.snapshot.resources[0]!;
    const target = {
      project_id: descriptor.project_id,
      resource_provider_id: descriptor.resource_provider_id,
      resource_kind: descriptor.resource_kind,
      resource_id: descriptor.resource_id,
      expected_project_revision: state.snapshot.project_revision,
      expected_resource_revision: descriptor.resource_revision,
    };
    const sharedA = await store.read({ target, consistency: "shared_document" });
    const sharedB = await store.read({ target, consistency: "shared_document" });
    expect(sharedA.document_revision).toBe(sharedB.document_revision);
    const preview = await store.read({ target, consistency: "immutable_snapshot" });
    const draft = await store.updateDraft({
      target,
      expected_document_revision: sharedA.document_revision,
      content: "draft <- TRUE\n",
    });
    const sharedFromSibling = await store.read({ target, consistency: "shared_document" });
    expect(sharedFromSibling.content).toBe("draft <- TRUE\n");
    expect(sharedFromSibling.document_revision).toBe(draft.document_revision);
    const saved = await store.save({
      target,
      expected_document_revision: draft.document_revision,
    });
    expect(saved.descriptor.resource_revision).toBe(descriptor.resource_revision + 1);
    expect(preview.content).not.toBe(saved.content);
    const surfaces = await transport.loadSurfaces();
    expect(
      surfaces.catalog.instances.find((surface) => surface.instance_id === "instance:file-source")
        ?.resource_binding?.resource_revision,
    ).toBe(saved.descriptor.resource_revision);
    expect(
      surfaces.catalog.instances.find((surface) => surface.instance_id === "instance:file-preview")
        ?.resource_binding?.resource_revision,
    ).toBe(descriptor.resource_revision);
    await expect(store.read({ target, consistency: "immutable_snapshot" })).rejects.toThrow(/stale/i);
    stop();
  });

  it("keeps duplicate source view state independent while rename and delete preserve Resource truth", async () => {
    const transport = createMockUiKernelTransport();
    let surfaces = await transport.loadSurfaces();
    const studio = await transport.loadStudio();
    const source = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === "instance:file-source"
    )!;
    const request: OpenSurfaceRequest = {
      surface_id: "rho.file-source",
      project_id: surfaces.project_id,
      mode_id: "source",
      resource_binding: source.resource_binding,
      runtime_binding: null,
      view_group_id: null,
      view_state: { cursor_start: 90, cursor_end: 90, scroll_top: 120 },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    };
    surfaces = await transport.openSurface(request);
    const duplicate = surfaces.catalog.instances.at(-1)!;
    expect(duplicate.surface_id).toBe("rho.file-source");
    expect(duplicate.resource_binding).toEqual(source.resource_binding);
    expect(duplicate.view_state).not.toEqual(source.view_state);
    const targetSurface = (surface: typeof source) => ({
      project_id: surface.project_id,
      instance_id: surface.instance_id,
      activation_generation: surface.activation_generation,
      expected_project_revision: surfaces.project_revision,
      expected_surface_revision: surface.surface_revision,
    });
    surfaces = await transport.updateSurface({
      target: targetSurface(source),
      mutation: { kind: "set_view_group", view_group_id: "analysis-sync" },
    });
    const groupedSource = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === source.instance_id
    )!;
    const ungroupedDuplicate = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === duplicate.instance_id
    )!;
    surfaces = await transport.updateSurface({
      target: targetSurface(ungroupedDuplicate),
      mutation: { kind: "set_view_group", view_group_id: "analysis-sync" },
    });
    const currentSource = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === source.instance_id
    )!;
    surfaces = await transport.updateSurface({
      target: targetSurface(currentSource),
      mutation: {
        kind: "set_view_state",
        view_state: { cursor_start: 12, cursor_end: 12, scroll_top: 240 },
      },
    });
    expect(
      surfaces.catalog.instances.filter((surface) =>
        surface.instance_id === source.instance_id || surface.instance_id === duplicate.instance_id
      ).map((surface) => surface.view_state),
    ).toEqual([
      { cursor_start: 12, cursor_end: 12, scroll_top: 240 },
      { cursor_start: 12, cursor_end: 12, scroll_top: 240 },
    ]);
    expect(groupedSource.view_state).not.toEqual(ungroupedDuplicate.view_state);

    let resources = await transport.loadResources();
    const descriptor = resources.resources[0]!;
    const target = {
      project_id: descriptor.project_id,
      resource_provider_id: descriptor.resource_provider_id,
      resource_kind: descriptor.resource_kind,
      resource_id: descriptor.resource_id,
      expected_project_revision: resources.project_revision,
      expected_resource_revision: descriptor.resource_revision,
    };
    const renamed = await transport.renameResource({
      target,
      expected_document_revision: null,
      new_resource_id: "R/renamed.R",
    });
    expect(renamed.resources.map((resource) => resource.resource_id)).toEqual(["R/renamed.R"]);
    surfaces = await transport.loadSurfaces();
    expect(surfaces.catalog.instances.filter((surface) =>
      surface.resource_binding?.resource_id === "R/renamed.R"
    ).length).toBeGreaterThanOrEqual(3);
    resources = await transport.deleteResource({
      target: {
        ...target,
        resource_id: "R/renamed.R",
        expected_resource_revision: 1,
      },
      expected_document_revision: null,
      discard_dirty: false,
    });
    expect(resources.resources[0]?.status).toBe("missing");
    expect((await transport.loadStudio()).scene.root).toEqual(studio.scene.root);
  });

  it("uses Tauri snapshot and event APIs behind the same interface", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const handlers = new Map<string, () => void>();
    const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args == null ? { command } : { command, args });
      return (command.startsWith("ui_profile")
        ? generatedProfile()
        : command.startsWith("resource_")
        ? ["resource_read", "resource_update_draft", "resource_save", "resource_reload"].includes(command)
          ? {
              contract: "rho.ui.resource-content.v1",
              descriptor: generatedResources().resources[0],
              consistency: "shared_document",
              document_revision: 1,
              base_resource_revision: 4,
              dirty: false,
              stale: false,
              content_encoding: "utf-8",
              content: "1 + 1\n",
            }
          : generatedResources()
        : command.startsWith("runtime_")
        ? command === "runtime_attach" || command === "runtime_detach"
          ? generatedSurfaces()
          : command === "runtime_execute"
            ? {
                execution_id: "runtime-execution:test",
                runtime_instance_id: "runtime:workspace-r",
                runtime_activation_generation: 1,
                console_instance_id: "instance:console-a",
                state_revision_after: 13,
                status: "completed",
                events: [],
              }
            : generatedRuntimes()
        : command === "plugin_surface_document"
        ? {
            project_id: "project:fixture",
            instance_id: "instance:playground-a",
            surface_id: "ui.surface.fixture",
            surface_revision: 1,
            document: {
              contract: "rho.plugin_surface_document.v1",
              revision: 1,
              title: "Fixture",
              blocks: [],
            },
            provenance: {},
          }
        : command === "plugin_surface_event"
        ? {
            event_id: "surface-event:fixture",
            status: "completed",
            document: null,
            command_result: null,
            provenance: {},
          }
        : command === "check_project_run"
        ? { result: {} }
        : command === "check_result"
        ? {}
        : command.startsWith("surface_")
        ? generatedSurfaces()
        : command.startsWith("studio_")
          ? generatedStudio()
          : generated()) as T;
    };
    const transport = createTauriUiKernelTransport(invoke, async (event, handler) => {
      handlers.set(event, () => handler({ payload: undefined as never }));
      return () => handlers.delete(event);
    });
    await transport.loadSnapshot();
    await transport.setSelection({
      project_id: "project:fixture",
      expected_project_revision: 7,
      expected_snapshot_revision: 9,
      selection: null,
    });
    const open: OpenSurfaceRequest = {
      surface_id: "rho.surface-playground",
      project_id: "project:fixture",
      mode_id: "notes",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {},
      instance_disposition: "new_instance",
      placement_intent: "current",
      expected_project_revision: 7,
      expected_layout_revision: 1,
    };
    const target: SurfaceInstanceRequest = {
      project_id: "project:fixture",
      instance_id: "instance:playground-a",
      activation_generation: 1,
      expected_project_revision: 7,
      expected_surface_revision: 1,
    };
    await transport.loadSurfaces();
    await transport.openSurface(open);
    await transport.updateSurface({
      target,
      mutation: { kind: "set_view_state", view_state: { draft: "changed" } },
    });
    await transport.closeSurface(target);
    await transport.suspendSurface(target);
    await transport.resumeSurface(target);
    const pluginDocumentRequest = {
      target,
      expected_layout_revision: 1,
      expected_page_revision: null,
    } as const;
    await transport.loadPluginSurfaceDocument(pluginDocumentRequest);
    await transport.dispatchPluginSurfaceEvent({
      ...pluginDocumentRequest,
      expected_document_revision: 1,
      control_id: "apply",
      event_kind: "activate",
      value: "",
    });
    const checkRunRequest = {
      project_id: "project:fixture",
      expected_project_revision: 7,
    } as const;
    await transport.runCheckProject(checkRunRequest);
    await transport.loadCheckResult({
      ...checkRunRequest,
      result_id: "check-result:fixture",
    });
    const studioRequest = {
      project_id: "project:fixture",
      expected_project_revision: 7,
      expected_layout_revision: 1,
    } as const;
    await transport.loadStudio();
    await transport.applyStudio({
      ...studioRequest,
      edit: { kind: "set_focus", instance_id: "instance:file-source" },
    });
    await transport.undoStudio(studioRequest);
    await transport.redoStudio(studioRequest);
    const profileTarget = {
      project_id: "project:fixture",
      expected_profile_revision: 5,
    } as const;
    await transport.loadUiProfile();
    await transport.setUiProfileMode({ target: profileTarget, mode: "vibe" });
    await transport.selectUiProfileScene({ target: profileTarget, scene_id: "scene:rho-studio" });
    await transport.selectUiProfilePage({ target: profileTarget, page_id: "page:project-review" });
    await transport.duplicateUiProfileScene({ target: profileTarget, scene_id: "scene:rho-studio", label: "Copy" });
    await transport.saveUiProfileScene({ target: profileTarget, scene_id: "scene:rho-studio" });
    await transport.renameUiProfileScene({ target: profileTarget, scene_id: "scene:rho-studio", label: "Renamed" });
    await transport.deleteUiProfileScene({ target: profileTarget, scene_id: "scene:rho-studio" });
    await transport.resetUiProfileScene({ target: profileTarget, scene_id: "scene:rho-studio" });
    const runtimeTarget = {
      project_id: "project:fixture",
      runtime_provider_id: "rho.ark-r",
      runtime_instance_id: "runtime:workspace-r",
      activation_generation: 1,
      expected_project_revision: 7,
      expected_state_revision: 12,
    } as const;
    const attachment = { runtime: runtimeTarget, surface: target } as const;
    const createRuntime = {
      project_id: "project:fixture",
      runtime_provider_id: "rho.ark-r",
      expected_project_revision: 7,
      expected_snapshot_revision: 4,
      display_label: null,
    } as const;
    await transport.loadRuntimes();
    await transport.createRuntime(createRuntime);
    await transport.attachRuntime(attachment);
    await transport.detachRuntime({ surface: target });
    await transport.interruptRuntime(runtimeTarget);
    await transport.restartRuntime(runtimeTarget);
    await transport.stopRuntime(runtimeTarget);
    await transport.executeRuntime({
      runtime: runtimeTarget,
      console_instance_id: "instance:console-a",
      expected_console_revision: 1,
      code: "1 + 1",
    });
    const resourceDescriptor = generatedResources().resources[0]!;
    const resourceTarget = {
      project_id: resourceDescriptor.project_id,
      resource_provider_id: resourceDescriptor.resource_provider_id,
      resource_kind: resourceDescriptor.resource_kind,
      resource_id: resourceDescriptor.resource_id,
      expected_project_revision: 7,
      expected_resource_revision: 4,
    } as const;
    const resourceResolve = {
      project_id: resourceDescriptor.project_id,
      resource_provider_id: resourceDescriptor.resource_provider_id,
      resource_kind: resourceDescriptor.resource_kind,
      resource_id: resourceDescriptor.resource_id,
      expected_project_revision: 7,
      expected_snapshot_revision: 3,
    } as const;
    await transport.loadResources();
    await transport.resolveResource(resourceResolve);
    await transport.readResource({ target: resourceTarget, consistency: "shared_document" });
    await transport.updateResourceDraft({
      target: resourceTarget,
      expected_document_revision: 1,
      content: "draft\n",
    });
    await transport.saveResource({ target: resourceTarget, expected_document_revision: 1 });
    await transport.reloadResource({
      target: resourceTarget,
      expected_document_revision: 1,
      discard_dirty: false,
    });
    await transport.renameResource({
      target: resourceTarget,
      expected_document_revision: 1,
      new_resource_id: "renamed.R",
    });
    await transport.deleteResource({
      target: resourceTarget,
      expected_document_revision: 1,
      discard_dirty: false,
    });
    const invalidated = vi.fn();
    const stop = transport.subscribeInvalidated(invalidated);
    await Promise.resolve();
    handlers.get("rho://ui-snapshot-invalidated")?.();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { command: "ui_kernel_snapshot" },
      {
        command: "ui_set_selection",
        args: {
          request: {
            project_id: "project:fixture",
            expected_project_revision: 7,
            expected_snapshot_revision: 9,
            selection: null,
          },
        },
      },
      { command: "surface_list" },
      { command: "surface_open", args: { request: open } },
      {
        command: "surface_update",
        args: {
          request: {
            target,
            mutation: { kind: "set_view_state", view_state: { draft: "changed" } },
          },
        },
      },
      { command: "surface_close", args: { request: target } },
      { command: "surface_suspend", args: { request: target } },
      { command: "surface_resume", args: { request: target } },
      {
        command: "plugin_surface_document",
        args: { request: pluginDocumentRequest },
      },
      {
        command: "plugin_surface_event",
        args: {
          request: {
            ...pluginDocumentRequest,
            expected_document_revision: 1,
            control_id: "apply",
            event_kind: "activate",
            value: "",
          },
        },
      },
      { command: "check_project_run", args: { request: checkRunRequest } },
      {
        command: "check_result",
        args: { request: { ...checkRunRequest, result_id: "check-result:fixture" } },
      },
      { command: "studio_scene" },
      {
        command: "studio_apply",
        args: {
          request: {
            ...studioRequest,
            edit: { kind: "set_focus", instance_id: "instance:file-source" },
          },
        },
      },
      { command: "studio_undo", args: { request: studioRequest } },
      { command: "studio_redo", args: { request: studioRequest } },
      { command: "ui_profile_snapshot" },
      { command: "ui_profile_set_mode", args: { request: { target: profileTarget, mode: "vibe" } } },
      { command: "ui_profile_select_scene", args: { request: { target: profileTarget, scene_id: "scene:rho-studio" } } },
      { command: "ui_profile_select_page", args: { request: { target: profileTarget, page_id: "page:project-review" } } },
      { command: "ui_profile_scene_duplicate", args: { request: { target: profileTarget, scene_id: "scene:rho-studio", label: "Copy" } } },
      { command: "ui_profile_scene_save", args: { request: { target: profileTarget, scene_id: "scene:rho-studio" } } },
      { command: "ui_profile_scene_rename", args: { request: { target: profileTarget, scene_id: "scene:rho-studio", label: "Renamed" } } },
      { command: "ui_profile_scene_delete", args: { request: { target: profileTarget, scene_id: "scene:rho-studio" } } },
      { command: "ui_profile_scene_reset", args: { request: { target: profileTarget, scene_id: "scene:rho-studio" } } },
      { command: "runtime_list" },
      { command: "runtime_create", args: { request: createRuntime } },
      { command: "runtime_attach", args: { request: attachment } },
      { command: "runtime_detach", args: { request: { surface: target } } },
      { command: "runtime_interrupt", args: { request: runtimeTarget } },
      { command: "runtime_restart", args: { request: runtimeTarget } },
      { command: "runtime_stop", args: { request: runtimeTarget } },
      {
        command: "runtime_execute",
        args: {
          request: {
            runtime: runtimeTarget,
            console_instance_id: "instance:console-a",
            expected_console_revision: 1,
            code: "1 + 1",
          },
        },
      },
      { command: "resource_list" },
      { command: "resource_resolve", args: { request: resourceResolve } },
      {
        command: "resource_read",
        args: { request: { target: resourceTarget, consistency: "shared_document" } },
      },
      {
        command: "resource_update_draft",
        args: {
          request: {
            target: resourceTarget,
            expected_document_revision: 1,
            content: "draft\n",
          },
        },
      },
      {
        command: "resource_save",
        args: { request: { target: resourceTarget, expected_document_revision: 1 } },
      },
      {
        command: "resource_reload",
        args: {
          request: {
            target: resourceTarget,
            expected_document_revision: 1,
            discard_dirty: false,
          },
        },
      },
      {
        command: "resource_rename",
        args: {
          request: {
            target: resourceTarget,
            expected_document_revision: 1,
            new_resource_id: "renamed.R",
          },
        },
      },
      {
        command: "resource_delete",
        args: {
          request: {
            target: resourceTarget,
            expected_document_revision: 1,
            discard_dirty: false,
          },
        },
      },
    ]);
    stop();
  });

  it("keeps the mock Surface command lane in lockstep with instance semantics", async () => {
    const transport = createMockUiKernelTransport();
    const store = new SurfaceExternalStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("Surface fixture did not load");
    const initial = state.snapshot.catalog.instances.length;
    const request: OpenSurfaceRequest = {
      surface_id: "rho.surface-playground",
      project_id: state.snapshot.project_id,
      mode_id: "notes",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: { fixture: true },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: state.snapshot.project_revision,
      expected_layout_revision: (await transport.loadStudio()).scene.layout_revision,
    };
    const opened = await store.open(request);
    expect(opened.catalog.instances).toHaveLength(initial + 1);
    const second = await store.open(request);
    expect(second.catalog.instances).toHaveLength(initial + 2);
    const reuse = await store.open({ ...request, instance_disposition: "reuse_exact" });
    expect(reuse.snapshot_revision).toBe(second.snapshot_revision);
    const created = reuse.catalog.instances.find(
      (instance) => instance.instance_id === "surface-instance:mock-1",
    );
    if (created == null) throw new Error("mock host did not allocate an instance ID");
    const closed = await store.close({
      project_id: reuse.project_id,
      instance_id: created.instance_id,
      activation_generation: created.activation_generation,
      expected_project_revision: reuse.project_revision,
      expected_surface_revision: created.surface_revision,
    });
    expect(closed.catalog.instances).toHaveLength(initial + 1);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    stop();
  });

  it("keeps Studio edits stale-safe, undoable, and reconciled with Surface availability", async () => {
    const transport = createMockUiKernelTransport();
    const store = new StudioExternalStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("Studio fixture did not load");
    const initial = state.snapshot;
    const placed = await store.apply({
      project_id: initial.project_id,
      expected_project_revision: initial.project_revision,
      expected_layout_revision: initial.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: initial.scene.root.node_id,
        child_index: initial.scene.root.kind === "container" ? initial.scene.root.children.length : 0,
        instance_id: "instance:playground-a",
        basis: { kind: "fraction", weight: 1 },
      },
    });
    expect(placed.unplaced_instance_ids).not.toContain("instance:playground-a");
    expect(placed.can_undo).toBe(true);
    await expect(store.apply({
      project_id: initial.project_id,
      expected_project_revision: initial.project_revision,
      expected_layout_revision: initial.scene.layout_revision,
      edit: { kind: "normalize" },
    })).rejects.toThrow(/stale/i);
    const undone = await store.undo({
      project_id: placed.project_id,
      expected_project_revision: placed.project_revision,
      expected_layout_revision: placed.scene.layout_revision,
    });
    expect(undone.unplaced_instance_ids).toContain("instance:playground-a");
    expect(undone.scene.layout_revision).toBeGreaterThan(placed.scene.layout_revision);
    stop();
  });

  it("supports shared and split runtimes without coupling Console or layout lifetime", async () => {
    const transport = createMockUiKernelTransport();
    const runtimeStore = new RuntimeExternalStore(transport);
    const stop = runtimeStore.subscribe(() => undefined);
    await runtimeStore.refresh();
    let runtimeState = runtimeStore.getSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime fixture did not load");
    const workspace = runtimeState.snapshot.instances[0]!;
    const runtimeTarget = (runtime = workspace) => ({
      project_id: runtime.project_id,
      runtime_provider_id: runtime.runtime_provider_id,
      runtime_instance_id: runtime.runtime_instance_id,
      activation_generation: runtime.activation_generation,
      expected_project_revision: runtimeState.status === "ready"
        ? runtimeState.snapshot.project_revision
        : 0,
      expected_state_revision: runtime.state_revision,
    });
    let surfaces = await transport.loadSurfaces();
    const consoleA = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === "instance:console-a"
    )!;
    const consoleB = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === "instance:console-b"
    )!;
    const first = await runtimeStore.execute({
      runtime: runtimeTarget(),
      console_instance_id: consoleA.instance_id,
      expected_console_revision: consoleA.surface_revision,
      code: "1 + 1",
    });
    expect(first.events[0]).toMatchObject({
      runtime_instance_id: workspace.runtime_instance_id,
      console_instance_id: consoleA.instance_id,
    });
    await runtimeStore.refresh();
    runtimeState = runtimeStore.getSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime refresh failed");
    const currentWorkspace = runtimeState.snapshot.instances[0]!;
    const second = await runtimeStore.execute({
      runtime: runtimeTarget(currentWorkspace),
      console_instance_id: consoleB.instance_id,
      expected_console_revision: consoleB.surface_revision,
      code: "2 + 2",
    });
    expect(second.console_instance_id).toBe(consoleB.instance_id);
    await runtimeStore.refresh();
    runtimeState = runtimeStore.getSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime refresh failed");
    await transport.closeSurface({
      project_id: consoleA.project_id,
      instance_id: consoleA.instance_id,
      activation_generation: consoleA.activation_generation,
      expected_project_revision: surfaces.project_revision,
      expected_surface_revision: consoleA.surface_revision,
    });
    expect((await transport.loadRuntimes()).instances.some((runtime) =>
      runtime.runtime_instance_id === workspace.runtime_instance_id
    )).toBe(true);

    const created = await runtimeStore.create({
      project_id: runtimeState.snapshot.project_id,
      runtime_provider_id: "rho.ark-r",
      expected_project_revision: runtimeState.snapshot.project_revision,
      expected_snapshot_revision: runtimeState.snapshot.snapshot_revision,
      display_label: "Split R",
    });
    const auxiliary = created.instances.find((runtime) => !runtime.primary_scientific_runtime)!;
    surfaces = await transport.loadSurfaces();
    const latestConsoleB = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === consoleB.instance_id
    )!;
    await runtimeStore.attach({
      runtime: {
        project_id: auxiliary.project_id,
        runtime_provider_id: auxiliary.runtime_provider_id,
        runtime_instance_id: auxiliary.runtime_instance_id,
        activation_generation: auxiliary.activation_generation,
        expected_project_revision: created.project_revision,
        expected_state_revision: auxiliary.state_revision,
      },
      surface: {
        project_id: latestConsoleB.project_id,
        instance_id: latestConsoleB.instance_id,
        activation_generation: latestConsoleB.activation_generation,
        expected_project_revision: surfaces.project_revision,
        expected_surface_revision: latestConsoleB.surface_revision,
      },
    });
    const restarted = await runtimeStore.restart({
      project_id: auxiliary.project_id,
      runtime_provider_id: auxiliary.runtime_provider_id,
      runtime_instance_id: auxiliary.runtime_instance_id,
      activation_generation: auxiliary.activation_generation,
      expected_project_revision: created.project_revision,
      expected_state_revision: auxiliary.state_revision,
    });
    const restartedAux = restarted.instances.find((runtime) =>
      runtime.runtime_instance_id === auxiliary.runtime_instance_id
    )!;
    expect(restartedAux.activation_generation).toBe(auxiliary.activation_generation + 1);
    const rebound = (await transport.loadSurfaces()).catalog.instances.find((surface) =>
      surface.instance_id === consoleB.instance_id
    )!;
    expect(rebound.runtime_binding?.activation_generation).toBe(
      restartedAux.activation_generation,
    );
    const sceneBeforeStop = await transport.loadStudio();
    await runtimeStore.stop({
      project_id: restartedAux.project_id,
      runtime_provider_id: restartedAux.runtime_provider_id,
      runtime_instance_id: restartedAux.runtime_instance_id,
      activation_generation: restartedAux.activation_generation,
      expected_project_revision: restarted.project_revision,
      expected_state_revision: restartedAux.state_revision,
    });
    expect((await transport.loadSurfaces()).catalog.instances).toContainEqual(rebound);
    expect((await transport.loadStudio()).scene).toEqual(sceneBeforeStop.scene);
    stop();
  });
});
