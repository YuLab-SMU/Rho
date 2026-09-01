export function AgentCurrentWork({ prompt, turnCount }: {
  readonly prompt: string | null;
  readonly turnCount: number;
}) {
  return <header className="rho-agent-current-work-header">
    <div>
      <span className="rho-agent-section-label">Current Work</span>
      <strong>{prompt ?? "Conversation"}</strong>
    </div>
    <span>{turnCount} {turnCount === 1 ? "turn" : "turns"}</span>
  </header>;
}

export function AgentRunningRow({ status, startedAt, disabled, onStop }: {
  readonly status: AgentTurnSummary["status"];
  readonly startedAt: string;
  readonly disabled: boolean;
  readonly onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = Date.parse(startedAt);
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const label = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  return <div className="rho-agent-running" role="status">
    <span className="rho-status-dot rho-status-degraded" aria-hidden="true" />
    <span className="rho-agent-running-label">
      {status === "waiting" ? "Waiting for a decision or response" : "Agent running"} · {label}
    </span>
    <button type="button" disabled={disabled} onClick={onStop}>Stop</button>
  </div>;
}
import { useEffect, useState } from "react";
import type { AgentTurnSummary } from "../../transport";
