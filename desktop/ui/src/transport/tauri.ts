import { normalizeProjectState, normalizeStartupView } from "./normalize";
import type {
  BootstrapSnapshot,
  BootstrapTransport,
  RawProjectState,
  RawStartupView,
} from "./types";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createTauriBootstrapTransport(invoke: Invoke): BootstrapTransport {
  return {
    async loadBootstrap(): Promise<BootstrapSnapshot> {
      const [startup, project] = await Promise.all([
        invoke<RawStartupView>("startup_status"),
        invoke<RawProjectState>("project_state"),
      ]);
      return {
        source: "tauri",
        project: normalizeProjectState(project),
        startup: normalizeStartupView(startup),
      };
    },
  };
}
