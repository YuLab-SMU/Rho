import type {
  AgentConversationSummary,
  AgentFileMutationResponse,
  AgentTurnDetail,
  AgentTurnSummary,
  CheckResult,
  CheckResultRequest,
  CheckRunRequest,
  CheckRunResponse,
  DomainSurfaceData,
  DomainSurfaceItem,
  OpenSurfaceRequest,
  PluginSurfaceDocumentRequest,
  PluginSurfaceDocumentView,
  PluginSurfaceEventRequest,
  PluginSurfaceEventResult,
  ProjectUiProfileSnapshot,
  ResourceContent,
  ResourceDeleteRequest,
  ResourceDraftRequest,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
  RunAgentResponse,
  RuntimeAttachmentRequest,
  RuntimeCreateRequest,
  RuntimeDetachRequest,
  RuntimeExecuteRequest,
  RuntimeExecutionResult,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SceneEditRequest,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  UpdateSurfaceRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  Unsubscribe,
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  VibePageExport,
  VibePageExportRequest,
  VibePageMutationRequest,
} from "./types";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(
  event: string,
  handler: (event: { readonly payload: T }) => void,
) => Promise<Unsubscribe>;

const INVALIDATION_EVENTS = [
  "rho://ui-snapshot-invalidated",
  "project://files-changed",
  "rho://agent-turn-updated",
] as const;

function boundedJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded.length > 4_000 ? `${encoded.slice(0, 4_000)}\n…` : encoded;
  } catch {
    return String(value).slice(0, 4_000);
  }
}

function recordValue(record: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function collectDomainRecords(value: unknown, output: Readonly<Record<string, unknown>>[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectDomainRecords(item, output);
    return;
  }
  if (typeof value !== "object" || value == null) return;
  const record = value as Readonly<Record<string, unknown>>;
  const identity = recordValue(record, [
    "run_id", "problem_id", "claim_id", "artifact_id", "plot_id", "request_id", "hash", "id",
  ]);
  if (identity != null) output.push(record);
  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) collectDomainRecords(nested, output);
  }
  if (identity == null && output.length === 0) output.push(record);
}

function domainData(surfaceId: string, payload: unknown): DomainSurfaceData {
  const records: Readonly<Record<string, unknown>>[] = [];
  collectDomainRecords(payload, records);
  const items: DomainSurfaceItem[] = records.slice(0, 100).map((record, index) => {
    const id = recordValue(record, [
      "run_id", "problem_id", "claim_id", "artifact_id", "plot_id", "request_id", "hash", "id",
    ]) ?? `${surfaceId}:${index + 1}`;
    return {
      id,
      title: recordValue(record, [
        "title", "message", "summary", "package", "name", "output_path", "path", "request_type", "artifact_kind", "branch",
      ]) ?? id,
      subtitle: recordValue(record, ["source_path", "kind", "version", "author", "date", "mode", "tool"]),
      status: recordValue(record, ["status", "severity", "state"]),
      detail: boundedJson(record),
    };
  });
  return {
    surface_id: surfaceId,
    loaded_at: new Date().toISOString(),
    summary: `${items.length} ${items.length === 1 ? "record" : "records"}`,
    items,
  };
}

