import type {
  ProjectBootstrapView,
  RawProjectState,
  RawStartupView,
  StartupHealthView,
} from "./types";

const MAX_BOOTSTRAP_TEXT = 512;
const MAX_PROJECT_ROOT_TEXT = 4_096;

function boundedText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!normalized) return fallback;
  return normalized.slice(0, MAX_BOOTSTRAP_TEXT);
}

export function projectLabel(root: string): string {
  const pieces = root.replaceAll("\\", "/").split("/").filter(Boolean);
  return pieces.at(-1) ?? root;
}

export function normalizeProjectState(raw: RawProjectState): ProjectBootstrapView {
  const root =
    typeof raw.root === "string" && raw.root.length > 0
      ? raw.root.slice(0, MAX_PROJECT_ROOT_TEXT)
      : "No project selected";
  return { root, label: projectLabel(root) };
}

export function normalizeStartupView(raw: RawStartupView): StartupHealthView {
  const phase = boundedText(raw.phase, "unknown");
  if (raw.busy === true) {
    return {
      state: "checking",
      phase,
      title: "Preparing local runtime",
    };
  }
  if (phase === "runtime_ready" && raw.runtime != null) {
    return {
      state: "ready",
      phase,
      title: "Local runtime ready",
    };
  }
  if (raw.issue != null) {
    const title = boundedText(raw.issue.title, "Startup needs attention");
    const message = boundedText(raw.issue.message, "Review startup diagnostics.");
    return {
      state: "needs_attention",
      phase,
      title,
      detail: message,
    };
  }
  return {
    state: "unavailable",
    phase,
    title: "Startup state unavailable",
  };
}
