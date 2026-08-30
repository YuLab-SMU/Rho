import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  WorkbenchProjectionStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type { WorkbenchMutationLease } from "../transport/workbench-store";
import type {
  AgentTurnSummary,
  PluginSurfaceDocumentRequest,
  ProjectSwitchResponse,
  LayoutNode,
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
import {
  VibeWorkspaceSurface,
  type VibeReturnPoint,
  type VibeWorkspaceSurfaceHandle,
} from "./vibe/core/VibeWorkspaceSurface";
import {
  createVibeVerificationReadPort,
} from "./vibe/core/vibe-verification-read-port";
import {
  exactAgentSurfaceRequest,
  exactSurfaceInstance,
  exactSurfaceRequestForTarget,
  type OpenVibeTargetInStudioIntent,
  type VibeExactSurfaceRequest,
  type VibeStudioTarget,
} from "./vibe/core/vibe-studio-target";
import {
  blockForId,
  exactReferencesForBlock,
  sameVibeExactReferences,
} from "./vibe/core/vibe-workspace-model";
import { vibeFailureMessage } from "./vibe/core/vibe-failure";
import {
  createVerificationAdapter,
  type VerificationScope,
} from "./vibe/verification";
import { EnvironmentTaskbarPanel } from "./EnvironmentSurfaceView";
import type { FileMutationWorkflow } from "./FileResourceView";
import { MenuPopover } from "./MenuPopover";
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
import { installAcceptanceAutomation } from "../acceptance/automation";
import type { AutomationHost } from "../acceptance/automation";
import { ConsoleExecutionRouter } from "./controllers/console-execution-router";
import type { ConsoleExecutionEndpoint } from "./controllers/console-execution-router";
import { useConsoleProjectActivation } from "./controllers/console-project-activation";
import { ProjectSwitchController } from "./controllers/project-switch-controller";
import {
  ProjectTransitionEpochController,
  type ProjectActionScope,
  type ProjectActivationScope,
  type ProjectTransitionEpochToken,
} from "./controllers/project-transition-epoch-controller";
import {
  consolePinnedExecutionId,
  type ConsoleViewState,
} from "./controllers/console-instance-controller";
import { ConsoleRequirementController } from "./controllers/console-requirement-controller";
import { StudioMutationController } from "./controllers/studio-mutation-controller";
import { type AgentStudioPresentation } from "./agent/studio-presentation";
import {
  presentAgentTurnInStudio as applyAgentStudioPresentation,
} from "./controllers/agent-studio-presentation-controller";
import { SurfaceInstanceMutationController } from "./controllers/surface-instance-mutation-controller";
import {
  COMPOSE_FLOW_STAGES,
  compareSurfaceCatalogOrder,
  surfaceCatalogPolicy,
  surfaceDisplayLabel,
  surfaceUxProfile,
} from "./surface-ux";
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

function layoutInstanceIds(node: LayoutNode): string[] {
  switch (node.kind) {
    case "surface": return [node.instance_id];
    case "stack": return [...node.instances];
    case "container": return node.children.flatMap((child) => layoutInstanceIds(child.child));
  }
}

function LayoutMiniMap({
  node,
  instances,
  focusedInstanceId,
}: {
  readonly node: LayoutNode;
  readonly instances: ReadonlyMap<string, SurfaceInstance>;
  readonly focusedInstanceId: string | null;
}) {
  if (node.kind === "surface") {
    const instance = instances.get(node.instance_id);
    return <span
      className="rho-layout-mini-surface"
      data-focused={node.instance_id === focusedInstanceId || undefined}
      title={instance == null ? node.instance_id : surfaceDisplayLabel(instance.surface_id)}
    >{instance == null ? "?" : surfaceRailGlyph(instance.surface_id)}</span>;
  }
  if (node.kind === "stack") {
    return <span className="rho-layout-mini-stack">{node.instances.slice(0, 4).map((instanceId) => {
      const instance = instances.get(instanceId);
      return <span data-focused={instanceId === focusedInstanceId || undefined} key={instanceId}>{instance == null ? "?" : surfaceRailGlyph(instance.surface_id)}</span>;
    })}</span>;
  }
  return <span className={`rho-layout-mini-container rho-layout-mini-${node.axis}`}>
    {node.children.map((child) => <LayoutMiniMap node={child.child} instances={instances} focusedInstanceId={focusedInstanceId} key={child.child.node_id} />)}
  </span>;
}

function surfaceRailGlyph(surfaceId: string): string {
  switch (surfaceId) {
    case "rho.navigator": return "N";
    case "rho.file-source": return "R";
    case "rho.file-preview": return "P";
    case "rho.console": return ">_";
    case "rho.plots": return "▧";
    case "rho.runs": return "↺";
    case "rho.agent": return "✦";
    case "rho.environment": return "◉";
    case "rho.git": return "⑂";
    default: return surfaceDisplayLabel(surfaceId).slice(0, 1).toUpperCase();
  }
}

function surfaceToolHints(surfaceId: string): readonly string[] {
  switch (surfaceId) {
    case "rho.file-source": return ["Run the current expression from the Source toolbar", "Save or reload from the component header"];
    case "rho.console": return ["Return runs code", "Shift+Return inserts a new line"];
    case "rho.navigator": return ["Switch between Files and History", "Search the current project tree"];
    case "rho.plots": return ["Browse current and historical project plots", "Use exact Plot links from Console or History"];
    case "rho.environment": return ["Inspect Resources, Toolchains, Packages, and Requests"];
    default: return [surfaceUxProfile(surfaceId).primaryTask];
  }
}

interface WorkbenchAppProps {
  readonly transport?: UiKernelTransport;
}

interface ScopedActionError {
  readonly message: string;
  readonly scope: ProjectActionScope;
}

function boundedFailureMessage(error: unknown, fallback: string): string {
  return workbenchFailureMessage(error, fallback);
}

export async function settleWorkbenchMutationQueues(
  controllerQueues: readonly Promise<void>[],
  settleStore: () => Promise<void>,
): Promise<void> {
  const controllerResults = await Promise.allSettled(controllerQueues);
  let storeFailure: unknown = null;
  try {
    await settleStore();
  } catch (error: unknown) {
    storeFailure = error;
  }
  const controllerFailure = controllerResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (controllerFailure != null) throw controllerFailure.reason;
  if (storeFailure != null) throw storeFailure;
}

export async function runRevocableFileMutationWorkflow<T>(
  operation: (workflow: FileMutationWorkflow) => Promise<T>,
  ports: FileMutationWorkflow,
): Promise<T> {
  let open = true;
  const runIfOpen = <Result,>(action: () => Promise<Result>): Promise<Result> => (
    open
      ? action()
      : Promise.reject(new Error("The File workflow capability has expired."))
  );
  const workflow: FileMutationWorkflow = {
    updateDraft: (content, value) => runIfOpen(() => ports.updateDraft(content, value)),
    save: (content) => runIfOpen(() => ports.save(content)),
    runSourceExecution: (execution) => runIfOpen(() => ports.runSourceExecution(execution)),
  };
  try {
    return await operation(workflow);
  } finally {
    open = false;
  }
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

function sameProjectActionScope(
  left: ProjectActionScope | null,
  right: ProjectActionScope | null,
): boolean {
  return left?.epoch === right?.epoch
    && left?.projectId === right?.projectId
    && left?.projectRevision === right?.projectRevision;
}

const ADMISSION_GUARDED_TRANSPORT_METHODS = new Set<PropertyKey>([
  "retryRun",
  "updateRuntimeOutputPolicy",
  "pruneRuntimeOutput",
  "deleteRuntimeExecution",
  "createAgentConversation",
  "runAgent",
  "retryAgentTurn",
  "cancelAgentTurn",
  "respondAgentApproval",
  "retryAgentRuntime",
  "applyAgentFileEdit",
  "undoAgentFileEdit",
  "dispatchPluginSurfaceEvent",
  "runCheckProject",
  "setSelection",
]);

function createAdmissionGuardedTransport(
  transport: UiKernelTransport,
  store: WorkbenchProjectionStore,
  controller: ProjectTransitionEpochController,
  scope: ProjectActionScope | null,
): UiKernelTransport {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(transport, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached != null) return cached;
      const bound = value.bind(target) as (...args: unknown[]) => unknown;
      const method = ADMISSION_GUARDED_TRANSPORT_METHODS.has(property)
        ? (...args: unknown[]) => {
            if (scope == null || !controller.accepts(scope)) {
              return Promise.reject(new Error("The project action belongs to an inactive transition epoch."));
            }
            const current = store.getSnapshot();
            if (current.status !== "ready") {
              return Promise.reject(new Error("Workbench is not ready."));
            }
            if (
              current.snapshot.project_id !== scope.projectId
              || current.snapshot.kernel.context.project_revision !== scope.projectRevision
            ) {
              return Promise.reject(new Error("The project action scope is stale."));
            }
            return store.admitMutation(scope.projectId, () => (
              Promise.resolve(bound(...args))
            ));
          }
        : bound;
      methods.set(property, method);
      return method;
    },
  }) as UiKernelTransport;
}


