import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { createMockUiKernelTransport } from "./mock";
import { createTauriUiKernelTransport } from "./tauri";
import type { UiKernelTransport } from "./types";

export type { RuntimeTransport } from "./runtime";
export type { SurfaceStudioTransport } from "./surface-studio";
export type { ResourceTransport } from "./resource";
export type { ProfileTransport } from "./profile";
export type { AgentConversationTransport } from "./agent-conversation";
export type { AgentTurnDetailTransport } from "./agent-turn";
export type { AgentExecutionTransport } from "./agent-execution";
export type { AgentRuntimeTransport } from "./agent-runtime";
export type { AgentSettingsTransport } from "./agent-settings";
export type { AgentFileTransport } from "./agent-file";
export type { PluginSurfaceTransport } from "./plugin-surface";
export type { ProjectTransport } from "./project";
export type { KernelTransport } from "./kernel-generated";
export type { CheckTransport } from "./check";
export type {
  WorkbenchProjection,
  WorkbenchProjectionTransport,
  WorkbenchRevisionVector,
} from "./workbench-projection";

export function createUiKernelTransport(): UiKernelTransport {
  if (isTauri()) {
    return createTauriUiKernelTransport(invoke, listen);
  }
  return createMockUiKernelTransport(window.location.search);
}

export {
  commandsForPlacement,
  WorkbenchProjectionStore,
} from "./store";
export type {
  ResourceStoreSnapshot,
  RuntimeStoreSnapshot,
  StudioStoreSnapshot,
  SurfaceStoreSnapshot,
  UiProfileStoreSnapshot,
  UiStoreSnapshot,
  WorkbenchStoreSnapshot,
} from "./store";
export type {
  CommandAvailability,
  CommandPlacementTag,
  CommandRegistration,
  DomainSurfaceData,
  DomainSurfaceItem,
  AgentApprovalDecisionRequest,
  AgentApprovalRequest,
  AgentFileApplyRequest,
  AgentFileMutationResponse,
  AgentFileUndoRequest,
  AgentConversationSummary,
  AgentDependencyDiagnostics,
  AgentRuntimeDiagnostics,
  AgentMode,
  AgentTurnDetail,
  AgentContextPlanItem,
  AgentContextPlanPreview,
  AgentContextPreviewRequest,
  AgentContextCapacityRequest,
  AgentLlmCredentialRevealView,
  AgentLlmSettingsView,
  AgentModelDiscoveryResponse,
  AgentModelContextCapacity,
  AgentModelCapabilityDeclarationRequest,
  AgentModelProfile,
  AgentTurnEvent,
  AgentTurnSummary,
  RunAgentRequest,
  RunAgentResponse,
  CheckEvidence,
  CheckFinding,
  CheckProjectSnapshot,
  CheckResult,
  CheckResultRequest,
  CheckRunRequest,
  CheckRunResponse,
  HealthState,
  SetUiSelectionRequest,
  OpenSurfaceRequest,
  PluginSurfaceBlock,
  PluginSurfaceDocument,
  PluginSurfaceDocumentRequest,
  PluginSurfaceDocumentView,
  PluginSurfaceEventKind,
  PluginSurfaceEventRequest,
  PluginSurfaceEventResult,
  SurfaceInstance,
  SurfaceFactoryRegistration,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  LayoutAxis,
  LayoutBasis,
  LayoutChild,
  LayoutNode,
  SceneEdit,
  SceneEditRequest,
  SceneState,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  ProjectUiProfile,
  ProjectUiProfileSnapshot,
  ProjectSwitchResponse,
  ProjectSwitchStatus,
  StudioScenePreset,
  SurfaceInstanceSpec,
  UiProfileMode,
  UiProfileRevisionRequest,
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  VibeBlockContent,
  VibeBlock,
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
  RuntimeAttachmentRequest,
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeDescriptor,
  RuntimeDetachRequest,
  RuntimeExecuteRequest,
  RuntimeExecutionSourceContext,
  RuntimeExecution,
  RuntimeExecutionCursor,
  RuntimeExecutionStartResponse,
  RuntimeOutputChunk,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputPruneResult,
  RuntimeOutputReference,
  RuntimeOutputSearchHit,
  RuntimeOutputSearchRequest,
  RuntimeOutputSearchResult,
  RuntimeOutputPolicy,
  RuntimeOutputPolicyUpdate,
  RuntimeOutputPolicyView,
  RuntimeOutputTransport,
  RuntimeExecutionDeleteResult,
  RuntimeOutputPageRequest,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  ResourceBinding,
  ResourceContent,
  ResourceDeleteRequest,
  ResourceDescriptor,
  ResourceDraftRequest,
  ResourceReadConsistency,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
  ResourceStatus,
  ResourceTarget,
  UiKernelSnapshot,
  UiKernelTransport,
  UiSelection,
  WorkspacePreparation,
  WorkspacePreparationIssue,
} from "./types";
export {
  buildAddedModelProfile,
  CONSERVATIVE_CONTEXT_WINDOW_TOKENS,
  CONSERVATIVE_RESERVED_OUTPUT_TOKENS,
  MODEL_CAPABILITY_NAMES,
} from "./agent-settings";
