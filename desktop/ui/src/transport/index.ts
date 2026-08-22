import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { createMockUiKernelTransport } from "./mock";
import { createTauriUiKernelTransport } from "./tauri";
import type { UiKernelTransport } from "./types";

export function createUiKernelTransport(): UiKernelTransport {
  if (window.__TAURI__?.core?.invoke != null) {
    return createTauriUiKernelTransport(invoke, listen);
  }
  return createMockUiKernelTransport(window.location.search);
}

export {
  commandsForPlacement,
  StudioExternalStore,
  UiProfileExternalStore,
  SurfaceExternalStore,
  RuntimeExternalStore,
  ResourceExternalStore,
  UiExternalStore,
} from "./store";
export type { ResourceStoreSnapshot, RuntimeStoreSnapshot, StudioStoreSnapshot, SurfaceStoreSnapshot, UiProfileStoreSnapshot, UiStoreSnapshot } from "./store";
export type {
  CommandAvailability,
  CommandPlacementTag,
  CommandRegistration,
  HealthState,
  SetUiSelectionRequest,
  OpenSurfaceRequest,
  SurfaceInstance,
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
  VibePage,
  RuntimeAttachmentRequest,
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeDescriptor,
  RuntimeDetachRequest,
  RuntimeExecuteRequest,
  RuntimeExecutionResult,
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
} from "./types";
