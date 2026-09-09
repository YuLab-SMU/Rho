import { useSyncExternalStore } from "react";
import { Studio } from "./studio";
import { HostClient } from "./host-client";

const studio = new Studio(HostClient.fromLocation(), { width: globalThis.innerWidth });
function useModule<T extends { subscribe(listener: () => void): () => void; getSnapshot(): unknown }>(owner: T): T {
  useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return owner;
}
export const useSession = () => useModule(studio.session);
export const useAgents = () => useModule(studio.agents);
export const useNativeAgents = () => useModule(studio.nativeAgents);
export const useAgentTasks = () => useModule(studio.agentTasks);
export const useOperations = () => useModule(studio.operations);
export const useFiles = () => useModule(studio.files);
export const useObjects = () => useModule(studio.objects);
export const useObjectCompletions = () => studio.objects.completionNames;
export const usePackages = () => useModule(studio.packages);
export const useOutputs = () => useModule(studio.outputs);
export const useMediaCache = () => useModule(studio.mediaCache);
export const usePlots = () => useModule(studio.plots);
export const useLayout = () => useModule(studio.layout);
export const useNavigation = () => useModule(studio.navigation);
export const usePreferences = () => useModule(studio.preferences);
export const usePersistence = () => useModule(studio.persistence);
export function useDocuments(id?: string) {
  const owner = studio.documents;
  useSyncExternalStore<unknown>(id ? (listener) => owner.subscribeDocument(id, listener) : owner.subscribe,
    id ? () => owner.getDocumentSnapshot(id) : owner.getSnapshot);
  return owner;
}
export function useConsole(id?: string) {
  const owner = useModule(studio.console);
  useSyncExternalStore<unknown>(id ? (listener) => owner.subscribeView(id, listener) : owner.subscribe,
    id ? () => owner.getViewSnapshot(id) : owner.getSnapshot);
  return owner;
}
export const startStudio = () => studio.start();
export const stopStudio = () => studio.stop();
