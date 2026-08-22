import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  UiExternalStore,
  commandsForPlacement,
  createUiKernelTransport,
} from "../transport";
import type { UiKernelTransport } from "../transport";

interface AppProps {
  readonly transport?: UiKernelTransport;
}

const defaultTransport = createUiKernelTransport();
const defaultStore = new UiExternalStore(defaultTransport);

export function App({ transport }: AppProps) {
  const store = useMemo(
    () => (transport == null ? defaultStore : new UiExternalStore(transport)),
    [transport],
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const snapshot = state.status === "ready" ? state.snapshot : null;
  const primaryCommands = useMemo(
    () => (snapshot == null ? [] : commandsForPlacement(snapshot, "primary_candidate")),
    [snapshot],
  );
  const commandCount = snapshot?.command_registry.registrations.length ?? 0;
  const evidence = useMemo(() => {
    if (state.status !== "ready") return { ready: false, state: state.status };
    return {
      ready: true,
      source: state.source,
      snapshotRevision: state.snapshot.snapshot_revision,
      project: state.snapshot.project.display_path,
      workspaceHealth: state.snapshot.context.workspace_health,
      agentHealth: state.snapshot.context.agent_health,
      commands: state.snapshot.command_registry.registrations.map(
        (registration) => registration.definition.command_id,
      ),
    };
  }, [state]);

  useEffect(() => {
    document.documentElement.dataset.rsrReady = String(evidence.ready);
  }, [evidence.ready]);

  return (
    <main className="rho-foundation-shell">
      <header className="rho-foundation-bar">
        <div className="rho-mark" aria-label="Rho">
          <span className="rho-mark-glyph" aria-hidden="true">R</span>
          <span>Rho</span>
        </div>
        <div className="rho-project-identity">
          <span className="rho-eyebrow">Project</span>
          <strong>{snapshot?.project.display_label ?? "Loading…"}</strong>
        </div>
        <div className="rho-command-projection" aria-label="Contextual commands">
          {primaryCommands
            .filter((registration) => registration.availability.state === "available")
            .slice(0, 1)
            .map((registration) => (
              <span className="rho-primary-command" key={registration.definition.command_id}>
                {registration.definition.label}
              </span>
            ))}
          <span className="rho-command-count">{commandCount} commands</span>
        </div>
        <div className="rho-foundation-status" aria-live="polite">
          <span
            className={`rho-status-dot rho-status-${
              snapshot?.context.workspace_health ?? state.status
            }`}
            aria-hidden="true"
          />
          <span>
            {snapshot?.health.workspace.label ??
              (state.status === "failed" ? "UI Kernel unavailable" : "Connecting to local Rho")}
          </span>
        </div>
      </header>

      <section className="rho-foundation-stage" aria-labelledby="foundation-title">
        <div className="rho-foundation-orbit" aria-hidden="true" />
        <div className="rho-foundation-copy">
          <span className="rho-eyebrow">Composition kernel</span>
          <h1 id="foundation-title">Rho Surface Runtime</h1>
          {state.status === "loading" && <p>Reading the broker-owned UI snapshot…</p>}
          {state.status === "failed" && <p role="alert">{state.message}</p>}
          {snapshot != null && (
            <>
              <p>
                Project context, command availability, health, and active work now cross one
                bounded immutable snapshot.
              </p>
              <dl className="rho-bootstrap-facts">
                <div>
                  <dt>Project root</dt>
                  <dd title={snapshot.project.display_path}>{snapshot.project.display_path}</dd>
                </div>
                <div>
                  <dt>Snapshot revision</dt>
                  <dd>{snapshot.snapshot_revision}</dd>
                </div>
                <div>
                  <dt>Active operations</dt>
                  <dd>{snapshot.context.active_operations.length}</dd>
                </div>
              </dl>
              <aside
                className={`rho-health-card rho-health-${snapshot.health.agent.state}`}
                aria-label="Agent runtime health"
              >
                <strong>{snapshot.health.agent.label}</strong>
                {snapshot.health.agent.detail != null && <p>{snapshot.health.agent.detail}</p>}
              </aside>
            </>
          )}
        </div>
      </section>
      <pre id="rsrPreviewEvidence" hidden>{JSON.stringify(evidence)}</pre>
    </main>
  );
}
