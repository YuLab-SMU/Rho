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
  SurfaceExternalStore,
  UiExternalStore,
} from "./store";
export type { StudioStoreSnapshot, SurfaceStoreSnapshot, UiStoreSnapshot } from "./store";
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
  UiKernelSnapshot,
  UiKernelTransport,
  UiSelection,
} from "./types";
