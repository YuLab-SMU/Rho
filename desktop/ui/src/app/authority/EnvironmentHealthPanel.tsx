import { useCallback, useEffect, useState } from "react";

import type { EnvironmentHealthView } from "../../transport/environment";
import type { AuthorityEnvironmentPort } from "../workbench/authorityPorts";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";

type EnvironmentHealthMode = "health" | "plans" | "activity";

function statusLabel(status: EnvironmentHealthView["status"]): string {
  switch (status) {
    case "realized": return "Realized and observed";
    case "restart_required": return "Workspace restart required";
    case "observation_required": return "Workspace re-observation required";
    case "blocked_by_incident": return "Blocked by Environment incident";
    default: return "No verified Environment binding";
  }
}

function BindingFacts({ health }: { readonly health: EnvironmentHealthView }) {
  const binding = health.binding;
  return <section className="rho-environment-authority-card" aria-label="Environment Authority facts">
    <span className="rho-eyebrow">Authority facts</span>
    {binding == null ? <p>No verified Environment receipt is recorded for this project.</p> : <>
      <header><strong>{binding.environment_id}</strong><span>{binding.receipt_outcome}</span></header>
      <dl>
        <div><dt>Receipt</dt><dd><code>{binding.receipt_id}</code></dd></div>
        <div><dt>Digest</dt><dd><code>{binding.receipt_digest}</code></dd></div>
        <div><dt>Desired</dt><dd><code>{binding.desired_revision}</code></dd></div>
        <div><dt>Realization</dt><dd><code>{binding.realization_revision}</code></dd></div>
        <div><dt>Runtime</dt><dd><code>{binding.runtime_id}</code></dd></div>
        <div><dt>Target</dt><dd>{binding.target_id}</dd></div>
      </dl>
    </>}
  </section>;
}

function WorkspaceFacts({ health, busy, reobserve }: {
  readonly health: EnvironmentHealthView;
  readonly busy: boolean;
  readonly reobserve: () => void;
}) {
  return <section className="rho-environment-authority-card" aria-label="Live Workspace Environment">
    <span className="rho-eyebrow">Live Workspace</span>
    <header><strong>{health.workspace.phase.replaceAll("_", " ")}</strong>
      <span>{health.workspace.kernel_instance_id ?? "not running"}</span></header>
    {health.workspace.restart_required && <p>The verified realization is pending. Restart Workspace R from its runtime control; the failed expression will not replay.</p>}
    {health.workspace.reobserve_required && <p>The current kernel cannot execute until its package inventory and namespaces match the receipt.</p>}
    {health.workspace.reobserve_required && !health.workspace.restart_required && <button type="button" disabled={busy} onClick={reobserve}>{busy ? "Observing…" : "Re-observe now"}</button>}
    {health.workspace.active_receipt_digest != null && <small>Active receipt <code>{health.workspace.active_receipt_digest}</code></small>}
    {health.workspace.pending_receipt_digest != null && <small>Pending receipt <code>{health.workspace.pending_receipt_digest}</code></small>}
  </section>;
}

function PlanReview({ health }: { readonly health: EnvironmentHealthView }) {
  const operation = health.latest_operation;
  const plan = health.pending_plan ?? operation?.plan;
  if (plan == null) return <SurfaceTaskState tone="empty" title="No materialized plan" detail="An immutable exact plan appears here before Environment execution." role="status" />;
  return <section className="rho-environment-plan-review" aria-label="Immutable Environment plan">
    <header><div><span className="rho-eyebrow">{health.pending_plan == null ? "Immutable exact plan" : "Awaiting exact approval"}</span><strong>{plan.intent.replaceAll("_", " ")}</strong></div><code>{plan.plan_id}</code></header>
    <div className="rho-environment-plan-runtime"><strong>R {plan.runtime_version}</strong><span>{plan.runtime_ownership} · {plan.runtime_support_tier}</span><code>{plan.runtime_id}</code></div>
    <div className="rho-environment-plan-runtime"><strong>{plan.target_library_kind.replaceAll("_", " ")}</strong><span>Exact target library</span><code>{plan.target_library_path}</code><small>{plan.library_stack_digest}</small></div>
    <ul>{plan.package_actions.map((action) => <li key={`${action.package}:${action.action}`}>
      <strong>{action.action} {action.package}{action.version == null ? "" : `@${action.version}`}</strong>
      <span>{action.artifact_byte_size} bytes</span>
      <code>{action.artifact_digest}</code>
      <small>{action.source}</small>
    </li>)}</ul>
    <dl>
      <div><dt>Expected desired</dt><dd><code>{plan.expected_desired_revision}</code></dd></div>
      <div><dt>Expected realization</dt><dd><code>{plan.expected_realization_revision}</code></dd></div>
      <div><dt>Network</dt><dd>{plan.network_intents.join(", ") || "none"}</dd></div>
      <div><dt>Secret refs</dt><dd>{plan.secret_requirements.join(", ") || "none"}</dd></div>
      <div><dt>Verification</dt><dd>{plan.verification_probes.join(", ")}</dd></div>
    </dl>
  </section>;
}

