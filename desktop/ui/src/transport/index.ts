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

export { commandsForPlacement, SurfaceExternalStore, UiExternalStore } from "./store";
export type { SurfaceStoreSnapshot, UiStoreSnapshot } from "./store";
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
  UiKernelSnapshot,
  UiKernelTransport,
  UiSelection,
} from "./types";
