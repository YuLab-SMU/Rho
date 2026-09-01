import { useEffect, useState } from "react";

import type { CheckResult, FindingReference, SurfaceInstance, UiKernelTransport } from "../transport";
import { formatHistoryTime } from "./time-format";
import { SurfaceTaskState } from "./SurfaceTaskState";

function checkResultId(instance: SurfaceInstance): string | null {
  if (typeof instance.view_state !== "object" || instance.view_state == null) return null;
  const value = (instance.view_state as Record<string, unknown>).check_result_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function checkOriginLabel(finding: CheckResult["findings"][number]): string {
  if (finding.origin.kind === "application") return "Rho core";
  return `Workspace rule pack · ${finding.origin.plugin_id} · g${finding.activation_generation}`;
}

function referenceLabel(reference: FindingReference): string {
  switch (reference.kind) {
    case "source_range": return `${reference.path}:${reference.line}${reference.column == null ? "" : `:${reference.column}`}`;
    case "project_file": return reference.path;
    case "run_ref": return `Run ${reference.run_id}`;
    case "environment_ref": return `Environment ${reference.snapshot_id}`;
    case "note": return reference.text;
  }
}

export function CheckResultView({
  instance,
  projectRevision,
  transport,
  openReference,
  reportError,
}: {
  readonly instance: SurfaceInstance;
  readonly projectRevision: number;
  readonly transport: UiKernelTransport;
  readonly openReference: (path: string) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}) {
  const resultId = checkResultId(instance);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [status, setStatus] = useState<"empty" | "loading" | "ready" | "failed">(
    resultId == null ? "empty" : "loading",
  );
  useEffect(() => {
    if (resultId == null) {
      setResult(null);
      setStatus("empty");
      return;
    }
    let active = true;
    const load = () => {
      setStatus("loading");
      void transport.loadCheckResult({
        project_id: instance.project_id,
        expected_project_revision: projectRevision,
        result_id: resultId,
      }).then((next) => {
        if (!active) return;
        setResult(next);
        setStatus("ready");
      }).catch((error: unknown) => {
        if (!active) return;
        setStatus("failed");
        reportError(error);
      });
    };
    load();
    const unsubscribe = transport.subscribeCheckResultsInvalidated(load);
    return () => { active = false; unsubscribe(); };
  }, [instance.project_id, projectRevision, reportError, resultId, transport]);
  if (status === "empty") {
    return <SurfaceTaskState tone="empty" title="No Check result yet" detail="Run Check project to create an immutable result." role="status" className="rho-check-empty" />;
  }
  if (result == null) {
    return status === "failed"
      ? <SurfaceTaskState tone="error" title="Check result unavailable" detail="This captured result is no longer available. Run Check project again." role="alert" className="rho-check-empty rho-check-failed" />
      : <SurfaceTaskState tone="loading" title="Loading Check result…" detail="Reading the immutable captured result." role="status" busy className="rho-check-empty rho-check-loading" />;
  }
  return (
    <section className="rho-check-result" data-result-id={result.result_id}>
      <header className="rho-check-summary">
        <div className="rho-check-outcome">
          <span className={`rho-check-status rho-check-status-${result.status}`}>{result.status}</span>
          <div><strong>{result.findings.length === 0 ? "Project check passed" : `${result.findings.length} ${result.findings.length === 1 ? "finding" : "findings"} to review`}</strong><small title={result.generated_at}>Captured {formatHistoryTime(result.generated_at)}</small></div>
        </div>
        <details className="rho-check-result-meta">
          <summary>Result details</summary>
          <dl>
            <div><dt>Files</dt><dd>{result.coverage.files_scanned}</dd></div>
            <div><dt>Core rules</dt><dd>{result.coverage.core_rules}</dd></div>
            <div><dt>Rule packs</dt><dd>{result.coverage.plugin_rule_packs}</dd></div>
          </dl>
          <small>Snapshot <code>{result.snapshot.snapshot_id}</code></small>
        </details>
      </header>
      {result.limitations.length > 0 && <div className="rho-check-limitations" role="status"><strong>Coverage limitations</strong>{result.limitations.map((item) => <p key={item}>{item}</p>)}</div>}
      <div className="rho-check-findings">
        {result.findings.map((finding, index) => (
          <article className={`rho-check-finding rho-check-finding-${finding.severity}`} key={`${finding.rule_id}:${index}`}>
            <header><span>{finding.category}</span><span>{finding.severity}</span></header>
            <h3>{finding.title}</h3>
            <p>{finding.summary}</p>
            <div className="rho-check-remediation"><strong>Next step</strong><span>{finding.remediation}</span></div>
            <div className="rho-check-references">
              {finding.references.map((reference, referenceIndex) => {
                const path = reference.kind === "source_range" || reference.kind === "project_file" ? reference.path : null;
                return path == null
                  ? <span key={referenceIndex}>{referenceLabel(reference)}</span>
                  : <button type="button" onClick={() => void openReference(path).catch(reportError)} key={referenceIndex}>{referenceLabel(reference)}</button>;
              })}
            </div>
            <details className="rho-check-rule-meta"><summary>Rule details</summary><div><span>{checkOriginLabel(finding)}</span><code>{finding.rule_id} · v{finding.rule_version}</code></div></details>
          </article>
        ))}
        {result.findings.length === 0 && <div className="rho-check-clean">No findings in this captured project revision.</div>}
      </div>
    </section>
  );
}
