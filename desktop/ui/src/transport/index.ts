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

export { commandsForPlacement, UiExternalStore } from "./store";
export type { UiStoreSnapshot } from "./store";
export type {
  CommandAvailability,
  CommandPlacementTag,
  CommandRegistration,
  HealthState,
  SetUiSelectionRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  UiSelection,
} from "./types";