function OperationActivity({ health }: { readonly health: EnvironmentHealthView }) {
  const operation = health.latest_operation;
  if (operation == null) return null;
  return <section className="rho-environment-operation-activity" aria-label="Environment operation activity">
    <header><span className="rho-eyebrow">Operation activity</span><strong>{operation.status}</strong><code>{operation.operation_id}</code></header>
    <ol>{operation.checkpoints.map((checkpoint, index) => <li key={`${index}:${checkpoint.name}`}>
      <strong>{checkpoint.name}</strong><time>{checkpoint.reached_at}</time>
      {checkpoint.digest != null && <code>{checkpoint.digest}</code>}
    </li>)}</ol>
    {operation.reason != null && <p>{operation.reason}</p>}
  </section>;
}

function IncidentList({ health }: { readonly health: EnvironmentHealthView }) {
  if (health.incidents.length === 0) return null;
  return <section className="rho-environment-incidents" aria-label="Environment incidents">
    <span className="rho-eyebrow">Package incidents</span>
    {health.incidents.map((incident) => <article key={incident.incident_id}>
      <header><strong>{incident.kind.replaceAll("_", " ")}</strong><span>{incident.status}</span></header>
      <p>{incident.subject}: {incident.detail}</p>
    </article>)}
  </section>;
}

export function EnvironmentHealthPanel({ transport, mode, reportError }: {
  readonly transport: AuthorityEnvironmentPort;
  readonly mode: EnvironmentHealthMode;
  readonly reportError: (error: unknown) => void;
}) {
  const [health, setHealth] = useState<EnvironmentHealthView | null>(null);
  const [loading, setLoading] = useState(true);
  const [reobserving, setReobserving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setHealth(await transport.environmentHealth());
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Environment Authority facts could not load."));
    } finally {
      setLoading(false);
    }
  }, [transport]);
  useEffect(() => {
    void load();
    return transport.subscribeInvalidated(() => void load());
  }, [load, transport]);
  const reobserve = async () => {
    setReobserving(true);
    try {
      setHealth(await transport.reobserveEnvironment());
      setError(null);
    } catch (cause: unknown) {
      setError(workbenchFailureMessage(cause, "Workspace Environment could not be re-observed."));
      reportError(cause);
    } finally {
      setReobserving(false);
    }
  };
  if (loading && health == null) return <SurfaceTaskState tone="loading" title="Reading Environment authority…" detail="Loading the verified receipt, exact plan and live Workspace gate." role="status" busy />;
  if (error != null && health == null) return <SurfaceTaskState tone="error" title="Environment Authority unavailable" detail={error} role="alert"><button type="button" onClick={() => void load()}>Try again</button></SurfaceTaskState>;
  if (health == null) return null;
  return <section className="rho-environment-health" data-status={health.status}>
    <header><div><span className="rho-eyebrow">Environment realization</span><strong>{statusLabel(health.status)}</strong></div><button type="button" disabled={loading} onClick={() => void load()}>Refresh</button></header>
    {error != null && <p role="alert">{error}</p>}
    {mode === "health" && <div className="rho-environment-authority-grid"><BindingFacts health={health} /><WorkspaceFacts health={health} busy={reobserving} reobserve={() => void reobserve()} /></div>}
    {(mode === "health" || mode === "plans") && <PlanReview health={health} />}
    {(mode === "health" || mode === "activity") && <OperationActivity health={health} />}
    <IncidentList health={health} />
    {mode === "health" && <details><summary>Projection limitations</summary><ul>{health.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>}
  </section>;
}
