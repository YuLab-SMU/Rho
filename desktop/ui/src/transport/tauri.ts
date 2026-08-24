import type {
  AgentConversationSummary,
  AgentContextPlanPreview,
  AgentContextPreviewRequest,
  AgentContextCapacityRequest,
  AgentLlmSettingsView,
  AgentRuntimeDiagnostics,
  AgentFileMutationResponse,
  AgentTurnDetail,
  AgentTurnSummary,
  CheckResult,
  CheckResultRequest,
  CheckRunRequest,
  CheckRunResponse,
  DomainSurfaceData,
  DomainSurfaceItem,
  PluginSurfaceDocumentRequest,
  PluginSurfaceDocumentView,
  PluginSurfaceEventRequest,
  PluginSurfaceEventResult,
  PlotImageView,
  ProjectSwitchResponse,
  ProjectUiProfileSnapshot,
  RunAgentResponse,
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
  WorkspacePreparation,
} from "./types";
import { invalidationEvents } from "./invalidation-contract";
import { createTauriResourceTransport } from "./resource";
import { createTauriRuntimeTransport } from "./runtime";
import { createTauriRuntimeOutputTransport } from "./runtime-output";
import { createTauriSurfaceStudioTransport } from "./surface-studio";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(
  event: string,
  handler: (event: { readonly payload: T }) => void,
) => Promise<Unsubscribe>;

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
        "title", "message", "summary", "package", "name", "output_path", "path", "source_path", "request_type", "artifact_kind", "branch", "media_type",
      ]) ?? id,
      subtitle: recordValue(record, ["source_path", "media_type", "kind", "version", "author", "date", "started_at", "mode", "tool", "request_type"]),
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
    async prepareWorkspace(chooseRscript = false): Promise<WorkspacePreparation> {
      const startup = await invoke<{
        readonly phase: string;
        readonly issue: {
          readonly code: string;
          readonly title: string;
          readonly message: string;
          readonly technical_detail?: string;
        } | null;
      }>(chooseRscript ? "startup_choose_rscript" : "startup_bootstrap");
      if (startup.phase !== "runtime_ready" || startup.issue != null) {
        return {
          status: "needs_attention",
          phase: startup.phase,
          workspace_ready: false,
          restored_project_status: null,
          issue: startup.issue == null ? {
            code: "STARTUP_NOT_READY",
            title: "Rho could not prepare the R runtime",
            message: "Retry startup or select a valid Rscript executable.",
            technical_detail: null,
          } : {
            code: startup.issue.code,
            title: startup.issue.title,
            message: startup.issue.message,
            technical_detail: startup.issue.technical_detail ?? null,
          },
        };
      }
      try {
        await invoke<unknown>("workspace_start");
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          status: "needs_attention",
          phase: "workspace_start_failed",
          workspace_ready: false,
          restored_project_status: null,
          issue: {
            code: "WORKSPACE_START_FAILED",
            title: "Workspace R could not start",
            message: "Retry startup. The Agent runtime remains an independent fault domain.",
            technical_detail: detail.slice(0, 2_048),
          },
        };
      }
      void invoke<AgentRuntimeDiagnostics>("agent_runtime_retry").catch(() => undefined);
      try {
        const restored = await invoke<{ readonly status?: string }>("project_restore_session");
        const restoredStatus = restored.status ?? "unknown";
        if (restoredStatus === "ready") {
          return {
            status: "ready",
            phase: "project_ready",
            workspace_ready: true,
            restored_project_status: restoredStatus,
            issue: null,
          };
        }
        return {
          status: "needs_attention",
          phase: "project_restore_incomplete",
          workspace_ready: true,
          restored_project_status: restoredStatus,
          issue: {
            code: "PROJECT_RESTORE_INCOMPLETE",
            title: "The saved project could not be restored",
            message: "Workspace R is available. Choose or reopen a project to continue.",
            technical_detail: `project_restore_session returned ${restoredStatus}`,
          },
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          status: "needs_attention",
          phase: "project_restore_failed",
          workspace_ready: true,
          restored_project_status: null,
          issue: {
            code: "PROJECT_RESTORE_FAILED",
            title: "The saved project could not be restored",
            message: "Workspace R is available. Retry startup or choose another project.",
            technical_detail: detail.slice(0, 2_048),
          },
        };
      }
    },
    openProject: (path) => invoke<ProjectSwitchResponse>("project_open", { path }),
    pickProjectDirectory: () => invoke<ProjectSwitchResponse>("project_pick_directory"),
    loadSnapshot: () => invoke<UiKernelSnapshot>("ui_kernel_snapshot"),
    setSelection: (request) =>
      invoke<UiKernelSnapshot>("ui_set_selection", { request }),
    subscribeInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("kernel"), listener),
    ...createTauriSurfaceStudioTransport(invoke),
    subscribeSurfacesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("surfaces"), listener),
    loadPluginSurfaceDocument: (request: PluginSurfaceDocumentRequest) =>
      invoke<PluginSurfaceDocumentView>("plugin_surface_document", { request }),
    dispatchPluginSurfaceEvent: (request: PluginSurfaceEventRequest) =>
      invoke<PluginSurfaceEventResult>("plugin_surface_event", { request }),
    subscribePluginSurfacesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("plugin-surfaces"), listener),
    runCheckProject: (request: CheckRunRequest) =>
      invoke<CheckRunResponse>("check_project_run", { request }),
    loadCheckResult: (request: CheckResultRequest) =>
      invoke<CheckResult>("check_result", { request }),
    subscribeCheckResultsInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("check-results"), listener),
    subscribeStudioInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("studio"), listener),
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
      subscribeEvents(listen, invalidationEvents("profile"), listener),
    ...createTauriRuntimeTransport(invoke),
    ...createTauriRuntimeOutputTransport(invoke),
    subscribeRuntimesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("runtimes"), listener),
    ...createTauriResourceTransport(invoke),
    subscribeResourcesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("resources"), listener),
    listAgentConversations: (limit = 50) =>
      invoke<readonly AgentConversationSummary[]>("list_agent_conversations", { limit }),
    createAgentConversation: () =>
      invoke<AgentConversationSummary>("create_agent_conversation"),
    listAgentTurns: (conversationId, limit = 50) =>
      invoke<readonly AgentTurnSummary[]>("list_agent_turns", { conversationId, limit }),
    getAgentTurnDetail: (turnId) =>
      invoke<AgentTurnDetail | null>("get_agent_turn_detail", { turnId }),
    loadAgentLlmSettings: () =>
      invoke<AgentLlmSettingsView>("agent_llm_settings"),
    setAgentContextCapacity: (request: AgentContextCapacityRequest) =>
      invoke<AgentLlmSettingsView>("agent_llm_set_context_capacity", { request }),
    previewAgentContext: (request: AgentContextPreviewRequest) =>
      invoke<AgentContextPlanPreview>("agent_context_preview", {
        prompt: request.prompt,
        mode: request.mode,
        taskKind: request.task_kind,
        modelId: request.model_id,
        editorContext: request.editor_context,
        conversationId: request.conversation_id,
        runtimeOutputContext: request.runtime_output_context,
      }),
    runAgent: (request) => invoke<RunAgentResponse>("run_agent", {
      prompt: request.prompt,
      mode: request.mode,
      taskKind: request.task_kind,
      modelId: request.model_id,
      autoApprove: request.auto_approve,
      editorContext: request.editor_context,
      conversationId: request.conversation_id,
      runtimeOutputContext: request.runtime_output_context,
      contextPlanDigest: request.context_plan_digest,
    }),
    retryAgentTurn: (turnId) =>
      invoke<RunAgentResponse>("retry_agent_turn", { turnId }),
    cancelAgentTurn: (turnId) => invoke("cancel_agent_turn", { turnId }),
    respondAgentApproval: (request) => invoke("respond_approval", { request }),
    getAgentRuntimeDiagnostics: () =>
      invoke<AgentRuntimeDiagnostics>("agent_runtime_status"),
    retryAgentRuntime: () =>
      invoke<AgentRuntimeDiagnostics>("agent_runtime_retry"),
    subscribeAgentInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("agent"), listener),
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
          const [snapshot, app] = await Promise.all([
            invoke<UiKernelSnapshot>("ui_kernel_snapshot"),
            invoke<{
              readonly version: string;
              readonly commit: string;
              readonly platform: string;
              readonly executable_path: string;
              readonly frontend_entry: string;
            }>("app_info"),
          ]);
          payload = [{
            id: "rho.build-identity",
            title: `Rho ${app.version}`,
            summary: "Exact desktop build identity",
            status: "current",
            detail: `Executable: ${app.executable_path}\nFrontend: ${app.frontend_entry}\nCommit: ${app.commit}\nPlatform: ${app.platform}`,
          }, ...snapshot.command_registry.registrations.map((registration) => ({
            id: registration.definition.command_id,
            title: registration.definition.label,
            status: registration.availability.state,
            summary: registration.definition.purpose,
          }))];
          break;
        }
        default: payload = [];
      }
      return domainData(surfaceId, payload);
    },
    readPlotArtifact: (plotId) => invoke<PlotImageView>("read_plot_artifact", { plotId }),
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
