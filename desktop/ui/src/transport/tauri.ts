import type {
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

export function createTauriUiKernelTransport(
  invoke: Invoke,
  listen: Listen,
): UiKernelTransport {
  return {
    source: "tauri",
    loadSnapshot: () => invoke<UiKernelSnapshot>("ui_kernel_snapshot"),
    setSelection: (request) =>
      invoke<UiKernelSnapshot>("ui_set_selection", { request }),
    subscribeInvalidated(listener): Unsubscribe {
      let active = true;
      const unlisteners: Unsubscribe[] = [];
      for (const eventName of INVALIDATION_EVENTS) {
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
    },
  };
}
