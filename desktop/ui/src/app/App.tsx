import { useCallback, useEffect, useRef, useState } from "react";

import type { UiKernelTransport, WorkspacePreparation } from "../transport";
import { defaultTransport, WorkbenchApp } from "./WorkbenchApp";

interface AppProps {
  readonly transport?: UiKernelTransport;
}


type PreparationState =
  | { readonly status: "preparing" }
  | { readonly status: "ready"; readonly result: WorkspacePreparation }
  | { readonly status: "needs_attention"; readonly result: WorkspacePreparation };

export function App({ transport }: AppProps) {
  const resolvedTransport = transport ?? defaultTransport;
  const [preparation, setPreparation] = useState<PreparationState>({ status: "preparing" });
  const generation = useRef(0);
  const prepare = useCallback((chooseRscript = false) => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setPreparation({ status: "preparing" });
    void resolvedTransport.prepareWorkspace(chooseRscript).then((result) => {
      if (generation.current !== currentGeneration) return;
      setPreparation(result.status === "ready"
        ? { status: "ready", result }
        : { status: "needs_attention", result });
    }).catch((error: unknown) => {
      if (generation.current !== currentGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      setPreparation({
        status: "needs_attention",
        result: {
          status: "needs_attention",
          phase: "preparation_failed",
          workspace_ready: false,
          restored_project_status: null,
          issue: {
            code: "PREPARATION_FAILED",
            title: "Rho could not prepare the workspace",
            message: "Retry startup or select a valid Rscript executable.",
            technical_detail: detail.slice(0, 2_048),
          },
        },
      });
    });
  }, [resolvedTransport]);
  useEffect(() => {
    prepare();
    return () => { generation.current += 1; };
  }, [prepare]);
  useEffect(() => {
    if (preparation.status !== "ready") {
      document.documentElement.dataset.rsrReady = "false";
    }
  }, [preparation.status]);

  if (preparation.status === "preparing") {
    return (
      <main className="rho-preparation-shell" aria-busy="true">
        <section className="rho-preparation-card">
          <div className="rho-mark" aria-label="Rho"><span className="rho-mark-glyph">R</span><span>Rho</span></div>
          <span className="rho-preparation-spinner" aria-hidden="true" />
          <div><strong>Preparing the project runtime</strong><p>Starting Workspace R, restoring the project, and reconciling its Surfaces…</p></div>
        </section>
      </main>
    );
  }
  if (preparation.status === "needs_attention") {
    const issue = preparation.result.issue;
    return (
      <main className="rho-preparation-shell">
        <section className="rho-preparation-card rho-preparation-issue" role="alert">
          <div className="rho-mark" aria-label="Rho"><span className="rho-mark-glyph">R</span><span>Rho</span></div>
          <div>
            <span className="rho-eyebrow">{issue?.code ?? preparation.result.phase}</span>
            <h1>{issue?.title ?? "The project runtime needs attention"}</h1>
            <p>{issue?.message ?? "Retry startup to continue."}</p>
            {issue?.technical_detail != null && <details><summary>Technical details</summary><pre>{issue.technical_detail}</pre></details>}
            <div className="rho-preparation-actions">
              <button type="button" onClick={() => prepare()}>Retry</button>
              <button type="button" onClick={() => prepare(true)}>Choose Rscript</button>
            </div>
          </div>
        </section>
      </main>
    );
  }
  return <WorkbenchApp transport={resolvedTransport} />;
}
