import type {
  RuntimeExecution,
  RuntimeExecutionCursor,
  RuntimeExecutionDeleteResult,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputPageRequest,
  RuntimeOutputPolicyUpdate,
  RuntimeOutputPolicyView,
  RuntimeOutputPruneResult,
  RuntimeOutputReference,
  RuntimeOutputSearchRequest,
  RuntimeOutputSearchResult,
} from "./runtime-output";
import type {
  RuntimeCreateRequest,
  RuntimeExecuteRequest,
  RuntimeExecutionStartResponse,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
} from "./runtime";
import type {
  SurfaceOrigin,
  SurfaceStudioTransport,
} from "./surface-studio";
import type {
  ResourceBinding,
  ResourceTransport,
} from "./resource";
import type {
  ProfileTransport,
} from "./profile";
import type {
  AgentConversationTransport,
} from "./agent-conversation";
import type {
  AgentTurnDetailTransport,
} from "./agent-turn";
import type { AgentExecutionTransport } from "./agent-execution";
import type { AgentRuntimeTransport } from "./agent-runtime";
import type { AgentSettingsTransport } from "./agent-settings";
import type { AgentFileTransport } from "./agent-file";
import type { PluginSurfaceTransport } from "./plugin-surface";
import type { ProjectTransport } from "./project";

export type {
  RuntimeExecution,
  RuntimeExecutionCursor,
  RuntimeExecutionDeleteResult,
  RuntimeExecutionStatus,
  RuntimeOutputChunk,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputPageRequest,
  RuntimeOutputPolicy,
  RuntimeOutputPolicyUpdate,
  RuntimeOutputPolicyView,
  RuntimeOutputPresentationKind,
  RuntimeOutputPruneResult,
  RuntimeOutputReference,
  RuntimeOutputReferenceKind,
  RuntimeOutputSearchHit,
  RuntimeOutputSearchRequest,
  RuntimeOutputSearchResult,
  RuntimeOutputState,
  RuntimeOutputStorageKind,
  RuntimeOutputTransport,
} from "./runtime-output";

export type {
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeDescriptor,
  RuntimeExecuteRequest,
  RuntimeExecutionSourceContext,
  RuntimeExecutionSourceRange,
  RuntimeExecutionStartResponse,
  RuntimeInstanceRequest,
  RuntimePersistenceClass,
  RuntimeProviderDefinition,
  RuntimeProviderRegistration,
  RuntimeRegistrySnapshot,
  RuntimeStatus,
  RuntimeTransport,
} from "./runtime";

export type {
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  OpenSurfaceRequest,
  RuntimeAttachmentRequest,
  RuntimeDetachRequest,
  SceneEdit,
  SceneEditRequest,
  SceneState,
  StackNode,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  SurfaceDefinition,
  SurfaceFactoryRegistration,
  SurfaceInstance,
  SurfaceInstanceMutation,
  SurfaceInstanceRequest,
  SurfaceLifecycleState,
  SurfaceOrigin,
  SurfaceRuntimeSnapshot,
  SurfaceStudioTransport,
  UpdateSurfaceRequest,
} from "./surface-studio";

export type {
  ResourceBinding,
  ResourceContent,
  ResourceDeleteRequest,
  ResourceDescriptor,
  ResourceDraftRequest,
  ResourceProviderDefinition,
  ResourceProviderRegistration,
  ResourceReadConsistency,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
  ResourceStatus,
  ResourceTarget,
  ResourceTransport,
} from "./resource";

export type {
  ProfileTransport,
  ProjectUiProfile,
  ProjectUiProfileSnapshot,
  RuntimeAttachmentIntent,
  StudioScenePreset,
  SurfaceInstanceSpec,
  UiProfileLoadStatus,
  UiProfileMode,
  UiProfileRevisionRequest,
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  VibeBlock,
  VibeBlockContent,
  VibeCalloutTone,
  VibeGridPlacement,
  VibePage,
  VibePageExport,
  VibePageExportRequest,
  VibePageMutation,
  VibePageMutationRequest,
  VibeRichTextBlock,
  VibeRichTextDocument,
  VibeRichTextInline,
  VibeRichTextMark,
  VibeSection,
  VibeSectionLayout,
} from "./profile";

export type {
  AgentConversationSummary,
  AgentConversationTransport,
  AgentMode,
  AgentTurnSummary,
} from "./agent-conversation";

export type {
  AgentApprovalRequest,
  AgentContextPlanItem,
  AgentTurnDetail,
  AgentTurnDetailTransport,
  AgentTurnEvent,
} from "./agent-turn";

export type {
  AgentApprovalDecisionRequest,
  AgentApprovalDeliveryResponse,
  AgentContextPlanPreview,
  AgentContextPreviewRequest,
  AgentEditorContext,
  AgentExecutionTransport,
  AgentTaskKind,
  AgentTurnCancelResponse,
  RunAgentRequest,
  RunAgentResponse,
} from "./agent-execution";

export type {
  AgentDependencyDiagnostics,
  AgentRuntimeDiagnostics,
  AgentRuntimeTransport,
} from "./agent-runtime";

