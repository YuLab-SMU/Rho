import { describe, expect, it, vi } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { createMockUiKernelTransport } from "./mock";
import { WorkbenchProjectionStore } from "./store";
import { createTauriUiKernelTransport } from "./tauri";
import type {
  CheckResult,
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

function generatedCheckResult(): CheckResult {
  return {
    contract: "rho.ui.check-result.v1",
    result_id: "check-result:fixture",
    project_id: "project:fixture",
    project_revision: 7,
    snapshot: {
      contract: "rho.ui.check-project.snapshot.v1",
      snapshot_id: "check-snapshot:fixture",
      project_id: "project:fixture",
      project_revision: 7,
      captured_at: "2026-08-25T00:00:00Z",
      files: [],
      source_bytes: 0,
      renv_lock_sha256: null,
      truncated: false,
      limitations: [],
    },
    ruleset_digest: "a".repeat(64),
    generated_at: "2026-08-25T00:00:01Z",
    status: "clean",
    findings: [],
    coverage: {
      files_scanned: 0,
      files_skipped: 0,
      core_rules: 22,
      plugin_rule_packs: 0,
      plugin_rule_failures: 0,
    },
    truncated: false,
    limitations: [],
  };
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

  it("caches one immutable Workbench projection without tearing", async () => {
    const transport = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore(transport);
    const changes = vi.fn();
    const unsubscribe = store.subscribe(changes);
    await store.refresh();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("projection did not load");
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.kernel)).toBe(true);
    transport.publish(generated());
    await store.refresh();
    const second = store.getSnapshot();
    expect(second.status).toBe("ready");
    if (second.status === "ready") {
      expect(second.snapshot.projection_generation)
        .toBeGreaterThan(first.snapshot.projection_generation);
    }
    unsubscribe();
  });

  it("switches every domain to a new project in one publication", async () => {
    const projectB = "/tmp/project-b";
    const transport = createMockUiKernelTransport("?project=%2Ftmp%2Fproject-a");
    const store = new WorkbenchProjectionStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();

    await transport.openProject(projectB);
    await store.refresh();

    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("project projection did not reload");
    const projection = state.snapshot;
    const projectIds = [
      projection.project_id,
      projection.kernel.project.project_id,
      projection.surfaces.project_id,
      projection.studio.project_id,
      projection.runtimes.project_id,
      projection.resources.project_id,
      projection.profile.profile.project_id,
    ];
    expect(new Set(projectIds)).toEqual(new Set([`project:mock:${encodeURIComponent(projectB)}`]));
    stop();
  });

  it("keeps Project UI Profile mode and Scene mutations CAS-safe", async () => {
    const transport = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getProfileSnapshot();
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
    const store = new WorkbenchProjectionStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getResourceSnapshot();
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
      return (command === "ui_profile_page_export"
        ? {
            contract: "rho.ui.vibe-page.export.v1",
            project_id: "project:fixture",
            page_id: "page:project-review",
            page_revision: 2,
            label: "Project review",
            markdown: "# Project review\n",
          }
        : command.startsWith("ui_profile")
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
          : command === "runtime_execution_start"
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
        ? { result: generatedCheckResult() }
        : command === "check_result"
        ? generatedCheckResult()
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
    const pageMutation = {
      target: profileTarget,
      page_id: "page:project-review",
      expected_page_revision: 2,
      mutation: { kind: "set_focus" as const, block_id: null },
    };
    const pageExport = {
      project_id: "project:fixture",
      expected_profile_revision: 5,
      page_id: "page:project-review",
      expected_page_revision: 2,
    };
    await transport.applyVibePage(pageMutation);
    await transport.exportVibePage(pageExport);
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
    await transport.startRuntimeExecution({
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
    handlers.get("rho://runtime-registry-changed")?.();
    expect(invalidated).toHaveBeenCalledTimes(2);
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
      { command: "ui_profile_page_apply", args: { request: pageMutation } },
      { command: "ui_profile_page_export", args: { request: pageExport } },
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
        command: "runtime_execution_start",
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

  it("prepares the Tauri workspace before any Surface snapshot is requested", async () => {
    const calls: string[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string) => {
      calls.push(command);
      if (command === "startup_bootstrap") {
        return { phase: "runtime_ready", issue: null } as T;
      }
      if (command === "workspace_start") return { status: "idle" } as T;
      if (command === "agent_runtime_retry") return { available: false } as T;
      if (command === "project_restore_session") return { status: "ready" } as T;
      throw new Error(`unexpected command ${command}`);
    }, async () => () => undefined);

    await expect(transport.prepareWorkspace()).resolves.toEqual({
      status: "ready",
      phase: "project_ready",
      workspace_ready: true,
      restored_project_status: "ready",
      issue: null,
    });
    expect(calls).toEqual([
      "startup_bootstrap",
      "workspace_start",
      "agent_runtime_retry",
      "project_restore_session",
    ]);
  });

  it("routes project paths and the native picker through the existing Tauri switch commands", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const response = {
      status: "cancelled" as const,
      project: null,
      session: {},
      unavailable: null,
      blocker: null,
      reason_code: null,
      message: null,
      restored_root: null,
      restart_required: false,
    };
    const transport = createTauriUiKernelTransport(async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(args === undefined ? { command } : { command, args });
      return response as T;
    }, async () => () => undefined);

    await expect(transport.openProject("/Users/example/Rho release 空格项目"))
      .resolves.toEqual(response);
    await expect(transport.pickProjectDirectory()).resolves.toEqual(response);
    expect(calls).toEqual([
      {
        command: "project_open",
        args: { path: "/Users/example/Rho release 空格项目" },
      },
      { command: "project_pick_directory", args: undefined },
    ]);
  });

  it("projects current and historical Plot records without inline image payloads", async () => {
    const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args === undefined ? { command } : { command, args });
      if (command !== "list_plot_artifacts") throw new Error(`unexpected command ${command}`);
      return [{
        plot_id: "plot:exact-preview",
        run_id: "run:different-identity",
        source_path: "analysis.R",
        media_type: "image/png",
        payload_json: JSON.stringify({ "image/png": "A".repeat(6_000) }),
        provenance_complete: true,
        created_at: "2026-08-27T20:00:00Z",
      }] as T;
    }, async () => () => undefined);

    const plots = await transport.loadDomainSurface("rho.plots");
    expect(calls).toEqual([{
      command: "list_plot_artifacts",
      args: { limit: 100, sessionOnly: false },
    }]);
    expect(plots.items).toHaveLength(1);
    expect(plots.items[0]?.id).toBe("plot:exact-preview");
    expect(plots.items[0]?.detail).not.toContain("payload_json");
    expect(plots.items[0]?.detail).not.toContain("AAAA");
    expect(JSON.parse(plots.items[0]?.detail ?? "{}")).toMatchObject({
      plot_id: "plot:exact-preview",
      run_id: "run:different-identity",
      media_type: "image/png",
    });
  });

  it("keeps surface identities ahead of cross-reference identities", async () => {
    const transport = createTauriUiKernelTransport(async <T,>(command: string) => {
      if (command !== "list_evidence_claims") throw new Error(`unexpected command ${command}`);
      return [{
        claim_id: "claim:primary-card",
        artifact_id: "artifact:cross-reference",
        summary: "Claim linked to an artifact",
      }] as T;
    }, async () => () => undefined);

    const evidence = await transport.loadDomainSurface("rho.evidence");
    expect(evidence.items).toHaveLength(1);
    expect(evidence.items[0]?.id).toBe("claim:primary-card");
  });

  it("keeps startup recovery actionable and never enters an unreconciled workspace", async () => {
    const calls: string[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string) => {
      calls.push(command);
      if (command === "startup_choose_rscript") {
        return {
          phase: "needs_attention",
          issue: {
            code: "R_NOT_FOUND",
            title: "R was not found",
            message: "Choose Rscript manually.",
            technical_detail: "No compatible executable was resolved.",
          },
        } as T;
      }
      throw new Error(`unexpected command ${command}`);
    }, async () => () => undefined);

    const result = await transport.prepareWorkspace(true);
    expect(result.status).toBe("needs_attention");
    expect(result.issue?.code).toBe("R_NOT_FOUND");
    expect(calls).toEqual(["startup_choose_rscript"]);
  });

  it("projects an unavailable saved path and reason after Workspace R starts", async () => {
    const calls: string[] = [];
    const transport = createTauriUiKernelTransport(async <T,>(command: string) => {
      calls.push(command);
      if (command === "startup_bootstrap") return { phase: "runtime_ready", issue: null } as T;
      if (command === "workspace_start") return { status: "idle" } as T;
      if (command === "agent_runtime_retry") return { available: false } as T;
      if (command === "project_restore_session") return {
        status: "unavailable",
        project: null,
        session: {},
        unavailable: {
          path: "/tmp/deleted-acceptance-project",
          reason: "Project directory does not exist",
        },
        blocker: null,
        reason_code: null,
        message: null,
        restored_root: null,
        restart_required: false,
      } as T;
      throw new Error(`unexpected command ${command}`);
    }, async () => () => undefined);

    await expect(transport.prepareWorkspace()).resolves.toEqual({
      status: "needs_attention",
      phase: "project_restore_incomplete",
      workspace_ready: true,
      restored_project_status: "unavailable",
      issue: {
        code: "PROJECT_RESTORE_INCOMPLETE",
        title: "The saved project could not be restored",
        message: "Workspace R is available. Choose or reopen a project to continue.",
        technical_detail: "Saved project: /tmp/deleted-acceptance-project\nReason: Project directory does not exist",
      },
    });
    expect(calls).toEqual([
      "startup_bootstrap",
      "workspace_start",
      "agent_runtime_retry",
      "project_restore_session",
    ]);
  });

  it("keeps the mock Surface command lane in lockstep with instance semantics", async () => {
    const transport = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSurfaceSnapshot();
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

  it("coalesces a Workbench invalidation flood into one trailing refresh", async () => {
    const base = createMockUiKernelTransport();
    const first = await base.loadWorkbenchProjection();
    const second = await base.loadWorkbenchProjection();

    let resolveFirst: ((snapshot: typeof first) => void) | undefined;
    const firstLoad = new Promise<typeof first>((resolve) => {
      resolveFirst = resolve;
    });
    const loadWorkbenchProjection = vi
      .fn<() => Promise<typeof first>>()
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValueOnce(second);
    let invalidate: () => void = () => undefined;
    const transport = {
      ...base,
      loadWorkbenchProjection,
      subscribeWorkbenchInvalidated(listener: () => void) {
        invalidate = listener;
        return () => undefined;
      },
    };
    const store = new WorkbenchProjectionStore(transport);
    const stop = store.subscribe(() => undefined);

    await vi.waitFor(() => expect(loadWorkbenchProjection).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 128; index += 1) invalidate();
    resolveFirst?.(first);
    await vi.waitFor(() => expect(loadWorkbenchProjection).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const state = store.getSnapshot();
      expect(state.status).toBe("ready");
      if (state.status === "ready") {
        expect(state.snapshot.projection_generation).toBe(second.projection_generation);
      }
    });
    expect(loadWorkbenchProjection).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps Studio edits stale-safe, undoable, and reconciled with Surface availability", async () => {
    const transport = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getStudioSnapshot();
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

  it("injects Runtime rejection before mutation and leaves History truthful", async () => {
    const transport = createMockUiKernelTransport("?fault=runtime-execute");
    const before = await transport.loadRuntimes();
    const runtime = before.instances[0]!;
    const console = (await transport.loadSurfaces()).catalog.instances.find(
      (surface) => surface.instance_id === "instance:console-a",
    )!;
    const historyBefore = await transport.loadDomainSurface("rho.runs");
    await expect(transport.startRuntimeExecution({
      runtime: {
        project_id: runtime.project_id,
        runtime_provider_id: runtime.runtime_provider_id,
        runtime_instance_id: runtime.runtime_instance_id,
        activation_generation: runtime.activation_generation,
        expected_project_revision: before.project_revision,
        expected_state_revision: runtime.state_revision,
      },
      console_instance_id: console.instance_id,
      expected_console_revision: console.surface_revision,
      code: "1 + 1",
    })).rejects.toThrow("Injected Runtime rejection");
    expect(await transport.loadRuntimes()).toEqual(before);
    expect(await transport.loadDomainSurface("rho.runs")).toEqual(historyBefore);
  });

  it("keeps the delayed Runtime scenario pending until its deterministic gate elapses", async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockUiKernelTransport("?delay=runtime-execute&delay_ms=250");
      const before = await transport.loadRuntimes();
      const runtime = before.instances[0]!;
      const console = (await transport.loadSurfaces()).catalog.instances.find(
        (surface) => surface.instance_id === "instance:console-a",
      )!;
      let settled = false;
      const execution = transport.startRuntimeExecution({
        runtime: {
          project_id: runtime.project_id,
          runtime_provider_id: runtime.runtime_provider_id,
          runtime_instance_id: runtime.runtime_instance_id,
          activation_generation: runtime.activation_generation,
          expected_project_revision: before.project_revision,
          expected_state_revision: runtime.state_revision,
        },
        console_instance_id: console.instance_id,
        expected_console_revision: console.surface_revision,
        code: "1 + 1",
      }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      expect(await transport.loadRuntimes()).toEqual(before);
      await vi.advanceTimersByTimeAsync(1);
      await expect(execution).resolves.toMatchObject({
        committed_through: 0,
        execution: { status: "admitted" },
      });
      expect(settled).toBe(true);
      expect((await transport.loadDomainSurface("rho.runs")).items[0]?.title).toBe("Console command");
    } finally {
      vi.useRealTimers();
    }
  });

  it("can drop, duplicate, and reorder named invalidations without changing snapshots", async () => {
    const dropped = createMockUiKernelTransport("?invalidation=drop:runtimes");
    const droppedListener = vi.fn();
    dropped.subscribeRuntimesInvalidated(droppedListener);
    dropped.publishRuntimes(await dropped.loadRuntimes());
    expect(droppedListener).not.toHaveBeenCalled();

    const duplicated = createMockUiKernelTransport("?invalidation=duplicate:runtimes");
    const duplicatedListener = vi.fn();
    duplicated.subscribeRuntimesInvalidated(duplicatedListener);
    duplicated.publishRuntimes(await duplicated.loadRuntimes());
    await Promise.resolve();
    expect(duplicatedListener).toHaveBeenCalledTimes(2);

    const reordered = createMockUiKernelTransport("?invalidation=reorder:runtimes:studio");
    const sequence: string[] = [];
    const runtimeBefore = await reordered.loadRuntimes();
    const studioBefore = await reordered.loadStudio();
    reordered.subscribeRuntimesInvalidated(() => sequence.push("runtimes"));
    reordered.subscribeStudioInvalidated(() => sequence.push("studio"));
    reordered.publishRuntimes(runtimeBefore);
    expect(sequence).toEqual([]);
    reordered.publishStudio(studioBefore);
    expect(sequence).toEqual(["studio", "runtimes"]);
    expect(await reordered.loadRuntimes()).toEqual(runtimeBefore);
    expect(await reordered.loadStudio()).toEqual(studioBefore);
  });

  it("supports shared and split runtimes without coupling Console or layout lifetime", async () => {
    const transport = createMockUiKernelTransport();
    const runtimeStore = new WorkbenchProjectionStore(transport);
    const stop = runtimeStore.subscribe(() => undefined);
    await runtimeStore.refresh();
    let runtimeState = runtimeStore.getRuntimeSnapshot();
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
    const first = await runtimeStore.startExecution({
      runtime: runtimeTarget(),
      console_instance_id: consoleA.instance_id,
      expected_console_revision: consoleA.surface_revision,
      code: "1 + 1",
    });
    expect(first.execution).toMatchObject({
      runtime_instance_id: workspace.runtime_instance_id,
      console_instance_id: consoleA.instance_id,
    });
    await runtimeStore.refresh();
    runtimeState = runtimeStore.getRuntimeSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime refresh failed");
    const currentWorkspace = runtimeState.snapshot.instances[0]!;
    const second = await runtimeStore.startExecution({
      runtime: runtimeTarget(currentWorkspace),
      console_instance_id: consoleB.instance_id,
      expected_console_revision: consoleB.surface_revision,
      code: "2 + 2",
    });
    expect(second.execution.console_instance_id).toBe(consoleB.instance_id);
    await runtimeStore.refresh();
    runtimeState = runtimeStore.getRuntimeSnapshot();
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
