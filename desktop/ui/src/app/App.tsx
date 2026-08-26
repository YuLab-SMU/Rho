import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectSwitchResponse, UiKernelTransport, WorkspacePreparation } from "../transport";
import { defaultTransport, WorkbenchApp } from "./WorkbenchApp";
import { projectSwitchFailure } from "./controllers/project-switch-controller";

interface AppProps {
  readonly transport?: UiKernelTransport;
}


type PreparationState =
  | { readonly status: "preparing" }
  | { readonly status: "ready"; readonly result: WorkspacePreparation }
  | { readonly status: "needs_attention"; readonly result: WorkspacePreparation };

function projectRecoveryDetail(response: ProjectSwitchResponse): string {
  if (response.unavailable != null) {
    return `Selected project: ${response.unavailable.path}\nReason: ${response.unavailable.reason}`.slice(0, 2_048);
  }
  const detail = [
    `project_pick_directory returned ${response.status}`,
    response.reason_code,
    response.message,
  ].filter((value): value is string => value != null && value.length > 0).join("\n");
  return detail.slice(0, 2_048);
}

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
  const chooseProject = useCallback(() => {
    if (preparation.status !== "needs_attention" || !preparation.result.workspace_ready) return;
    const previous = preparation;
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    setPreparation({ status: "preparing" });
    void resolvedTransport.pickProjectDirectory().then((response) => {
      if (generation.current !== currentGeneration) return;
      if (response.status === "ready") {
        setPreparation({
          status: "ready",
          result: {
            status: "ready",
            phase: "project_ready",
            workspace_ready: true,
            restored_project_status: "ready",
            issue: null,
          },
        });
        return;
      }
      if (response.status === "cancelled") {
        setPreparation(previous);
        return;
      }
      setPreparation({
        status: "needs_attention",
        result: {
          status: "needs_attention",
          phase: "project_selection_incomplete",
          workspace_ready: true,
          restored_project_status: response.status,
          issue: {
            code: "PROJECT_SELECTION_INCOMPLETE",
            title: "The selected project could not be opened",
            message: projectSwitchFailure(response, null)
              ?? "Choose another project folder to continue.",
            technical_detail: projectRecoveryDetail(response),
          },
        },
      });
    }).catch((error: unknown) => {
      if (generation.current !== currentGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      setPreparation({
        status: "needs_attention",
        result: {
          status: "needs_attention",
          phase: "project_selection_failed",
          workspace_ready: true,
          restored_project_status: null,
          issue: {
            code: "PROJECT_SELECTION_FAILED",
            title: "The project picker could not open the selected project",
            message: "Choose another project folder or retry startup.",
            technical_detail: detail.slice(0, 2_048),
          },
        },
      });
    });
  }, [preparation, resolvedTransport]);
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
              {preparation.result.workspace_ready
                ? <button type="button" onClick={chooseProject}>Choose project</button>
                : <button type="button" onClick={() => prepare(true)}>Choose Rscript</button>}
            </div>
          </div>
        </section>
      </main>
    );
  }
  return <WorkbenchApp transport={resolvedTransport} />;
}