export type {
  AgentContextCapacityRequest,
  AgentLlmSettingsView,
  AgentModelContextCapacity,
  AgentSettingsTransport,
} from "./agent-settings";

export type {
  AgentFileApplyRequest,
  AgentFileMutationResponse,
  AgentFileTransport,
  AgentFileUndoRequest,
} from "./agent-file";

export type {
  PluginSurfaceBlock,
  PluginSurfaceCommandResult,
  PluginSurfaceDocument,
  PluginSurfaceDocumentRequest,
  PluginSurfaceDocumentView,
  PluginSurfaceEventKind,
  PluginSurfaceEventRequest,
  PluginSurfaceEventResult,
  PluginSurfaceJsonValue,
  PluginSurfaceNoticeTone,
  PluginSurfaceTransport,
} from "./plugin-surface";

export type {
  ProjectBlockerKind,
  ProjectDocumentSession,
  ProjectFile,
  ProjectPanelSizes,
  ProjectSessionSnapshot,
  ProjectState,
  ProjectSwitchBlocker,
  ProjectSwitchResponse,
  ProjectSwitchStatus,
  ProjectTransport,
  UnavailableProject,
} from "./project";

export type UiSnapshotSource = "tauri" | "mock";
export type HealthState = "ready" | "degraded" | "unavailable" | "restarting";
export type ActiveOperationState = "queued" | "running" | "waiting" | "cancelling";
export type CommandPlacementTag =
  | "palette"
  | "surface_local"
  | "primary_candidate"
  | "menu"
  | "context_menu"
  | "keyboard";

export type UiSelection =
  | { readonly kind: "resource"; readonly binding: ResourceBinding }
  | {
      readonly kind: "text_range";
      readonly binding: ResourceBinding;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "run"; readonly run_id: string }
  | { readonly kind: "artifact"; readonly artifact_id: string }
  | { readonly kind: "object"; readonly object_id: string }
  | { readonly kind: "finding"; readonly finding_id: string }
  | { readonly kind: "task"; readonly task_id: string }
  | { readonly kind: "vibe_block"; readonly page_id: string; readonly block_id: string };

export interface ActiveOperation {
  readonly operation_id: string;
  readonly label: string;
  readonly state: ActiveOperationState;
}

export interface UiContext {
  readonly project_id: string;
  readonly project_revision: number;
  readonly scene_id: string | null;
  readonly page_id: string | null;
  readonly focused_surface_instance_id: string | null;
  readonly selection: UiSelection | null;
  readonly workspace_health: HealthState;
  readonly agent_health: HealthState;
  readonly active_operations: readonly ActiveOperation[];
}

export interface CommandDefinition {
  readonly command_id: string;
  readonly label: string;
  readonly purpose: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly consequence: string;
  readonly availability_predicate_id: string;
  readonly placement_tags: readonly CommandPlacementTag[];
  readonly origin: SurfaceOrigin;
}

export type CommandAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string };

export interface CommandRegistration {
  readonly definition: CommandDefinition;
  readonly activation_generation: number;
  readonly availability: CommandAvailability;
}

export interface UiHealthDetail {
  readonly state: HealthState;
  readonly label: string;
  readonly detail: string | null;
}

export interface UiKernelSnapshot {
  readonly contract: "rho.ui.kernel.snapshot.v1";
  readonly contract_major: 1;
  readonly snapshot_revision: number;
  readonly project: {
    readonly project_id: string;
    readonly display_label: string;
    readonly display_path: string;
  };
  readonly context: UiContext;
  readonly health: {
    readonly workspace: UiHealthDetail;
    readonly agent: UiHealthDetail;
  };
  readonly command_registry: {
    readonly registrations: readonly CommandRegistration[];
  };
}

export interface SetUiSelectionRequest {
  readonly project_id: string;
  readonly expected_project_revision: number;
  readonly expected_snapshot_revision: number;
  readonly selection: UiSelection | null;
}

