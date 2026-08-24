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
  SurfaceInstanceRequest,
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

export type PluginSurfaceEventKind = "input" | "change" | "submit" | "activate";

export type PluginSurfaceNoticeTone = "info" | "success" | "warning" | "error";

export type PluginSurfaceBlock =
  | { readonly kind: "row"; readonly blocks: readonly PluginSurfaceBlock[] }
  | { readonly kind: "column"; readonly blocks: readonly PluginSurfaceBlock[] }
  | {
      readonly kind: "grid";
      readonly columns: number;
      readonly blocks: readonly {
        readonly column_span: number;
        readonly block: PluginSurfaceBlock;
      }[];
    }
  | {
      readonly kind: "tabs";
      readonly active_tab_id: string;
      readonly tabs: readonly {
        readonly tab_id: string;
        readonly label: string;
        readonly blocks: readonly PluginSurfaceBlock[];
      }[];
    }
  | { readonly kind: "group"; readonly label: string | null; readonly blocks: readonly PluginSurfaceBlock[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly code: string; readonly language: string | null }
  | { readonly kind: "key_value"; readonly items: readonly { readonly key: string; readonly value: string }[] }
  | { readonly kind: "table"; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "notice"; readonly tone: PluginSurfaceNoticeTone; readonly text: string }
  | { readonly kind: "artifact_image_ref"; readonly artifact_id: string; readonly media_type: string; readonly alt: string }
  | {
      readonly kind: "field";
      readonly control_id: string;
      readonly label: string;
      readonly value: string;
      readonly placeholder: string | null;
      readonly disabled: boolean;
      readonly busy: boolean;
    }
  | {
      readonly kind: "select";
      readonly control_id: string;
      readonly label: string;
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly disabled: boolean;
      readonly busy: boolean;
    }
  | {
      readonly kind: "command_button";
      readonly control_id: string;
      readonly label: string;
      readonly command_id: string;
      readonly disabled: boolean;
      readonly busy: boolean;
    };

export interface PluginSurfaceDocument {
  readonly contract: "rho.plugin_surface_document.v1";
  readonly revision: number;
  readonly title: string;
  readonly blocks: readonly PluginSurfaceBlock[];
}

export interface PluginSurfaceDocumentRequest {
  readonly target: SurfaceInstanceRequest;
  readonly expected_layout_revision: number | null;
  readonly expected_page_revision: number | null;
}

export interface PluginSurfaceEventRequest extends PluginSurfaceDocumentRequest {
  readonly expected_document_revision: number;
  readonly control_id: string;
  readonly event_kind: PluginSurfaceEventKind;
  readonly value: unknown;
}

export interface PluginSurfaceDocumentView {
  readonly project_id: string;
  readonly instance_id: string;
  readonly surface_id: string;
  readonly surface_revision: number;
  readonly document: PluginSurfaceDocument;
  readonly provenance: unknown;
}

export interface PluginSurfaceEventResult {
  readonly event_id: string;
  readonly status: "completed" | "queued";
  readonly document: PluginSurfaceDocument | null;
  readonly command_result: unknown | null;
  readonly provenance: unknown | null;
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

export interface AgentFileApplyRequest {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_disk_sha256: string | null;
  readonly before_content: string;
}

export interface AgentFileUndoRequest {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_after_sha256: string;
  readonly before_content: string;
  readonly created: boolean;
}

export interface AgentFileMutationResponse {
  readonly status: string;
  readonly path: string;
  readonly content: string | null;
  readonly start: number;
  readonly end: number;
  readonly after_sha256: string | null;
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

export type ProjectSwitchStatus =
  | "ready"
  | "cancelled"
  | "blocked"
  | "unavailable"
  | "failed_restored"
  | "fatal";

export interface ProjectSwitchResponse {
  readonly status: ProjectSwitchStatus;
  readonly project: {
    readonly root: string;
    readonly files: readonly unknown[];
    readonly truncated: boolean;
  } | null;
  readonly session: unknown;
  readonly unavailable: { readonly path: string; readonly reason: string } | null;
  readonly blocker: {
    readonly kind: string;
    readonly message: string;
    readonly pending_count: number;
  } | null;
  readonly reason_code: string | null;
  readonly message: string | null;
  readonly restored_root: string | null;
  readonly restart_required: boolean;
}

export interface UiKernelTransport extends SurfaceStudioTransport, ResourceTransport, ProfileTransport, AgentConversationTransport, AgentTurnDetailTransport, AgentExecutionTransport, AgentRuntimeTransport, AgentSettingsTransport {
  readonly source: UiSnapshotSource;
  prepareWorkspace(chooseRscript?: boolean): Promise<WorkspacePreparation>;
  openProject(path: string): Promise<ProjectSwitchResponse>;
  pickProjectDirectory(): Promise<ProjectSwitchResponse>;
  loadSnapshot(): Promise<UiKernelSnapshot>;
  setSelection(request: SetUiSelectionRequest): Promise<UiKernelSnapshot>;
  subscribeInvalidated(listener: () => void): Unsubscribe;
  subscribeSurfacesInvalidated(listener: () => void): Unsubscribe;
  loadPluginSurfaceDocument(request: PluginSurfaceDocumentRequest): Promise<PluginSurfaceDocumentView>;
  dispatchPluginSurfaceEvent(request: PluginSurfaceEventRequest): Promise<PluginSurfaceEventResult>;
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
  applyAgentFileEdit(request: AgentFileApplyRequest): Promise<AgentFileMutationResponse>;
  undoAgentFileEdit(request: AgentFileUndoRequest): Promise<AgentFileMutationResponse>;
}