function subscribeEvents(
  listen: Listen,
  eventNames: readonly string[],
  listener: () => void,
): Unsubscribe {
  let active = true;
  const unlisteners: Unsubscribe[] = [];
  for (const eventName of eventNames) {
    void listen(eventName, listener)
      .then((unlisten) => {
        if (active) unlisteners.push(unlisten);
        else unlisten();
      })
      .catch(() => undefined);
  }
  return () => {
    active = false;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}

export function createTauriUiKernelTransport(
  invoke: Invoke,
  listen: Listen,
): UiKernelTransport {
  return {
    source: "tauri",
    loadSnapshot: () => invoke<UiKernelSnapshot>("ui_kernel_snapshot"),
    setSelection: (request) =>
      invoke<UiKernelSnapshot>("ui_set_selection", { request }),
    subscribeInvalidated: (listener) =>
      subscribeEvents(listen, INVALIDATION_EVENTS, listener),
    loadSurfaces: () => invoke<SurfaceRuntimeSnapshot>("surface_list"),
    openSurface: (request: OpenSurfaceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_open", { request }),
    updateSurface: (request: UpdateSurfaceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_update", { request }),
    closeSurface: (request: SurfaceInstanceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_close", { request }),
    suspendSurface: (request: SurfaceInstanceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_suspend", { request }),
    resumeSurface: (request: SurfaceInstanceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_resume", { request }),
    subscribeSurfacesInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://surface-runtime-changed", "rho://ui-snapshot-invalidated"],
        listener,
      ),
    loadPluginSurfaceDocument: (request: PluginSurfaceDocumentRequest) =>
      invoke<PluginSurfaceDocumentView>("plugin_surface_document", { request }),
    dispatchPluginSurfaceEvent: (request: PluginSurfaceEventRequest) =>
      invoke<PluginSurfaceEventResult>("plugin_surface_event", { request }),
    subscribePluginSurfacesInvalidated: (listener) =>
      subscribeEvents(
        listen,
        [
          "rho://plugin-surface-changed",
          "rho://surface-runtime-changed",
          "rho://ui-snapshot-invalidated",
        ],
        listener,
      ),
    runCheckProject: (request: CheckRunRequest) =>
      invoke<CheckRunResponse>("check_project_run", { request }),
    loadCheckResult: (request: CheckResultRequest) =>
      invoke<CheckResult>("check_result", { request }),
    subscribeCheckResultsInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://check-results-changed", "rho://ui-snapshot-invalidated"],
        listener,
      ),
    loadStudio: () => invoke<StudioRuntimeSnapshot>("studio_scene"),
    applyStudio: (request: SceneEditRequest) =>
      invoke<StudioRuntimeSnapshot>("studio_apply", { request }),
    undoStudio: (request: StudioRevisionRequest) =>
      invoke<StudioRuntimeSnapshot>("studio_undo", { request }),
    redoStudio: (request: StudioRevisionRequest) =>
      invoke<StudioRuntimeSnapshot>("studio_redo", { request }),
    subscribeStudioInvalidated: (listener) =>
      subscribeEvents(
        listen,
        [
          "rho://studio-runtime-changed",
          "rho://surface-runtime-changed",
          "rho://ui-snapshot-invalidated",
        ],
        listener,
      ),
    loadUiProfile: () => invoke<ProjectUiProfileSnapshot>("ui_profile_snapshot"),
    setUiProfileMode: (request: UiProfileSetModeRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_set_mode", { request }),
    selectUiProfileScene: (request: UiProfileSelectSceneRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_select_scene", { request }),
    selectUiProfilePage: (request: UiProfileSelectPageRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_select_page", { request }),
    applyVibePage: (request: VibePageMutationRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_page_apply", { request }),
    exportVibePage: (request: VibePageExportRequest) =>
      invoke<VibePageExport>("ui_profile_page_export", { request }),
    duplicateUiProfileScene: (request: UiProfileSceneLabelRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_scene_duplicate", { request }),
    saveUiProfileScene: (request: UiProfileSceneTargetRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_scene_save", { request }),
    renameUiProfileScene: (request: UiProfileSceneLabelRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_scene_rename", { request }),
    deleteUiProfileScene: (request: UiProfileSceneTargetRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_scene_delete", { request }),
    resetUiProfileScene: (request: UiProfileSceneTargetRequest) =>
      invoke<ProjectUiProfileSnapshot>("ui_profile_scene_reset", { request }),
    subscribeUiProfileInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://ui-profile-changed", "rho://ui-snapshot-invalidated"],
        listener,
      ),
    loadRuntimes: () => invoke<RuntimeRegistrySnapshot>("runtime_list"),
    createRuntime: (request: RuntimeCreateRequest) =>
      invoke<RuntimeRegistrySnapshot>("runtime_create", { request }),
    attachRuntime: (request: RuntimeAttachmentRequest) =>
      invoke<SurfaceRuntimeSnapshot>("runtime_attach", { request }),
    detachRuntime: (request: RuntimeDetachRequest) =>
      invoke<SurfaceRuntimeSnapshot>("runtime_detach", { request }),
    interruptRuntime: (request: RuntimeInstanceRequest) =>
      invoke<RuntimeRegistrySnapshot>("runtime_interrupt", { request }),
    restartRuntime: (request: RuntimeInstanceRequest) =>
      invoke<RuntimeRegistrySnapshot>("runtime_restart", { request }),
    stopRuntime: (request: RuntimeInstanceRequest) =>
      invoke<RuntimeRegistrySnapshot>("runtime_stop", { request }),
    executeRuntime: (request: RuntimeExecuteRequest) =>
      invoke<RuntimeExecutionResult>("runtime_execute", { request }),
    subscribeRuntimesInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://runtime-registry-changed", "rho://ui-snapshot-invalidated"],
        listener,
      ),
    loadResources: () => invoke<ResourceRegistrySnapshot>("resource_list"),
    resolveResource: (request: ResourceResolveRequest) =>
      invoke<ResourceRegistrySnapshot>("resource_resolve", { request }),
    readResource: (request: ResourceReadRequest) =>
      invoke<ResourceContent>("resource_read", { request }),
    updateResourceDraft: (request: ResourceDraftRequest) =>
      invoke<ResourceContent>("resource_update_draft", { request }),
    saveResource: (request: ResourceSaveRequest) =>
      invoke<ResourceContent>("resource_save", { request }),
    reloadResource: (request: ResourceReloadRequest) =>
      invoke<ResourceContent>("resource_reload", { request }),
    renameResource: (request: ResourceRenameRequest) =>
      invoke<ResourceRegistrySnapshot>("resource_rename", { request }),
    deleteResource: (request: ResourceDeleteRequest) =>
      invoke<ResourceRegistrySnapshot>("resource_delete", { request }),
    subscribeResourcesInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://resource-registry-changed", "rho://ui-snapshot-invalidated"],
        listener,
      ),
    listAgentConversations: (limit = 50) =>
      invoke<readonly AgentConversationSummary[]>("list_agent_conversations", { limit }),
    createAgentConversation: () =>
      invoke<AgentConversationSummary>("create_agent_conversation"),
    listAgentTurns: (conversationId, limit = 50) =>
      invoke<readonly AgentTurnSummary[]>("list_agent_turns", { conversationId, limit }),
    getAgentTurnDetail: (turnId) =>
      invoke<AgentTurnDetail | null>("get_agent_turn_detail", { turnId }),
    runAgent: (request) => invoke<RunAgentResponse>("run_agent", {
      prompt: request.prompt,
      mode: request.mode,
      taskKind: request.task_kind,
      modelId: request.model_id,
      autoApprove: request.auto_approve,
      editorContext: request.editor_context,
      conversationId: request.conversation_id,
    }),
    retryAgentTurn: (turnId) =>
      invoke<RunAgentResponse>("retry_agent_turn", { turnId }),
    cancelAgentTurn: (turnId) => invoke("cancel_agent_turn", { turnId }),
    respondAgentApproval: (request) => invoke("respond_approval", { request }),
    retryAgentRuntime: () => invoke("agent_runtime_retry"),
    subscribeAgentInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://agent-turn-updated", "rho://ui-snapshot-invalidated"],
        listener,
      ),
    loadDomainSurface: async (surfaceId) => {
      let payload: unknown;
      switch (surfaceId) {
        case "rho.environment": payload = {
          installed: await invoke<unknown>("list_installed_packages", { limit: 200 }),
          requests: await invoke<unknown>("list_environment_operation_requests", { limit: 50, status: null }),
        }; break;
        case "rho.evidence": payload = await invoke<unknown>("list_evidence_claims", { limit: 100 }); break;
        case "rho.git": payload = {
          status: await invoke<unknown>("git_status"),
          history: await invoke<unknown>("git_log", { limit: 30 }),
        }; break;
        case "rho.runs": payload = await invoke<unknown>("list_runs", { limit: 100 }); break;
        case "rho.artifacts": payload = await invoke<unknown>("list_artifact_records", { limit: 100, sessionOnly: false }); break;
        case "rho.problems": payload = await invoke<unknown>("list_problems", { limit: 100 }); break;
        case "rho.plots": payload = await invoke<unknown>("list_plot_artifacts", { limit: 100, sessionOnly: true }); break;
        case "rho.logs": payload = { id: "startup-diagnostics", title: "Startup diagnostics", status: "current", detail: await invoke<string>("startup_diagnostics") }; break;
        case "rho.render-jobs": {
          const runs = await invoke<unknown>("list_runs", { limit: 100 });
          payload = Array.isArray(runs) ? runs.filter((run) => {
            const encoded = boundedJson(run)?.toLowerCase() ?? "";
            return encoded.includes("render");
          }) : runs;
          break;
        }
        case "rho.help": {
          const snapshot = await invoke<UiKernelSnapshot>("ui_kernel_snapshot");
          payload = snapshot.command_registry.registrations.map((registration) => ({
            id: registration.definition.command_id,
            title: registration.definition.label,
            status: registration.availability.state,
            summary: registration.definition.purpose,
          }));
          break;
        }
        default: payload = [];
      }
      return domainData(surfaceId, payload);
    },
    retryRun: (runId) => invoke("retry_run", { runId }),
    applyAgentFileEdit: (request) => invoke<AgentFileMutationResponse>("apply_agent_file_edit", {
      request: {
        turnId: request.turn_id,
        proposalEventId: request.proposal_event_id,
        path: request.path,
        expectedDiskSha256: request.expected_disk_sha256,
        beforeContent: request.before_content,
      },
    }),
    undoAgentFileEdit: (request) => invoke<AgentFileMutationResponse>("undo_agent_file_edit", {
      request: {
        turnId: request.turn_id,
        proposalEventId: request.proposal_event_id,
        path: request.path,
        expectedAfterSha256: request.expected_after_sha256,
        beforeContent: request.before_content,
        created: request.created,
      },
    }),
  };
}