export interface RuntimeOutputEvent {
  readonly sequence: number;
  readonly runtime_instance_id: string;
  readonly console_instance_id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export type CheckSeverity = "info" | "warning" | "error";
export type CheckResultStatus = "clean" | "findings" | "incomplete" | "failed";

export type CheckEvidence =
  | {
      readonly kind: "source_range";
      readonly path: string;
      readonly line: number;
      readonly column: number | null;
      readonly excerpt: string | null;
    }
  | { readonly kind: "project_file"; readonly path: string }
  | { readonly kind: "run_ref"; readonly run_id: string }
  | { readonly kind: "environment_ref"; readonly snapshot_id: string }
  | { readonly kind: "note"; readonly text: string };

export interface CheckFinding {
  readonly rule_id: string;
  readonly rule_version: number;
  readonly origin: SurfaceOrigin;
  readonly activation_generation: number;
  readonly severity: CheckSeverity;
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  readonly remediation: string;
  readonly evidence: readonly CheckEvidence[];
  readonly limitations: readonly string[];
}

export interface CheckProjectSnapshot {
  readonly contract: "rho.ui.check-project.snapshot.v1";
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly project_revision: number;
  readonly captured_at: string;
  readonly files: readonly {
    readonly path: string;
    readonly size_bytes: number;
    readonly content_sha256: string;
    readonly skipped: boolean;
    readonly skip_reason: string | null;
  }[];
  readonly source_bytes: number;
  readonly renv_lock_sha256: string | null;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface CheckResult {
  readonly contract: "rho.ui.check-result.v1";
  readonly result_id: string;
  readonly project_id: string;
  readonly project_revision: number;
  readonly snapshot: CheckProjectSnapshot;
  readonly ruleset_digest: string;
  readonly generated_at: string;
  readonly status: CheckResultStatus;
  readonly findings: readonly CheckFinding[];
  readonly coverage: {
    readonly files_scanned: number;
    readonly files_skipped: number;
    readonly core_rules: number;
    readonly plugin_rule_packs: number;
    readonly plugin_rule_failures: number;
  };
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface CheckRunRequest {
  readonly project_id: string;
  readonly expected_project_revision: number;
}

export interface CheckResultRequest extends CheckRunRequest {
  readonly result_id: string;
}

export interface CheckRunResponse {
  readonly result: CheckResult;
}

export interface DomainSurfaceItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly status: string | null;
  readonly detail: string | null;
}

export interface DomainSurfaceData {
  readonly surface_id: string;
  readonly loaded_at: string;
  readonly summary: string;
  readonly items: readonly DomainSurfaceItem[];
}

export interface PlotImageView {
  readonly plot_id: string;
  readonly media_type: string;
  readonly data_base64: string;
}

export type Unsubscribe = () => void;

export interface WorkspacePreparationIssue {
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly technical_detail: string | null;
}

export interface WorkspacePreparation {
  readonly status: "ready" | "needs_attention";
  readonly phase: string;
  readonly workspace_ready: boolean;
  readonly restored_project_status: string | null;
  readonly issue: WorkspacePreparationIssue | null;
}

export interface UiKernelTransport extends SurfaceStudioTransport, ResourceTransport, ProfileTransport, AgentConversationTransport, AgentTurnDetailTransport, AgentExecutionTransport, AgentRuntimeTransport, AgentSettingsTransport, AgentFileTransport, PluginSurfaceTransport, ProjectTransport {
  readonly source: UiSnapshotSource;
  prepareWorkspace(chooseRscript?: boolean): Promise<WorkspacePreparation>;
  loadSnapshot(): Promise<UiKernelSnapshot>;
  setSelection(request: SetUiSelectionRequest): Promise<UiKernelSnapshot>;
  subscribeInvalidated(listener: () => void): Unsubscribe;
  subscribeSurfacesInvalidated(listener: () => void): Unsubscribe;
  subscribePluginSurfacesInvalidated(listener: () => void): Unsubscribe;
  runCheckProject(request: CheckRunRequest): Promise<CheckRunResponse>;
  loadCheckResult(request: CheckResultRequest): Promise<CheckResult>;
  subscribeCheckResultsInvalidated(listener: () => void): Unsubscribe;
  subscribeStudioInvalidated(listener: () => void): Unsubscribe;
  subscribeUiProfileInvalidated(listener: () => void): Unsubscribe;
  loadRuntimes(): Promise<RuntimeRegistrySnapshot>;
  createRuntime(request: RuntimeCreateRequest): Promise<RuntimeRegistrySnapshot>;
  interruptRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  restartRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  stopRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  startRuntimeExecution(request: RuntimeExecuteRequest): Promise<RuntimeExecutionStartResponse>;
  getRuntimeExecution(executionId: string): Promise<RuntimeExecution>;
  listRuntimeExecutions(limit?: number, before?: RuntimeExecutionCursor): Promise<readonly RuntimeExecution[]>;
  loadRuntimeOutputPage(request: RuntimeOutputPageRequest): Promise<RuntimeOutputPage>;
  searchRuntimeOutput(request: RuntimeOutputSearchRequest): Promise<RuntimeOutputSearchResult>;
  getRuntimeOutputPolicy(): Promise<RuntimeOutputPolicyView>;
  updateRuntimeOutputPolicy(request: RuntimeOutputPolicyUpdate): Promise<RuntimeOutputPolicyView>;
  createRuntimeOutputReference(
    executionId: string,
    startSequence?: number,
    endSequence?: number,
  ): Promise<RuntimeOutputReference>;
  pruneRuntimeOutput(executionId: string): Promise<RuntimeOutputPruneResult>;
  deleteRuntimeExecution(executionId: string): Promise<RuntimeExecutionDeleteResult>;
  followRuntimeOutput(
    executionId: string,
    afterSequence: number,
    listener: (frame: RuntimeOutputFollowFrame) => void,
  ): Promise<void>;
  subscribeRuntimesInvalidated(listener: () => void): Unsubscribe;
  subscribeResourcesInvalidated(listener: () => void): Unsubscribe;
  subscribeAgentInvalidated(listener: () => void): Unsubscribe;
  loadDomainSurface(surfaceId: string): Promise<DomainSurfaceData>;
  readPlotArtifact(plotId: string): Promise<PlotImageView>;
  retryRun(runId: string): Promise<unknown>;
}
