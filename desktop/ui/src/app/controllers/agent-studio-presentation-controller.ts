import type {
  AgentTurnSummary,
  LayoutNode,
  ResourceDescriptor,
  RuntimeDescriptor,
  UiKernelTransport,
} from "../../transport";
import type {
  WorkbenchMutationLease,
  WorkbenchProjectionStore,
} from "../../transport/workbench-store";
import {
  buildAgentStudioPresentationLayout,
  type AgentStudioPresentation,
  type AgentStudioPresentationInstances,
} from "../agent/studio-presentation";

export interface AgentStudioPresentationRequest {
  readonly projectId: string;
  readonly turn: AgentTurnSummary;
  readonly presentation: AgentStudioPresentation;
  readonly store: WorkbenchProjectionStore;
  readonly transport: Pick<UiKernelTransport, "loadDomainSurface">;
  readonly lease: WorkbenchMutationLease;
  readonly allocateLayoutNodeId: () => string;
}

/**
 * Compose a separate Studio result Scene through the same revision-checked
 * stores used by human workbench actions. The Agent supplies references, not
 * layout authority; this controller owns validation, shape, and recovery.
 */
export async function presentAgentTurnInStudio({
  projectId,
  turn,
  presentation,
  store,
  transport,
  lease,
  allocateLayoutNodeId,
}: AgentStudioPresentationRequest): Promise<void> {
  await store.refresh();
  const admittedProfile = store.getProfileSnapshot();
  const admittedSurfaces = store.getSurfaceSnapshot();
  const admittedStudio = store.getStudioSnapshot();
  const admittedResources = store.getResourceSnapshot();
  if (
    admittedProfile.status !== "ready" || admittedSurfaces.status !== "ready"
    || admittedStudio.status !== "ready" || admittedResources.status !== "ready"
  ) throw new Error("Studio result presentation requires a ready workbench.");
  if (
    admittedProfile.snapshot.profile.project_id !== projectId
    || admittedSurfaces.snapshot.project_id !== projectId
    || admittedStudio.snapshot.project_id !== projectId
    || admittedResources.snapshot.project_id !== projectId
    || turn.conversation_id.trim() === ""
  ) throw new Error("Agent Studio presentation belongs to another project or Conversation.");
  const sourceSceneId = admittedProfile.snapshot.profile.active_studio_scene_id;
  if (sourceSceneId == null) throw new Error("Studio has no active Scene to preserve.");
  const label = `Result · ${presentation.title}`.slice(0, 120);
  let resultSceneId: string | null = null;
  const createdInstanceIds: string[] = [];

  try {
    const duplicated = await store.duplicateScene({
      target: {
        project_id: projectId,
        expected_profile_revision: admittedProfile.snapshot.profile.revision,
      },
      scene_id: sourceSceneId,
      label,
    }, lease);
    resultSceneId = duplicated.profile.active_studio_scene_id;
    if (resultSceneId == null || resultSceneId === sourceSceneId) {
      throw new Error("Studio did not create an independent result Scene.");
    }
    await store.refresh();

    const openPresentationSurface = async ({
      surfaceId,
      modeId,
      resourceBinding,
      runtimeBinding,
      viewState,
    }: {
      readonly surfaceId: string;
      readonly modeId: string | null;
      readonly resourceBinding: ResourceDescriptor | null;
      readonly runtimeBinding: RuntimeDescriptor | null;
      readonly viewState: Readonly<Record<string, unknown>>;
    }): Promise<string> => {
      await store.refresh();
      const surfaceState = store.getSurfaceSnapshot();
      const studioState = store.getStudioSnapshot();
      if (surfaceState.status !== "ready" || studioState.status !== "ready") {
        throw new Error("Studio changed while arranging Agent results.");
      }
      const binding = resourceBinding == null ? null : {
        resource_provider_id: resourceBinding.resource_provider_id,
        resource_kind: resourceBinding.resource_kind,
        resource_id: resourceBinding.resource_id,
        resource_revision: resourceBinding.resource_revision,
      };
      const runtime = runtimeBinding == null ? null : {
        runtime_provider_id: runtimeBinding.runtime_provider_id,
        runtime_instance_id: runtimeBinding.runtime_instance_id,
        runtime_kind: runtimeBinding.runtime_kind,
        project_id: runtimeBinding.project_id,
        activation_generation: runtimeBinding.activation_generation,
        state_revision: runtimeBinding.state_revision,
        attach_capabilities: runtimeBinding.attach_capabilities,
      };
      const existing = surfaceState.snapshot.catalog.instances.find((instance) =>
        instance.surface_id === surfaceId
        && instance.mode_id === modeId
        && (binding == null
          ? instance.resource_binding == null
          : instance.resource_binding?.resource_provider_id === binding.resource_provider_id
            && instance.resource_binding.resource_kind === binding.resource_kind
            && instance.resource_binding.resource_id === binding.resource_id)
        && (runtime == null
          ? instance.runtime_binding == null
          : instance.runtime_binding?.runtime_provider_id === runtime.runtime_provider_id
            && instance.runtime_binding.runtime_instance_id === runtime.runtime_instance_id
            && instance.runtime_binding.activation_generation === runtime.activation_generation)
        && JSON.stringify(instance.view_state) === JSON.stringify(viewState));
      if (existing != null) return existing.instance_id;
      const before = new Set(
        surfaceState.snapshot.catalog.instances.map((instance) => instance.instance_id),
      );
      const opened = await store.open({
        surface_id: surfaceId,
        project_id: projectId,
        mode_id: modeId,
        resource_binding: binding,
        runtime_binding: runtime,
        view_group_id: null,
        view_state: viewState,
        instance_disposition: "new_instance",
        placement_intent: "beside",
        expected_project_revision: surfaceState.snapshot.project_revision,
        expected_layout_revision: studioState.snapshot.scene.layout_revision,
      }, lease);
      const created = opened.catalog.instances.find((instance) => !before.has(instance.instance_id));
      if (created == null) throw new Error(`Studio did not open ${surfaceId}.`);
      createdInstanceIds.push(created.instance_id);
      return created.instance_id;
    };

    const sourceIds: string[] = [];
    for (const path of presentation.code_paths) {
      const descriptor = admittedResources.snapshot.resources.find((resource) =>
        resource.resource_provider_id === "rho.project-files"
        && resource.resource_kind === "project_file"
        && resource.resource_id === path
        && resource.status === "ready");
      if (descriptor == null) continue;
      sourceIds.push(await openPresentationSurface({
        surfaceId: "rho.file-source",
        modeId: "source",
        resourceBinding: descriptor,
        runtimeBinding: null,
        viewState: { cursor_start: 0, cursor_end: 0, scroll_top: 0 },
      }));
    }

    let consoleId: string | null = null;
    if (presentation.execution_id != null) {
      const execution = await store.getExecution(presentation.execution_id);
      if (execution.execution_id !== presentation.execution_id) {
        throw new Error("Agent Runtime execution is unavailable in the active project.");
      }
      await store.refresh();
      const runtimeState = store.getRuntimeSnapshot();
      const attachedRuntime = runtimeState.status !== "ready" ? null : runtimeState.snapshot.instances.find(
        (runtime) => runtime.runtime_instance_id === execution.runtime_instance_id
          && runtime.activation_generation === execution.runtime_activation_generation,
      ) ?? runtimeState.snapshot.instances.find((runtime) => runtime.primary_scientific_runtime) ?? null;
      consoleId = await openPresentationSurface({
        surfaceId: "rho.console",
        modeId: null,
        resourceBinding: null,
        runtimeBinding: attachedRuntime,
        viewState: {
          schema_version: 4,
          filter: "",
          scroll_top: 0,
          follow_tail: true,
          transcript_start_after: null,
          read_cursor: null,
          pinned_execution_id: presentation.execution_id,
        },
      });
    }

    let plotsId: string | null = null;
    if (presentation.show_plots) {
      if (presentation.plot_id != null) {
        const plots = await transport.loadDomainSurface("rho.plots");
        if (!plots.items.some((item) => item.id === presentation.plot_id)) {
          throw new Error("Agent Plot reference is not available in the active project.");
        }
      }
      plotsId = await openPresentationSurface({
        surfaceId: "rho.plots",
        modeId: presentation.plot_id == null ? "gallery" : "single",
        resourceBinding: null,
        runtimeBinding: null,
        viewState: { selected_id: presentation.plot_id, filter: "" },
      });
    }

    const environmentId = presentation.show_environment
      ? await openPresentationSurface({
          surfaceId: "rho.environment",
          modeId: "packages",
          resourceBinding: null,
          runtimeBinding: null,
          viewState: { filter: "" },
        })
      : null;
    const instances: AgentStudioPresentationInstances = {
      source: sourceIds,
      console: consoleId,
      plots: plotsId,
      environment: environmentId,
    };
    const root: LayoutNode = buildAgentStudioPresentationLayout(instances, allocateLayoutNodeId);
    await store.refresh();
    let studioState = store.getStudioSnapshot();
    if (studioState.status !== "ready" || studioState.snapshot.scene.scene_id !== resultSceneId) {
      throw new Error("Agent result Scene is no longer active.");
    }
    if (studioState.snapshot.scene.focused_surface_instance_id != null) {
      await store.apply({
        project_id: projectId,
        expected_project_revision: studioState.snapshot.project_revision,
        expected_layout_revision: studioState.snapshot.scene.layout_revision,
        edit: { kind: "set_focus", instance_id: null },
      }, lease);
      studioState = store.getStudioSnapshot();
      if (studioState.status !== "ready") throw new Error("Studio focus did not settle.");
    }
    await store.apply({
      project_id: projectId,
      expected_project_revision: studioState.snapshot.project_revision,
      expected_layout_revision: studioState.snapshot.scene.layout_revision,
      edit: { kind: "replace_root", root },
    }, lease);
    studioState = store.getStudioSnapshot();
    const firstInstanceId = sourceIds[0] ?? consoleId ?? plotsId ?? environmentId;
    if (studioState.status !== "ready" || firstInstanceId == null) {
      throw new Error("Studio result layout did not settle.");
    }
    await store.apply({
      project_id: projectId,
      expected_project_revision: studioState.snapshot.project_revision,
      expected_layout_revision: studioState.snapshot.scene.layout_revision,
      edit: { kind: "set_focus", instance_id: firstInstanceId },
    }, lease);
  } catch (error: unknown) {
    for (const instanceId of createdInstanceIds.reverse()) {
      try {
        await store.refresh();
        const current = store.getSurfaceSnapshot();
        const instance = current.status === "ready"
          ? current.snapshot.catalog.instances.find((candidate) => candidate.instance_id === instanceId)
          : null;
        if (current.status === "ready" && instance != null) {
          await store.close({
            project_id: projectId,
            instance_id: instance.instance_id,
            activation_generation: instance.activation_generation,
            expected_project_revision: current.snapshot.project_revision,
            expected_surface_revision: instance.surface_revision,
          }, lease);
        }
      } catch { /* preserve the original truthful arrangement failure */ }
    }
    if (resultSceneId != null) {
      try {
        await store.refresh();
        const current = store.getProfileSnapshot();
        if (
          current.status === "ready"
          && current.snapshot.profile.studio_scenes.some((scene) => scene.scene_id === resultSceneId)
          && current.snapshot.profile.studio_scenes.length > 1
        ) {
          await store.deleteScene({
            target: {
              project_id: projectId,
              expected_profile_revision: current.snapshot.profile.revision,
            },
            scene_id: resultSceneId,
          }, lease);
        }
      } catch { /* the remaining Scene is visible recovery state */ }
    }
    throw error;
  }
}
