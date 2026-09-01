import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import type {
  PlotArtifactSummary,
  ProblemSummary,
} from "../../transport/history";
import type { SurfaceInstance } from "../../transport";
import type { ResultsPorts } from "../workbench/resultsPorts";
import { PlotThumbnail } from "../PlotThumbnail";
import { SurfaceTaskState } from "../SurfaceTaskState";
import { workbenchFailureMessage } from "../workbench-failure";

export const RESULTS_SURFACE_IDS = new Set(["rho.plots", "rho.problems"]);

function TypedResults<T>({ load, empty, label, detail, className, render }: {
  readonly load: () => Promise<readonly T[]>;
  readonly empty: string;
  readonly label: (count: number) => string;
  readonly detail: string;
  readonly className: string;
  readonly render: (item: T) => ReactNode;
}) {
  const [items, setItems] = useState<readonly T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setItems(await load()); setError(null); }
    catch (cause: unknown) { setError(workbenchFailureMessage(cause, "Result records could not be loaded.")); }
  }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (error != null) return <SurfaceTaskState tone="error" title="Results unavailable" detail={error} role="alert" />;
  if (items == null) return <SurfaceTaskState tone="loading" title="Loading results…" detail="Reading typed result projections." role="status" busy />;
  return <section className={`rho-authority-surface rho-results-surface ${className}`}>
    <header>
      <div><strong>{label(items.length)}</strong><small>{detail}</small></div>
      <button type="button" onClick={() => void refresh()}>Refresh</button>
    </header>
    {items.length === 0 ? <p className="rho-results-empty">{empty}</p> : <div className="rho-authority-records">{items.map(render)}</div>}
  </section>;
}

function sourceLabel(sourcePath: string | null): string {
  if (sourcePath == null) return "Plot artifact";
  return sourcePath.split("/").filter(Boolean).at(-1) ?? sourcePath;
}

export function ResultsSurfaceRouter({ instance, transport, openPlot }: {
  readonly instance: SurfaceInstance;
  readonly transport: ResultsPorts;
  readonly openPlot: (plotId: string) => void;
}) {
  if (instance.surface_id === "rho.plots") {
    const load = () => transport.listPlotArtifacts(200, false);
    return <TypedResults<PlotArtifactSummary>
      load={load}
      empty="No project plots are recorded."
      label={(count) => `${count} project ${count === 1 ? "plot" : "plots"}`}
      detail="Run-linked artifact records"
      className="rho-plots-results"
      render={(plot) => <article className="rho-plot-record" key={plot.plot_id}>
      <PlotThumbnail plotId={plot.plot_id} transport={transport} />
      <div className="rho-plot-record-copy">
        <strong title={plot.source_path ?? plot.plot_id}>{sourceLabel(plot.source_path)}</strong>
        <small title={plot.run_id}>Run {plot.run_id}</small>
      </div>
      <div className="rho-plot-record-footer">
        <span className={plot.provenance_complete ? "rho-result-authority-ready" : "rho-result-authority-incomplete"}>
          authority: {plot.provenance_complete ? "present" : "incomplete"}
        </span>
        <button type="button" onClick={() => openPlot(plot.plot_id)}>Open full view</button>
      </div>
    </article>}
    />;
  }
  if (instance.surface_id === "rho.problems") {
    const load = () => transport.listProblems(200);
    return <TypedResults<ProblemSummary>
      load={load}
      empty="No project problems are recorded."
      label={(count) => `${count} project ${count === 1 ? "problem" : "problems"}`}
      detail="Run-linked diagnostics"
      className="rho-problems-results"
      render={(problem) => <article key={`${problem.run_id}:${problem.message}`}>
      <strong>{problem.message}</strong><span>authority: {problem.status}</span><small>{problem.source_path ?? problem.run_id}</small>
    </article>}
    />;
  }
  return null;
}