export function WorkbenchApp({ transport }: WorkbenchAppProps) {
  const [actionError, setActionError] = useState<ScopedActionError | null>(null);
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
  const rhoMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const vibeWorkspaceRef = useRef<VibeWorkspaceSurfaceHandle>(null);
  const vibeReturnPointRef = useRef<VibeReturnPoint | null>(null);
  const vibeTransitionRef = useRef<Promise<unknown> | null>(null);
  const vibeIdentityRef = useRef<string | null>(null);
  const vibeProjectRef = useRef<string | null>(null);
  const verificationScopeRef = useRef<VerificationScope | null>(null);
  const [vibeTransitionBusy, setVibeTransitionBusy] = useState(false);
  const [vibeEditingLocked, setVibeEditingLocked] = useState(false);
  const consumeVibeReturnPoint = useCallback((point: VibeReturnPoint) => {
    if (vibeReturnPointRef.current === point) vibeReturnPointRef.current = null;
  }, []);
  const projectSwitchController = useMemo(() => new ProjectSwitchController(), []);
  const projectTransitionEpochController = useMemo(
    () => new ProjectTransitionEpochController(),
    [],
  );
  const [renderedActionScope, setRenderedActionScope] = useState<ProjectActionScope | null>(null);
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
  const admittedPluginTransport = useMemo(
    () => createAdmissionGuardedTransport(
      pluginTransport,
      store,
      projectTransitionEpochController,
      renderedActionScope,
    ),
    [
      pluginTransport,
      projectTransitionEpochController,
      renderedActionScope?.epoch,
      renderedActionScope?.projectId,
      renderedActionScope?.projectRevision,
      store,
    ],
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
  const projectionActivation: ProjectActivationScope | null = projection == null
    ? null
    : {
        projectId: projection.project_id,
        projectRevision: projection.kernel.context.project_revision,
        projectionGeneration: projection.projection_generation,
      };
  useLayoutEffect(() => {
    if (projectionActivation == null) return;
    const nextScope = !projectTransitionEpochController.isInitialized()
      ? projectTransitionEpochController.initialize(projectionActivation)
      : projectTransitionEpochController.isAdmissionOpen()
        ? projectTransitionEpochController.observeActivation(projectionActivation)
        : null;
    setRenderedActionScope((current) => (
      sameProjectActionScope(current, nextScope) ? current : nextScope
    ));
  }, [
    projectTransitionEpochController,
    projectionActivation?.projectId,
    projectionActivation?.projectRevision,
    projectionActivation?.projectionGeneration,
  ]);
  const reportActionError = useMemo(() => {
    const capturedScope = renderedActionScope;
    return (message: string | null) => {
      if (!projectTransitionEpochController.accepts(capturedScope)) return;
      if (message == null) {
        setActionError((current) => current != null
          && projectTransitionEpochController.accepts(current.scope)
          ? null
          : current);
        return;
      }
      if (capturedScope != null) setActionError({ message, scope: capturedScope });
    };
  }, [
    projectTransitionEpochController,
    renderedActionScope?.epoch,
    renderedActionScope?.projectId,
    renderedActionScope?.projectRevision,
  ]);
  const reportActionErrorRef = useRef(reportActionError);
  useLayoutEffect(() => {
    reportActionErrorRef.current = reportActionError;
  }, [reportActionError]);
  const vibeIdentity = projectionProjectId == null
    ? null
    : `${projectionProjectId}:${profile?.active_vibe_page_id ?? "no-page"}`;
  useEffect(() => {
    if (vibeIdentityRef.current === vibeIdentity) return;
    vibeIdentityRef.current = vibeIdentity;
    if (vibeProjectRef.current !== projectionProjectId) {
      vibeProjectRef.current = projectionProjectId;
      vibeReturnPointRef.current = null;
    }
  }, [projectionProjectId, vibeIdentity]);
  useLayoutEffect(() => {
    verificationScopeRef.current = snapshot == null
      || profile == null
      || renderedActionScope == null
      || !projectTransitionEpochController.accepts(renderedActionScope)
      || snapshot.project.project_id !== renderedActionScope.projectId
      || profile.project_id !== renderedActionScope.projectId
      || snapshot.context.project_revision !== renderedActionScope.projectRevision
        ? null
        : {
            projectId: renderedActionScope.projectId,
            projectRoot: snapshot.project.display_path,
            projectRevision: renderedActionScope.projectRevision,
            epoch: renderedActionScope.epoch,
          };
  }, [
    profile?.project_id,
    projectTransitionEpochController,
    renderedActionScope?.epoch,
    renderedActionScope?.projectId,
    renderedActionScope?.projectRevision,
    snapshot?.context.project_revision,
    snapshot?.project.display_path,
    snapshot?.project.project_id,
  ]);
  const vibeVerificationPort = useMemo(() => createVibeVerificationReadPort({
    transport: pluginTransport,
    currentScope: () => verificationScopeRef.current,
  }), [pluginTransport]);
  const vibeVerificationAdapter = useMemo(
    () => createVerificationAdapter(vibeVerificationPort),
    [vibeVerificationPort],
  );
  useConsoleProjectActivation(consoleExecutionRouter, renderedActionScope);
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
      if (menu?.open === true && event.target instanceof Node
          && !menu.contains(event.target) && !rhoMenuTriggerRef.current?.contains(event.target)) {
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
  const paletteCommands = useMemo(() => snapshot == null ? [] : commandsForPlacement(snapshot, "palette").filter((command) => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return query.length === 0 || command.definition.label.toLocaleLowerCase().includes(query) ||
      command.definition.command_id.toLocaleLowerCase().includes(query);
  }), [commandQuery, snapshot]);
  const run = (operation: Promise<unknown>, operationName = "workbench.action") => {
    reportActionError(null);
    void workbenchOperationTrace.run(
      operationName,
      () => operation,
      { fallback: "Studio operation failed.", scope: "workbench" },
    ).catch((error: unknown) => reportActionError(workbenchFailureMessage(error, "Studio operation failed.")));
  };
  const allocateLayoutNodeId = useCallback(
    () => `layout-node:${crypto.randomUUID().replaceAll("-", "")}`,
    [],
  );
  const studioMutationController = useMemo(() => new StudioMutationController({
    getStudio: studioStore.getStudioSnapshot,
    admit: (projectId, operation) => store.admitMutation(projectId, operation),
    apply: (request, lease) => studioStore.apply(request, lease),
    undo: (request, lease) => studioStore.undo(request, lease),
    redo: (request, lease) => studioStore.redo(request, lease),
    captureReport: () => reportActionErrorRef.current,
    allocateLayoutNodeId,
  }), [allocateLayoutNodeId, store, studioStore]);
  const surfaceMutationController = useMemo(() => new SurfaceInstanceMutationController({
    getSurfaces: surfaceStore.getSurfaceSnapshot,
    admit: (projectId, operation) => store.admitMutation(projectId, operation),
    update: (request, lease) => surfaceStore.update(request, lease),
    suspend: (request, lease) => surfaceStore.suspend(request, lease),
    resume: (request, lease) => surfaceStore.resume(request, lease),
  }), [store, surfaceStore]);
  const settleCurrentWorkbenchMutationQueues = () => settleWorkbenchMutationQueues([
    studioMutationController.settled(),
    surfaceMutationController.settled(),
  ], () => store.settled());
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
      reportActionError(detail);
    }
    setToolbarPreference({ projectId: toolbarProjectId, layout, status, detail });
  };
  const commit = (edit: SceneEdit) => {
    return studioMutationController.commit(edit);
  };
  const assertRenderedActionScope = (): ProjectActionScope => {
    const scope = renderedActionScope;
    if (scope == null || !projectTransitionEpochController.accepts(scope)) {
      throw new Error("The project action belongs to an inactive transition epoch.");
    }
    const current = store.getSnapshot();
    if (
      current.status !== "ready"
      || current.snapshot.project_id !== scope.projectId
      || current.snapshot.kernel.context.project_revision !== scope.projectRevision
    ) {
      throw new Error("The project action scope is stale.");
    }
    return scope;
  };
  const withMutationAdmission = <T,>(
    projectId: string,
    lease: WorkbenchMutationLease | undefined,
    operation: (admitted: WorkbenchMutationLease) => Promise<T>,
  ): Promise<T> => {
    if (lease != null) return operation(lease);
    let scope: ProjectActionScope;
    try {
      scope = assertRenderedActionScope();
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (scope.projectId !== projectId) {
      return Promise.reject(new Error("The project action belongs to another project."));
    }
    return store.admitMutation(projectId, operation);
  };
  const reportProjectWorkflowAction = (
    sourceScope: ProjectActionScope,
    message: string | null,
  ) => {
    if (!projectTransitionEpochController.isAdmissionOpen()) return;
    let currentScope: ProjectActionScope;
    try {
      currentScope = projectTransitionEpochController.observeActivation(
        currentProjectActivation(),
      );
    } catch {
      return;
    }
    if (
      currentScope.epoch !== sourceScope.epoch
      || currentScope.projectId !== sourceScope.projectId
      || currentScope.projectRevision < sourceScope.projectRevision
    ) return;
    if (message == null) {
      setActionError((current) => current != null
        && projectTransitionEpochController.accepts(current.scope)
        ? null
        : current);
    } else {
      setActionError({ message, scope: currentScope });
    }
  };
  const duplicate = async (
    instance: SurfaceInstance,
    admissionLease?: WorkbenchMutationLease,
  ) => {
    if (surfaces == null || studio == null) return;
    return withMutationAdmission(surfaces.project_id, admissionLease, async (lease) => {
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
    }, lease);
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
    }, lease);
    });
  };
  const openConsole = async (
    runtime: RuntimeDescriptor,
    admissionLease?: WorkbenchMutationLease,
  ) => {
    if (surfaces == null || studio == null) return;
    return withMutationAdmission(surfaces.project_id, admissionLease, async (lease) => {
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
    }, lease);
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
    }, lease);
    });
  };
  const openResource = async (
    descriptor: ResourceDescriptor,
    surfaceId: "rho.file-source" | "rho.file-preview",
    modeId: "source" | "preview" | "diff" | "outline",
    placement?: { readonly container_node_id: string; readonly child_index: number },
    admissionLease?: WorkbenchMutationLease,
  ) => {
    if (surfaces == null || studio == null) return;
    if (descriptor.status !== "ready") {
      throw new Error(`Resource ${descriptor.resource_id} is ${descriptor.status}.`);
    }
    return withMutationAdmission(surfaces.project_id, admissionLease, async (lease) => {
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
    }, lease);
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
    }, lease);
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
  const openSurfaceByIdAsync = async (surfaceId: string) => {
    const existing = surfaces?.catalog.instances.find((candidate) => candidate.surface_id === surfaceId);
    const factory = surfaces?.catalog.factories.find((candidate) => candidate.definition.surface_id === surfaceId);
    const placement = existing == null || studio == null
      ? null
      : findLayoutPlacement(studio.scene.root, existing.instance_id);
    if (existing != null && placement != null) {
      if (placement.kind === "stack" && !placement.active) {
        await commit({ kind: "set_stack_active", stack_node_id: placement.nodeId, instance_id: existing.instance_id });
      } else {
        await commit({ kind: "set_focus", instance_id: existing.instance_id });
      }
      return;
    }
    if (factory == null) {
      throw new Error(`Surface ${surfaceId} is unavailable.`);
    }
    if (
      existing != null &&
      factory.definition.instance_policy === "singleton" &&
      studio?.scene.root.kind === "container" &&
      studio.unplaced_instance_ids.includes(existing.instance_id)
    ) {
      await commit({
        kind: "insert_surface",
        target_container_node_id: studio.scene.root.node_id,
        child_index: studio.scene.root.children.length,
        instance_id: existing.instance_id,
        basis: factory.definition.instance_quota_class === "strip"
          ? { kind: "intrinsic" }
          : { kind: "minmax", min_logical_pixels: 220, max_logical_pixels: 1_200, weight: 1 },
      });
      return;
    }
    await openFactory(factory);
  };
  const openSurfaceById = (surfaceId: string) => { run(openSurfaceByIdAsync(surfaceId)); };
  const focusAutomationInstance = (instanceId: string): Promise<boolean> => {
    const placement = studio == null ? null : findLayoutPlacement(studio.scene.root, instanceId);
    if (placement != null && placement.kind === "stack" && !placement.active) {
      return commit({ kind: "set_stack_active", stack_node_id: placement.nodeId, instance_id: instanceId });
    }
    return commit({ kind: "set_focus", instance_id: instanceId });
  };
  const openFactory = async (
    factory: SurfaceFactoryRegistration,
    viewStateOverride?: unknown,
    admissionLease?: WorkbenchMutationLease,
    modeIdOverride?: string,
  ) => {
    if (surfaces == null || studio == null) {
      throw new Error("Surface Runtime is not ready.");
    }
    return withMutationAdmission(surfaces.project_id, admissionLease, async (lease) => {
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
      mode_id: modeIdOverride ?? definition.modes[0]?.mode_id ?? null,
      resource_binding: null,
      runtime_binding: consoleBinding,
      view_group_id: null,
      view_state: viewStateOverride ?? defaultViewState,
      instance_disposition: "new_instance",
      placement_intent: "current",
      expected_project_revision: surfaces.project_revision,
      expected_layout_revision: studio.scene.layout_revision,
    }, lease);
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
      }, lease);
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
    }, lease);
    return created;
    });
  };
  const openPlotArtifact = async (plotId: string) => {
    if (surfaces == null || studio == null) {
      throw new Error("Plot preview is unavailable while the Surface Runtime loads.");
    }
    const existing = surfaces.catalog.instances.find((candidate) => {
      if (candidate.surface_id !== "rho.plots") return false;
      const viewState = candidate.view_state;
      return typeof viewState === "object" && viewState != null
        && "selected_id" in viewState && viewState.selected_id === plotId;
    });
    if (existing != null && findLayoutPlacement(studio.scene.root, existing.instance_id) != null) {
      await focusAutomationInstance(existing.instance_id);
      return;
    }
    const factory = surfaces.catalog.factories.find(
      (candidate) => candidate.definition.surface_id === "rho.plots",
    );
    if (factory == null) throw new Error("Plots Surface is unavailable.");
    await openFactory(factory, { selected_id: plotId, filter: "" });
  };
  const openEnvironmentMode = async (modeId: "resources" | "connections") => {
    if (surfaces == null || studio == null) {
      throw new Error("Environment Resources is unavailable while the Surface Runtime loads.");
    }
    const existing = surfaces.catalog.instances.find(
      (candidate) => candidate.surface_id === "rho.environment",
    );
    const placement = existing == null ? null : findLayoutPlacement(studio.scene.root, existing.instance_id);
    if (profile?.active_mode === "studio" && existing != null && placement != null) {
      if (existing.mode_id !== modeId) {
        await surfaceMutationController.update(existing.instance_id, {
          kind: "set_mode",
          mode_id: modeId,
        });
      }
      await focusAutomationInstance(existing.instance_id);
      return;
    }
    const factory = surfaces.catalog.factories.find(
      (candidate) => candidate.definition.surface_id === "rho.environment",
    );
    if (factory == null) throw new Error("Environment Surface is unavailable.");
    await openFactory(factory, undefined, undefined, modeId);
  };
  const openEnvironmentResources = () => openEnvironmentMode("resources");
  const openEnvironmentConnections = () => openEnvironmentMode("connections");
  const currentProfileSnapshot = () => {
    const current = profileStore.getProfileSnapshot();
    if (current.status !== "ready") throw new Error("The Project UI Profile is unavailable.");
    return current.snapshot;
  };
  const currentSurfaceSnapshot = () => {
    const current = surfaceStore.getSurfaceSnapshot();
    if (current.status !== "ready") throw new Error("Surface Runtime is unavailable.");
    return current.snapshot;
  };
  const currentStudioSnapshot = () => {
    const current = studioStore.getStudioSnapshot();
    if (current.status !== "ready") throw new Error("Studio layout is unavailable.");
    return current.snapshot;
  };
  const setWorkspaceModeReconciled = async (mode: "studio" | "vibe") => {
    const sourceScope = projectTransitionEpochController.observeActivation(
      currentProjectActivation(),
    );
    const rejectGesture = (error: unknown): never => {
      reportProjectWorkflowAction(
        sourceScope,
        workbenchFailureMessage(error, "Workspace mode change failed."),
      );
      throw error;
    };
    try {
      await settleCurrentWorkbenchMutationQueues();
    } catch (error: unknown) {
      return rejectGesture(error);
    }
    let currentScope: ProjectActionScope;
    try {
      currentScope = projectTransitionEpochController.observeActivation(
        currentProjectActivation(),
      );
    } catch (error: unknown) {
      return rejectGesture(error);
    }
    if (
      currentScope.epoch !== sourceScope.epoch
      || currentScope.projectId !== sourceScope.projectId
    ) {
      return rejectGesture(new Error(
        "The workspace mode gesture belongs to a replaced project activation.",
      ));
    }
    const latest = currentProfileSnapshot().profile;
    if (latest.project_id !== sourceScope.projectId) {
      return rejectGesture(new Error("The workspace mode gesture belongs to another project."));
    }
    if (latest.active_mode === mode) return;
    try {
      await profileStore.setMode({
        target: {
          project_id: latest.project_id,
          expected_profile_revision: latest.revision,
        },
        mode,
      });
    } catch (error: unknown) {
      rejectGesture(error);
    }
  };
  const runVibeTransition = <T,>(operation: () => Promise<T>): Promise<T> => {
    if (vibeTransitionRef.current != null) {
      return Promise.reject(new Error("Another Vibe transition is still in progress."));
    }
    const profileAtStart = profileStore.getProfileSnapshot();
    const lockCurrentVibe = profileAtStart.status === "ready"
      && profileAtStart.snapshot.profile.active_mode === "vibe";
    if (lockCurrentVibe) setVibeEditingLocked(true);
    setVibeTransitionBusy(true);
    const task = operation().finally(() => {
      if (vibeTransitionRef.current === task) vibeTransitionRef.current = null;
      if (lockCurrentVibe) setVibeEditingLocked(false);
      setVibeTransitionBusy(false);
    });
    vibeTransitionRef.current = task;
    return task;
  };
  const prepareVibeReturnPoint = async (): Promise<VibeReturnPoint> => {
    const controller = vibeWorkspaceRef.current;
    if (controller == null) throw new Error("The Vibe manuscript is not ready to leave.");
    const point = await controller.prepareToLeave();
    const latest = currentProfileSnapshot().profile;
    if (latest.project_id !== point.projectId) {
      throw new Error("The project changed while the working manuscript was saving.");
    }
    const page = latest.vibe_pages.find((candidate) => candidate.page_id === point.pageId);
    if (page == null) throw new Error("The working manuscript changed before the transition.");
    return {
      ...point,
      blockId: blockForId(page, point.blockId)?.block_id ?? null,
    };
  };
  const validateVibeContext = (
    projectId: string,
    pageId: string,
    blockId: string | null,
    returnPoint: VibeReturnPoint,
  ) => {
    const latest = currentProfileSnapshot().profile;
    if (latest.active_mode !== "vibe" || latest.project_id !== projectId) {
      throw new Error("The Vibe project changed before Studio could open.");
    }
    const page = latest.vibe_pages.find((candidate) => candidate.page_id === pageId);
    if (page == null) throw new Error("The working manuscript is no longer available.");
    if (latest.active_vibe_page_id !== pageId) {
      throw new Error("The active working manuscript changed before the transition.");
    }
    if (blockId != null && blockForId(page, blockId) == null) {
      throw new Error("The selected manuscript content is no longer available.");
    }
    if (
      returnPoint.projectId !== projectId
      || returnPoint.pageId !== pageId
      || returnPoint.blockId !== blockId
    ) throw new Error("The Vibe return point no longer matches the selected content.");
    return page;
  };
  const validateVibeIntent = (
    intent: OpenVibeTargetInStudioIntent,
    returnPoint: VibeReturnPoint,
  ) => {
    const page = validateVibeContext(
      intent.projectId,
      intent.pageId,
      intent.blockId,
      returnPoint,
    );
    const surfaceSnapshot = currentSurfaceSnapshot();
    const currentInstances = new Map(
      surfaceSnapshot.catalog.instances.map((instance) => [instance.instance_id, instance]),
    );
    const currentRefs = exactReferencesForBlock(page, intent.blockId, currentInstances);
    if (!sameVibeExactReferences(currentRefs, intent.sourceExactRefs)) {
      throw new Error("The selected manuscript reference changed before Studio could open.");
    }
  };
  const prevalidateExactSurfaceRequest = (request: VibeExactSurfaceRequest) => {
    const surfaceSnapshot = currentSurfaceSnapshot();
    if (exactSurfaceInstance(surfaceSnapshot.catalog.instances, request) != null) return;
    if (!request.mayCreate) throw new Error("The exact target Surface is no longer available.");
    const factory = surfaceSnapshot.catalog.factories.find(
      (candidate) => candidate.definition.surface_id === request.surfaceId,
    );
    if (factory == null) throw new Error(`Surface ${request.surfaceId} is unavailable.`);
    if (
      request.modeId != null
      && !factory.definition.modes.some((mode) => mode.mode_id === request.modeId)
    ) throw new Error(`Surface ${request.surfaceId} cannot open the required exact view.`);
  };
  const prevalidateVibeTarget = (target: VibeStudioTarget) => {
    const surfaceSnapshot = currentSurfaceSnapshot();
    if (target.kind === "surface") {
      if (!surfaceSnapshot.catalog.instances.some((instance) => instance.instance_id === target.id)) {
        throw new Error("The exact Surface instance is no longer available.");
      }
      return;
    }
    prevalidateExactSurfaceRequest(exactSurfaceRequestForTarget(target));
  };
  const applyCurrentStudioEdit = async (edit: SceneEdit): Promise<void> => {
    const latest = currentStudioSnapshot();
    await studioStore.apply({
      project_id: latest.project_id,
      expected_project_revision: latest.project_revision,
      expected_layout_revision: latest.scene.layout_revision,
      edit,
    });
  };
  const placeAndFocusExactInstance = async (instanceId: string): Promise<void> => {
    let latest = currentStudioSnapshot();
    let placement = findLayoutPlacement(latest.scene.root, instanceId);
    if (placement == null) {
      if (
        !latest.unplaced_instance_ids.includes(instanceId)
        || latest.scene.root.kind !== "container"
      ) throw new Error("The exact Surface instance cannot be placed in Studio.");
      await applyCurrentStudioEdit({
        kind: "insert_surface",
        target_container_node_id: latest.scene.root.node_id,
        child_index: latest.scene.root.children.length,
        instance_id: instanceId,
        basis: { kind: "minmax", min_logical_pixels: 220, max_logical_pixels: 1_200, weight: 1 },
      });
      latest = currentStudioSnapshot();
      placement = findLayoutPlacement(latest.scene.root, instanceId);
      if (placement == null) throw new Error("Studio did not place the exact Surface instance.");
    }
    if (placement.kind === "stack" && !placement.active) {
      await applyCurrentStudioEdit({
        kind: "set_stack_active",
        stack_node_id: placement.nodeId,
        instance_id: instanceId,
      });
    }
    await applyCurrentStudioEdit({ kind: "set_focus", instance_id: instanceId });
  };
  const openExactSurfaceRequest = async (request: VibeExactSurfaceRequest): Promise<void> => {
    let surfaceSnapshot = currentSurfaceSnapshot();
    let target = exactSurfaceInstance(surfaceSnapshot.catalog.instances, request);
    if (target == null) {
      if (!request.mayCreate) throw new Error("The exact target Surface is no longer available.");
      const factory = surfaceSnapshot.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === request.surfaceId,
      );
      if (factory == null) throw new Error(`Surface ${request.surfaceId} is unavailable.`);
      const studioSnapshot = currentStudioSnapshot();
      const before = new Set(
        surfaceSnapshot.catalog.instances.map((instance) => instance.instance_id),
      );
      const opened = await surfaceStore.open({
        surface_id: request.surfaceId,
        project_id: surfaceSnapshot.project_id,
        mode_id: request.modeId,
        resource_binding: null,
        runtime_binding: null,
        view_group_id: null,
        view_state: request.viewState,
        instance_disposition: "new_instance",
        placement_intent: "current",
        expected_project_revision: surfaceSnapshot.project_revision,
        expected_layout_revision: studioSnapshot.scene.layout_revision,
      });
      target = opened.catalog.instances.find((instance) => !before.has(instance.instance_id))
        ?? exactSurfaceInstance(opened.catalog.instances, request);
      if (target == null) throw new Error("Surface Runtime did not create the exact target view.");
    } else {
      if (target.lifecycle_state === "suspended") {
        await surfaceMutationController.resume(target.instance_id);
      }
      if (request.modeId != null && target.mode_id !== request.modeId) {
        await surfaceMutationController.update(target.instance_id, {
          kind: "set_mode",
          mode_id: request.modeId,
        });
      }
      await surfaceMutationController.update(target.instance_id, {
        kind: "set_view_state",
        view_state: request.viewState,
      });
      surfaceSnapshot = currentSurfaceSnapshot();
      target = surfaceSnapshot.catalog.instances.find(
        (instance) => instance.instance_id === target?.instance_id,
      ) ?? null;
      if (target == null) throw new Error("The exact target Surface disappeared while opening.");
    }
    await placeAndFocusExactInstance(target.instance_id);
  };
  const openExactSurfaceInstance = async (instanceId: string): Promise<void> => {
    const surfaceSnapshot = currentSurfaceSnapshot();
    const instance = surfaceSnapshot.catalog.instances.find(
      (candidate) => candidate.instance_id === instanceId,
    );
    if (instance == null) throw new Error("The exact Surface instance is no longer available.");
    if (instance.lifecycle_state === "suspended") {
      await surfaceMutationController.resume(instance.instance_id);
    }
    await placeAndFocusExactInstance(instance.instance_id);
  };
  const openVibeTargetInStudio = (
    intent: OpenVibeTargetInStudioIntent,
    returnPoint: VibeReturnPoint,
  ): Promise<void> => runVibeTransition(async () => {
    validateVibeIntent(intent, returnPoint);
    prevalidateVibeTarget(intent.target);
    vibeReturnPointRef.current = returnPoint;
    await setWorkspaceModeReconciled("studio");
    try {
      if (intent.target.kind === "surface") {
        await openExactSurfaceInstance(intent.target.id);
      } else {
        await openExactSurfaceRequest(exactSurfaceRequestForTarget(intent.target));
      }
    } catch (error: unknown) {
      const detail = boundedFailureMessage(error, "The exact target is unavailable.");
      throw new Error(`Studio 已打开，但精确目标未能打开。${detail}`, { cause: error });
    }
  });
  const openVibeAgentInStudio = (
    selection: { readonly conversationId: string | null; readonly turnId: string | null },
    compose: boolean,
    returnPoint: VibeReturnPoint,
  ): Promise<void> => runVibeTransition(async () => {
    validateVibeContext(
      returnPoint.projectId,
      returnPoint.pageId,
      returnPoint.blockId,
      returnPoint,
    );
    const surfaceSnapshot = currentSurfaceSnapshot();
    if (!surfaceSnapshot.catalog.factories.some(
      (factory) => factory.definition.surface_id === "rho.agent",
    )) throw new Error("Agent Surface is unavailable.");
    let conversationId = selection.conversationId;
    if (conversationId == null) {
      if (!compose) throw new Error("No exact Agent conversation is selected.");
      const created = await admittedPluginTransport.createAgentConversation();
      const currentRoot = verificationScopeRef.current?.projectRoot;
      if (created.project_root !== currentRoot) {
        throw new Error("Agent created a conversation for another project.");
      }
      conversationId = created.conversation_id;
    }
    const request = exactAgentSurfaceRequest(conversationId, compose);
    prevalidateExactSurfaceRequest(request);
    vibeReturnPointRef.current = returnPoint;
    await setWorkspaceModeReconciled("studio");
    try {
      await openExactSurfaceRequest(request);
    } catch (error: unknown) {
      const detail = boundedFailureMessage(error, "The Agent conversation is unavailable.");
      throw new Error(`Studio 已打开，但精确的 Agent 会话未能打开。${detail}`, { cause: error });
    }
  });
  const changeWorkspaceMode = (mode: "studio" | "vibe"): Promise<void> => (
    runVibeTransition(async () => {
      const latest = currentProfileSnapshot().profile;
      if (latest.active_mode === mode) return;
      if (mode === "studio") {
        const returnPoint = await prepareVibeReturnPoint();
        vibeReturnPointRef.current = returnPoint;
        try {
          await setWorkspaceModeReconciled("studio");
        } catch (error: unknown) {
          const actual = profileStore.getProfileSnapshot();
          if (actual.status === "ready" && actual.snapshot.profile.active_mode === "vibe") {
            vibeReturnPointRef.current = null;
          }
          throw error;
        }
        return;
      }
      const returnPoint = vibeReturnPointRef.current;
      if (returnPoint != null && returnPoint.projectId === latest.project_id) {
        const targetPage = latest.vibe_pages.find(
          (candidate) => candidate.page_id === returnPoint.pageId,
        );
        if (targetPage == null) {
          vibeReturnPointRef.current = null;
        } else {
          vibeReturnPointRef.current = {
            ...returnPoint,
            blockId: blockForId(targetPage, returnPoint.blockId)?.block_id ?? null,
          };
          if (latest.active_vibe_page_id !== targetPage.page_id) {
            await profileStore.selectPage({
              target: {
                project_id: latest.project_id,
                expected_profile_revision: latest.revision,
              },
              page_id: targetPage.page_id,
            });
          }
        }
      }
      await setWorkspaceModeReconciled("vibe");
    })
  );
  const exportCurrentVibePage = async (pageId: string) => {
    const latest = currentProfileSnapshot().profile;
    const page = latest.vibe_pages.find((candidate) => candidate.page_id === pageId);
    if (page == null) throw new Error("The working manuscript is unavailable for export.");
    return profileStore.exportPage({
      project_id: latest.project_id,
      expected_profile_revision: latest.revision,
      page_id: page.page_id,
      expected_page_revision: page.page_revision,
    });
  };
  const invokeCommand = async (commandId: string) => {
    if (commandId === "rho.agent.new-conversation") {
      const factory = surfaces?.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === "rho.agent",
      );
      if (factory == null) throw new Error("Agent Surface factory is unavailable.");
      if (surfaces == null) throw new Error("Surface Runtime is unavailable.");
      await withMutationAdmission(surfaces.project_id, undefined, async (lease) => {
        const conversation = await pluginTransport.createAgentConversation();
        await openFactory(factory, {
          conversation_id: conversation.conversation_id,
          mode: "ask",
          composer: "",
          auto_approve: false,
        }, lease);
      });
      setCommandSearchOpen(false);
      return;
    }
    if (commandId.startsWith("rho.surface.open.")) {
      const surfaceId = `rho.${commandId.slice("rho.surface.open.".length)}`;
      await openSurfaceByIdAsync(surfaceId);
      setCommandSearchOpen(false);
      return;
    }
    if (commandId !== "rho.check.run") {
      throw new Error(`Command ${commandId} has no RSR frontend handler yet.`);
    }
    if (snapshot == null || surfaces == null || studio == null) {
      throw new Error("Check project is unavailable until the project Surface Runtime is ready.");
    }
    const checkScope = assertRenderedActionScope();
    if (checkScope.projectId !== snapshot.project.project_id) {
      throw new Error("The Check action belongs to another project.");
    }
    await withMutationAdmission(checkScope.projectId, undefined, async (lease) => {
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
    }, lease);
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
      }, lease);
    } else if (profile?.active_mode === "vibe") {
      await profileStore.refresh();
      const latest = profileStore.getProfileSnapshot();
      if (latest.status !== "ready") throw new Error("Vibe Page Profile is unavailable after Check.");
      if (latest.snapshot.profile.project_id !== checkScope.projectId) {
        throw new Error("The Check result belongs to another project.");
      }
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
      }, lease);
    }
    });
    setCommandSearchOpen(false);
  };
  const pinAgentTask = async (turn: AgentTurnSummary) => {
    if (profile == null) throw new Error("The Project UI Profile is unavailable.");
    const sourceScope = assertRenderedActionScope();
    if (sourceScope.projectId !== profile.project_id) {
      throw new Error("The Agent task belongs to another project.");
    }
    const sourceProjectId = sourceScope.projectId;
    return withMutationAdmission(sourceProjectId, undefined, async (lease) => {
      await profileStore.refresh();
      const latest = profileStore.getProfileSnapshot();
      if (latest.status !== "ready") throw new Error("The Project UI Profile is unavailable.");
      const latestProfile = latest.snapshot.profile;
      if (latestProfile.project_id !== sourceProjectId) {
        throw new Error("The Agent task belongs to a previous project activation.");
      }
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
      }, lease);
    });
  };
  const presentAgentTurnInStudio = async (
    turn: AgentTurnSummary,
    presentation: AgentStudioPresentation,
  ) => {
    const sourceScope = assertRenderedActionScope();
    return withMutationAdmission(sourceScope.projectId, undefined, (lease) => (
      applyAgentStudioPresentation({
        projectId: sourceScope.projectId,
        turn,
        presentation,
        store,
        transport: pluginTransport,
        lease,
        allocateLayoutNodeId,
      })
    ));
  };
  const createConsoleRequirementController = (lease: WorkbenchMutationLease) => (
    new ConsoleRequirementController({
      getSurfaces: surfaceStore.getSurfaceSnapshot,
      getStudio: studioStore.getStudioSnapshot,
      getRuntimes: runtimeStore.getRuntimeSnapshot,
      getProfile: profileStore.getProfileSnapshot,
      attachRuntime: (request) => runtimeStore.attach(request, lease),
      refreshSurfaces: () => surfaceStore.refresh(),
      openSurface: (request) => surfaceStore.open(request, lease),
      applyStudio: (request) => studioStore.apply(request, lease),
      waitForRenderer: (instanceId) => consoleExecutionRouter.waitFor(instanceId),
      markPreferred: (instanceId) => consoleExecutionRouter.markPreferred(instanceId),
      allocateLayoutNodeId,
    })
  );
  const runSourceExecution = async (
    sourceInstanceId: string,
    execution: SourceExecutionSubmission,
    admissionLease?: WorkbenchMutationLease,
    report: (message: string | null) => void = reportActionError,
  ): Promise<boolean> => consoleExecutionRouter.run(
    sourceInstanceId,
    execution,
    () => {
      const current = surfaceStore.getSurfaceSnapshot();
      if (current.status !== "ready") {
        return Promise.reject(new Error("Surface Runtime is unavailable."));
      }
      return withMutationAdmission(current.snapshot.project_id, admissionLease, (lease) => (
        createConsoleRequirementController(lease).resolve(sourceInstanceId)
      ));
    },
    report,
  );
  const surfaceView = (
    instance: SurfaceInstance,
    embedded = false,
    _nodeId?: string,
    _paneMemberCount?: number,
    gestureOwner?: "rho" | "dockview",
  ) => {
    const hostScope = renderedActionScope;
    if (
      hostScope == null
      || !projectTransitionEpochController.accepts(hostScope)
    ) return null;
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
      key={`${hostScope.epoch}:${instance.project_id}:${instance.instance_id}:${instance.activation_generation}`}
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
      }}
      detachRuntime={async () => {
        if (surfaces == null) return;
        await runtimeStore.detach({
          surface: instanceRequest(instance, surfaces.project_revision),
        });
      }}
      startRuntimeExecution={async (runtime, code, sourceContext) => {
        await store.settled();
        const currentScope = projectTransitionEpochController.isAdmissionOpen()
          ? projectTransitionEpochController.observeActivation(currentProjectActivation())
          : null;
        if (
          currentScope == null
          || currentScope.epoch !== hostScope.epoch
          || currentScope.projectId !== hostScope.projectId
          || currentScope.projectRevision < hostScope.projectRevision
        ) {
          throw new Error("The Console execution belongs to a previous project activation.");
        }
        setActionError((current) => current != null
          && projectTransitionEpochController.accepts(current.scope)
          ? null
          : current);
        try {
          return await store.admitMutation(currentScope.projectId, async (lease) => {
            const runtimeState = runtimeStore.getRuntimeSnapshot();
            const surfaceState = surfaceStore.getSurfaceSnapshot();
            if (
              runtimeState.status !== "ready"
              || surfaceState.status !== "ready"
              || runtimeState.snapshot.project_id !== currentScope.projectId
              || surfaceState.snapshot.project_id !== currentScope.projectId
              || runtimeState.snapshot.project_revision !== currentScope.projectRevision
              || surfaceState.snapshot.project_revision !== currentScope.projectRevision
            ) {
              throw new Error("Runtime Registry or Surface Runtime is not ready for this project.");
            }
            const currentRuntime = runtimeState.snapshot.instances.find((candidate) =>
              candidate.runtime_instance_id === runtime.runtime_instance_id
              && candidate.activation_generation === runtime.activation_generation
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
              }, lease),
              {
                fallback: "Runtime operation failed.",
                defaultKind: "runtime_infrastructure",
                scope: "surface",
              },
            );
            await runtimeStore.refresh();
            return result;
          });
        } catch (error: unknown) {
          if (projectTransitionEpochController.accepts(currentScope)) {
            setActionError({
              message: workbenchFailureMessage(error, "Runtime operation failed."),
              scope: currentScope,
            });
          }
          throw error;
        }
      }}
      followRuntimeOutput={async (executionId, afterSequence, listener) => {
        if (!projectTransitionEpochController.accepts(hostScope)) {
          throw new Error("The Runtime output follow belongs to a previous project activation.");
        }
        try {
          await runtimeStore.followOutput(executionId, afterSequence, (frame) => {
            if (
              projectTransitionEpochController.accepts(hostScope)
              && frame.project_id === hostScope.projectId
            ) listener(frame);
          });
        } finally {
          if (projectTransitionEpochController.accepts(hostScope)) {
            await runtimeStore.refresh();
          }
        }
      }}
      listRuntimeExecutions={async () => {
        const pinnedExecutionId = consolePinnedExecutionId(instance);
        const owned = (await runtimeStore.listExecutions(100))
          .filter((execution) => execution.console_instance_id === instance.instance_id);
        if (pinnedExecutionId != null) {
          const pinned = await runtimeStore.getExecution(pinnedExecutionId);
          return [pinned, ...owned.filter((execution) => execution.execution_id !== pinnedExecutionId)]
            .sort((left, right) => right.started_at.localeCompare(left.started_at));
        }
        return owned;
      }}
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
      }}
      persistConsole={async (viewState) => {
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      registerConsoleExecution={registerConsoleExecution}
      markConsolePreferred={markConsolePreferred}
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
      withFileMutation={async (operation) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        const projectId = resources.project_id;
        const workflowScope = assertRenderedActionScope();
        const reportWorkflowAction = (message: string | null) => {
          reportProjectWorkflowAction(workflowScope, message);
        };
        reportWorkflowAction(null);
        try {
          return await withMutationAdmission(projectId, undefined, (lease) => {
          const currentResourceProjectRevision = () => {
            const current = resourceStore.getResourceSnapshot();
            if (
              current.status !== "ready"
              || current.snapshot.project_id !== projectId
              || current.snapshot.project_revision < resources.project_revision
            ) {
              throw new Error("Resource Registry changed before the File workflow could continue.");
            }
            return current.snapshot.project_revision;
          };
          return runRevocableFileMutationWorkflow(operation, {
            updateDraft: (content, value) => resourceStore.updateDraft({
              target: resourceTarget(
                content.descriptor,
                currentResourceProjectRevision(),
              ),
              expected_document_revision: content.document_revision,
              content: value,
            }, lease),
            save: (content) => resourceStore.save({
              target: resourceTarget(
                content.descriptor,
                currentResourceProjectRevision(),
              ),
              expected_document_revision: content.document_revision,
            }, lease),
            runSourceExecution: (execution) => runSourceExecution(
              instance.instance_id,
              execution,
              lease,
              reportWorkflowAction,
            ),
          });
          });
        } catch (error: unknown) {
          reportWorkflowAction(boundedFailureMessage(error, "File operation failed."));
          throw error;
        }
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
      reportError={(error) => reportActionError(boundedFailureMessage(error, "Runtime operation failed."))}
      pluginTransport={admittedPluginTransport}
      surfaceFactories={surfaces?.catalog.factories ?? []}
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
      createAgentConversation={async (currentViewState) => {
        const workflowScope = hostScope;
        reportProjectWorkflowAction(workflowScope, null);
        try {
          return await withMutationAdmission(workflowScope.projectId, undefined, async (lease) => {
            const conversation = await pluginTransport.createAgentConversation();
            await store.refresh();
            const nextViewState = {
              ...currentViewState,
              conversation_id: conversation.conversation_id,
            };
            await surfaceMutationController.updateExact(instance, {
              kind: "set_view_state",
              view_state: nextViewState,
            }, lease);
            return nextViewState;
          });
        } catch (error: unknown) {
          reportProjectWorkflowAction(
            workflowScope,
            boundedFailureMessage(error, "Agent conversation could not be created or selected."),
          );
          throw error;
        }
      }}
      runAgentConversation={async (currentViewState, request, onAccepted) => {
        const workflowScope = hostScope;
        reportProjectWorkflowAction(workflowScope, null);
        try {
          return await withMutationAdmission(workflowScope.projectId, undefined, async (lease) => {
            const response = await pluginTransport.runAgent(request);
            onAccepted?.(response.conversation_id);
            await store.refresh();
            const nextViewState = {
              ...currentViewState,
              conversation_id: response.conversation_id,
              composer: "",
            };
            await surfaceMutationController.updateExact(instance, {
              kind: "set_view_state",
              view_state: nextViewState,
            }, lease);
            return nextViewState;
          });
        } catch (error: unknown) {
          reportProjectWorkflowAction(
            workflowScope,
            boundedFailureMessage(error, "Agent turn could not start or select its conversation."),
          );
          throw error;
        }
      }}
      persistAgentViewState={async (viewState) => {
        assertRenderedActionScope();
        await surfaceMutationController.updateExact(instance, {
          kind: "set_view_state",
          view_state: viewState,
        });
      }}
      persistSurfaceViewState={async (viewState) => {
        assertRenderedActionScope();
        await surfaceMutationController.update(instance.instance_id, {
          kind: "set_view_state",
          view_state: viewState,
        });
        reportActionError(null);
      }}
      pinAgentTask={pinAgentTask}
      presentAgentTurnInStudio={presentAgentTurnInStudio}
      applyAgentFileProposal={async (turn, eventId, proposal, review) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        return withMutationAdmission(resources.project_id, undefined, async (lease) => {
        let beforeContent = "";
        let expectedDiskSha256: string | null = null;
        if (review != null) {
          if (proposal.operation !== "append" && proposal.operation !== "create") {
            throw new Error("Only append and create proposals support a reviewed diff identity.");
          }
          beforeContent = review.before_content;
          expectedDiskSha256 = review.expected_disk_sha256;
          if (proposal.operation !== "create" && expectedDiskSha256 == null) {
            throw new Error(`Agent proposal target ${proposal.path} has no reviewed disk digest.`);
          }
        } else if (proposal.operation !== "create") {
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
            }, lease);
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
        });
      }}
      undoAgentFileProposal={async (request) => {
        if (resources == null) throw new Error("Resource Registry is not ready.");
        await withMutationAdmission(resources.project_id, undefined, async () => {
          await pluginTransport.undoAgentFileEdit(request);
          await Promise.all([resourceStore.refresh(), surfaceStore.refresh()]);
        });
      }}
      embedded={embedded}
      dockviewHosted={gestureOwner === "dockview"}
      openNavigatorFile={openNavigatorFile}
      openSurfaceById={openSurfaceById}
      openPlot={(plotId) => run(openPlotArtifact(plotId))}
      agentRuntimeOutputContext={agentRuntimeOutputContext}
      setAgentRuntimeOutputContext={(reference) => {
        if (!projectTransitionEpochController.accepts(hostScope)) return false;
        if (reference != null && reference.project_id !== hostScope.projectId) return false;
        setAgentRuntimeOutputContext(reference);
        return true;
      }}
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
    projectRevision: snapshot?.context.project_revision ?? null,
    layoutRevision: studio?.scene.layout_revision ?? null,
    surfaceInstanceCount: surfaces?.catalog.instances.length ?? 0,
    agentInstances: surfaces?.catalog.instances
      .filter((instance) => instance.surface_id === "rho.agent")
      .map((instance) => {
        const viewState = instance.view_state;
        const conversationId = typeof viewState === "object"
          && viewState != null
          && "conversation_id" in viewState
          && typeof viewState.conversation_id === "string"
            ? viewState.conversation_id
            : null;
        return {
          id: instance.instance_id,
          generation: instance.activation_generation,
          surfaceRevision: instance.surface_revision,
          conversationId,
        };
      }) ?? [],
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
  const currentProjectActivation = (): ProjectActivationScope => {
    const current = store.getSnapshot();
    if (current.status !== "ready") throw new Error("The Workbench projection is unavailable.");
    return {
      projectId: current.snapshot.project_id,
      projectRevision: current.snapshot.kernel.context.project_revision,
      projectionGeneration: current.snapshot.projection_generation,
    };
  };
  const performProjectSwitch = async (
    operation: () => Promise<ProjectSwitchResponse>,
    targetPath: string | null,
  ) => {
    let transitionToken: ProjectTransitionEpochToken | null = null;
    let brokerResponse: ProjectSwitchResponse | null = null;
    let sourceProjectId: string | null = null;
    const perform = () => projectSwitchController.perform(async () => {
      if (transitionToken == null) throw new Error("Project transition admission did not start.");
      await settleCurrentWorkbenchMutationQueues();
      projectTransitionEpochController.captureSettledSource(
        transitionToken,
        currentProjectActivation(),
      );
      brokerResponse = await operation();
      return brokerResponse;
    }, targetPath, {
      start: (target) => {
        const sourceActivation = currentProjectActivation();
        sourceProjectId = sourceActivation.projectId;
        transitionToken = projectTransitionEpochController.begin(sourceActivation);
        consoleExecutionRouter.activate(null);
        store.closeMutationAdmission();
        setRenderedActionScope(null);
        setProjectSwitching(true);
        setProjectSwitchTarget(target);
        setProjectSwitchError(null);
        setActionError(null);
        setAgentRuntimeOutputContext(null);
        verificationScopeRef.current = null;
        vibeReturnPointRef.current = null;
      },
      accept: async () => {
        draftCache.clear();
        consoleSessionCache.clear();
        await refreshProjectProjections();
        closeRhoMenu();
      },
      refreshRestored: async () => {
        draftCache.clear();
        consoleSessionCache.clear();
        await refreshProjectProjections();
      },
      report: setProjectSwitchError,
      finish: () => {
        setProjectSwitching(false);
        setProjectSwitchTarget(null);
      },
    });
    return runVibeTransition(async () => {
      const current = profileStore.getProfileSnapshot();
      if (current.status === "ready" && current.snapshot.profile.active_mode === "vibe") {
        await prepareVibeReturnPoint();
      }
      const status = await perform();
      const token = transitionToken;
      if (token == null) return status;
      let reopened = false;
      try {
        if (brokerResponse?.restart_required === true || brokerResponse?.status === "fatal") {
          projectTransitionEpochController.seal(token);
          setProjectSwitchError((current) => {
            const restartMessage = "Restart Rho before continuing project work; the transition cannot safely reopen this session.";
            if (current == null) return restartMessage;
            return current.includes(restartMessage) ? current : `${current} ${restartMessage}`;
          });
        } else if (status === "ready") {
          const activation = currentProjectActivation();
          const acceptedScope = projectTransitionEpochController.acceptReady(token, activation);
          setRenderedActionScope(acceptedScope);
          if (sourceProjectId != null && activation.projectId !== sourceProjectId) {
            workbenchOperationTrace.reset();
            traceProjectRef.current = activation.projectId;
          }
          reopened = true;
        } else if (status === "failed_restored") {
          const activation = currentProjectActivation();
          setRenderedActionScope(projectTransitionEpochController.acceptRestored(token, activation));
          reopened = true;
        } else if (
          status === "blocked"
          || status === "cancelled"
          || status === "unavailable"
        ) {
          const activation = currentProjectActivation();
          setRenderedActionScope(projectTransitionEpochController.acceptNoChange(token, activation));
          reopened = true;
        } else if (status === "fatal") {
          await refreshProjectProjections();
          const recovered = currentProjectActivation();
          if (brokerResponse?.status === "failed_restored") {
            setRenderedActionScope(projectTransitionEpochController.acceptRestored(token, recovered));
          } else {
            setRenderedActionScope(projectTransitionEpochController.recoverPrevious(token, recovered));
          }
          reopened = true;
        }
        if (reopened) store.openMutationAdmission();
      } catch (error: unknown) {
        try {
          projectTransitionEpochController.seal(token);
        } catch {
          // A consumed token means a coherent activation already reopened.
        }
        const message = workbenchFailureMessage(
          error,
          "Project transition truth could not be reconciled. Restart Rho before continuing.",
        );
        setProjectSwitchError(message);
        throw error instanceof Error ? error : new Error(message);
      }
      return status;
    });
  };
  // Acceptance automation (debug-only bridge): keep a per-render host so the
  // stable bridge listener below always acts on fresh projections and
  // controllers. The host carries no authority beyond the UI's own actions.
  const automationHostRef = useRef<AutomationHost | null>(null);
  useEffect(() => {
    automationHostRef.current = {
      store,
      getEvidence: () => evidence,
      actions: {
        openProject: async (path) => {
          const status = await performProjectSwitch(() => pluginTransport.openProject(path), path);
          if (status !== "ready") {
            throw new Error(`Project switch did not complete: ${status}.`);
          }
        },
        openSurface: openSurfaceByIdAsync,
        focusInstance: (instanceId) => focusAutomationInstance(instanceId).then(() => undefined),
        closeInstance: (instanceId) => commit({
          kind: "close_surface_placement",
          instance_id: instanceId,
        }).then(() => undefined),
        setMode: async (mode) => {
          await changeWorkspaceMode(mode);
        },
      },
    };
  });
  useEffect(() => {
    if (!isTauri()) return undefined;
    let disposed = false;
    let uninstall: (() => void) | undefined;
    // The bridge command only exists in debug builds with
    // RHO_ACCEPTANCE_BRIDGE=1; any rejection leaves the surface uninstalled.
    void invoke<boolean>("acceptance_bridge_active").then((active) => {
      if (!active || disposed) return;
      uninstall = installAcceptanceAutomation({
        host: () => automationHostRef.current,
        listen,
        invoke,
      });
    }).catch(() => undefined);
    return () => {
      disposed = true;
      uninstall?.();
    };
  }, []);
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
  const RailComposeIcon = () => (
    <svg {...railIconProps}><rect x="2" y="2.5" width="12" height="11" rx="1" /><path d="M9.5 2.5v11" /></svg>
  );
  const RailStudioIcon = () => (
    <svg {...railIconProps}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
  );
  const RailVibeIcon = () => (
    <svg {...railIconProps}><path d="M8 2v4M8 10v4M2 8h4M10 8h4M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2" /></svg>
  );
  const RailTuneIcon = () => (
    <svg {...railIconProps}><path d="M2 4h5M10 4h4M2 12h2M7 12h7M7 2v4M4 10v4" /></svg>
  );
  const renderToolbarComponent = (componentId: ToolbarComponentId) => {
    let content: ReactNode;
    switch (componentId) {
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
  const componentFactories = [...(surfaces?.catalog.factories.filter((factory) =>
    factory.definition.origin.kind === "application"
    && surfaceCatalogPolicy(factory.definition.surface_id).visibility === "primary") ?? [])]
    .sort((left, right) => compareSurfaceCatalogOrder(
      left.definition.surface_id,
      right.definition.surface_id,
    ));
  const componentFactoryGroups = Object.entries(COMPOSE_FLOW_STAGES).map(([stage, definition]) => ({
    stage,
    definition,
    factories: componentFactories.filter((factory) =>
      surfaceCatalogPolicy(factory.definition.surface_id).flowStage === stage),
  })).filter((group) => group.factories.length > 0);
  const developerFactories = surfaces?.catalog.factories.filter((factory) =>
    factory.definition.origin.kind === "application"
    && surfaceCatalogPolicy(factory.definition.surface_id).visibility === "developer") ?? [];
  const pluginFactories = surfaces?.catalog.factories.filter((factory) =>
    factory.definition.origin.kind === "workspace_plugin"
    && surfaceCatalogPolicy(factory.definition.surface_id).visibility === "primary") ?? [];
  const showDeveloperComponents = import.meta.env.DEV;
  const activePluginSurfaceIds = new Set(
    surfaces?.catalog.instances
      .filter((instance) =>
        instance.origin.kind === "workspace_plugin" && instance.lifecycle_state === "active"
      )
      .map((instance) => instance.surface_id) ?? [],
  );
  const openSurfaceTools = studio == null
    ? []
    : [...new Set(layoutInstanceIds(studio.scene.root))]
      .map((instanceId) => instances.get(instanceId))
      .filter((instance): instance is SurfaceInstance => instance != null && instance.lifecycle_state === "active");
  const recentlyClosedViews = studio == null ? [] : studio.unplaced_instance_ids
    .map((instanceId) => instances.get(instanceId))
    .filter((instance): instance is SurfaceInstance => instance != null)
    .filter((instance, index, values) => values.findIndex((candidate) =>
      candidate.surface_id === instance.surface_id && candidate.mode_id === instance.mode_id
    ) === index);
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
  const renderOpenSurfaceTool = (instance: SurfaceInstance) => {
    const factory = surfaces?.catalog.factories.find(
      (candidate) => candidate.definition.surface_id === instance.surface_id,
    );
    const label = surfaceDisplayLabel(instance.surface_id);
    const canDuplicate = factory?.definition.instance_policy === "multi_instance";
    const attachedRuntime = instance.runtime_binding == null
      ? null
      : runtimes?.instances.find((runtime) =>
          runtime.runtime_instance_id === instance.runtime_binding?.runtime_instance_id
        ) ?? null;
    return <div
      className="rho-open-surface-tool"
      data-surface-tool-instance={instance.instance_id}
      data-focused={studio?.scene.focused_surface_instance_id === instance.instance_id || undefined}
      key={instance.instance_id}
    >
      <MenuPopover
        label={`Tools for ${label}`}
        glyph={<span className="rho-open-surface-glyph" aria-hidden="true">{surfaceRailGlyph(instance.surface_id)}</span>}
        panelClassName="rho-surface-tool-panel"
        viewportBound
        placement="right"
      >
        <div className="rho-menu-heading"><strong>{label}</strong><code>{instance.instance_id}</code></div>
        <dl className="rho-menu-facts">
          <div><dt>Mode</dt><dd>{instance.mode_id ?? "default"}</dd></div>
          <div><dt>State</dt><dd>{instance.lifecycle_state}</dd></div>
          {attachedRuntime != null && <div><dt>Runtime</dt><dd>{attachedRuntime.display_label}</dd></div>}
        </dl>
        <button type="button" data-menu-close onClick={() => run(focusAutomationInstance(instance.instance_id))}>Focus component</button>
        {(factory?.definition.modes.length ?? 0) > 1 && <>
          <span className="rho-menu-separator" />
          <span className="rho-surface-tool-label">Component mode</span>
          {factory?.definition.modes.map((mode) => <button
            type="button"
            data-menu-close
            disabled={instance.mode_id === mode.mode_id}
            onClick={() => run(surfaceMutationController.update(instance.instance_id, {
              kind: "set_mode",
              mode_id: mode.mode_id,
            }))}
            key={mode.mode_id}
          >{mode.label}</button>)}
        </>}
        {attachedRuntime != null && <>
          <span className="rho-menu-separator" />
          <button type="button" data-menu-close onClick={() => run(runtimeStore.interrupt(runtimeRequest(attachedRuntime, runtimes!.project_revision)))}>Interrupt runtime</button>
          <button type="button" data-menu-close onClick={() => run(runtimeStore.restart(runtimeRequest(attachedRuntime, runtimes!.project_revision)))}>Restart runtime</button>
        </>}
        <span className="rho-menu-separator" />
        <button type="button" data-menu-close disabled={!canDuplicate} onClick={() => run(duplicate(instance))}>Open another</button>
        <button type="button" data-menu-close onClick={() => run(commit({ kind: "close_surface_placement", instance_id: instance.instance_id }))}>Close component</button>
        <ul className="rho-surface-tool-hints">{surfaceToolHints(instance.surface_id).map((hint) => <li key={hint}>{hint}</li>)}</ul>
      </MenuPopover>
    </div>;
  };
  const toolbarSplit = Math.ceil(visibleToolbarComponents.length / 2);
  const leftToolbarComponents = visibleToolbarComponents.slice(0, toolbarSplit);
  const rightToolbarComponents = visibleToolbarComponents.slice(toolbarSplit);

  return (
    <main className="rho-studio-shell">
      <header className="rho-studio-bar">
        <div className="rho-toolbar-anchor rho-toolbar-anchor-left">
          <details className="rho-rho-menu rho-rho-menu-bottom" ref={rhoMenuRef}>
            <summary aria-hidden="true" tabIndex={-1}><span className="rho-mark-word">Rho</span></summary>
            <div className="rho-rho-menu-panel" aria-busy={projectSwitching}>
              <button
                type="button"
                className="rho-rho-project"
                aria-label="Open a different project folder"
                disabled={snapshot == null || projectSwitching || vibeTransitionBusy}
                onClick={() => {
                  void performProjectSwitch(
                    () => pluginTransport.pickProjectDirectory(),
                    null,
                  ).catch((error: unknown) => reportActionError(workbenchFailureMessage(
                    error,
                    "The current Vibe manuscript could not be saved before switching projects.",
                  )));
                }}
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
                      disabled={projectSwitching || vibeTransitionBusy}
                      key={path}
                      onClick={() => {
                        void performProjectSwitch(
                          () => pluginTransport.openProject(path),
                          path,
                        ).catch((error: unknown) => reportActionError(workbenchFailureMessage(
                          error,
                          "The current Vibe manuscript could not be saved before switching projects.",
                        )));
                      }}
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
              {projectHistory.status === "unavailable" && projectHistory.detail != null && (
                <p className="rho-project-history-status" role="status">{projectHistory.detail}</p>
              )}
              <span className="rho-menu-separator" />
              <button type="button" onClick={openCommandSearch}><span>Command search</span><kbd>⌘K</kbd></button>
              <button type="button" onClick={() => {
                closeRhoMenu();
                openSurfaceById("rho.settings");
              }}>Settings…</button>
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
              disabled={profile == null || projectSwitching || vibeTransitionBusy}
              key={mode}
              onClick={() => {
                if (profile?.active_mode !== mode) {
                  run(changeWorkspaceMode(mode), "profile.set_mode");
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
        {openSurfaceTools.length > 0 && <nav className="rho-open-surface-rail" aria-label="Open component tools">
          {openSurfaceTools.map(renderOpenSurfaceTool)}
        </nav>}
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
            showTrigger={false}
          />
          <button
            type="button"
            ref={rhoMenuTriggerRef}
            className="rho-rail-btn rho-unified-menu-trigger"
            aria-label="Rho menu"
            aria-haspopup="menu"
            title="Rho menu and toolbar settings"
            onClick={() => {
              setToolbarCustomizerOpen(false);
              if (rhoMenuRef.current != null) rhoMenuRef.current.open = !rhoMenuRef.current.open;
            }}
          ><RailTuneIcon /></button>
        </div>
        {commandSearchTransient && (
          <div className="rho-toolbar-command-overlay">{commandSearch}</div>
        )}
      </header>
      {projectSwitchError != null && (
        <p className="rho-project-switch-error" role="alert">{projectSwitchError}</p>
      )}
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
                  <button type="button" disabled={!studio.can_undo} onClick={() => void studioMutationController.undo()}>Undo</button>
                  <button type="button" disabled={!studio.can_redo} onClick={() => void studioMutationController.redo()}>Redo</button>
                  <button type="button" onClick={() => commit({ kind: "normalize" })}>Normalize</button>
                  {studio.scene.root.kind === "container" && <button type="button" onClick={() => commit({ kind: "distribute_container", container_node_id: studio.scene.root.node_id })}>Distribute</button>}
                </div>
                <div className="rho-layout-mini-map" role="img" aria-label="Current workspace layout preview">
                  <LayoutMiniMap
                    node={studio.scene.root}
                    instances={instances}
                    focusedInstanceId={studio.scene.focused_surface_instance_id}
                  />
                </div>
                <ol className="rho-layout-outline"><li><NodeOutline node={studio.scene.root} commit={commit} /></li></ol>
              </details>
              {surfaces != null && (
                <section className="rho-surface-catalog">
                  <div className="rho-surface-catalog-heading">
                    <span className="rho-eyebrow">Core components</span>
                    <span>{componentFactories.length}</span>
                  </div>
                  {componentFactoryGroups.map(({ stage, definition, factories }) => (
                    <section className="rho-surface-catalog-flow" data-flow-stage={stage} key={stage}>
                      <div className="rho-surface-catalog-flow-heading">
                        <strong>{definition.label}</strong><small>{definition.description}</small>
                      </div>
                      {factories.map((factory) => renderComponentFactory(factory))}
                    </section>
                  ))}
                  {pluginFactories.length > 0 && <details className="rho-developer-components rho-project-components">
                    <summary><span>Project extensions</span><span>{pluginFactories.length}</span></summary>
                    <p>Only Surface contributions installed for this project appear here.</p>
                    {pluginFactories.map((factory) => renderComponentFactory(factory))}
                  </details>}
                  {showDeveloperComponents && developerFactories.length > 0 && <details className="rho-developer-components">
                    <summary><span>Developer tools</span><span>{developerFactories.length}</span></summary>
                    <p>Preview fixtures are available in development builds only.</p>
                    {developerFactories.map((factory) => renderComponentFactory(factory, true))}
                  </details>}
                </section>
              )}
              {recentlyClosedViews.length > 0 && <details className="rho-recent-closed">
                <summary><span>Recently closed views</span><span>{recentlyClosedViews.length}</span></summary>
                <p>Restore a view with its previous mode and local state.</p>
                {recentlyClosedViews.map((instance) => {
                  const factory = surfaces?.catalog.factories.find(
                    (candidate) => candidate.definition.surface_id === instance.surface_id,
                  );
                  const mode = factory?.definition.modes.find(
                    (candidate) => candidate.mode_id === instance.mode_id,
                  )?.label;
                  return <div className="rho-recent-closed-item" key={`${instance.surface_id}:${instance.mode_id ?? "default"}`}>
                    <div><strong>{surfaceDisplayLabel(instance.surface_id)}</strong><small>{mode ?? "Default view"}</small></div>
                    <button type="button" disabled={studio.scene.root.kind !== "container"} onClick={() => {
                      if (studio.scene.root.kind !== "container") return;
                      commit({
                        kind: "insert_surface",
                        target_container_node_id: studio.scene.root.node_id,
                        child_index: studio.scene.root.children.length,
                        instance_id: instance.instance_id,
                        basis: instance.surface_id === "rho.status" ? { kind: "intrinsic" } : { kind: "fraction", weight: 1 },
                      });
                    }}>Restore</button>
                  </div>;
                })}
              </details>}
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
          {actionError != null && projectTransitionEpochController.accepts(actionError.scope) && (
            <p className="rho-action-error" role="alert">{actionError.message}</p>
          )}
          {snapshot == null
            || profile == null
            || surfaces == null
            || studio == null
            || !projectProjectionsCoherent
            || renderedActionScope == null
            || !projectTransitionEpochController.accepts(renderedActionScope)
            ? <div className="rho-studio-loading">{projectSwitching ? "Switching project…" : "Loading the project UI Profile…"}</div>
            : profile.active_mode === "vibe"
              ? activeVibePage == null
                ? <div className="rho-studio-loading">The active Vibe Page is unavailable.</div>
                : <VibeWorkspaceSurface
                    key={`${renderedActionScope.epoch}:${profile.project_id}:${activeVibePage.page_id}`}
                    ref={vibeWorkspaceRef}
                    page={activeVibePage}
                    profileRevision={profile.revision}
                    projectRoot={snapshot.project.display_path}
                    projectRevision={snapshot.context.project_revision}
                    projectEpoch={renderedActionScope.epoch}
                    transitionBusy={vibeEditingLocked}
                    instances={instances}
                    restoredReturnPoint={vibeReturnPointRef.current}
                    onReturnPointRestored={consumeVibeReturnPoint}
                    commitPage={(request) => profileStore.applyPage(request)}
                    exportCurrentPage={exportCurrentVibePage}
                    explorationTransport={pluginTransport}
                    verificationAdapter={vibeVerificationAdapter}
                    onOpenStudio={openVibeTargetInStudio}
                    onOpenAgent={openVibeAgentInStudio}
                    reportError={(error) => reportActionError(vibeFailureMessage(
                      error,
                      "Vibe Page operation failed.",
                    ))}
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
      <footer
        className="rho-statusbar"
        data-workspace-mode={profile?.active_mode ?? "loading"}
        aria-label="Workbench status"
      >
        <EnvironmentTaskbarPanel
          transport={pluginTransport}
          workspaceState={snapshot?.context.workspace_health ?? "unknown"}
          workspaceLabel={snapshot?.health.workspace.label ?? "Workspace connecting"}
          agentState={snapshot?.context.agent_health ?? "unknown"}
          agentLabel={snapshot?.health.agent.label ?? "Agent unavailable"}
          activeOperations={snapshot?.context.active_operations.length ?? 0}
          openResources={() => run(openEnvironmentResources())}
          openConnections={() => run(openEnvironmentConnections())}
          openDiagnostics={() => {
            const logs = surfaces?.catalog.factories.find((factory) => factory.definition.surface_id === "rho.logs");
            if (logs != null) run(openFactory(logs));
          }}
          diagnosticsAvailable={surfaces?.catalog.factories.some((factory) => factory.definition.surface_id === "rho.logs") === true}
        />
        {(snapshot?.context.active_operations.length ?? 0) > 0 && <span className="rho-statusbar-item" aria-live="polite">
          {`${snapshot!.context.active_operations.length} task${snapshot!.context.active_operations.length > 1 ? "s" : ""} running`}
        </span>}
        <span className="rho-statusbar-path" title={snapshot?.project.display_path ?? ""}>{snapshot?.project.display_path ?? ""}</span>
      </footer>
      </div>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
