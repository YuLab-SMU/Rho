import { createContext, useContext, useSyncExternalStore } from "react";
import type { Objects } from "./objects.js";
import type { ObjectPathElement } from "../public/r-protocol/index.js";
import type { PluginViewClient } from "../public/plugin-ui/index.js";

/** Services belong to this view connection; no shared Studio or Host credential. */
export interface ObjectsViewServices {
  objects: Objects;
  session: { project: string | null; runtime: { state: string } | null };
  navigation: { openObject(name: string, path?: ObjectPathElement[]): void };
  execution: { run(code: string, mode: "console"): Promise<unknown> };
  clipboard: Pick<PluginViewClient, "copyText">;
}
export const ObjectsViewContext = createContext<ObjectsViewServices | null>(null);
function useServices() {
  const value = useContext(ObjectsViewContext);
  if (!value) throw new Error("Objects view connection is missing.");
  return value;
}
export function useObjects() {
  const owner = useServices().objects;
  useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return owner;
}
export const useSession = () => useServices().session;
export const useNavigation = () => useServices().navigation;
export const useExecution = () => useServices().execution;
export const useClipboard = () => useServices().clipboard;
