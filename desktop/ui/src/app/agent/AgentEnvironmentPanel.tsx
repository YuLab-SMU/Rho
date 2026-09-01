import { useCallback, useEffect, useState } from "react";

import type { EnvironmentHealthView } from "../../transport/environment";
import type { AgentEnvironmentPort } from "../workbench/agentPorts";

export function AgentEnvironmentPanel({ port, reportError }: {
  readonly port: AgentEnvironmentPort;
  readonly reportError: (error: unknown) => void;
}) {
  const [health, setHealth] = useState<EnvironmentHealthView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(async () => {
    try {
      setHealth(await port.environmentHealth());
      setUnavailable(false);
    } catch (error: unknown) {
      setUnavailable(true);
      reportError(error);
    }
  }, [port, reportError]);
  useEffect(() => {
    void load();
    return port.subscribeInvalidated(() => void load());
  }, [load, port]);
  return <section className="rho-agent-environment-doctor" aria-label="Agent Environment Doctor">
    <span className="rho-agent-section-label">Environment Doctor</span>
    {unavailable && <p>Environment Authority is unavailable; the Agent cannot verify runtime or package state.</p>}
    {!unavailable && health == null && <p>Reading Environment Authority…</p>}
    {health != null && <>
      <header><strong>{health.workspace.phase.replaceAll("_", " ")}</strong><span>authority: {health.binding?.receipt_outcome ?? "unbound"}</span></header>
      {health.binding != null && <p>Cites receipt <code>{health.binding.receipt_id}</code> and realization <code>{health.binding.realization_revision}</code>.</p>}
      {health.incidents.length === 0
        ? <p>No open Environment incident is reported by Authority.</p>
        : <ul>{health.incidents.map((incident) => <li key={incident.incident_id}><strong>{incident.kind.replaceAll("_", " ")}</strong><span>{incident.subject}: {incident.detail}</span></li>)}</ul>}
      {(health.workspace.restart_required || health.workspace.reobserve_required) && <p className="rho-agent-environment-uncertainty">Execution is unavailable until Workspace activation is re-observed. Agent may explain or request the exact plan through Broker; it cannot install directly.</p>}
    </>}
  </section>;
}
