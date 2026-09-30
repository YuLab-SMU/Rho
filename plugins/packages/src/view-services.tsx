import { createContext, useContext, useSyncExternalStore } from "react";
import type { Packages } from "./packages.js";
import type { PackageEntry } from "../public/r-protocol/index.js";
export interface PackagesViewServices {
  packages: Packages;
  session: { project: string | null; runtime: { state: string } | null };
  agent?: {blocked:boolean;recovering:boolean;ask(copy:PackageEntry):void;annotate?(copy:PackageEntry):void};
  navigation: { blocked: boolean; canOpenDocumentation: boolean; openDocumentation(copy: PackageEntry): void; openLink(url: string): void };
}
export const PackagesViewContext = createContext<PackagesViewServices | null>(null);
function useServices() {
  const services = useContext(PackagesViewContext);
  if (!services) throw new Error("The Packages view connection is missing.");
  return services;
}
export function usePackages() { const packages = useServices().packages; useSyncExternalStore(packages.subscribe, packages.getSnapshot); return packages; }
export const useSession = () => useServices().session;
export const useAgent = () => useServices().agent;
export const useNavigation = () => useServices().navigation;
