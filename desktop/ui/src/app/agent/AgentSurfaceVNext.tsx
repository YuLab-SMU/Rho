import type { ReactNode } from "react";

import type {
  ActivityProjection,
  AgentUxFixture,
  JobProjection,
} from "../../acceptance/agentUxContract";
import type { NegotiatedProviderCapabilities } from "../../contracts/providerCapabilities";
import {
  ControlledPatchCard,
  type ControlledPatchProjection,
} from "./ControlledPatchCard";
import { ProviderControls } from "./ProviderControls";
import "../../styles/agent-surface-vnext.css";

export const MAX_VISIBLE_AGENT_ACTIVITIES = 120;

export type AgentSurfaceVNextProps = {
  projection: AgentUxFixture;
  hotCursor: number;
  hotGap: boolean;
  onApprove?: (approvalId: string) => void;
  onDeny?: (approvalId: string) => void;
  onCancel?: (activityId: string) => void;
  onReconnect?: () => void;
  negotiatedProvider?: NegotiatedProviderCapabilities;
  controlledPatch?: ControlledPatchProjection;
};

export function AgentSurfaceVNext({
  projection,
  hotCursor,
  hotGap,
  onApprove,
  onDeny,
  onCancel,
  onReconnect,
  negotiatedProvider,
  controlledPatch,
}: AgentSurfaceVNextProps) {
  const activities = boundVisibleActivities(projection.activities);
  const canRunR =
    !projection.provider.read_only_external_observer &&
    projection.provider.capability_ids.includes("workspace.run_r");

  return (
    <main
      className="rho-agent-vnext"
      data-surface-state={projection.surface_state}
      aria-label="Scientific agent workbench"
    >
      <header className="rho-agent-vnext__goal">
        <div>
          <p className="rho-agent-vnext__eyebrow">Goal</p>
          <h1>{projection.goal.text}</h1>
        </div>
        <StatusLabel state={projection.surface_state} />
      </header>

      {hotGap ? (
        <section className="rho-agent-vnext__recovery" role="status" aria-live="polite">
          <strong>Live activity gap detected</strong>
          <span>Reloading the durable snapshot from cursor {hotCursor}.</span>
          <button type="button" onClick={onReconnect} aria-label="Reconnect activity stream">
            Reconnect
          </button>
        </section>
      ) : null}

      <div className="rho-agent-vnext__layout">
        <section className="rho-agent-vnext__work" aria-labelledby="current-work-title">
          <h2 id="current-work-title">Current Work</h2>
          <ProviderPlanCard projection={projection} />
          <div className="rho-agent-vnext__messages" aria-label="Visible agent messages">
            {projection.messages.map((message) => (
              <article className="rho-agent-vnext__message" key={message.message_id}>
                <header>
                  <strong>{message.role === "agent" ? "Agent" : message.role}</strong>
                  <StatusLabel state={message.state} />
                </header>
                <p>
                  {message.visibility === "private_reasoning_redacted"
                    ? "Private reasoning withheld"
                    : message.content_preview}
                </p>
              </article>
            ))}
          </div>
        </section>

        <aside className="rho-agent-vnext__activity" aria-labelledby="activity-title">
          <header>
            <h2 id="activity-title">Activity</h2>
            <span aria-label={`Live cursor ${hotCursor}`}>#{hotCursor}</span>
          </header>
          <ol aria-live="polite" aria-relevant="additions text">
            {activities.map((activity) => (
              <ActivityRow
                activity={activity}
                key={activity.activity_id}
                onCancel={onCancel}
              />
            ))}
          </ol>
        </aside>
      </div>

      <section className="rho-agent-vnext__approvals" aria-labelledby="approval-title">
        <h2 id="approval-title">Approval</h2>
        {controlledPatch === undefined ? null : (
          <ControlledPatchCard patch={controlledPatch} />
        )}
        {projection.approvals.map((approval) => (
          <article className="rho-agent-vnext__approval" key={approval.approval_id}>
            <header>
              <strong>{approval.exact_effect.capability_id}</strong>
              <StatusLabel state={approval.state} />
            </header>
            <dl>
              <Detail label="Effect" value={approval.exact_effect.effect_class} />
              <Detail label="Destination" value={approval.exact_effect.destination} />
              <Detail
                label="Revision"
                value={`${approval.exact_effect.expected_revision.state_revision}/${approval.exact_effect.expected_revision.project_revision}`}
              />
              <Detail label="Risk" value={approval.exact_effect.risk_label} />
              <Detail
                label="One-time scope"
                value={approval.exact_effect.reversible ? "Exact reversible effect" : "Exact non-reversible effect"}
              />
            </dl>
            <pre aria-label="Normalized effect arguments">
              {JSON.stringify(redactArguments(approval.exact_effect.normalized_arguments), null, 2)}
            </pre>
            {approval.state === "pending" && canRunR ? (
              <div className="rho-agent-vnext__actions">
                <button
                  type="button"
                  onClick={() => onApprove?.(approval.approval_id)}
                  aria-label={`Approve exact effect ${approval.approval_id}`}
                >
                  Approve once
                </button>
                <button
                  type="button"
                  onClick={() => onDeny?.(approval.approval_id)}
                  aria-label={`Deny effect ${approval.approval_id}`}
                >
                  Deny
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <section className="rho-agent-vnext__jobs" aria-labelledby="jobs-title">
        <h2 id="jobs-title">Jobs</h2>
        {projection.jobs.map((job) => (
          <JobCard job={job} key={job.job_id} onCancel={onCancel} />
        ))}
      </section>

      <section className="rho-agent-vnext__context" aria-labelledby="context-title">
        <h2 id="context-title">Context &amp; Policy</h2>
        {negotiatedProvider === undefined ? null : (
          <ProviderControls capabilities={negotiatedProvider} />
        )}
        <p>{projection.provider.provider_label}</p>
        <p>Permission: {projection.permission_posture.replaceAll("_", " ")}</p>
        <p>Data egress: {projection.data_egress.replaceAll("_", " ")}</p>
        <ul aria-label="Available capabilities">
          {projection.provider.capability_ids.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </section>

      <section className="rho-agent-vnext__outputs" aria-label="Artifacts and recovery">
        {projection.artifacts.map((artifact) => (
          <article key={artifact.artifact_id} className="rho-agent-vnext__artifact">
            <strong>Artifact {artifact.artifact_id}</strong>
            <code>{artifact.digest}</code>
            <span>Revision {artifact.revision.state_revision}</span>
          </article>
        ))}
        {projection.recovery.map((recovery) => (
          <article key={recovery.recovery_id} className="rho-agent-vnext__recovery">
            <strong>{recovery.object}</strong>
            <p>{recovery.known_truth}</p>
            <p>{recovery.safe_next_step}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

export function boundVisibleActivities(activities: ActivityProjection[]): ActivityProjection[] {
  const latestById = new Map<string, ActivityProjection>();
  for (const activity of activities) latestById.set(activity.activity_id, activity);
  const unique = [...latestById.values()];
  const pinned = unique.filter(
    (activity) =>
      activity.kind === "approval" ||
      activity.kind === "capability_request" ||
      activity.kind === "plan_transition" ||
      ["succeeded", "failed", "cancelled", "uncertain"].includes(activity.status),
  );
  const hot = unique.filter((activity) => !pinned.includes(activity));
  const pinnedBudget = Math.min(pinned.length, Math.floor(MAX_VISIBLE_AGENT_ACTIVITIES * 0.75));
  const retainedPinned = pinned.slice(-pinnedBudget);
  const retainedHot = hot.slice(-(MAX_VISIBLE_AGENT_ACTIVITIES - retainedPinned.length));
  return [...retainedPinned, ...retainedHot].sort(
    (left, right) => unique.indexOf(left) - unique.indexOf(right),
  );
}

function ProviderPlanCard({ projection }: { projection: AgentUxFixture }) {
  return (
    <article className="rho-agent-vnext__plan" aria-label="Provider plan">
      <header>
        <strong>Plan</strong>
        <StatusLabel state={projection.plan.state} />
      </header>
      <ol>
        {projection.plan.steps.map((step) => (
          <li key={step.step_id} data-state={step.state}>
            <span>{step.label}</span>
            <StatusLabel state={step.state} />
          </li>
        ))}
      </ol>
    </article>
  );
}

function ActivityRow({
  activity,
  onCancel,
}: {
  activity: ActivityProjection;
  onCancel: ((activityId: string) => void) | undefined;
}) {
  const cancellable = activity.status === "running" || activity.status === "streaming";
  return (
    <li className="rho-agent-vnext__activity-row" data-kind={activity.kind}>
      <div>
        <strong>{activity.label}</strong>
        <StatusLabel state={activity.status} />
      </div>
      {activity.status === "uncertain" ? (
        <p>Outcome uncertain; reconciliation is required before retry.</p>
      ) : null}
      {activity.status === "reconnecting" ? <p>Reconnecting to durable activity.</p> : null}
      {cancellable ? (
        <button
          type="button"
          onClick={() => onCancel?.(activity.activity_id)}
          aria-label={`Request cancellation for ${activity.label}`}
        >
          Request cancel
        </button>
      ) : null}
    </li>
  );
}

function JobCard({
  job,
  onCancel,
}: {
  job: JobProjection;
  onCancel: ((jobId: string) => void) | undefined;
}) {
  return (
    <article className="rho-agent-vnext__job" data-state={job.state}>
      <header>
        <strong>Job {job.job_id}</strong>
        <StatusLabel state={job.state} />
      </header>
      <p>Execution {job.execution_id}</p>
      <p>Workspace revision {job.revision.state_revision}</p>
      {job.state === "cancelled" ? <p>Cancellation confirmed by the execution boundary.</p> : null}
      {job.state === "uncertain" || job.state === "reconciling" ? (
        <p>Execution truth is being reconciled; no automatic replay.</p>
      ) : null}
      {job.state === "running" ? (
        <button
          type="button"
          onClick={() => onCancel?.(job.job_id)}
          aria-label={`Request cancellation for job ${job.job_id}`}
        >
          Request cancel
        </button>
      ) : null}
    </article>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StatusLabel({ state }: { state: string }) {
  return <span className="rho-agent-vnext__status">{state.replaceAll("_", " ")}</span>;
}

function redactArguments(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /secret|token|password|credential/i.test(key) ? "[REDACTED]" : item,
    ]),
  );
}
