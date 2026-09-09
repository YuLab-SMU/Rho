import type { AgentTaskEvent } from "../generated/AgentTaskEvent";
import type { AgentTaskSummary } from "../generated/AgentTaskSummary";

export function agentActivity(task: AgentTaskSummary, events: readonly AgentTaskEvent[], pending: boolean) {
  const state = task.attachment.state;
  const fixed: Record<string, string> = { connecting: "Connecting to Agent", resuming: "Restoring session", stopping: "Stopping Agent", waiting_for_permission: "Waiting for your permission" };
  if (fixed[state]) return { label: fixed[state], at: 0 };
  if (pending && state !== "running") return { label: "Sending message", at: 0 };
  if (state !== "running") return null;
  const current = events.filter(e => e.generation === task.attachment.generation && e.source !== "native_history").reverse();
  const request = current.find(e => e.role === "user")?.request_id;
  const activity = current.find(e => e.kind === "activity" && e.request_id === request);
  const phase: Record<string, string> = { thinking: "Thinking", responding: "Responding", tool: "Using tools", working: "Working" };
  return { label: phase[activity?.status ?? ""] ?? "Waiting for Agent", at: activity?.observed_at_ms ?? 0 };
}

export function AgentActivity({ task, events, pending, now }: { task: AgentTaskSummary; events: readonly AgentTaskEvent[]; pending: boolean; now: number }) {
  const activity = agentActivity(task, events, pending);
  if (!activity) return null;
  const quiet = activity.at ? Math.max(0, Math.floor((now - activity.at) / 1000)) : 0;
  return <div className="at-live-activity" role="status" aria-label="Agent activity">
    <span className="at-activity-dots" aria-hidden="true"><i /><i /><i /></span>
    <span>{activity.label}<span aria-hidden="true">…</span></span>
    {quiet >= 30 && <small aria-live="off">No new activity for {quiet}s</small>}
  </div>;
}
