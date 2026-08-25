import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import {
  WorkbenchProjectionStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type {
  AgentTurnSummary,
  PluginSurfaceDocumentRequest,
  ProjectSwitchResponse,
  ResourceDescriptor,
  ResourceTarget,
  RuntimeDescriptor,
  RuntimeOutputReference,
  RuntimeInstanceRequest,
  SceneEdit,
  SurfaceInstance,
  SurfaceFactoryRegistration,
  SurfaceInstanceRequest,
  UiKernelTransport,
} from "../transport";
import { VibePageEditor } from "./VibePageEditor";
import { SurfaceView } from "./SurfaceView";
import type { SourceExecutionSubmission } from "./source-execution";
import { ToolbarCustomizer } from "./ToolbarCustomizer";
import {
  loadProjectHistory,
  rememberProjectPath,
  saveProjectHistory,
} from "./project-history";
import type { ProjectHistoryLoad } from "./project-history";
import {
  defaultToolbarLayout,
  loadToolbarLayout,
  saveToolbarLayout,
} from "./toolbar-model";
import { workbenchFailureMessage } from "./workbench-failure";
import { workbenchOperationTrace } from "./operation-trace";
import { ConsoleExecutionRouter } from "./controllers/console-execution-router";
import type { ConsoleExecutionEndpoint } from "./controllers/console-execution-router";
import { useConsoleProjectActivation } from "./controllers/console-project-activation";
import { ProjectSwitchController } from "./controllers/project-switch-controller";
import type { ConsoleViewState } from "./controllers/console-instance-controller";
import { ConsoleRequirementController } from "./controllers/console-requirement-controller";
import { StudioMutationController } from "./controllers/studio-mutation-controller";
import { SurfaceInstanceMutationController } from "./controllers/surface-instance-mutation-controller";
import { surfaceDisplayLabel, surfaceUxProfile } from "./surface-ux";
import {
  findLayoutPlacement,
  NodeOutline,
} from "./layout/LegacySceneLayout";
import { DockviewSceneLayout } from "./layout/DockviewSceneLayout";
import type {
  ToolbarComponentId,
  ToolbarLayout,
  ToolbarPreferenceLoad,
} from "./toolbar-model";
import { projectLabel } from "../transport/normalize";

interface WorkbenchAppProps {
  readonly transport?: UiKernelTransport;
}

function boundedFailureMessage(error: unknown, fallback: string): string {
  return workbenchFailureMessage(error, fallback);
}

export const defaultTransport = createUiKernelTransport();
const defaultStore = new WorkbenchProjectionStore(defaultTransport);

function instanceRequest(
  instance: SurfaceInstance,
  projectRevision: number,
): SurfaceInstanceRequest {
  return {
    project_id: instance.project_id,
    instance_id: instance.instance_id,
    activation_generation: instance.activation_generation,
    expected_project_revision: projectRevision,
    expected_surface_revision: instance.surface_revision,
  };
}

function runtimeRequest(
  runtime: RuntimeDescriptor,
  projectRevision: number,
): RuntimeInstanceRequest {
  return {
    project_id: runtime.project_id,
    runtime_provider_id: runtime.runtime_provider_id,
    runtime_instance_id: runtime.runtime_instance_id,
    activation_generation: runtime.activation_generation,
    expected_project_revision: projectRevision,
    expected_state_revision: runtime.state_revision,
  };
}

function resourceTarget(
  descriptor: ResourceDescriptor,
  projectRevision: number,
  resourceRevision = descriptor.resource_revision,
): ResourceTarget {
  return {
    project_id: descriptor.project_id,
    resource_provider_id: descriptor.resource_provider_id,
    resource_kind: descriptor.resource_kind,
    resource_id: descriptor.resource_id,
    expected_project_revision: projectRevision,
    expected_resource_revision: resourceRevision,
  };
}


export function WorkbenchApp({ transport }: WorkbenchAppProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [resourcePath, setResourcePath] = useState("analysis.R");
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [commandSearchTransient, setCommandSearchTransient] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [toolbarCustomizerOpen, setToolbarCustomizerOpen] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [projectSwitchTarget, setProjectSwitchTarget] = useState<string | null>(null);
  const [projectSwitchError, setProjectSwitchError] = useState<string | null>(null);
  const [agentRuntimeOutputContext, setAgentRuntimeOutputContext] = useState<RuntimeOutputReference | null>(null);
  const [projectHistory, setProjectHistory] = useState<ProjectHistoryLoad>(() =>
    loadProjectHistory(window.localStorage)
  );
  const [toolbarPreference, setToolbarPreference] = useState<ToolbarPreferenceLoad & {
    readonly projectId: string | null;
  }>({
    projectId: null,
    layout: defaultToolbarLayout(),
    status: "default",
    detail: null,
  });
  const commandSearchRef = useRef<HTMLInputElement>(null);
  const rhoMenuRef = useRef<HTMLDetailsElement>(null);
  const rhoMenuTriggerRef = useRef<HTMLElement>(null);
  const projectSwitchController = useMemo(() => new ProjectSwitchController(), []);
  const traceProjectRef = useRef<string | null>(null);
  const consoleExecutionRouter = useMemo(() => new ConsoleExecutionRouter(), []);
  const draftCache = useRef(new Map<string, string>()).current;
  const consoleSessionCache = useRef(new Map<string, ConsoleViewState>()).current;
  const registerConsoleExecution = useCallback(
    (endpoint: ConsoleExecutionEndpoint) => consoleExecutionRouter.register(endpoint),
    [consoleExecutionRouter],
  );
  const markConsolePreferred = useCallback((instanceId: string) => {
    consoleExecutionRouter.markPreferred(instanceId);
  }, [consoleExecutionRouter]);
  const pluginTransport = transport ?? defaultTransport;
  const store = useMemo(
    () => transport == null ? defaultStore : new WorkbenchProjectionStore(transport),
    [transport],
  );
  const surfaceStore = store;
  const studioStore = store;
  const runtimeStore = store;
  const resourceStore = store;
  const profileStore = store;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const projection = state.status === "ready" ? state.snapshot : null;
  const snapshot = projection?.kernel ?? null;
  const surfaces = projection?.surfaces ?? null;
  const studio = projection?.studio ?? null;
  const runtimes = projection?.runtimes ?? null;
  const resources = projection?.resources ?? null;
  const profileSnapshot = projection?.profile ?? null;
  const profile = profileSnapshot?.profile ?? null;
  const projectionProjectId = snapshot?.project.project_id ?? null;
  useConsoleProjectActivation(consoleExecutionRouter, projectionProjectId);
  useEffect(() => {
    if (projectionProjectId != null && traceProjectRef.current !== projectionProjectId) {
      workbenchOperationTrace.reset();
      traceProjectRef.current = projectionProjectId;
    }
  }, [projectionProjectId]);
  useEffect(() => {
    setAgentRuntimeOutputContext(null);
  }, [projectionProjectId]);
  const projectProjectionsCoherent = projection != null;
  const toolbarProjectId = profile?.project_id ?? null;
  const toolbarLayout = toolbarPreference.projectId === toolbarProjectId
    ? toolbarPreference.layout
    : defaultToolbarLayout();
  useEffect(() => {
    if (profile?.active_mode === "vibe") setInspectorOpen(false);
  }, [profile?.active_mode]);
  useEffect(() => {
    if (toolbarProjectId == null) return;
    let loaded: ToolbarPreferenceLoad;
    try {
      loaded = loadToolbarLayout(window.localStorage, toolbarProjectId);
    } catch {
      loaded = {
        layout: defaultToolbarLayout(),
        status: "unavailable",
        detail: "Toolbar settings could not be read; using the session default.",
      };
    }
    setToolbarPreference({ projectId: toolbarProjectId, ...loaded });
  }, [toolbarProjectId]);
  useEffect(() => {
    const path = snapshot?.project.display_path;
    if (path == null) return;
    setProjectHistory((current) => {
      const history = rememberProjectPath(current.history, path);
      if (history === current.history) return current;
      try {
        saveProjectHistory(window.localStorage, history);
        return { history, status: "clean", detail: null };
      } catch {
        return {
          history,
          status: "unavailable",
          detail: "Recent projects work for this session but could not be saved on this device.",
        };
      }
    });
  }, [snapshot?.project.display_path]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandSearchRef.current == null) setCommandSearchTransient(true);
        else {
          commandSearchRef.current.focus();
          commandSearchRef.current.select();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    if (!commandSearchTransient) return;
    commandSearchRef.current?.focus();
    commandSearchRef.current?.select();
  }, [commandSearchTransient]);
  useEffect(() => {
    const closeRhoMenu = (event: PointerEvent) => {
      const menu = rhoMenuRef.current;
      if (menu?.open === true && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    const closeRhoMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && rhoMenuRef.current?.open === true) {
        rhoMenuRef.current.open = false;
        rhoMenuTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeRhoMenu);
    document.addEventListener("keydown", closeRhoMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeRhoMenu);
      document.removeEventListener("keydown", closeRhoMenuOnEscape);
    };
  }, []);
  const instances = useMemo(() => new Map(surfaces?.catalog.instances.map((instance) => [instance.instance_id, instance]) ?? []), [surfaces]);
  const primaryCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "primary_candidate"), [snapshot]);
  const paletteCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "palette").filter((command) => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return query.length === 0 || command.definition.label.toLocaleLowerCase().includes(query) ||
      command.definition.command_id.toLocaleLowerCase().includes(query);
  }), [commandQuery, snapshot]);
  const run = (operation: Promise<unknown>, operationName = "workbench.action") => {
    setActionError(null);
    void workbenchOperationTrace.run(
      operationName,
      () => operation,
      { fallback: "Studio operation failed.", scope: "workbench" },
    ).catch((error: unknown) => setActionError(workbenchFailureMessage(error, "Studio operation failed.")));
  };
  const allocateLayoutNodeId = useCallback(
    () => `layout-node:${crypto.randomUUID().replaceAll("-", "")}`,
    [],
  );
  const studioMutationController = useMemo(() => new StudioMutationController({
    getStudio: studioStore.getStudioSnapshot,
    apply: (request) => studioStore.apply(request),
    undo: (request) => studioStore.undo(request),
    redo: (request) => studioStore.redo(request),
    report: setActionError,
    allocateLayoutNodeId,
  }), [allocateLayoutNodeId, studioStore]);
  const surfaceMutationController = useMemo(() => new SurfaceInstanceMutationController({
    getSurfaces: surfaceStore.getSurfaceSnapshot,
    update: (request) => surfaceStore.update(request),
    suspend: (request) => surfaceStore.suspend(request),
    resume: (request) => surfaceStore.resume(request),
  }), [surfaceStore]);
  const previewToolbarLayout = (layout: ToolbarLayout) => {
    if (toolbarProjectId == null) return;
    setToolbarPreference((current) => ({
      projectId: toolbarProjectId,
      layout,
      status: current.projectId === toolbarProjectId ? current.status : "default",
      detail: current.projectId === toolbarProjectId ? current.detail : null,
    }));
  };
  const commitToolbarLayout = (layout: ToolbarLayout) => {
    if (toolbarProjectId == null) return;
    let status: ToolbarPreferenceLoad["status"] = "clean";
    let detail: string | null = null;
    try {
      saveToolbarLayout(window.localStorage, toolbarProjectId, layout);
    } catch {
      status = "unavailable";
      detail = "Toolbar changed for this session, but the preference could not be saved.";
      setActionError(detail);
    }
    setToolbarPreference({ projectId: toolbarProjectId, layout, status, detail });
  };
  const commit = (edit: SceneEdit) => {
    return studioMutationController.commit(edit);
  };
  const profileRevisionRequest = () => profile == null ? null : {
    project_id: profile.project_id,
    expected_profile_revision: profile.revision,
  };
  const duplicate = async (instance: SurfaceInstance) => {
    if (surfaces == null || studio == null) return;
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const opened = await surfaceStore.open({
      surface_id: instance.surface_id,
      project_id: surfaces.project_id,
      mode_id: instance.mode_id,
      resource_binding: instance.resource_binding,
      runtime_binding: instance.runtime_binding,
      view_group_id: instance.view_group_id,
      view_state: instance.view_state,
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Surface Runtime did not return the duplicated instance.");
    if (studio.scene.root.kind !== "container") return;
    await studioStore.apply({
      project_id: studio.project_id,
      expected_project_revision: studio.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: studio.scene.root.node_id,
        child_index: studio.scene.root.children.length,
        instance_id: created.instance_id,
        basis: { kind: "fraction", weight: 1 },
      },
    });
  };
  const openConsole = async (runtime: RuntimeDescriptor) => {
    if (surfaces == null || studio == null) return;
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const opened = await surfaceStore.open({
      surface_id: "rho.console",
      project_id: surfaces.project_id,
      mode_id: null,
      resource_binding: null,
      runtime_binding: {
        runtime_provider_id: runtime.runtime_provider_id,
        runtime_instance_id: runtime.runtime_instance_id,
        runtime_kind: runtime.runtime_kind,
        project_id: runtime.project_id,
        activation_generation: runtime.activation_generation,
        state_revision: runtime.state_revision,
        attach_capabilities: runtime.attach_capabilities,
      },
      view_group_id: null,
      view_state: {
        draft: "",
        history: [],
        history_cursor: null,
        filter: "",
        scroll_top: 0,
        outputs: [],
      },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Surface Runtime did not return the new Console.");
    if (studio.scene.root.kind !== "container") return;
    await studioStore.apply({
      project_id: studio.project_id,
      expected_project_revision: studio.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: studio.scene.root.node_id,
        child_index: studio.scene.root.children.length,
        instance_id: created.instance_id,
        basis: { kind: "fraction", weight: 1 },
      },
    });
  };
  const openResource = async (
    descriptor: ResourceDescriptor,
    surfaceId: "rho.file-source" | "rho.file-preview",
    modeId: "source" | "preview" | "diff" | "outline",
    placement?: { readonly container_node_id: string; readonly child_index: number },
  ) => {
    if (surfaces == null || studio == null) return;
    if (descriptor.status !== "ready") {
      throw new Error(`Resource ${descriptor.resource_id} is ${descriptor.status}.`);
    }
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const opened = await surfaceStore.open({
      surface_id: surfaceId,
      project_id: surfaces.project_id,
      mode_id: modeId,
      resource_binding: {
        resource_provider_id: descriptor.resource_provider_id,
        resource_kind: descriptor.resource_kind,
        resource_id: descriptor.resource_id,
        resource_revision: descriptor.resource_revision,
      },
      runtime_binding: null,
      view_group_id: null,
      view_state: { cursor_start: 0, cursor_end: 0, scroll_top: 0 },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Surface Runtime did not return the new file view.");
    if (studio.scene.root.kind !== "container") return;
    await studioStore.apply({
      project_id: studio.project_id,
      expected_project_revision: studio.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: placement?.container_node_id ?? studio.scene.root.node_id,
        child_index: placement?.child_index ?? studio.scene.root.children.length,
        instance_id: created.instance_id,
        basis: { kind: "fraction", weight: 1 },
      },
    });
  };
  const navigatorPlacement = (): { readonly container_node_id: string; readonly child_index: number } | undefined => {
    if (studio == null || studio.scene.root.kind !== "container") return undefined;
    const center = studio.scene.root.children
      .map((child) => child.child)
      .find((node) => node.kind === "container" && node.axis === "vertical");
    if (center == null || center.kind !== "container") return undefined;
    return { container_node_id: center.node_id, child_index: 0 };
  };
  const openNavigatorFile = async (descriptor: ResourceDescriptor) => {
    await openResource(descriptor, "rho.file-source", "source", navigatorPlacement());
  };
  const openSurfaceById = (surfaceId: string) => {
    const existing = surfaces?.catalog.instances.find((candidate) => candidate.surface_id === surfaceId);
    const placement = existing == null || studio == null
      ? null
      : findLayoutPlacement(studio.scene.root, existing.instance_id);
    if (existing != null && placement != null) {
      if (placement.kind === "stack" && !placement.active) {
        commit({ kind: "set_stack_active", stack_node_id: placement.nodeId, instance_id: existing.instance_id });
      } else {
        commit({ kind: "set_focus", instance_id: existing.instance_id });
      }
      return;
    }
    const factory = surfaces?.catalog.factories.find((candidate) => candidate.definition.surface_id === surfaceId);
    if (factory == null) {
      setActionError(`Surface ${surfaceId} is unavailable.`);
      return;
    }
    run(openFactory(factory));
  };
  const openFactory = async (
    factory: SurfaceFactoryRegistration,
    viewStateOverride?: unknown,
  ) => {
    if (surfaces == null || studio == null) {
      throw new Error("Surface Runtime is not ready.");
    }
    const definition = factory.definition;
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const primaryRuntime = runtimes?.instances.find((runtime) => runtime.primary_scientific_runtime);
    const consoleBinding = definition.surface_id === "rho.console" && primaryRuntime != null
      ? {
          runtime_provider_id: primaryRuntime.runtime_provider_id,
          runtime_instance_id: primaryRuntime.runtime_instance_id,
          runtime_kind: primaryRuntime.runtime_kind,
          project_id: primaryRuntime.project_id,
          activation_generation: primaryRuntime.activation_generation,
          state_revision: primaryRuntime.state_revision,
          attach_capabilities: primaryRuntime.attach_capabilities,
        }
      : null;
    const defaultViewState = definition.surface_id === "rho.agent"
      ? { conversation_id: null, mode: "ask", composer: "", auto_approve: false }
      : definition.surface_id === "rho.console"
        ? { draft: "", history: [], history_cursor: null, filter: "", scroll_top: 0, outputs: [] }
        : {};
    const opened = await surfaceStore.open({
      surface_id: definition.surface_id,
      project_id: surfaces.project_id,
      mode_id: definition.modes[0]?.mode_id ?? null,
      resource_binding: null,
      runtime_binding: consoleBinding,
      view_group_id: null,
      view_state: viewStateOverride ?? defaultViewState,
      instance_disposition: "new_instance",
      placement_intent: "current",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error(`${definition.label} did not create a Surface instance.`);
    if (profile?.active_mode === "studio" && studio.scene.root.kind === "container") {
      await studioStore.apply({
        project_id: studio.project_id,
        expected_project_revision: studio.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
        edit: {
          kind: "insert_surface",
          target_container_node_id: studio.scene.root.node_id,
          child_index: studio.scene.root.children.length,
          instance_id: created.instance_id,
          basis: definition.instance_quota_class === "strip"
            ? { kind: "intrinsic" }
            : { kind: "minmax", min_logical_pixels: 220, max_logical_pixels: 1_200, weight: 1 },
        },
      });
      return created;
    }
    await profileStore.refresh();
    const latest = profileStore.getProfileSnapshot();
    if (latest.status !== "ready") throw new Error("Vibe Page Profile is unavailable.");
    const latestProfile = latest.snapshot.profile;
    const page = latestProfile.vibe_pages.find(
      (candidate) => candidate.page_id === latestProfile.active_vibe_page_id,
    );
    if (page == null) throw new Error("The active Vibe Page is unavailable.");
    const block = {
      block_id: `vibe-block:${crypto.randomUUID().replaceAll("-", "")}`,
      content: { kind: "surface_ref" as const, instance_id: created.instance_id, live: true },
    };
    const sections = page.sections.length === 0
      ? [{
          section_id: `vibe-section:${crypto.randomUUID().replaceAll("-", "")}`,
          heading: definition.label,
          layout: { kind: "flow" as const },
          blocks: [block],
        }]
      : page.sections.map((section, index) => {
          if (index !== page.sections.length - 1) return section;
          if (section.layout.kind === "flow") {
            return { ...section, blocks: [...section.blocks, block] };
          }
          const nextRow = section.layout.placements.reduce(
            (maximum, placement) => Math.max(maximum, placement.row_start),
            0,
          ) + 1;
          return {
            ...section,
            blocks: [...section.blocks, block],
            layout: {
              ...section.layout,
              placements: [...section.layout.placements, {
                block_id: block.block_id,
                row_start: nextRow,
                column_start: 1,
                column_span: 12,
              }],
            },
          };
        });
    await profileStore.applyPage({
      target: {
        project_id: latestProfile.project_id,
        expected_profile_revision: latestProfile.revision,
      },
      page_id: page.page_id,
      expected_page_revision: page.page_revision,
      mutation: { kind: "replace_sections", sections, focused_block_id: block.block_id },
    });
    return created;
  };
  const invokeCommand = async (commandId: string) => {
    if (commandId === "rho.agent.new-conversation") {
      const factory = surfaces?.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === "rho.agent",
      );
      if (factory == null) throw new Error("Agent Surface factory is unavailable.");
      const conversation = await pluginTransport.createAgentConversation();
      await openFactory(factory, {
        conversation_id: conversation.conversation_id,
        mode: "ask",
        composer: "",
        auto_approve: false,
      });
      setCommandSearchOpen(false);
      return;
    }
    if (commandId.startsWith("rho.surface.open.")) {
      const surfaceId = `rho.${commandId.slice("rho.surface.open.".length)}`;
      const factory = surfaces?.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === surfaceId,
      );
      if (factory == null) throw new Error(`Surface factory ${surfaceId} is unavailable.`);
      await openFactory(factory);
      setCommandSearchOpen(false);
      return;
    }
    if (commandId !== "rho.check.run") {
      throw new Error(`Command ${commandId} has no RSR frontend handler yet.`);
    }
    if (snapshot == null || surfaces == null || studio == null) {
      throw new Error("Check project is unavailable until the project Surface Runtime is ready.");
    }
    const before = new Set(surfaces.catalog.instances.map((candidate) => candidate.instance_id));
    const response = await pluginTransport.runCheckProject({
      project_id: snapshot.project.project_id,
      expected_project_revision: snapshot.context.project_revision,
    });
    const opened = await surfaceStore.open({
      surface_id: "rho.check-result",
      project_id: surfaces.project_id,
      mode_id: null,
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: { check_result_id: response.result.result_id },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    });
    const created = opened.catalog.instances.find((candidate) => !before.has(candidate.instance_id));
    if (created == null) throw new Error("Check completed, but its result Surface was not created.");
    if (profile?.active_mode === "studio" && studio.scene.root.kind === "container") {
      await studioStore.apply({
        project_id: studio.project_id,
        expected_project_revision: studio.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
        edit: {
          kind: "insert_surface",
          target_container_node_id: studio.scene.root.node_id,
          child_index: studio.scene.root.children.length,
          instance_id: created.instance_id,
          basis: { kind: "minmax", min_logical_pixels: 280, max_logical_pixels: 900, weight: 1 },
        },
      });
    } else if (profile?.active_mode === "vibe") {
      await profileStore.refresh();
      const latest = profileStore.getProfileSnapshot();
      if (latest.status !== "ready") throw new Error("Vibe Page Profile is unavailable after Check.");
      const activePage = latest.snapshot.profile.vibe_pages.find(
        (page) => page.page_id === latest.snapshot.profile.active_vibe_page_id,
      );
      if (activePage == null) throw new Error("The active Vibe Page is unavailable after Check.");
      const block = {
        block_id: `vibe-block:${crypto.randomUUID().replaceAll("-", "")}`,
        content: { kind: "surface_ref" as const, instance_id: created.instance_id, live: true },
      };
      const sections = activePage.sections.length === 0
        ? [{
            section_id: `vibe-section:${crypto.randomUUID().replaceAll("-", "")}`,
            heading: "Check results",
            layout: { kind: "flow" as const },
            blocks: [block],
          }]
        : activePage.sections.map((section, index) => {
            if (index !== activePage.sections.length - 1) return section;
            if (section.layout.kind === "flow") {
              return { ...section, blocks: [...section.blocks, block] };
            }
            const nextRow = Math.max(0, ...section.layout.placements.map((placement) => placement.row_start)) + 1;
            return {
              ...section,
              blocks: [...section.blocks, block],
              layout: {
                kind: "grid" as const,
                placements: [...section.layout.placements, {
                  block_id: block.block_id,
                  row_start: nextRow,
                  column_start: 1,
                  column_span: 12,
                }],
              },
            };
          });
      await profileStore.applyPage({
        target: {
          project_id: latest.snapshot.profile.project_id,
          expected_profile_revision: latest.snapshot.profile.revision,
        },
        page_id: activePage.page_id,
        expected_page_revision: activePage.page_revision,
        mutation: {
          kind: "replace_sections",
          sections,
          focused_block_id: activePage.focused_block_id,
        },
      });
    }
    setCommandSearchOpen(false);
  };
  const pinAgentTask = async (turn: AgentTurnSummary) => {
    await profileStore.refresh();
    const latest = profileStore.getProfileSnapshot();
    if (latest.status !== "ready") throw new Error("The Project UI Profile is unavailable.");
    const latestProfile = latest.snapshot.profile;
    const activePage = latestProfile.vibe_pages.find(
      (page) => page.page_id === latestProfile.active_vibe_page_id,
    );
    if (activePage == null) throw new Error("The active Vibe Page is unavailable.");
    const block = {
      block_id: `vibe-block:${crypto.randomUUID().replaceAll("-", "")}`,
      content: {
        kind: "task_ref" as const,
        task_id: turn.turn_id,
        label: `${turn.mode.toUpperCase()} · ${turn.prompt_preview.slice(0, 96)}`,
      },
    };
    const sections = activePage.sections.length === 0
      ? [{
          section_id: `vibe-section:${crypto.randomUUID().replaceAll("-", "")}`,
          heading: "Agent tasks",
          layout: { kind: "flow" as const },
          blocks: [block],
        }]
      : activePage.sections.map((section, index) => {
          if (index !== activePage.sections.length - 1) return section;
          if (section.layout.kind === "flow") {
            return { ...section, blocks: [...section.blocks, block] };
          }
          const nextRow = section.layout.placements.reduce(
            (maximum, placement) => Math.max(maximum, placement.row_start),
            0,
          ) + 1;
          return {
            ...section,
            blocks: [...section.blocks, block],
            layout: {
              ...section.layout,
              placements: [...section.layout.placements, {
                block_id: block.block_id,
                row_start: nextRow,
                column_start: 1,
                column_span: 12,
              }],
            },
          };
        });
    await profileStore.applyPage({
      target: {
        project_id: latestProfile.project_id,
        expected_profile_revision: latestProfile.revision,
      },
      page_id: activePage.page_id,
      expected_page_revision: activePage.page_revision,
      mutation: {
        kind: "replace_sections",
        sections,
        focused_block_id: block.block_id,
      },
    });
  };
  const consoleRequirementController = useMemo(() => new ConsoleRequirementController({
    getSurfaces: surfaceStore.getSurfaceSnapshot,
    getStudio: studioStore.getStudioSnapshot,
    getRuntimes: runtimeStore.getRuntimeSnapshot,
    getProfile: profileStore.getProfileSnapshot,
    attachRuntime: (request) => runtimeStore.attach(request),
    refreshSurfaces: () => surfaceStore.refresh(),
    openSurface: (request) => surfaceStore.open(request),
    applyStudio: (request) => studioStore.apply(request),
    waitForRenderer: (instanceId) => consoleExecutionRouter.waitFor(instanceId),
    markPreferred: (instanceId) => consoleExecutionRouter.markPreferred(instanceId),
    allocateLayoutNodeId,
  }), [allocateLayoutNodeId, consoleExecutionRouter, profileStore, runtimeStore, studioStore, surfaceStore]);
  const runSourceExecution = async (
    sourceInstanceId: string,
    execution: SourceExecutionSubmission,
  ): Promise<boolean> => consoleExecutionRouter.run(
    sourceInstanceId,
    execution,
    () => consoleRequirementController.resolve(sourceInstanceId),
    setActionError,
  );
  const surfaceView = (
    instance: SurfaceInstance,
    embedded = false,
  ) => {
    const boundDescriptor = resources?.resources.find((descriptor) =>
      descriptor.resource_provider_id === instance.resource_binding?.resource_provider_id &&
      descriptor.resource_kind === instance.resource_binding?.resource_kind &&
      descriptor.resource_id === instance.resource_binding.resource_id
    ) ?? null;
    const activePage = profile?.vibe_pages.find(
      (page) => page.page_id === profile.active_vibe_page_id,
    ) ?? null;
    const availableModes = surfaces?.catalog.factories.find(
      (factory) => factory.definition.surface_id === instance.surface_id,
    )?.definition.modes ?? [];
    const pluginDocumentRequest: PluginSurfaceDocumentRequest | null =
      surfaces == null || studio == null || instance.origin.kind !== "workspace_plugin"
        ? null
        : {
            target: instanceRequest(instance, surfaces.project_revision),
            expected_layout_revision: profile?.active_mode === "studio"
              ? studio.scene.layout_revision
              : null,
            expected_page_revision: profile?.active_mode === "vibe"
              ? activePage?.page_revision ?? null
              : null,
          };
    return <SurfaceView
      key={instance.instance_id}
      instance={instance}
      focused={!embedded && studio?.scene.focused_surface_instance_id === instance.instance_id}
      setFocus={() => {
        if (!embedded && studio?.scene.focused_surface_instance_id !== instance.instance_id) {
          commit({ kind: "set_focus", instance_id: instance.instance_id });
        }
      }}
      remove={() => commit({ kind: "close_surface_placement", instance_id: instance.instance_id })}
      duplicate={() => run(duplicate(instance))}
      suspend={async () => {
        await surfaceMutationController.suspend(instance.instance_id);
      }}
      resume={async () => {
        await surfaceMutationController.resume(instance.instance_id);
      }}
      draftCache={draftCache}
      consoleSessionCache={consoleSessionCache}
      availableModes={availableModes}
      setMode={async (modeId) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_mode",
          mode_id: modeId,
        });
      }}
      persistDraft={(draft) => {
        run(surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: { draft },
        }), "surface.set_view_state");
      }}
      runtimes={runtimes}
      attachRuntime={async (runtime) => {
        if (surfaces == null || runtimes == null) return;
        await runtimeStore.attach({
          runtime: runtimeRequest(runtime, runtimes.project_revision),
          surface: instanceRequest(instance, surfaces.project_revision),
        });
        await surfaceStore.refresh();
      }}
      detachRuntime={async () => {
        if (surfaces == null) return;
        await runtimeStore.detach({
          surface: instanceRequest(instance, surfaces.project_revision),
        });
        await surfaceStore.refresh();
      }}
      startRuntimeExecution={async (runtime, code, sourceContext) => {
        await store.settled();
        const runtimeState = runtimeStore.getRuntimeSnapshot();
        const surfaceState = surfaceStore.getSurfaceSnapshot();
        if (runtimeState.status !== "ready" || surfaceState.status !== "ready") {
          throw new Error("Runtime Registry or Surface Runtime is not ready.");
        }
        const currentRuntime = runtimeState.snapshot.instances.find((candidate) =>
          candidate.runtime_instance_id === runtime.runtime_instance_id &&
          candidate.activation_generation === runtime.activation_generation
        );
        const currentConsole = surfaceState.snapshot.catalog.instances.find(
          (candidate) => candidate.instance_id === instance.instance_id,
        );
        if (currentRuntime == null || currentConsole == null) {
          throw new Error("The Console or Runtime changed before execution could start.");
        }
        const result = await workbenchOperationTrace.run(
          "runtime.execution.start",
          () => runtimeStore.startExecution({
            runtime: runtimeRequest(currentRuntime, runtimeState.snapshot.project_revision),
            console_instance_id: currentConsole.instance_id,
            expected_console_revision: currentConsole.surface_revision,
            code,
            ...(sourceContext == null ? {} : { source_context: sourceContext }),
          }),
          {
            fallback: "Runtime operation failed.",
            defaultKind: "runtime_infrastructure",
            scope: "surface",
          },
        );
        await runtimeStore.refresh();
        return result;
      }}
      followRuntimeOutput={async (executionId, afterSequence, listener) => {
        try {
          await runtimeStore.followOutput(executionId, afterSequence, listener);
        } finally {
          await runtimeStore.refresh();
        }
      }}
      listRuntimeExecutions={async () => (
        await runtimeStore.listExecutions(100)
      ).filter((execution) => execution.console_instance_id === instance.instance_id)}
      loadRuntimeOutputPage={(executionId, afterSequence) => (
        runtimeStore.outputPage(executionId, afterSequence)
      )}
      loadRuntimeOutputPageBefore={(executionId, beforeSequence) => (
        runtimeStore.outputPageBefore(executionId, beforeSequence)
      )}
      interruptRuntime={async (runtime) => {
        if (runtimes == null) return;
        await runtimeStore.interrupt(runtimeRequest(runtime, runtimes.project_revision));
      }}
      restartRuntime={async (runtime) => {
        if (runtimes == null) return;
        await runtimeStore.restart(runtimeRequest(runtime, runtimes.project_revision));
        await surfaceStore.refresh();
      }}
      persistConsole={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      registerConsoleExecution={registerConsoleExecution}
      markConsolePreferred={markConsolePreferred}
      runSourceExecution={runSourceExecution}
      resources={resources}
      readResource={async (descriptor, consistency, resourceRevision) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.read({
          target: resourceTarget(descriptor, resources.project_revision, resourceRevision),
          consistency,
        });
      }}
      updateResourceDraft={async (content, value) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.updateDraft({
          target: resourceTarget(content.descriptor, resources.project_revision),
          expected_document_revision: content.document_revision,
          content: value,
        });
      }}
      saveResource={async (content) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.save({
          target: resourceTarget(content.descriptor, resources.project_revision),
          expected_document_revision: content.document_revision,
        });
      }}
      reloadResource={async (content, discardDirty) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return resourceStore.reload({
          target: resourceTarget(content.descriptor, resources.project_revision),
          expected_document_revision: content.document_revision,
          discard_dirty: discardDirty,
        });
      }}
      renameResource={async (content, nextId) => {
        if (resources == null || boundDescriptor == null) {
          throw new Error("Bound Resource is unavailable.");
        }
        await resourceStore.rename({
          target: resourceTarget(boundDescriptor, resources.project_revision),
          expected_document_revision: content?.document_revision ?? null,
          new_resource_id: nextId,
        });
        await surfaceStore.refresh();
      }}
      deleteResource={async (content, discardDirty) => {
        if (resources == null || boundDescriptor == null) {
          throw new Error("Bound Resource is unavailable.");
        }
        await resourceStore.delete({
          target: resourceTarget(boundDescriptor, resources.project_revision),
          expected_document_revision: content?.document_revision ?? null,
          discard_dirty: discardDirty,
        });
      }}
      refreshResourceBinding={async (descriptor) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "bind_resource",
          binding: {
            resource_provider_id: descriptor.resource_provider_id,
            resource_kind: descriptor.resource_kind,
            resource_id: descriptor.resource_id,
            resource_revision: descriptor.resource_revision,
          },
        });
      }}
      setViewGroup={async (viewGroupId) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_group",
          view_group_id: viewGroupId,
        });
      }}
      persistFileViewState={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      reportError={(error) => setActionError(boundedFailureMessage(error, "Runtime operation failed."))}
      pluginTransport={pluginTransport}
      pluginDocumentRequest={pluginDocumentRequest}
      projectRevision={surfaces?.project_revision ?? 0}
      openCheckEvidence={async (path) => {
        const descriptor = resources?.resources.find((candidate) =>
          candidate.resource_provider_id === "rho.project-files" &&
          candidate.resource_kind === "project_file" &&
          candidate.resource_id === path
        );
        if (descriptor == null) throw new Error(`Check evidence Resource ${path} is unavailable.`);
        await openResource(descriptor, "rho.file-source", "source");
      }}
      agentHealth={snapshot?.health.agent ?? null}
      persistAgentViewState={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      persistSurfaceViewState={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      pinAgentTask={pinAgentTask}
      applyAgentFileProposal={async (turn, eventId, proposal) => {
        let beforeContent = "";
        let expectedDiskSha256: string | null = null;
        if (proposal.operation !== "create") {
          if (resources == null) throw new Error("Resource Registry is not ready.");
          let descriptor = resources.resources.find((candidate) =>
            candidate.resource_provider_id === "rho.project-files" &&
            candidate.resource_kind === "project_file" &&
            candidate.resource_id === proposal.path
          );
          if (descriptor == null) {
            const resolved = await resourceStore.resolve({
              project_id: resources.project_id,
              resource_provider_id: "rho.project-files",
              resource_kind: "project_file",
              resource_id: proposal.path,
              expected_project_revision: resources.project_revision,
              expected_snapshot_revision: resources.snapshot_revision,
            });
            descriptor = resolved.resources.find((candidate) =>
              candidate.resource_provider_id === "rho.project-files" &&
              candidate.resource_kind === "project_file" &&
              candidate.resource_id === proposal.path
            );
          }
          if (descriptor == null || descriptor.status !== "ready") {
            throw new Error(`Agent proposal target ${proposal.path} is unavailable.`);
          }
          const content = await resourceStore.read({
            target: resourceTarget(descriptor, resources.project_revision),
            consistency: "shared_document",
          });
          beforeContent = content.content;
          expectedDiskSha256 = descriptor.content_sha256;
          if (expectedDiskSha256 == null) {
            throw new Error(`Agent proposal target ${proposal.path} has no disk digest.`);
          }
        }
        const response = await pluginTransport.applyAgentFileEdit({
          turn_id: turn.turn_id,
          proposal_event_id: eventId,
          path: proposal.path,
          expected_disk_sha256: expectedDiskSha256,
          before_content: beforeContent,
        });
        await Promise.all([resourceStore.refresh(), surfaceStore.refresh()]);
        return { response, beforeContent };
      }}
      undoAgentFileProposal={async (request) => {
        await pluginTransport.undoAgentFileEdit(request);
        await Promise.all([resourceStore.refresh(), surfaceStore.refresh()]);
      }}
      embedded={embedded}
      openNavigatorFile={openNavigatorFile}
      openSurfaceById={openSurfaceById}
      agentRuntimeOutputContext={agentRuntimeOutputContext}
      setAgentRuntimeOutputContext={setAgentRuntimeOutputContext}
    />;
  };
  const activeVibePage = profile?.vibe_pages.find(
    (page) => page.page_id === profile.active_vibe_page_id,
  ) ?? null;
  const evidence = useMemo(() => ({
    ready: snapshot != null && surfaces != null && studio != null && runtimes != null && resources != null && profile != null && projectProjectionsCoherent,
    buildId: __RHO_FRONTEND_BUILD_ID__,
    operationTraceCount: workbenchOperationTrace.snapshot().length,
    source: state.status === "ready" ? state.source : null,
    project: snapshot?.project.display_path ?? null,
    layoutRevision: studio?.scene.layout_revision ?? null,
    surfaceInstanceCount: surfaces?.catalog.instances.length ?? 0,
    studioInstances: studio == null ? [] : [...instances.keys()],
    unplaced: studio?.unplaced_instance_ids ?? [],
    recursiveLayout: studio?.scene.root.kind ?? null,
    runtimeInstances: runtimes?.instances.map((runtime) => ({
      id: runtime.runtime_instance_id,
      generation: runtime.activation_generation,
      status: runtime.status,
    })) ?? [],
    resourceInstances: resources?.resources.map((resource) => ({
      id: resource.resource_id,
      revision: resource.resource_revision,
      status: resource.status,
    })) ?? [],
    profileRevision: profile?.revision ?? null,
    activeMode: profile?.active_mode ?? null,
    activeScene: profile?.active_studio_scene_id ?? null,
    activePage: profile?.active_vibe_page_id ?? null,
    activePageBlockCount: activeVibePage?.sections.reduce(
      (total, section) => total + section.blocks.length,
      0,
    ) ?? 0,
    profileLoadStatus: profileSnapshot?.load_status ?? null,
  }), [activeVibePage, instances, profile, profileSnapshot, projectProjectionsCoherent, resources, runtimes, snapshot, state, studio, surfaces]);
  useEffect(() => {
    document.documentElement.dataset.rsrReady = String(evidence.ready);
  }, [evidence.ready]);

  const closeRhoMenu = () => {
    if (rhoMenuRef.current != null) rhoMenuRef.current.open = false;
  };
  const refreshProjectProjections = () => store.refresh();
  const performProjectSwitch = async (
    operation: () => Promise<ProjectSwitchResponse>,
    targetPath: string | null,
  ) => projectSwitchController.perform(operation, targetPath, {
      start: (target) => {
        setProjectSwitching(true);
        setProjectSwitchTarget(target);
        setProjectSwitchError(null);
        setActionError(null);
      },
      accept: async () => {
        draftCache.clear();
        consoleSessionCache.clear();
        await refreshProjectProjections();
        closeRhoMenu();
      },
      refreshRestored: async () => {
        await refreshProjectProjections();
      },
      report: setProjectSwitchError,
      finish: () => {
        setProjectSwitching(false);
        setProjectSwitchTarget(null);
      },
    });
  const openCommandSearch = () => {
    closeRhoMenu();
    if (commandSearchRef.current == null) setCommandSearchTransient(true);
    else {
      commandSearchRef.current.focus();
      commandSearchRef.current.select();
    }
  };
  const commandSearch = (
    <div className="rho-command-search">
      <input
        ref={commandSearchRef}
        aria-label="Search commands"
        placeholder="Search or run a command…"
        value={commandQuery}
        onChange={(event) => setCommandQuery(event.target.value)}
        onFocus={() => setCommandSearchOpen(true)}
        onBlur={() => window.setTimeout(() => {
          setCommandSearchOpen(false);
          setCommandSearchTransient(false);
        }, 120)}
      />
      <kbd className="rho-command-kbd" aria-hidden="true">⌘K</kbd>
      <span className="rho-command-count">{snapshot?.command_registry.registrations.length ?? 0} commands</span>
      {commandSearchOpen && (
        <div className="rho-command-results" role="listbox">
          {paletteCommands.slice(0, 8).map((command) => (
            <button type="button" role="option" disabled={command.availability.state !== "available"} onClick={() => run(invokeCommand(command.definition.command_id))} key={command.definition.command_id}>
              <strong>{command.definition.label}</strong><code>{command.definition.command_id}</code>
            </button>
          ))}
          {paletteCommands.length === 0 && <p>No matching command</p>}
        </div>
      )}
    </div>
  );
  const railIconProps = {
    viewBox: "0 0 16 16",
    "aria-hidden": true,
    focusable: false,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  const RailSearchIcon = () => (
    <svg {...railIconProps}><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5" /></svg>
  );
  const RailFolderIcon = () => (
    <svg {...railIconProps}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 2h5.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7Z" /></svg>
  );
  const RailLayersIcon = () => (
    <svg {...railIconProps}><path d="m8 2 6 3-6 3-6-3 6-3Z" /><path d="m2 8.5 6 3 6-3" /></svg>
  );
  const RailPlayIcon = () => (
    <svg {...railIconProps}><path d="M5 3.5v9l7-4.5-7-4.5Z" /></svg>
  );
  const RailComposeIcon = () => (
    <svg {...railIconProps}><rect x="2" y="2.5" width="12" height="11" rx="1" /><path d="M9.5 2.5v11" /></svg>
  );
  const RailStudioIcon = () => (
    <svg {...railIconProps}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
  );
  const RailVibeIcon = () => (
    <svg {...railIconProps}><path d="M8 2v4M8 10v4M2 8h4M10 8h4M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2" /></svg>
  );
  const renderToolbarComponent = (componentId: ToolbarComponentId) => {
    let content: ReactNode;
    switch (componentId) {
      case "project_context":
        content = (
          <button
            type="button"
            className="rho-rail-btn"
            title={snapshot?.project.display_path ?? ""}
            aria-label={`Project ${snapshot?.project.display_label ?? "menu"}`}
            onClick={() => {
              setToolbarCustomizerOpen(false);
              if (rhoMenuRef.current != null) rhoMenuRef.current.open = true;
            }}
          ><RailFolderIcon /></button>
        );
        break;
      case "scene_selector":
        content = (
          <details className="rho-rail-popover">
            <summary
              className="rho-rail-btn"
              aria-label={profile?.active_mode === "vibe" ? "Vibe Pages" : "Studio Scenes"}
              title={profile?.active_mode === "vibe" ? "Vibe Pages" : "Studio Scenes"}
            ><RailLayersIcon /></summary>
            <div className="rho-rail-popover-panel">
              {profile?.active_mode === "vibe" ? (
                <select
                  aria-label="Active Vibe Page"
                  value={profile.active_vibe_page_id ?? ""}
                  onChange={(event) => {
                    const target = profileRevisionRequest();
                    if (target != null) run(profileStore.selectPage({ target, page_id: event.target.value }));
                  }}
                >{profile.vibe_pages.map((page) => <option value={page.page_id} key={page.page_id}>{page.label}</option>)}</select>
              ) : (
                <select
                  aria-label="Active Studio Scene"
                  value={profile?.active_studio_scene_id ?? ""}
                  onChange={(event) => {
                    const target = profileRevisionRequest();
                    if (target != null) run(profileStore.selectScene({ target, scene_id: event.target.value }));
                  }}
                >{profile?.studio_scenes.map((scene) => <option value={scene.scene_id} key={scene.scene_id}>{scene.label}</option>)}</select>
              )}
              {profile?.active_mode !== "vibe" && (
                <>
                  <button type="button" disabled={profile == null || studio == null} onClick={() => {
                    const target = profileRevisionRequest();
                    const scene = profile?.studio_scenes.find((candidate) => candidate.scene_id === profile.active_studio_scene_id);
                    if (target != null && scene != null) run(profileStore.duplicateScene({ target, scene_id: scene.scene_id, label: `${scene.label} copy` }));
                  }}>Duplicate</button>
                  <button type="button" disabled={profile == null || studio == null} onClick={() => {
                    const target = profileRevisionRequest();
                    if (target != null && profile?.active_studio_scene_id != null) run(profileStore.saveScene({ target, scene_id: profile.active_studio_scene_id }));
                  }}>Save</button>
                  <button type="button" disabled={profile == null} onClick={() => {
                    const target = profileRevisionRequest();
                    const scene = profile?.studio_scenes.find((candidate) => candidate.scene_id === profile.active_studio_scene_id);
                    const label = scene == null ? null : window.prompt("Scene name", scene.label)?.trim();
                    if (target != null && scene != null && label) run(profileStore.renameScene({ target, scene_id: scene.scene_id, label }));
                  }}>Rename</button>
                  <button type="button" disabled={(profile?.studio_scenes.length ?? 0) < 2} onClick={() => {
                    const target = profileRevisionRequest();
                    if (target != null && profile?.active_studio_scene_id != null) run(profileStore.deleteScene({ target, scene_id: profile.active_studio_scene_id }));
                  }}>Delete</button>
                  <button type="button" disabled={profile == null} onClick={() => {
                    const target = profileRevisionRequest();
                    if (target != null && profile?.active_studio_scene_id != null) run(profileStore.resetScene({ target, scene_id: profile.active_studio_scene_id }));
                  }}>Reset to Rho Studio</button>
                  <span className="rho-menu-separator" />
                  <button type="button" disabled={!studio?.can_undo} onClick={() => void studioMutationController.undo()}>Undo</button>
                  <button type="button" disabled={!studio?.can_redo} onClick={() => void studioMutationController.redo()}>Redo</button>
                </>
              )}
            </div>
          </details>
        );
        break;
      case "command_search":
        content = (
          <button
            type="button"
            className="rho-rail-btn"
            title="Command search (⌘K)"
            aria-label="Command search"
            onClick={() => {
              closeRhoMenu();
              setCommandSearchTransient(true);
            }}
          ><RailSearchIcon /></button>
        );
        break;
      case "project_action":
        content = (
          <div className="rho-command-projection" aria-label="Primary contextual command">
            {primaryCommands.filter((command) => command.availability.state === "available" && command.definition.command_id === "rho.check.run").slice(0, 1).map((command) => <button type="button" className="rho-rail-btn" title={command.definition.label} aria-label={command.definition.label} onClick={() => run(invokeCommand(command.definition.command_id))} key={command.definition.command_id}><RailPlayIcon /></button>)}
          </div>
        );
        break;
      case "runtime_status":
        content = (
          <div
            className="rho-foundation-status"
            title={snapshot?.health.workspace.label ?? "Connecting"}
          ><span className={`rho-status-dot rho-status-${snapshot?.context.workspace_health ?? state.status}`} /></div>
        );
        break;
      case "compose":
        content = (
          <button
            className="rho-rail-choice rho-bar-compose"
            type="button"
            aria-pressed={inspectorOpen}
            title="Arrange workspace components"
            onClick={() => setInspectorOpen((open) => !open)}
          ><RailComposeIcon /><span>Compose</span></button>
        );
        break;
    }
    return (
      <div
        className={`rho-toolbar-slot rho-toolbar-slot-${componentId.replaceAll("_", "-")}`}
        data-toolbar-component={componentId}
        key={componentId}
      >{content}</div>
    );
  };
  const visibleToolbarComponents = toolbarLayout.order.filter((componentId) =>
    toolbarLayout.visible.includes(componentId)
  );
  const recentProjectPaths = projectHistory.history.paths.filter((path) =>
    path !== snapshot?.project.display_path
  );
  const componentFactories = surfaces?.catalog.factories.filter(
    (factory) => factory.definition.surface_id !== "rho.surface-playground",
  ) ?? [];
  const developerFactories = surfaces?.catalog.factories.filter(
    (factory) => factory.definition.surface_id === "rho.surface-playground",
  ) ?? [];
  const pluginFactories = surfaces?.catalog.factories.filter(
    (factory) => factory.definition.origin.kind === "workspace_plugin",
  ) ?? [];
  const activePluginSurfaceIds = new Set(
    surfaces?.catalog.instances
      .filter((instance) =>
        instance.origin.kind === "workspace_plugin" && instance.lifecycle_state === "active"
      )
      .map((instance) => instance.surface_id) ?? [],
  );
  const renderComponentFactory = (factory: SurfaceFactoryRegistration, developer = false) => {
    const surfaceId = factory.definition.surface_id;
    const label = surfaceId.startsWith("rho.")
      ? surfaceDisplayLabel(surfaceId)
      : factory.definition.label;
    const purpose = developer
      ? "Preview instance-local component state without project or Runtime authority."
      : surfaceId.startsWith("rho.")
        ? surfaceUxProfile(surfaceId).primaryTask
        : factory.definition.purpose;
    return <article className="rho-surface-factory" data-surface-factory={surfaceId} key={`${surfaceId}:${factory.activation_generation}`}>
      <div>
        <strong>{label}</strong>
        {factory.definition.origin.kind === "workspace_plugin" && <span className="rho-component-origin">Project component</span>}
        <small>{purpose}</small>
      </div>
      <button type="button" onClick={() => run(openFactory(factory))}>{developer ? "Open preview" : "Open"}</button>
    </article>;
  };
  const toolbarSplit = Math.ceil(visibleToolbarComponents.length / 2);
  const leftToolbarComponents = visibleToolbarComponents.slice(0, toolbarSplit);
  const rightToolbarComponents = visibleToolbarComponents.slice(toolbarSplit);

  return (
    <main className="rho-studio-shell">
      <header className="rho-studio-bar">
        <div className="rho-toolbar-anchor rho-toolbar-anchor-left">
          <details className="rho-rho-menu" ref={rhoMenuRef}>
            <summary ref={rhoMenuTriggerRef} aria-label="Rho menu" onClick={() => setToolbarCustomizerOpen(false)}><span className="rho-mark-word">Rho</span><span aria-hidden="true">⌄</span></summary>
            <div className="rho-rho-menu-panel" aria-busy={projectSwitching}>
              <button
                type="button"
                className="rho-rho-project"
                aria-label="Open a different project folder"
                disabled={snapshot == null || projectSwitching}
                onClick={() => void performProjectSwitch(
                  () => pluginTransport.pickProjectDirectory(),
                  null,
                )}
              >
                <span className="rho-rho-project-copy">
                  <span className="rho-eyebrow">Project</span>
                  <strong>{snapshot?.project.display_label ?? "Loading…"}</strong>
                  <small>{snapshot?.project.display_path ?? ""}</small>
                </span>
                <span className="rho-project-switch-hint">
                  {projectSwitching && projectSwitchTarget == null ? "Choosing…" : "Switch…"}
                </span>
              </button>
              {recentProjectPaths.length > 0 && (
                <div className="rho-recent-projects">
                  <div className="rho-recent-projects-heading">
                    <span className="rho-eyebrow">Recent projects</span>
                    <span>{recentProjectPaths.length}</span>
                  </div>
                  {recentProjectPaths.map((path) => (
                    <button
                      type="button"
                      data-project-path={path}
                      disabled={projectSwitching}
                      key={path}
                      onClick={() => void performProjectSwitch(
                        () => pluginTransport.openProject(path),
                        path,
                      )}
                    >
                      <span>
                        <strong>{projectLabel(path)}</strong>
                        <small>{path}</small>
                      </span>
                      <span aria-hidden="true">
                        {projectSwitching && projectSwitchTarget === path ? "…" : "›"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {projectSwitchError != null && (
                <p className="rho-project-switch-error" role="alert">{projectSwitchError}</p>
              )}
              {projectHistory.status === "unavailable" && projectHistory.detail != null && (
                <p className="rho-project-history-status" role="status">{projectHistory.detail}</p>
              )}
              <span className="rho-menu-separator" />
              <button type="button" onClick={openCommandSearch}><span>Command search</span><kbd>⌘K</kbd></button>
              <button type="button" onClick={() => {
                closeRhoMenu();
                setToolbarCustomizerOpen(true);
              }}>Customize toolbar…</button>
              <button
                type="button"
                className="rho-build-identity"
                title="Copy this development build identity"
                onClick={() => void navigator.clipboard?.writeText(__RHO_FRONTEND_BUILD_ID__)}
              >
                <span>Development build</span>
                <code>{__RHO_FRONTEND_BUILD_ID__}</code>
              </button>
              <button
                type="button"
                className="rho-session-diagnostics"
                onClick={() => void navigator.clipboard?.writeText(JSON.stringify({
                  build_id: __RHO_FRONTEND_BUILD_ID__,
                  operations: workbenchOperationTrace.snapshot(),
                }, null, 2))}
              >
                <span>Copy session diagnostics</span>
                <span aria-hidden="true">⌘C</span>
              </button>
            </div>
          </details>
        </div>
        <div className="rho-mode-switch" aria-label="Workspace mode">
          {(["studio", "vibe"] as const).map((mode) => (
            <button
              type="button"
              className="rho-rail-choice"
              aria-pressed={profile?.active_mode === mode}
              title={mode === "studio" ? "Studio mode" : "Vibe mode"}
              disabled={profile == null}
              key={mode}
              onClick={() => {
                const target = profileRevisionRequest();
                if (target != null && profile?.active_mode !== mode) {
                  run(profileStore.setMode({ target, mode }));
                }
              }}
            >{mode === "studio" ? <RailStudioIcon /> : <RailVibeIcon />}<span>{mode === "studio" ? "Studio" : "Vibe"}</span></button>
          ))}
        </div>
        {pluginFactories.length > 0 && (
          <nav className="rho-plugin-rail" aria-label="Workspace plugins">
            {pluginFactories.map((factory) => {
              const { definition } = factory;
              const origin = definition.origin;
              const pluginId = origin.kind === "workspace_plugin" ? origin.plugin_id : "";
              const fallback = Array.from(definition.label.trim())[0]?.toUpperCase() ?? "?";
              const active = activePluginSurfaceIds.has(definition.surface_id);
              return (
                <button
                  key={`${definition.surface_id}:${factory.activation_generation}`}
                  type="button"
                  className={`rho-plugin-icon${active ? " rho-plugin-icon-active" : ""}`}
                  title={`${definition.label} · ${pluginId}`}
                  aria-label={`Open ${definition.label}`}
                  onClick={() => run(openFactory(factory))}
                >
                  <span aria-hidden="true">{definition.icon ?? fallback}</span>
                </button>
              );
            })}
          </nav>
        )}
        <div className="rho-toolbar-anchor rho-toolbar-anchor-right">
          <div className="rho-toolbar-lane rho-toolbar-lane-left">
            {leftToolbarComponents.map(renderToolbarComponent)}
          </div>
          <div className="rho-toolbar-lane rho-toolbar-lane-right">
            {rightToolbarComponents.map(renderToolbarComponent)}
          </div>
          <ToolbarCustomizer
            layout={toolbarLayout}
            open={toolbarCustomizerOpen}
            persistenceStatus={toolbarPreference.status}
            persistenceDetail={toolbarPreference.detail}
            onOpenChange={(open) => {
              if (open) closeRhoMenu();
              setToolbarCustomizerOpen(open);
            }}
            onPreview={previewToolbarLayout}
            onCommit={commitToolbarLayout}
          />
        </div>
        {commandSearchTransient && (
          <div className="rho-toolbar-command-overlay">{commandSearch}</div>
        )}
      </header>
      <div className="rho-studio-main">
      <div className={`rho-studio-workspace ${inspectorOpen ? "rho-inspector-open" : "rho-inspector-closed"}`}>
        {inspectorOpen && <aside className="rho-studio-inspector">
          <header>
            <div><span className="rho-eyebrow">Compose</span><strong>Arrange workspace</strong></div>
            <button type="button" onClick={() => setInspectorOpen(false)}>Done</button>
          </header>
          <p className="rho-compose-intro">Add components here. Move and resize them directly on the workspace.</p>
          {snapshot?.health.agent.state !== "ready" && snapshot?.health.agent.label != null && (
            <div className="rho-agent-health" role="status">
              <strong>{snapshot.health.agent.label}</strong>
              {snapshot.health.agent.detail != null && <small>{snapshot.health.agent.detail}</small>}
            </div>
          )}
          {studio != null && (
            <>
              <details className="rho-compose-layout">
                <summary><span>Layout structure</span><span>Advanced</span></summary>
                <div className="rho-inspector-actions">
                  <button type="button" onClick={() => commit({ kind: "normalize" })}>Normalize</button>
                  {studio.scene.root.kind === "container" && <button type="button" onClick={() => commit({ kind: "distribute_container", container_node_id: studio.scene.root.node_id })}>Distribute</button>}
                </div>
                <ol className="rho-layout-outline"><li><NodeOutline node={studio.scene.root} commit={commit} /></li></ol>
              </details>
              {surfaces != null && (
                <section className="rho-surface-catalog">
                  <div className="rho-surface-catalog-heading">
                    <span className="rho-eyebrow">Components</span>
                    <span>{componentFactories.length}</span>
                  </div>
                  {componentFactories.map((factory) => renderComponentFactory(factory))}
                  {developerFactories.length > 0 && <details className="rho-developer-components">
                    <summary><span>Developer tools</span><span>{developerFactories.length}</span></summary>
                    <p>Preview and diagnostic components are kept separate from the normal workbench catalog.</p>
                    {developerFactories.map((factory) => renderComponentFactory(factory, true))}
                  </details>}
                </section>
              )}
              {studio.unplaced_instance_ids.length > 0 && <section className="rho-inventory">
                <span className="rho-eyebrow">Unplaced instances</span>
                {studio.unplaced_instance_ids.map((id) => {
                  const instance = instances.get(id);
                  return (
                    <div key={id} className="rho-inventory-item">
                      <div><strong>{instance?.surface_id ?? id}</strong><small>{instance?.mode_id ?? "default"}</small></div>
                      <button
                        type="button"
                        disabled={studio.scene.root.kind !== "container"}
                        onClick={() => {
                          if (studio.scene.root.kind !== "container") return;
                          commit({
                            kind: "insert_surface",
                            target_container_node_id: studio.scene.root.node_id,
                            child_index: studio.scene.root.children.length,
                            instance_id: id,
                            basis: instance?.surface_id === "rho.status" ? { kind: "intrinsic" } : { kind: "fraction", weight: 1 },
                          });
                        }}
                      >Place</button>
                    </div>
                  );
                })}
              </section>}
            </>
          )}
          {resources != null && (
            <details className="rho-compose-advanced">
              <summary><span>Resource registry</span><span>{resources.resources.length}</span></summary>
              <section className="rho-resource-inventory">
              <div className="rho-resource-inventory-heading">
                <span className="rho-eyebrow">Resource registry</span>
                <span>{resources.resources.length} resolved</span>
              </div>
              <form onSubmit={(event) => {
                event.preventDefault();
                const provider = resources.providers.find((candidate) =>
                  candidate.definition.resource_kinds.includes("project_file")
                );
                if (provider == null) return;
                run(resourceStore.resolve({
                  project_id: resources.project_id,
                  resource_provider_id: provider.definition.resource_provider_id,
                  resource_kind: "project_file",
                  resource_id: resourcePath,
                  expected_project_revision: resources.project_revision,
                  expected_snapshot_revision: resources.snapshot_revision,
                }));
              }}>
                <input aria-label="Resolve project Resource" value={resourcePath} onChange={(event) => setResourcePath(event.target.value)} />
                <button type="submit">Resolve</button>
              </form>
              {resources.resources.map((resource) => (
                <article className="rho-resource-card" data-resource-id={resource.resource_id} key={`${resource.resource_provider_id}:${resource.resource_id}`}>
                  <div>
                    <span className={`rho-resource-dot rho-resource-${resource.status}`} />
                    <strong>{resource.label}</strong>
                    <small>{resource.resource_id} · r{resource.resource_revision}</small>
                  </div>
                  <div className="rho-resource-open-actions">
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.read.document")} onClick={() => run(openResource(resource, "rho.file-source", "source"))}>Source</button>
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.preview")} onClick={() => run(openResource(resource, "rho.file-preview", "preview"))}>Preview</button>
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.read.document")} onClick={() => run(openResource(resource, "rho.file-source", "diff"))}>Diff</button>
                    <button type="button" disabled={resource.status !== "ready" || !resource.capabilities.includes("resource.read.document")} onClick={() => run(openResource(resource, "rho.file-source", "outline"))}>Outline</button>
                  </div>
                </article>
              ))}
              </section>
            </details>
          )}
          {runtimes != null && (
            <details className="rho-compose-advanced">
              <summary><span>Runtime controls</span><span>{runtimes.instances.length}</span></summary>
              <section className="rho-runtime-inventory">
              <div className="rho-runtime-inventory-heading">
                <span className="rho-eyebrow">Runtime registry</span>
                {runtimes.providers.some((provider) => provider.definition.create_supported) && (
                  <button type="button" onClick={() => {
                    const provider = runtimes.providers.find((candidate) => candidate.definition.create_supported);
                    if (provider == null) return;
                    run(runtimeStore.create({
                      project_id: runtimes.project_id,
                      runtime_provider_id: provider.definition.runtime_provider_id,
                      expected_project_revision: runtimes.project_revision,
                      expected_snapshot_revision: runtimes.snapshot_revision,
                      display_label: null,
                    }));
                  }}>+ Runtime</button>
                )}
              </div>
              {runtimes.instances.map((runtime) => (
                <article className="rho-runtime-card" data-runtime-id={runtime.runtime_instance_id} key={runtime.runtime_instance_id}>
                  <div>
                    <span className={`rho-runtime-dot rho-runtime-${runtime.status}`} />
                    <strong>{runtime.display_label}</strong>
                    <small>{runtime.runtime_instance_id} · gen {runtime.activation_generation}</small>
                  </div>
                  <div className="rho-runtime-actions">
                    <button type="button" onClick={() => run(openConsole(runtime))}>Console</button>
                    <button type="button" onClick={() => run(runtimeStore.interrupt(runtimeRequest(runtime, runtimes.project_revision)))}>Interrupt</button>
                    <button type="button" onClick={() => run(runtimeStore.restart(runtimeRequest(runtime, runtimes.project_revision)))}>Restart</button>
                    {!runtime.primary_scientific_runtime && (
                      <button type="button" onClick={() => run(runtimeStore.stop(runtimeRequest(runtime, runtimes.project_revision)))}>Stop</button>
                    )}
                  </div>
                </article>
              ))}
              </section>
            </details>
          )}
        </aside>}
        <section className={`rho-studio-canvas rho-canvas-${profile?.active_mode ?? "loading"}`} aria-label={profile?.active_mode === "vibe" ? "Vibe page canvas" : "Studio layout canvas"}>
          {state.status === "failed" && <p role="alert">{state.message}</p>}
          {profileSnapshot?.recovery_detail != null && (
            <div className="rho-profile-recovery" role="status">
              <div><strong>UI Profile recovered from backup</strong><code>{profileSnapshot.recovery_detail}</code></div>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(profileSnapshot.recovery_detail ?? "")}>Copy diagnostics</button>
            </div>
          )}
          {actionError != null && <p className="rho-action-error" role="alert">{actionError}</p>}
          {profile == null || surfaces == null || studio == null || !projectProjectionsCoherent
            ? <div className="rho-studio-loading">{projectSwitching ? "Switching project…" : "Loading the project UI Profile…"}</div>
            : profile.active_mode === "vibe"
              ? activeVibePage == null
                ? <div className="rho-studio-loading">The active Vibe Page is unavailable.</div>
                : <VibePageEditor
                    key={profile.project_id}
                    page={activeVibePage}
                    profileRevision={profile.revision}
                    instances={instances}
                    renderSurface={(instance) => surfaceView(instance, true)}
                    invokeCommand={invokeCommand}
                    commit={(request) => profileStore.applyPage(request)}
                    exportPage={(request) => profileStore.exportPage(request)}
                    reportError={(error) => setActionError(
                      error instanceof Error && error.message.trim()
                        ? error.message.slice(0, 512)
                        : "Vibe Page operation failed.",
                    )}
                  />
              : <DockviewSceneLayout
                  key={studio.project_id}
                  node={studio.scene.root}
                  instances={instances}
                  studio={studio}
                  commit={commit}
                  allocateLayoutNodeId={allocateLayoutNodeId}
                  surfaceView={surfaceView}
                />}
        </section>
      </div>
      <footer className="rho-statusbar" aria-label="Workbench status">
        <span className="rho-statusbar-item">
          <span className={`rho-status-dot rho-status-${snapshot?.context.workspace_health ?? "unknown"}`} />
          {snapshot?.health.workspace.label ?? "Connecting"}
        </span>
        <span className="rho-statusbar-item">
          <span className={`rho-status-dot rho-status-${snapshot?.context.agent_health ?? "unknown"}`} />
          {snapshot?.health.agent.label ?? "Agent"}
        </span>
        {(snapshot?.context.active_operations.length ?? 0) > 0 && <span className="rho-statusbar-item" aria-live="polite">
          {`${snapshot!.context.active_operations.length} task${snapshot!.context.active_operations.length > 1 ? "s" : ""} running`}
        </span>}
        <button
          type="button"
          className="rho-link"
          disabled={surfaces?.catalog.factories.some((factory) => factory.definition.surface_id === "rho.problems") !== true}
          onClick={() => {
            const problems = surfaces?.catalog.factories.find((factory) => factory.definition.surface_id === "rho.problems");
            if (problems != null) run(openFactory(problems));
          }}
        >Diagnostics</button>
        <span className="rho-statusbar-path" title={snapshot?.project.display_path ?? ""}>{snapshot?.project.display_path ?? ""}</span>
      </footer>
      </div>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
