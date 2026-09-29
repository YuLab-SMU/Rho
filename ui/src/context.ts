import { createContext, createElement, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Studio } from "./studio";
import { HostClient } from "./host-client";

// The fixed composition is created only when its reference shell is mounted.
// Importing the default plugin entry must not construct scientific/UI owners.
let studio: Studio | undefined;
function fixedStudio(): Studio {
  return studio ??= new Studio(HostClient.fromLocation(), { width: globalThis.innerWidth });
}
const RuntimeView = createContext<string | undefined>(undefined);
export const withRuntimeView = (viewId: string, children: ReactNode) => createElement(RuntimeView.Provider, { value: viewId }, children);
function useRuntimeBinding(viewId?: string) {
  const inherited = useContext(RuntimeView);
  useSyncExternalStore(fixedStudio().runtimeSessions.subscribe, fixedStudio().runtimeSessions.getSnapshot);
  const view = viewId ?? inherited;
  return { view, id: (view ? fixedStudio().runtimeSessions.targetForView(view) : fixedStudio().runtimeSessions.selectedId) ?? "main" };
}
function useModule<T extends { subscribe(listener: () => void): () => void; getSnapshot(): unknown }>(owner: T): T {
  useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return owner;
}
export const useRuntimeSessions = () => useModule(fixedStudio().runtimeSessions);
// Management pages inspect an explicit instance without changing the run target.
export const useInstanceSession = (id: string) => useModule(fixedStudio().session.forInstance(id));
export const useInstanceConsole = (id: string) => useModule(fixedStudio().workspaceFor(id).console);
export const useInstanceOperations = (id: string) => useModule(fixedStudio().operations.forInstance(id));
export const useInstanceObjects = (id: string) => useModule(fixedStudio().workspaceFor(id).objects);
export const useSession = () => { const { view, id } = useRuntimeBinding(); return useModule(view ? fixedStudio().session.forInstance(id) : fixedStudio().session); };
export const useAgents = () => useModule(fixedStudio().agents);
export const useNativeAgents = () => useModule(fixedStudio().nativeAgents);
export const useAgentTasks = () => useModule(fixedStudio().agentTasks);
export const useAgentHandoffs = () => useModule(fixedStudio().agentTasks.handoffs);
export const useComponentAgents = () => useModule(fixedStudio().componentAgents);
export const useOperations = () => { const { view, id } = useRuntimeBinding(); return useModule(view ? fixedStudio().operations.forInstance(id) : fixedStudio().operations); };
export const useFiles = () => useModule(fixedStudio().files);
export const useObjects = () => { const { id } = useRuntimeBinding(); return useModule(fixedStudio().workspaceFor(id).objects); };
export const useObjectCompletions = () => { const { id } = useRuntimeBinding(); return fixedStudio().workspaceFor(id).objects.completionNames; };
export const usePackages = () => { const { id } = useRuntimeBinding(); return useModule(fixedStudio().workspaceFor(id).packages); };
export const useOutputs = () => useModule(fixedStudio().outputs);
export const useMediaCache = () => useModule(fixedStudio().mediaCache);
export const usePlots = () => useModule(fixedStudio().plots);
export const useHelp = () => useModule(fixedStudio().help);
export const useViewer = () => useModule(fixedStudio().viewer);
export const useLayout = () => useModule(fixedStudio().layout);
const scopedNavigation = new Map<string, Studio["navigation"]>();
export const useNavigation = () => {
  const { view, id } = useRuntimeBinding(); useModule(fixedStudio().navigation);
  if (!view) return fixedStudio().navigation;
  let navigation = scopedNavigation.get(id);
  if (!navigation) {
    navigation = new Proxy(fixedStudio().navigation, { get: (owner, property) => {
      if (property === "openObject") return (name: string, path: import("./generated/ObjectPathElement").ObjectPathElement[] = []) => owner.openObject(name, path, id);
      const value = Reflect.get(owner, property, owner); return typeof value === "function" ? value.bind(owner) : value;
    } });
    scopedNavigation.set(id, navigation);
  }
  return navigation;
};
export const usePreferences = () => useModule(fixedStudio().preferences);
export const usePersistence = () => useModule(fixedStudio().persistence);
export const useApplication = () => useModule(fixedStudio().application);
export function useDocuments(id?: string) {
  const owner = fixedStudio().documents;
  useSyncExternalStore<unknown>(id ? (listener) => owner.subscribeDocument(id, listener) : owner.subscribe,
    id ? () => owner.getDocumentSnapshot(id) : owner.getSnapshot);
  return owner;
}
export function useConsole(id?: string) {
  const target = useRuntimeBinding(id), owner = useModule(fixedStudio().workspaceFor(target.id).console);
  useSyncExternalStore<unknown>(id ? (listener) => owner.subscribeView(id, listener) : owner.subscribe,
    id ? () => owner.getViewSnapshot(id) : owner.getSnapshot);
  return owner;
}
export const startStudio = () => fixedStudio().start();
export const stopStudio = () => studio?.stop();
