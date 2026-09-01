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
  SurfaceStudioTransport,
} from "./surface-studio";
import type { ResourceTransport } from "./resource";
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
import type { AgentEventsTransport } from "./agent-events";
import type { AgentFileTransport } from "./agent-file";
import type { PluginSurfaceTransport } from "./plugin-surface";
import type { ProjectTransport } from "./project";
import type { KernelTransport } from "./kernel-generated";
import type { CheckTransport } from "./check";
import type { WorkbenchProjectionTransport } from "./workbench-projection";
import type { EvidenceGraphTransport } from "./evidence-graph";
import type { AuthorityReadTransport } from "./authority";
import type { EnvironmentHealthView } from "./environment";
import type { HistoryReadTransport } from "./history";

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
  AgentLlmCredentialRevealView,
  AgentLlmSettingsView,
  AgentModelCapabilityDeclarationRequest,
  AgentModelDiscoveryResponse,
  AgentModelContextCapacity,
  AgentModelProfile,
  AgentSettingsTransport,
} from "./agent-settings";
export {
  buildAddedModelProfile,
  CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
  CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
  MODEL_CAPABILITY_NAMES,
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

export type {
  ActiveOperation,
  ActiveOperationState,
  AppInfo,
  CommandAvailability,
  CommandDefinition,
  CommandPlacementTag,
  CommandRegistration,
  HealthState,
  KernelTransport,
  SetUiSelectionRequest,
  UiContext,
  UiKernelSnapshot,
  UiSelection,
} from "./kernel-generated";

export type {
  FindingReference,
  CheckFinding,
  CheckProjectSnapshot,
  CheckResult,
  CheckResultRequest,
  CheckResultStatus,
  CheckRunRequest,
  CheckRunResponse,
  CheckSeverity,
  CheckTransport,
} from "./check";

export type {
  ArtifactRecordSummary,
  HistoryReadTransport,
  PlotArtifactSummary,
  PlotImageView,
  ProblemSummary,
  RunSummary,
} from "./history";

export type {
  AuthorityObservation,
  AuthorityReceipt,
  AuthorityReceiptPage,
  AuthorityReadTransport,
  AuthorityReference,
} from "./authority";

export type {
  ClaimTrace,
  CreateDraftClaimRequest,
  CreateDraftLinkRequest,
  EvidenceDraftTransport,
  EvidenceEdge,
  EvidenceGap,
  EvidenceGapPage,
  EvidenceGraphAdminTransport,
  EvidenceGraphHealth,
  EvidenceGraphReadTransport,
  EvidenceGraphTransport,
  EvidenceMutation,
  EvidenceNode,
  EvidencePromotionRequest,
  EvidencePromotionTransport,
  EvidenceRetirementRequest,
  EvidenceSubgraph,
  ReviseDraftClaimRequest,
} from "./evidence-graph";

export type UiSnapshotSource = "tauri" | "mock";

export interface RuntimeOutputEvent {
  readonly sequence: number;
  readonly runtime_instance_id: string;
  readonly console_instance_id: string;
  readonly kind: string;
  readonly payload: unknown;
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

export type WorkspacePreparationStage = "runtime" | "workspace" | "project";
export type WorkspacePreparationProgressState = "active" | "complete";

export type WorkspacePreparationProgress =
  | {
      readonly stage: "runtime";
      readonly state: "active";
    }
  | {
      readonly stage: "runtime";
      readonly state: "complete";
      readonly r_version?: string;
    }
  | {
      readonly stage: "workspace";
      readonly state: "active";
    }
  | {
      readonly stage: "workspace";
      readonly state: "complete";
      readonly workspace_pid?: number;
    }
  | {
      readonly stage: "project";
      readonly state: "active";
    }
  | {
      readonly stage: "project";
      readonly state: "complete";
      readonly project_root?: string;
    };

export type WorkspacePreparationProgressListener = (
  snapshot: WorkspacePreparationProgress,
) => void;

export interface UiKernelTransport extends SurfaceStudioTransport, ResourceTransport, ProfileTransport, AgentConversationTransport, AgentTurnDetailTransport, AgentExecutionTransport, AgentEventsTransport, AgentRuntimeTransport, AgentSettingsTransport, AgentFileTransport, PluginSurfaceTransport, ProjectTransport, KernelTransport, CheckTransport, WorkbenchProjectionTransport, HistoryReadTransport, AuthorityReadTransport, EvidenceGraphTransport {
  readonly source: UiSnapshotSource;
  prepareWorkspace(
    chooseRscript?: boolean,
    onProgress?: WorkspacePreparationProgressListener,
  ): Promise<WorkspacePreparation>;
  subscribeInvalidated(listener: () => void): Unsubscribe;
  subscribeSurfacesInvalidated(listener: () => void): Unsubscribe;
  subscribePluginSurfacesInvalidated(listener: () => void): Unsubscribe;
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
  environmentHealth(): Promise<EnvironmentHealthView>;
  reobserveEnvironment(): Promise<EnvironmentHealthView>;
  retryRun(runId: string): Promise<unknown>;
}
