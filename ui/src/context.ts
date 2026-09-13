import { createContext, createElement, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Studio } from "./studio";
import { HostClient } from "./host-client";

const studio = new Studio(HostClient.fromLocation(), { width: globalThis.innerWidth });
const RuntimeView = createContext<string | undefined>(undefined);
export const withRuntimeView = (viewId: string, children: ReactNode) => createElement(RuntimeView.Provider, { value: viewId }, children);
function useRuntimeBinding(viewId?: string) {
  const inherited = useContext(RuntimeView);
  useSyncExternalStore(studio.runtimeSessions.subscribe, studio.runtimeSessions.getSnapshot);
  const view = viewId ?? inherited;
  return { view, id: (view ? studio.runtimeSessions.targetForView(view) : studio.runtimeSessions.selectedId) ?? "main" };
}
function useModule<T extends { subscribe(listener: () => void): () => void; getSnapshot(): unknown }>(owner: T): T {
  useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return owner;
}
export const useRuntimeSessions = () => useModule(studio.runtimeSessions);
// Management pages inspect an explicit instance without changing the run target.
export const useInstanceSession = (id: string) => useModule(studio.session.forInstance(id));
export const useInstanceConsole = (id: string) => useModule(studio.workspaceFor(id).console);
export const useInstanceOperations = (id: string) => useModule(studio.operations.forInstance(id));
export const useInstanceObjects = (id: string) => useModule(studio.workspaceFor(id).objects);
export const useSession = () => { const { view, id } = useRuntimeBinding(); return useModule(view ? studio.session.forInstance(id) : studio.session); };
export const useAgents = () => useModule(studio.agents);
export const useNativeAgents = () => useModule(studio.nativeAgents);
export const useAgentTasks = () => useModule(studio.agentTasks);
export const useComponentAgents = () => useModule(studio.componentAgents);
export const useOperations = () => { const { view, id } = useRuntimeBinding(); return useModule(view ? studio.operations.forInstance(id) : studio.operations); };
export const useFiles = () => useModule(studio.files);
export const useObjects = () => { const { id } = useRuntimeBinding(); return useModule(studio.workspaceFor(id).objects); };
export const useObjectCompletions = () => { const { id } = useRuntimeBinding(); return studio.workspaceFor(id).objects.completionNames; };
export const usePackages = () => { const { id } = useRuntimeBinding(); return useModule(studio.workspaceFor(id).packages); };
export const useOutputs = () => useModule(studio.outputs);
export const useMediaCache = () => useModule(studio.mediaCache);
export const usePlots = () => useModule(studio.plots);
export const useLayout = () => useModule(studio.layout);
const scopedNavigation = new Map<string, typeof studio.navigation>();
export const useNavigation = () => {
  const { view, id } = useRuntimeBinding(); useModule(studio.navigation);
  if (!view) return studio.navigation;
  let navigation = scopedNavigation.get(id);
  if (!navigation) {
    navigation = new Proxy(studio.navigation, { get: (owner, property) => {
      if (property === "openObject") return (name: string, path: import("./generated/ObjectPathElement").ObjectPathElement[] = []) => owner.openObject(name, path, id);
      const value = Reflect.get(owner, property, owner); return typeof value === "function" ? value.bind(owner) : value;
    } });
    scopedNavigation.set(id, navigation);
  }
  return navigation;
};
export const usePreferences = () => useModule(studio.preferences);
export const usePersistence = () => useModule(studio.persistence);
export const useApplication = () => useModule(studio.application);
export function useDocuments(id?: string) {
  const owner = studio.documents;
  useSyncExternalStore<unknown>(id ? (listener) => owner.subscribeDocument(id, listener) : owner.subscribe,
    id ? () => owner.getDocumentSnapshot(id) : owner.getSnapshot);
  return owner;
}
export function useConsole(id?: string) {
  const target = useRuntimeBinding(id), owner = useModule(studio.workspaceFor(target.id).console);
  useSyncExternalStore<unknown>(id ? (listener) => owner.subscribeView(id, listener) : owner.subscribe,
    id ? () => owner.getViewSnapshot(id) : owner.getSnapshot);
  return owner;
}
export const startStudio = () => studio.start();
export const stopStudio = () => studio.stop();
