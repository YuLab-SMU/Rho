import type {
  DomainSurfaceData,
  DomainSurfaceItem,
  UiKernelTransport,
  Unsubscribe,
  WorkspacePreparation,
} from "./types";
import { invalidationEvents } from "./invalidation-contract";
import { createTauriAgentConversationTransport } from "./agent-conversation";
import { createTauriAgentEventsTransport } from "./agent-events";
import { createTauriAgentExecutionTransport } from "./agent-execution";
import { createTauriAgentRuntimeTransport } from "./agent-runtime";
import { createTauriAgentSettingsTransport } from "./agent-settings";
import { createTauriAgentFileTransport } from "./agent-file";
import { createTauriPluginSurfaceTransport } from "./plugin-surface";
import {
  createTauriProjectCommands,
  createTauriProjectTransport,
  normalizeProjectSwitchResponse,
} from "./project";
import { createTauriKernelTransport } from "./kernel-generated";
import { createTauriCheckTransport } from "./check";
import { createTauriStartupTransport } from "./startup";
import { createTauriHistoryTransport } from "./history";
import { createTauriEnvironmentReadTransport } from "./environment";
import { createTauriEvidenceReadTransport } from "./evidence";
import { createTauriGitReadTransport } from "./git";
import { createTauriAgentTurnDetailTransport } from "./agent-turn";
import { createTauriProfileTransport } from "./profile";
import { createTauriResourceTransport } from "./resource";
import { createTauriRuntimeTransport } from "./runtime";
import { createTauriRuntimeOutputTransport } from "./runtime-output";
import { createTauriSurfaceStudioTransport } from "./surface-studio";
import { createTauriWorkbenchProjectionTransport } from "./workbench-projection";

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
  const agentRuntimeTransport = createTauriAgentRuntimeTransport(invoke);
  const projectCommands = createTauriProjectCommands(invoke);
  const kernelTransport = createTauriKernelTransport(invoke);
  const startupTransport = createTauriStartupTransport(invoke);
  const historyTransport = createTauriHistoryTransport(invoke);
  const environmentTransport = createTauriEnvironmentReadTransport(invoke);
  const evidenceTransport = createTauriEvidenceReadTransport(invoke);
  const gitTransport = createTauriGitReadTransport(invoke);
  return {
    source: "tauri",
    async prepareWorkspace(chooseRscript = false): Promise<WorkspacePreparation> {
      const startup = chooseRscript
        ? await startupTransport.chooseRscript()
        : await startupTransport.bootstrapStartup();
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
        await startupTransport.startWorkspace();
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
      void agentRuntimeTransport.retryAgentRuntime().catch(() => undefined);
      try {
        const restored = normalizeProjectSwitchResponse(
          await projectCommands.projectRestoreSession(),
        );
        const restoredStatus = restored.status;
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
            technical_detail: restored.unavailable == null
              ? `project_restore_session returned ${restoredStatus}`
              : `Saved project: ${restored.unavailable.path}\nReason: ${restored.unavailable.reason}`.slice(0, 2_048),
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
    ...createTauriProjectTransport(projectCommands),
    ...kernelTransport,
    ...createTauriWorkbenchProjectionTransport(invoke),
    subscribeWorkbenchInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("workbench"), listener),
    subscribeInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("kernel"), listener),
    ...createTauriSurfaceStudioTransport(invoke),
    subscribeSurfacesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("surfaces"), listener),
    ...createTauriPluginSurfaceTransport(invoke),
    subscribePluginSurfacesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("plugin-surfaces"), listener),
    ...createTauriCheckTransport(invoke),
    subscribeCheckResultsInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("check-results"), listener),
    subscribeStudioInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("studio"), listener),
    ...createTauriProfileTransport(invoke),
    subscribeUiProfileInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("profile"), listener),
    ...createTauriRuntimeTransport(invoke),
    ...createTauriRuntimeOutputTransport(invoke),
    subscribeRuntimesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("runtimes"), listener),
    ...createTauriResourceTransport(invoke),
    subscribeResourcesInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("resources"), listener),
    ...createTauriAgentConversationTransport(invoke),
    ...createTauriAgentTurnDetailTransport(invoke),
    ...createTauriAgentExecutionTransport(invoke),
    ...createTauriAgentEventsTransport(listen),
    ...agentRuntimeTransport,
    ...createTauriAgentSettingsTransport(invoke),
    ...createTauriAgentFileTransport(invoke),
    subscribeAgentInvalidated: (listener) =>
      subscribeEvents(listen, invalidationEvents("agent"), listener),
    loadDomainSurface: async (surfaceId) => {
      let payload: unknown;
      switch (surfaceId) {
        case "rho.environment": payload = {
          installed: await environmentTransport.listInstalledPackages(200),
          requests: await environmentTransport.listEnvironmentOperationRequests(50),
        }; break;
        case "rho.evidence": payload = await evidenceTransport.listEvidenceClaims(100); break;
        case "rho.git": payload = {
          status: await gitTransport.status(),
          history: await gitTransport.log(30),
        }; break;
        case "rho.runs": payload = await historyTransport.listRuns(100); break;
        case "rho.artifacts": payload = await historyTransport.listArtifactRecords(100, false); break;
        case "rho.problems": payload = await historyTransport.listProblems(100); break;
        case "rho.plots": payload = await historyTransport.listPlotArtifacts(100, true); break;
        case "rho.logs": payload = { id: "startup-diagnostics", title: "Startup diagnostics", status: "current", detail: await startupTransport.diagnostics() }; break;
        case "rho.render-jobs": {
          const runs = await historyTransport.listRuns(100);
          payload = Array.isArray(runs) ? runs.filter((run) => {
            const encoded = boundedJson(run)?.toLowerCase() ?? "";
            return encoded.includes("render");
          }) : runs;
          break;
        }
        case "rho.help": {
          const [snapshot, app] = await Promise.all([
            kernelTransport.loadSnapshot(),
            kernelTransport.appInfo(),
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
    readPlotArtifact: historyTransport.readPlotArtifact,
    retryRun: historyTransport.retryRun,
  };
}
