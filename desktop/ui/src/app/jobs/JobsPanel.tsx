import type { JobResources, JobSnapshot, JobsSnapshot } from "../../contracts/jobs";

export function JobsPanel({
  snapshot,
  onCancel,
}: {
  snapshot: JobsSnapshot;
  onCancel?: (jobId: string) => void;
}) {
  return (
    <section className="rho-jobs" aria-label="Background jobs">
      <header>
        <div>
          <p className="rho-agent-vnext__eyebrow">Job Plane</p>
          <h2>Jobs</h2>
        </div>
        <span>{snapshot.jobs.length} jobs</span>
      </header>
      <div className="rho-jobs__list">
        {snapshot.jobs.map((job) => (
          <JobCard job={job} key={job.job_id} onCancel={onCancel} />
        ))}
      </div>
    </section>
  );
}

function JobCard({
  job,
  onCancel,
}: {
  job: JobSnapshot;
  onCancel: ((jobId: string) => void) | undefined;
}) {
  const cancelPending = job.cancel_state === "requested";
  const canCancel = ["queued", "submitted", "running", "reconciling"].includes(job.state);
  return (
    <article className="rho-jobs__card" data-state={job.state}>
      <header>
        <div>
          <strong>{job.job_id}</strong>
          <span>{job.executor.replaceAll("_", " ")}</span>
        </div>
        <span className="rho-agent-vnext__status">{job.state}</span>
      </header>
      <dl>
        <Detail label="Execution" value={job.execution_id} />
        <Detail label="Operation" value={job.operation_id} />
        <Detail label="Queued" value={formatTimestamp(job.queued_at_ms)} />
        <Detail label="Started" value={formatTimestamp(job.started_at_ms)} />
        <Detail label="Terminal" value={formatTimestamp(job.terminal_at_ms)} />
      </dl>
      <ResourceComparison requested={job.requested_resources} effective={job.effective_resources} />
      <div className="rho-jobs__cancel" role="status">
        <strong>Cancellation</strong>
        <span>{job.cancel_state.replaceAll("_", " ")}</span>
        {cancelPending ? <p>Cancellation requested; process-tree death is not yet confirmed.</p> : null}
        {job.cancel_state === "process_tree_confirmed" ? (
          <p>Process tree confirmed dead.</p>
        ) : null}
        {job.cancel_state === "reconcile_required" ? (
          <p>Process identity requires reconciliation; no unrelated process will be signalled.</p>
        ) : null}
      </div>
      {canCancel ? (
        <button
          type="button"
          disabled={cancelPending}
          onClick={() => onCancel?.(job.job_id)}
          aria-label={`Request cancellation for job ${job.job_id}`}
        >
          {cancelPending ? "Cancel requested" : "Request cancel"}
        </button>
      ) : null}
      <div className="rho-jobs__logs" aria-label={`Bounded logs for ${job.job_id}`}>
        {job.logs.map((line) => (
          <pre key={`${line.stream}:${line.sequence}`} data-stream={line.stream}>
            {line.text}
          </pre>
        ))}
        {job.logs_truncated ? <p>Logs truncated at the configured bound.</p> : null}
      </div>
      <div className="rho-jobs__artifacts">
        <strong>Artifacts: {job.artifact_state}</strong>
        {job.artifact_state === "committed"
          ? job.artifacts.map((artifact) => (
              <button
                type="button"
                key={artifact.artifact_id}
                aria-label={`Open committed artifact ${artifact.artifact_id}`}
              >
                {artifact.artifact_id} · {artifact.media_type} · {artifact.byte_size} bytes
              </button>
            ))
          : null}
        {job.artifact_state === "partial" ? (
          <p>Partial collection requires reconciliation before outputs can be trusted.</p>
        ) : null}
      </div>
      {job.terminal_reason_code === null ? null : (
        <p className="rho-jobs__terminal">
          <strong>{job.terminal_reason_code.replaceAll("_", " ")}</strong>
          {job.safe_next_action === null ? null : <span>{job.safe_next_action}</span>}
        </p>
      )}
    </article>
  );
}

function ResourceComparison({
  requested,
  effective,
}: {
  requested: JobResources;
  effective: JobResources;
}) {
  return (
    <table>
      <caption>Requested and effective resources</caption>
      <thead>
        <tr>
          <th>Resource</th>
          <th>Requested</th>
          <th>Effective</th>
        </tr>
      </thead>
      <tbody>
        {(
          [
            ["CPU ms", requested.cpu_millis, effective.cpu_millis],
            ["Memory bytes", requested.memory_bytes, effective.memory_bytes],
            ["Processes", requested.max_processes, effective.max_processes],
            ["Walltime ms", requested.walltime_ms, effective.walltime_ms],
            ["Disk bytes", requested.disk_bytes, effective.disk_bytes],
            ["Output bytes", requested.output_bytes, effective.output_bytes],
          ] as const
        ).map(([label, requestedValue, effectiveValue]) => (
          <tr key={label}>
            <th>{label}</th>
            <td>{requestedValue}</td>
            <td>{effectiveValue}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatTimestamp(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}
