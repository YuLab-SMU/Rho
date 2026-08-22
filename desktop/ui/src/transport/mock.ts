import { normalizeProjectState } from "./normalize";
import type {
  BootstrapSnapshot,
  BootstrapTransport,
  StartupHealthState,
  StartupHealthView,
} from "./types";

const MOCK_PROJECT_ROOT = "/Users/rho/Projects/Surface Playground";
const VALID_HEALTH = new Set<StartupHealthState>([
  "checking",
  "ready",
  "needs_attention",
  "unavailable",
]);

function mockHealth(search: URLSearchParams): StartupHealthView {
  const requested = search.get("health") as StartupHealthState | null;
  const state = requested != null && VALID_HEALTH.has(requested) ? requested : "ready";
  switch (state) {
    case "checking":
      return { state, phase: "probing_runtime", title: "Preparing local runtime" };
    case "needs_attention":
      return {
        state,
        phase: "needs_attention",
        title: "Agent runtime needs attention",
        detail: "The scientific workbench remains available.",
      };
    case "unavailable":
      return { state, phase: "unknown", title: "Startup state unavailable" };
    case "ready":
      return { state, phase: "runtime_ready", title: "Local runtime ready" };
  }
}

export function createMockBootstrapTransport(
  searchInput: string | URLSearchParams = "",
): BootstrapTransport {
  const search =
    typeof searchInput === "string" ? new URLSearchParams(searchInput) : searchInput;
  return {
    async loadBootstrap(): Promise<BootstrapSnapshot> {
      const root = search.get("project") ?? MOCK_PROJECT_ROOT;
      return {
        source: "mock",
        project: normalizeProjectState({ root }),
        startup: mockHealth(search),
      };
    },
  };
}
