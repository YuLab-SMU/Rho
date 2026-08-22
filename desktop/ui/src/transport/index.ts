import { createMockBootstrapTransport } from "./mock";
import { createTauriBootstrapTransport } from "./tauri";
import type { BootstrapTransport } from "./types";

export function createBootstrapTransport(): BootstrapTransport {
  const tauriCore = window.__TAURI__?.core;
  if (tauriCore != null && typeof tauriCore.invoke === "function") {
    return createTauriBootstrapTransport(tauriCore.invoke.bind(tauriCore));
  }
  return createMockBootstrapTransport(window.location.search);
}

export type {
  BootstrapSnapshot,
  BootstrapTransport,
  ProjectBootstrapView,
  StartupHealthState,
  StartupHealthView,
} from "./types";
