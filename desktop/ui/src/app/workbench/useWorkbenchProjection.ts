import { useSyncExternalStore } from "react";

import type { WorkbenchProjectionStore } from "../../transport";

export function useWorkbenchProjection(store: WorkbenchProjectionStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
