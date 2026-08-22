import type {
  OpenSurfaceRequest,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  UpdateSurfaceRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  Unsubscribe,
} from "./types";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(
  event: string,
  handler: (event: { readonly payload: T }) => void,
) => Promise<Unsubscribe>;

const INVALIDATION_EVENTS = [
  "rho://ui-snapshot-invalidated",
  "project://files-changed",
  "rho://agent-turn-updated",
] as const;

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
    loadSnapshot: () => invoke<UiKernelSnapshot>("ui_kernel_snapshot"),
    setSelection: (request) =>
      invoke<UiKernelSnapshot>("ui_set_selection", { request }),
    subscribeInvalidated: (listener) =>
      subscribeEvents(listen, INVALIDATION_EVENTS, listener),
    loadSurfaces: () => invoke<SurfaceRuntimeSnapshot>("surface_list"),
    openSurface: (request: OpenSurfaceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_open", { request }),
    updateSurface: (request: UpdateSurfaceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_update", { request }),
    closeSurface: (request: SurfaceInstanceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_close", { request }),
    suspendSurface: (request: SurfaceInstanceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_suspend", { request }),
    resumeSurface: (request: SurfaceInstanceRequest) =>
      invoke<SurfaceRuntimeSnapshot>("surface_resume", { request }),
    subscribeSurfacesInvalidated: (listener) =>
      subscribeEvents(
        listen,
        ["rho://surface-runtime-changed", "rho://ui-snapshot-invalidated"],
        listener,
      ),
  };
}
