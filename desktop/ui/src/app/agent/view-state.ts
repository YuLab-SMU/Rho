import type { AgentMode, AgentTurnSummary, SurfaceInstance } from "../../transport";

export interface AgentSurfaceViewState {
  readonly conversation_id: string | null;
  readonly mode: AgentMode;
  readonly composer: string;
  readonly auto_approve: boolean;
  readonly file_decisions: Readonly<Record<string, "rejected">>;
}

export function initialAgentSurfaceState(instance: SurfaceInstance): AgentSurfaceViewState {
  const candidate = typeof instance.view_state === "object" && instance.view_state != null
    ? instance.view_state as Record<string, unknown>
    : {};
  const mode = candidate.mode;
  return {
    conversation_id: typeof candidate.conversation_id === "string"
      ? candidate.conversation_id
      : null,
    mode: mode === "plan" || mode === "act" ? mode : "ask",
    composer: typeof candidate.composer === "string" ? candidate.composer : "",
    auto_approve: candidate.auto_approve === true,
    file_decisions: typeof candidate.file_decisions === "object" && candidate.file_decisions != null
      ? candidate.file_decisions as Readonly<Record<string, "rejected">>
      : {},
  };
}

export function agentTurnStatusLabel(status: AgentTurnSummary["status"]): string {
  switch (status) {
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export const AGENT_MODE_HINTS: Readonly<Record<AgentMode, string>> = {
  ask: "Ask about this project",
  plan: "Shape a reviewable approach",
  act: "Work with project tools",
};

export const AGENT_SUGGESTIONS: readonly string[] = [
  "Summarize this project's structure",
  "Check the runtime health and report issues",
  "Draft a reproducible analysis plan",
];
